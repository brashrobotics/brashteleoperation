import { randomUUID } from "node:crypto";
import {
  CONTRACT_VERSION,
  assertObjectDeclaration,
  assertObservationBundle,
  fail,
  type GroundedObject,
  type ObjectDeclaration,
  type ObservationBundleReference,
  type RequestedHumanInput,
} from "../../../packages/contracts/src/index.ts";
import { RuntimeSceneModel } from "../../../packages/scene-model/src/index.ts";

export interface CameraIntrinsics {
  width: number;
  height: number;
  fx: number;
  fy: number;
  cx: number;
  cy: number;
}

export interface DepthObservation {
  reference: ObservationBundleReference;
  imageFrameId: string;
  poseFrameId: string;
  intrinsics: CameraIntrinsics;
  depthMeters: readonly number[];
  cameraOriginInPoseFrameMeters: readonly [number, number, number];
}

export type GroundingResult =
  | { status: "GROUNDED"; object: GroundedObject }
  | { status: "NEEDS_INPUT"; code: string; message: string; requestedInput: RequestedHumanInput };

export interface InteractiveGrounderOptions {
  scene: RuntimeSceneModel;
  now?: () => number;
  idGenerator?: () => string;
  validityMs?: number;
  maximumPositionStdDevMeters?: number;
  algorithmName?: string;
  algorithmVersion?: string;
}

export class InteractiveGrounder {
  private readonly scene: RuntimeSceneModel;
  private readonly now: () => number;
  private readonly idGenerator: () => string;
  private readonly validityMs: number;
  private readonly maximumPositionStdDevMeters: number;
  private readonly algorithmName: string;
  private readonly algorithmVersion: string;

  constructor(options: InteractiveGrounderOptions) {
    this.scene = options.scene;
    this.now = options.now ?? Date.now;
    this.idGenerator = options.idGenerator ?? randomUUID;
    this.validityMs = options.validityMs ?? 2_000;
    this.maximumPositionStdDevMeters = options.maximumPositionStdDevMeters ?? 0.08;
    this.algorithmName = options.algorithmName ?? "brash-deterministic-rgbd-grounder";
    this.algorithmVersion = options.algorithmVersion ?? "0.1.0";
  }

  ground(
    declaration: ObjectDeclaration,
    observation: DepthObservation,
    masks: Readonly<Record<string, readonly number[]>> = {},
  ): GroundingResult {
    return this.compute(declaration, observation, masks, undefined);
  }

  track(
    existing: GroundedObject,
    declaration: ObjectDeclaration,
    observation: DepthObservation,
    masks: Readonly<Record<string, readonly number[]>> = {},
  ): GroundingResult {
    if (observation.reference.calibrationVersion !== this.observationCalibration(existing.observationId)) {
      this.scene.invalidateObject(existing.objectId, "INVALIDATED", this.now());
      return needsInput("GROUNDING_CALIBRATION_CHANGED", "Calibration changed during tracking.", "SELECT_TARGET");
    }
    return this.compute(declaration, observation, masks, existing);
  }

  private compute(
    declaration: ObjectDeclaration,
    observation: DepthObservation,
    masks: Readonly<Record<string, readonly number[]>>,
    existing: GroundedObject | undefined,
  ): GroundingResult {
    assertObjectDeclaration(declaration);
    validateObservation(observation);
    if (declaration.observationId !== observation.reference.observationId && !existing) {
      fail("GROUNDING_OBSERVATION_MISMATCH", "Declaration and depth observation IDs do not match.");
    }
    if (declaration.selection.frameId !== observation.imageFrameId
      || !observation.reference.frameIds.includes(observation.imageFrameId)) {
      return needsInput("GROUNDING_FRAME_MISMATCH", "Selection frame is unavailable in the referenced observation.", "SELECT_TARGET");
    }
    const pixels = selectedPixels(declaration, observation.intrinsics, masks);
    if (pixels.length === 0) return needsInput("GROUNDING_SELECTION_EMPTY", "Selection does not contain usable pixels.", "SELECT_TARGET");
    const points: Array<readonly [number, number, number]> = [];
    for (const index of pixels) {
      const depth = observation.depthMeters[index];
      if (!Number.isFinite(depth) || depth <= 0) continue;
      const u = index % observation.intrinsics.width;
      const v = Math.floor(index / observation.intrinsics.width);
      points.push(project(u, v, depth, observation));
    }
    if (points.length < Math.min(3, pixels.length)) {
      return needsInput("GROUNDING_DEPTH_MISSING", "Selection has insufficient valid depth samples.", "SELECT_TARGET");
    }
    const xs = points.map((point) => point[0]);
    const ys = points.map((point) => point[1]);
    const zs = points.map((point) => point[2]);
    const center: readonly [number, number, number] = [median(xs), median(ys), median(zs)];
    const dimensions: readonly [number, number, number] = [extent(xs), extent(ys), extent(zs)];
    const uncertainty: readonly [number, number, number] = [stddev(xs), stddev(ys), stddev(zs)];
    if (uncertainty.some((value) => value > this.maximumPositionStdDevMeters)) {
      return needsInput("GROUNDING_UNCERTAINTY_HIGH", "Depth geometry is too uncertain for autonomous manipulation.", "SELECT_TARGET");
    }
    this.scene.registerObservation(observation.reference);
    const groundedAtUnixMs = this.now();
    const object: GroundedObject = {
      contractVersion: CONTRACT_VERSION,
      objectId: existing?.objectId ?? this.idGenerator(),
      requestId: declaration.requestId,
      declarationId: declaration.declarationId,
      declarationRevision: declaration.revision,
      observationId: observation.reference.observationId,
      robotId: observation.reference.robotId,
      sceneRevision: observation.reference.sceneRevision,
      revision: existing ? existing.revision + 1 : 1,
      status: existing ? "TRACKED" : "GROUNDED",
      pose: { frameId: observation.poseFrameId, positionMeters: center, orientationXyzw: [0, 0, 0, 1] },
      dimensionsMeters: dimensions,
      positionStdDevMeters: uncertainty,
      groundedAtUnixMs,
      validUntilUnixMs: groundedAtUnixMs + this.validityMs,
      algorithm: { name: this.algorithmName, version: this.algorithmVersion },
    };
    return { status: "GROUNDED", object: this.scene.publishGroundedObject(object) };
  }

  private observationCalibration(observationId: string): string {
    return this.scene.getObservation(observationId).calibrationVersion;
  }
}

function validateObservation(observation: DepthObservation): void {
  assertObservationBundle(observation.reference);
  if (!observation.imageFrameId.trim() || !observation.poseFrameId.trim()) fail("GROUNDING_FRAME_REQUIRED", "Image and pose frames are required.");
  const intrinsics = observation.intrinsics;
  if (!Number.isSafeInteger(intrinsics.width) || !Number.isSafeInteger(intrinsics.height)
    || intrinsics.width < 1 || intrinsics.height < 1
    || !Number.isFinite(intrinsics.fx) || !Number.isFinite(intrinsics.fy) || intrinsics.fx <= 0 || intrinsics.fy <= 0
    || !Number.isFinite(intrinsics.cx) || !Number.isFinite(intrinsics.cy)) {
    fail("GROUNDING_INTRINSICS_INVALID", "Camera intrinsics are invalid.");
  }
  if (observation.depthMeters.length !== intrinsics.width * intrinsics.height) {
    fail("GROUNDING_DEPTH_SHAPE_INVALID", "Depth array size does not match camera intrinsics.");
  }
  if (observation.cameraOriginInPoseFrameMeters.some((value) => !Number.isFinite(value))) {
    fail("GROUNDING_EXTRINSICS_INVALID", "Camera origin contains non-finite values.");
  }
}

function selectedPixels(
  declaration: ObjectDeclaration,
  intrinsics: CameraIntrinsics,
  masks: Readonly<Record<string, readonly number[]>>,
): number[] {
  const selection = declaration.selection;
  if (selection.kind === "MASK") {
    return uniqueValidIndices(masks[selection.maskArtifactId] ?? [], intrinsics.width * intrinsics.height);
  }
  if (selection.kind === "POINT") {
    const centerX = Math.round(selection.x);
    const centerY = Math.round(selection.y);
    const indices: number[] = [];
    for (let y = centerY - 1; y <= centerY + 1; y += 1) {
      for (let x = centerX - 1; x <= centerX + 1; x += 1) {
        if (x >= 0 && x < intrinsics.width && y >= 0 && y < intrinsics.height) indices.push(y * intrinsics.width + x);
      }
    }
    return indices;
  }
  const left = Math.max(0, Math.floor(selection.x));
  const top = Math.max(0, Math.floor(selection.y));
  const right = Math.min(intrinsics.width, Math.ceil(selection.x + selection.width));
  const bottom = Math.min(intrinsics.height, Math.ceil(selection.y + selection.height));
  const indices: number[] = [];
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) indices.push(y * intrinsics.width + x);
  }
  return indices;
}

function uniqueValidIndices(indices: readonly number[], length: number): number[] {
  return [...new Set(indices.filter((index) => Number.isSafeInteger(index) && index >= 0 && index < length))];
}

function project(u: number, v: number, depth: number, observation: DepthObservation): readonly [number, number, number] {
  const { fx, fy, cx, cy } = observation.intrinsics;
  const [tx, ty, tz] = observation.cameraOriginInPoseFrameMeters;
  return [tx + ((u - cx) * depth) / fx, ty + ((v - cy) * depth) / fy, tz + depth];
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function extent(values: readonly number[]): number {
  return Math.max(0.005, Math.max(...values) - Math.min(...values));
}

function stddev(values: readonly number[]): number {
  const average = values.reduce((total, value) => total + value, 0) / values.length;
  const variance = values.reduce((total, value) => total + ((value - average) ** 2), 0) / values.length;
  return Math.sqrt(variance);
}

function needsInput(code: string, message: string, requestedInput: RequestedHumanInput): GroundingResult {
  return { status: "NEEDS_INPUT", code, message, requestedInput };
}
