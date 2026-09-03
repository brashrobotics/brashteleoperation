import assert from "node:assert/strict";
import test from "node:test";
import { TeleoperationError } from "../../packages/contracts/src/index.ts";
import { createSimulationObservationPng, MediaGateway } from "../../edge/media-gateway/src/index.ts";

test("simulation observation fixture is a bounded RGB PNG", () => {
  const image = createSimulationObservationPng(96, 64);
  assert.deepEqual([...image.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.ok(image.byteLength > 100);
  assert.ok(image.byteLength < 96 * 64 * 3);
  assert.throws(() => createSimulationObservationPng(8, 8), /dimensions/);
});

test("media gateway freezes synchronized frames and drops stale or reordered input", () => {
  let now = 1_000;
  let id = 0;
  const gateway = new MediaGateway({
    robotId: "robot-1",
    signingSecret: "test-media-signing-secret-at-least-32-bytes",
    now: () => now,
    idGenerator: () => `id-${++id}`,
    maximumLiveFrameAgeMs: 100,
  });
  gateway.registerCamera({ cameraId: "rgb", robotId: "robot-1", frameId: "camera_color", calibrationVersion: "cal-1", kind: "RGB" });
  gateway.registerCamera({ cameraId: "depth", robotId: "robot-1", frameId: "camera_depth", calibrationVersion: "cal-1", kind: "DEPTH" });
  assert.equal(gateway.ingest(frame("rgb-1", "rgb", 1, 980, "image/jpeg")).accepted, true);
  assert.equal(gateway.ingest(frame("depth-1", "depth", 1, 985, "application/x-point-cloud")).accepted, true);
  assert.equal(gateway.ingest(frame("rgb-replay", "rgb", 1, 990, "image/jpeg")).reason, "MEDIA_FRAME_REORDERED");
  const observation = gateway.createObservation({ rgbCameraId: "rgb", depthCameraId: "depth", sceneRevision: "scene-1", observationId: "observation-1" });
  assert.equal(observation.reference.observationId, "observation-1");
  assert.equal(observation.maximumSensorSkewMs, 40);
  assert.equal(observation.frames.length, 2);
  assert.equal(observation.frames[0]?.sha256.length, 64);

  const token = gateway.issueAccess({ operatorId: "operator-1", cameraIds: ["rgb"], lifetimeMs: 1_000 });
  assert.equal(gateway.liveFrame("rgb", token).frameId, "rgb-1");
  assert.throws(
    () => gateway.observationPreview("observation-1", token),
    (error) => error instanceof TeleoperationError && error.code === "MEDIA_ACCESS_DENIED",
  );
  const observationToken = gateway.issueObservationAccess({ operatorId: "operator-1", observationId: "observation-1", lifetimeMs: 1_000 });
  const preview = gateway.observationPreview("observation-1", observationToken);
  assert.equal(preview.reference.frameId, "rgb-1");
  assert.deepEqual(preview.bytes, new Uint8Array([1, 2, 3]));
  assert.equal(gateway.retentionState().retainedBytes, 6);
  assert.throws(
    () => gateway.liveFrame("depth", token),
    (error) => error instanceof TeleoperationError && error.code === "MEDIA_ACCESS_DENIED",
  );
  assert.equal(gateway.selectQuality({ estimatedKilobitsPerSecond: 10_000, packetLossRatio: 0, latestFrameAgeMs: 101 }), "PAUSED_STALE");
  now = 2_001;
  assert.throws(
    () => gateway.verifyAccess(token),
    (error) => error instanceof TeleoperationError && error.code === "MEDIA_ACCESS_EXPIRED",
  );
  assert.equal(gateway.ingest(frame("rgb-stale", "rgb", 2, 1_800, "image/jpeg")).reason, "MEDIA_FRAME_STALE");
});

test("immutable observation media is scope checked, integrity bound, and memory bounded", () => {
  let now = 8_000;
  const gateway = new MediaGateway({
    robotId: "robot-1",
    signingSecret: "bounded-media-signing-secret-32-bytes",
    now: () => now,
    maximumObservations: 1,
    maximumRetainedObservationBytes: 8,
  });
  gateway.registerCamera({ cameraId: "rgb", robotId: "robot-1", frameId: "rgb_frame", calibrationVersion: "cal-1", kind: "RGB" });
  gateway.registerCamera({ cameraId: "depth", robotId: "robot-1", frameId: "depth_frame", calibrationVersion: "cal-1", kind: "DEPTH" });
  gateway.ingest(frame("rgb-1", "rgb", 1, now, "image/jpeg"));
  gateway.ingest(frame("depth-1", "depth", 1, now, "application/x-point-cloud"));
  gateway.createObservation({ rgbCameraId: "rgb", depthCameraId: "depth", sceneRevision: "scene-1", observationId: "observation-1" });

  const rgbOnly = gateway.issueAccess({ operatorId: "operator-1", cameraIds: ["rgb"], lifetimeMs: 1_000 });
  assert.throws(
    () => gateway.observationPreview("observation-1", rgbOnly),
    (error) => error instanceof TeleoperationError && error.code === "MEDIA_ACCESS_DENIED",
  );
  const observationGrant = gateway.issueObservationAccess({ operatorId: "operator-1", observationId: "observation-1", lifetimeMs: 1_000 });
  assert.equal(gateway.verifyAccess(observationGrant).cameraIds.length, 2);
  assert.deepEqual(gateway.verifyAccess(observationGrant).observationIds, ["observation-1"]);
  assert.equal(gateway.observationPreview("observation-1", observationGrant).reference.cameraId, "rgb");
  assert.throws(
    () => gateway.liveFrame("rgb", observationGrant),
    (error) => error instanceof TeleoperationError && error.code === "MEDIA_ACCESS_DENIED",
  );

  now += 10;
  gateway.ingest(frame("rgb-2", "rgb", 2, now, "image/jpeg"));
  gateway.ingest(frame("depth-2", "depth", 2, now, "application/x-point-cloud"));
  gateway.createObservation({ rgbCameraId: "rgb", depthCameraId: "depth", sceneRevision: "scene-2", observationId: "observation-2" });
  assert.equal(gateway.retentionState().observationCount, 1);
  assert.equal(gateway.retentionState().retainedBytes, 6);
  assert.throws(
    () => gateway.getObservation("observation-1"),
    (error) => error instanceof TeleoperationError && error.code === "MEDIA_OBSERVATION_NOT_FOUND",
  );
});

test("observation creation rejects stale frames, future skew, and ID collisions", () => {
  let now = 5_000;
  const gateway = new MediaGateway({ robotId: "robot-1", signingSecret: "z".repeat(32), now: () => now });
  gateway.registerCamera({ cameraId: "rgb", robotId: "robot-1", frameId: "rgb_frame", calibrationVersion: "cal-1", kind: "RGB" });
  gateway.registerCamera({ cameraId: "depth", robotId: "robot-1", frameId: "depth_frame", calibrationVersion: "cal-1", kind: "DEPTH" });
  assert.equal(gateway.ingest(frame("future", "rgb", 1, now + 101, "image/jpeg")).reason, "MEDIA_FRAME_CLOCK_SKEW");
  gateway.ingest(frame("rgb-1", "rgb", 2, now, "image/jpeg"));
  gateway.ingest(frame("depth-1", "depth", 1, now, "application/x-point-cloud"));
  gateway.createObservation({ rgbCameraId: "rgb", depthCameraId: "depth", sceneRevision: "scene-1", observationId: "observation-fixed" });
  now += 600;
  assert.equal(
    gateway.createObservation({ rgbCameraId: "rgb", depthCameraId: "depth", sceneRevision: "scene-1", observationId: "observation-fixed" }).reference.observationId,
    "observation-fixed",
  );
  assert.throws(
    () => gateway.createObservation({ rgbCameraId: "rgb", depthCameraId: "depth", sceneRevision: "scene-2" }),
    (error) => error instanceof TeleoperationError && error.code === "MEDIA_FRAME_STALE",
  );
  gateway.ingest(frame("rgb-2", "rgb", 3, now, "image/jpeg"));
  gateway.ingest(frame("depth-2", "depth", 2, now, "application/x-point-cloud"));
  assert.throws(
    () => gateway.createObservation({ rgbCameraId: "rgb", depthCameraId: "depth", sceneRevision: "scene-2", observationId: "observation-fixed" }),
    (error) => error instanceof TeleoperationError && error.code === "MEDIA_OBSERVATION_ID_COLLISION",
  );
});

function frame(frameId: string, cameraId: string, sequence: number, sourceTimestampUnixMs: number, mediaType: string) {
  return {
    frameId,
    cameraId,
    robotId: "robot-1",
    sequence,
    sourceTimestampUnixMs,
    receivedAtUnixMs: sourceTimestampUnixMs + 5,
    mediaType,
    bytes: new Uint8Array([sequence, 2, 3]),
  };
}
