import { createHmac, randomUUID, timingSafeEqual, createHash } from "node:crypto";
import {
  CONTRACT_VERSION,
  clone,
  fail,
  type ObservationBundleReference,
} from "../../../packages/contracts/src/index.ts";

export interface CameraDescriptor {
  cameraId: string;
  robotId: string;
  frameId: string;
  calibrationVersion: string;
  kind: "RGB" | "DEPTH";
}

export interface MediaFrame {
  frameId: string;
  cameraId: string;
  robotId: string;
  sequence: number;
  sourceTimestampUnixMs: number;
  receivedAtUnixMs: number;
  mediaType: string;
  bytes: Uint8Array;
}

export interface ImmutableFrameReference {
  frameId: string;
  cameraId: string;
  sensorFrameId: string;
  sequence: number;
  sourceTimestampUnixMs: number;
  calibrationVersion: string;
  mediaType: string;
  sha256: string;
  byteLength: number;
}

export interface ImmutableObservationBundle {
  reference: ObservationBundleReference;
  frames: readonly ImmutableFrameReference[];
  maximumSensorSkewMs: number;
}

export interface ImmutableObservationFrame {
  observationId: string;
  reference: ImmutableFrameReference;
  bytes: Uint8Array;
}

export interface MediaRetentionState {
  observationCount: number;
  retainedBytes: number;
  maximumObservations: number;
  maximumRetainedObservationBytes: number;
}

export interface MediaAccessClaims {
  operatorId: string;
  robotId: string;
  cameraIds: readonly string[];
  resource: "LIVE_CAMERAS" | "IMMUTABLE_OBSERVATION";
  observationIds?: readonly string[];
  scope: "OBSERVE";
  issuedAtUnixMs: number;
  expiresAtUnixMs: number;
  nonce: string;
}

export interface MediaGatewayOptions {
  robotId: string;
  signingSecret: string;
  now?: () => number;
  idGenerator?: () => string;
  maximumFrameBytes?: number;
  framesPerCamera?: number;
  maximumLiveFrameAgeMs?: number;
  maximumFutureClockSkewMs?: number;
  maximumObservations?: number;
  maximumRetainedObservationBytes?: number;
}

export class MediaGateway {
  private readonly robotId: string;
  private readonly signingSecret: string;
  private readonly now: () => number;
  private readonly idGenerator: () => string;
  private readonly maximumFrameBytes: number;
  private readonly framesPerCamera: number;
  private readonly maximumLiveFrameAgeMs: number;
  private readonly maximumFutureClockSkewMs: number;
  private readonly maximumObservations: number;
  private readonly maximumRetainedObservationBytes: number;
  private readonly cameras = new Map<string, CameraDescriptor>();
  private readonly frames = new Map<string, MediaFrame[]>();
  private readonly observations = new Map<string, ImmutableObservationBundle>();
  private readonly observationFrames = new Map<string, ReadonlyMap<string, MediaFrame>>();
  private retainedObservationBytes = 0;

  constructor(options: MediaGatewayOptions) {
    if (!options.robotId.trim()) throw new Error("Media gateway robotId is required.");
    if (Buffer.byteLength(options.signingSecret) < 32) throw new Error("Media signing secret must contain at least 32 bytes.");
    this.robotId = options.robotId;
    this.signingSecret = options.signingSecret;
    this.now = options.now ?? Date.now;
    this.idGenerator = options.idGenerator ?? randomUUID;
    this.maximumFrameBytes = options.maximumFrameBytes ?? 8 * 1024 * 1024;
    this.framesPerCamera = options.framesPerCamera ?? 4;
    this.maximumLiveFrameAgeMs = options.maximumLiveFrameAgeMs ?? 500;
    this.maximumFutureClockSkewMs = options.maximumFutureClockSkewMs ?? 100;
    this.maximumObservations = options.maximumObservations ?? 32;
    this.maximumRetainedObservationBytes = options.maximumRetainedObservationBytes ?? 64 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maximumFrameBytes) || this.maximumFrameBytes < 1
      || !Number.isSafeInteger(this.framesPerCamera) || this.framesPerCamera < 1
      || !Number.isSafeInteger(this.maximumLiveFrameAgeMs) || this.maximumLiveFrameAgeMs < 1
      || !Number.isSafeInteger(this.maximumFutureClockSkewMs) || this.maximumFutureClockSkewMs < 0
      || !Number.isSafeInteger(this.maximumObservations) || this.maximumObservations < 1
      || !Number.isSafeInteger(this.maximumRetainedObservationBytes) || this.maximumRetainedObservationBytes < 1) {
      throw new Error("Media gateway buffer and clock limits are invalid.");
    }
  }

  registerCamera(camera: CameraDescriptor): CameraDescriptor {
    if (camera.robotId !== this.robotId) fail("MEDIA_ROBOT_MISMATCH", "Camera belongs to another robot.");
    for (const value of [camera.cameraId, camera.frameId, camera.calibrationVersion]) {
      if (!value.trim()) fail("MEDIA_CAMERA_INVALID", "Camera identity, frame, and calibration are required.");
    }
    const existing = this.cameras.get(camera.cameraId);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(camera)) fail("MEDIA_CAMERA_ID_COLLISION", `Camera ${camera.cameraId} metadata changed.`);
      return clone(existing);
    }
    this.cameras.set(camera.cameraId, clone(camera));
    return clone(camera);
  }

  getCamera(cameraId: string): CameraDescriptor {
    return clone(this.requireCamera(cameraId));
  }

  ingest(frame: MediaFrame): { accepted: boolean; reason?: string; frameAgeMs: number } {
    const camera = this.requireCamera(frame.cameraId);
    if (frame.robotId !== this.robotId) fail("MEDIA_ROBOT_MISMATCH", "Frame belongs to another robot.");
    if (!frame.frameId.trim() || !frame.mediaType.trim()) fail("MEDIA_FRAME_INVALID", "Frame ID and media type are required.");
    if (!Number.isSafeInteger(frame.sequence) || frame.sequence < 1
      || !Number.isSafeInteger(frame.sourceTimestampUnixMs) || !Number.isSafeInteger(frame.receivedAtUnixMs)) {
      fail("MEDIA_FRAME_INVALID", "Frame sequence and timestamps are invalid.");
    }
    if (frame.bytes.byteLength < 1 || frame.bytes.byteLength > this.maximumFrameBytes) {
      fail("MEDIA_FRAME_SIZE_INVALID", `Frame size must be between 1 and ${this.maximumFrameBytes} bytes.`);
    }
    const buffered = this.frames.get(camera.cameraId) ?? [];
    const latest = buffered.at(-1);
    if (latest && frame.sequence <= latest.sequence) return { accepted: false, reason: "MEDIA_FRAME_REORDERED", frameAgeMs: this.now() - frame.sourceTimestampUnixMs };
    const age = this.now() - frame.sourceTimestampUnixMs;
    if (age < -this.maximumFutureClockSkewMs
      || frame.receivedAtUnixMs < frame.sourceTimestampUnixMs - this.maximumFutureClockSkewMs) {
      return { accepted: false, reason: "MEDIA_FRAME_CLOCK_SKEW", frameAgeMs: age };
    }
    if (age > this.maximumLiveFrameAgeMs) return { accepted: false, reason: "MEDIA_FRAME_STALE", frameAgeMs: age };
    buffered.push(clone(frame));
    while (buffered.length > this.framesPerCamera) buffered.shift();
    this.frames.set(camera.cameraId, buffered);
    return { accepted: true, frameAgeMs: age };
  }

  liveFrame(cameraId: string, token: string): MediaFrame {
    const claims = this.verifyAccess(token);
    if (claims.resource !== "LIVE_CAMERAS") fail("MEDIA_ACCESS_DENIED", "Media grant does not authorize live camera frames.");
    if (!claims.cameraIds.includes(cameraId)) fail("MEDIA_ACCESS_DENIED", "Media grant does not include this camera.");
    const frame = this.frames.get(cameraId)?.at(-1);
    if (!frame) fail("MEDIA_FRAME_UNAVAILABLE", `Camera ${cameraId} has no live frame.`);
    if (this.now() - frame.sourceTimestampUnixMs > this.maximumLiveFrameAgeMs) fail("MEDIA_FRAME_STALE", "Latest frame is stale.");
    return clone(frame);
  }

  createObservation(input: {
    rgbCameraId: string;
    depthCameraId: string;
    sceneRevision: string;
    maximumSensorSkewMs?: number;
    observationId?: string;
  }): ImmutableObservationBundle {
    if (!input.sceneRevision.trim()) fail("MEDIA_SCENE_REVISION_REQUIRED", "sceneRevision is required.");
    const rgbCamera = this.requireCamera(input.rgbCameraId);
    const depthCamera = this.requireCamera(input.depthCameraId);
    if (rgbCamera.kind !== "RGB" || depthCamera.kind !== "DEPTH") fail("MEDIA_CAMERA_KIND_INVALID", "Observation requires RGB and depth cameras.");
    if (rgbCamera.calibrationVersion !== depthCamera.calibrationVersion) {
      fail("MEDIA_CALIBRATION_MISMATCH", "RGB and depth camera calibration versions differ.");
    }
    const maximumSensorSkewMs = input.maximumSensorSkewMs ?? 40;
    if (!Number.isSafeInteger(maximumSensorSkewMs) || maximumSensorSkewMs < 0) {
      fail("MEDIA_SENSOR_SKEW_INVALID", "maximumSensorSkewMs must be a non-negative integer.");
    }
    const observationId = input.observationId ?? this.idGenerator();
    const existing = this.observations.get(observationId);
    if (existing) {
      const cameraIds = new Set(existing.frames.map((frame) => frame.cameraId));
      if (existing.reference.sceneRevision !== input.sceneRevision
        || existing.maximumSensorSkewMs !== maximumSensorSkewMs
        || cameraIds.size !== 2
        || !cameraIds.has(input.rgbCameraId)
        || !cameraIds.has(input.depthCameraId)) {
        fail("MEDIA_OBSERVATION_ID_COLLISION", `Observation ${observationId} identifies different frames or provenance.`);
      }
      return clone(existing);
    }
    const now = this.now();
    const rgbFrames = this.liveCandidates(this.frames.get(input.rgbCameraId) ?? [], now);
    const depthFrames = this.liveCandidates(this.frames.get(input.depthCameraId) ?? [], now);
    const pair = closestPair(rgbFrames, depthFrames);
    if (!pair) {
      const buffered = (this.frames.get(input.rgbCameraId)?.length ?? 0) + (this.frames.get(input.depthCameraId)?.length ?? 0);
      fail(buffered > 0 ? "MEDIA_FRAME_STALE" : "MEDIA_FRAME_UNAVAILABLE", "Fresh synchronized RGB and depth frames are unavailable.");
    }
    const skew = Math.abs(pair[0].sourceTimestampUnixMs - pair[1].sourceTimestampUnixMs);
    if (skew > maximumSensorSkewMs) fail("MEDIA_SENSOR_SKEW_EXCEEDED", `RGB/depth skew ${skew} ms exceeds ${maximumSensorSkewMs} ms.`);
    const frames = [toReference(pair[0], rgbCamera), toReference(pair[1], depthCamera)];
    const bundle: ImmutableObservationBundle = {
      reference: {
        observationId,
        robotId: this.robotId,
        capturedAtUnixMs: Math.max(...frames.map((frame) => frame.sourceTimestampUnixMs)),
        sceneRevision: input.sceneRevision,
        calibrationVersion: rgbCamera.calibrationVersion,
        frameIds: frames.map((frame) => frame.sensorFrameId),
      },
      frames,
      maximumSensorSkewMs,
    };
    const retainedBytes = pair[0].bytes.byteLength + pair[1].bytes.byteLength;
    if (retainedBytes > this.maximumRetainedObservationBytes) {
      fail("MEDIA_OBSERVATION_SIZE_INVALID", "Synchronized observation exceeds the retained-media budget.");
    }
    this.evictFor(retainedBytes);
    this.observations.set(observationId, bundle);
    this.observationFrames.set(observationId, new Map(pair.map((frame) => [frame.frameId, clone(frame)])));
    this.retainedObservationBytes += retainedBytes;
    return clone(bundle);
  }

  getObservation(observationId: string): ImmutableObservationBundle {
    const observation = this.observations.get(observationId);
    if (!observation) fail("MEDIA_OBSERVATION_NOT_FOUND", `Observation ${observationId} was not found.`);
    return clone(observation);
  }

  observationFrame(observationId: string, frameId: string, token: string): ImmutableObservationFrame {
    const claims = this.verifyAccess(token);
    if (claims.resource !== "IMMUTABLE_OBSERVATION" || !claims.observationIds?.includes(observationId)) {
      fail("MEDIA_ACCESS_DENIED", "Media grant does not include this immutable observation.");
    }
    const observation = this.getObservation(observationId);
    const reference = observation.frames.find((candidate) => candidate.frameId === frameId);
    if (!reference) fail("MEDIA_OBSERVATION_FRAME_NOT_FOUND", `Frame ${frameId} is not part of observation ${observationId}.`);
    if (!claims.cameraIds.includes(reference.cameraId)) {
      fail("MEDIA_ACCESS_DENIED", "Media grant does not include this observation frame.");
    }
    const frame = this.observationFrames.get(observationId)?.get(frameId);
    if (!frame) fail("MEDIA_OBSERVATION_NOT_FOUND", `Observation ${observationId} media is no longer retained.`);
    if (frame.bytes.byteLength !== reference.byteLength
      || createHash("sha256").update(frame.bytes).digest("hex") !== reference.sha256) {
      fail("MEDIA_OBSERVATION_INTEGRITY_INVALID", `Observation ${observationId} frame integrity failed.`);
    }
    return clone({ observationId, reference, bytes: frame.bytes });
  }

  observationPreview(observationId: string, token: string): ImmutableObservationFrame {
    const observation = this.getObservation(observationId);
    const rgb = observation.frames.find((frame) => this.requireCamera(frame.cameraId).kind === "RGB");
    if (!rgb) fail("MEDIA_OBSERVATION_PREVIEW_UNAVAILABLE", `Observation ${observationId} has no RGB preview.`);
    return this.observationFrame(observationId, rgb.frameId, token);
  }

  issueObservationAccess(input: { operatorId: string; observationId: string; lifetimeMs: number }): string {
    const observation = this.getObservation(input.observationId);
    return this.issueAccess({
      operatorId: input.operatorId,
      cameraIds: observation.frames.map((frame) => frame.cameraId),
      observationIds: [input.observationId],
      lifetimeMs: input.lifetimeMs,
    });
  }

  retentionState(): MediaRetentionState {
    return clone({
      observationCount: this.observations.size,
      retainedBytes: this.retainedObservationBytes,
      maximumObservations: this.maximumObservations,
      maximumRetainedObservationBytes: this.maximumRetainedObservationBytes,
    });
  }

  issueAccess(input: { operatorId: string; cameraIds: readonly string[]; observationIds?: readonly string[]; lifetimeMs: number }): string {
    if (!input.operatorId.trim() || input.cameraIds.length === 0) fail("MEDIA_ACCESS_INVALID", "Operator and at least one camera are required.");
    input.cameraIds.forEach((cameraId) => this.requireCamera(cameraId));
    if (input.observationIds !== undefined
      && (input.observationIds.length === 0 || input.observationIds.some((observationId) => !this.observations.has(observationId)))) {
      fail("MEDIA_ACCESS_INVALID", "Observation media grant contains an unavailable observation.");
    }
    if (!Number.isSafeInteger(input.lifetimeMs) || input.lifetimeMs < 1_000 || input.lifetimeMs > 5 * 60_000) {
      fail("MEDIA_ACCESS_LIFETIME_INVALID", "Media access lifetime must be between 1 second and 5 minutes.");
    }
    const issuedAtUnixMs = this.now();
    const claims: MediaAccessClaims = {
      operatorId: input.operatorId,
      robotId: this.robotId,
      cameraIds: [...new Set(input.cameraIds)].sort(),
      resource: input.observationIds === undefined ? "LIVE_CAMERAS" : "IMMUTABLE_OBSERVATION",
      ...(input.observationIds === undefined ? {} : { observationIds: [...new Set(input.observationIds)].sort() }),
      scope: "OBSERVE",
      issuedAtUnixMs,
      expiresAtUnixMs: issuedAtUnixMs + input.lifetimeMs,
      nonce: this.idGenerator(),
    };
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    return `${payload}.${sign(payload, this.signingSecret)}`;
  }

  verifyAccess(token: string): MediaAccessClaims {
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra !== undefined || !secureEqual(signature, sign(payload, this.signingSecret))) {
      fail("MEDIA_ACCESS_INVALID", "Media access grant signature is invalid.");
    }
    let claims: MediaAccessClaims;
    try {
      claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as MediaAccessClaims;
    } catch {
      fail("MEDIA_ACCESS_INVALID", "Media access grant payload is invalid.");
    }
    const resourceValid = claims.resource === "LIVE_CAMERAS"
      ? claims.observationIds === undefined
      : claims.resource === "IMMUTABLE_OBSERVATION"
        && Array.isArray(claims.observationIds)
        && claims.observationIds.length > 0
        && claims.observationIds.every((observationId) => typeof observationId === "string" && this.observations.has(observationId));
    if (claims.robotId !== this.robotId || claims.scope !== "OBSERVE" || !resourceValid || !Array.isArray(claims.cameraIds)
      || !claims.operatorId?.trim() || !claims.nonce?.trim()
      || claims.cameraIds.length === 0 || claims.cameraIds.some((cameraId) => typeof cameraId !== "string" || !this.cameras.has(cameraId))
      || !Number.isSafeInteger(claims.issuedAtUnixMs) || !Number.isSafeInteger(claims.expiresAtUnixMs)
      || claims.expiresAtUnixMs <= claims.issuedAtUnixMs
      || claims.expiresAtUnixMs - claims.issuedAtUnixMs > 5 * 60_000
      || claims.issuedAtUnixMs > this.now() + this.maximumFutureClockSkewMs
      || this.now() >= claims.expiresAtUnixMs) {
      fail("MEDIA_ACCESS_EXPIRED", "Media access grant is expired or has invalid scope.");
    }
    return clone(claims);
  }

  selectQuality(input: { estimatedKilobitsPerSecond: number; packetLossRatio: number; latestFrameAgeMs: number }): "PAUSED_STALE" | "LOW" | "MEDIUM" | "HIGH" {
    if (input.latestFrameAgeMs > this.maximumLiveFrameAgeMs) return "PAUSED_STALE";
    if (input.packetLossRatio > 0.12 || input.estimatedKilobitsPerSecond < 500) return "LOW";
    if (input.packetLossRatio > 0.04 || input.estimatedKilobitsPerSecond < 1_500) return "MEDIUM";
    return "HIGH";
  }

  private requireCamera(cameraId: string): CameraDescriptor {
    const camera = this.cameras.get(cameraId);
    if (!camera) fail("MEDIA_CAMERA_NOT_FOUND", `Camera ${cameraId} is not registered.`);
    return camera;
  }

  private liveCandidates(frames: readonly MediaFrame[], nowUnixMs: number): MediaFrame[] {
    return frames.filter((frame) => {
      const age = nowUnixMs - frame.sourceTimestampUnixMs;
      return age >= -this.maximumFutureClockSkewMs && age <= this.maximumLiveFrameAgeMs;
    });
  }

  private evictFor(incomingBytes: number): void {
    while (this.observations.size >= this.maximumObservations
      || this.retainedObservationBytes + incomingBytes > this.maximumRetainedObservationBytes) {
      const oldestId = this.observations.keys().next().value as string | undefined;
      if (!oldestId) break;
      const retained = this.observationFrames.get(oldestId);
      if (retained) {
        for (const frame of retained.values()) this.retainedObservationBytes -= frame.bytes.byteLength;
      }
      this.observationFrames.delete(oldestId);
      this.observations.delete(oldestId);
    }
  }
}

function closestPair(left: readonly MediaFrame[], right: readonly MediaFrame[]): readonly [MediaFrame, MediaFrame] | undefined {
  let pair: readonly [MediaFrame, MediaFrame] | undefined;
  let best = Number.POSITIVE_INFINITY;
  for (const first of left) {
    for (const second of right) {
      const skew = Math.abs(first.sourceTimestampUnixMs - second.sourceTimestampUnixMs);
      if (skew < best) { best = skew; pair = [first, second]; }
    }
  }
  return pair;
}

function toReference(frame: MediaFrame, camera: CameraDescriptor): ImmutableFrameReference {
  return {
    frameId: frame.frameId,
    cameraId: camera.cameraId,
    sensorFrameId: camera.frameId,
    sequence: frame.sequence,
    sourceTimestampUnixMs: frame.sourceTimestampUnixMs,
    calibrationVersion: camera.calibrationVersion,
    mediaType: frame.mediaType,
    sha256: createHash("sha256").update(frame.bytes).digest("hex"),
    byteLength: frame.bytes.byteLength,
  };
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function secureEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}
