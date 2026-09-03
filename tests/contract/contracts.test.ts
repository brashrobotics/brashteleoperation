import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  CONTRACT_VERSION,
  TeleoperationError,
  assertObjectDeclaration,
  decodeAssistanceRequest,
  decodeGroundedObject,
  decodeManipulationApproval,
  decodeManipulationOutcome,
  decodeManipulationPlanPreview,
  decodeObjectDeclaration,
  decodeRealtimeSignalingMessage,
  decodeRobotSessionReadinessReport,
  decodeTeleopCommandEnvelope,
  type TeleopCommandEnvelope,
  type TeleopSessionLease,
} from "../../packages/contracts/src/index.ts";
import { TeleopCommandValidator } from "../../edge/robot-agent/src/index.ts";
import { RuntimeSceneModel } from "../../packages/scene-model/src/index.ts";

const lease: TeleopSessionLease = {
  contractVersion: CONTRACT_VERSION,
  sessionId: "session-1",
  robotId: "robot-1",
  operatorId: "operator-1",
  scopes: ["CONTROL_BASE"],
  revision: 1,
  issuedAtUnixMs: 1_000,
  expiresAtUnixMs: 10_000,
};

function baseCommand(sequence = 1): TeleopCommandEnvelope {
  return {
    contractVersion: CONTRACT_VERSION,
    commandId: `command-${sequence}`,
    sessionId: lease.sessionId,
    robotId: lease.robotId,
    sourceId: lease.operatorId,
    actuatorGroup: "BASE",
    sequence,
    producedAtUnixMs: 2_000,
    expiresAtUnixMs: 2_250,
    deadman: true,
    intent: {
      kind: "BASE_MOTION",
      frameId: "base_link",
      linearXMetersPerSecond: 0.1,
      linearYMetersPerSecond: 0,
      angularZRadiansPerSecond: 0,
      speedScale: 0.5,
    },
  };
}

test("command validation accepts one fresh command and rejects replay", () => {
  const validator = new TeleopCommandValidator();
  assert.equal(validator.validate(baseCommand(), lease, 2_100, 50).command.commandId, "command-1");
  assert.throws(
    () => validator.validate(baseCommand(), lease, 2_110, 60),
    (error) => error instanceof TeleoperationError && error.code === "COMMAND_SEQUENCE_REPLAY",
  );
});

test("golden JSON fixtures decode and round-trip canonically", async () => {
  const command = JSON.parse(await readFile(new URL("../../packages/contracts/fixtures/teleop-command.v1.json", import.meta.url), "utf8"));
  const armCommand = JSON.parse(await readFile(new URL("../../packages/contracts/fixtures/teleop-arm-command.v1.json", import.meta.url), "utf8"));
  const assistance = JSON.parse(await readFile(new URL("../../packages/contracts/fixtures/assistance-request.v1.json", import.meta.url), "utf8"));
  const declaration = JSON.parse(await readFile(new URL("../../packages/contracts/fixtures/object-declaration.v1.json", import.meta.url), "utf8"));
  const object = JSON.parse(await readFile(new URL("../../packages/contracts/fixtures/grounded-object.v1.json", import.meta.url), "utf8"));
  const plan = JSON.parse(await readFile(new URL("../../packages/contracts/fixtures/manipulation-plan.v1.json", import.meta.url), "utf8"));
  const approval = JSON.parse(await readFile(new URL("../../packages/contracts/fixtures/manipulation-approval.v1.json", import.meta.url), "utf8"));
  const outcome = JSON.parse(await readFile(new URL("../../packages/contracts/fixtures/manipulation-outcome.v1.json", import.meta.url), "utf8"));
  const signalingOffer = JSON.parse(await readFile(new URL("../../packages/contracts/fixtures/realtime-signaling-offer.v1.json", import.meta.url), "utf8"));
  const robotReadiness = JSON.parse(await readFile(new URL("../../packages/contracts/fixtures/robot-session-readiness.v1.json", import.meta.url), "utf8"));
  assert.deepEqual(jsonValue(decodeTeleopCommandEnvelope(command)), command);
  assert.deepEqual(jsonValue(decodeTeleopCommandEnvelope(armCommand)), armCommand);
  assert.deepEqual(jsonValue(decodeAssistanceRequest(assistance)), assistance);
  assert.deepEqual(jsonValue(decodeObjectDeclaration(declaration)), declaration);
  assert.deepEqual(jsonValue(decodeGroundedObject(object)), object);
  assert.deepEqual(jsonValue(decodeManipulationPlanPreview(plan)), plan);
  assert.deepEqual(jsonValue(decodeManipulationApproval(approval)), approval);
  assert.deepEqual(jsonValue(decodeManipulationOutcome(outcome)), outcome);
  assert.deepEqual(jsonValue(decodeRealtimeSignalingMessage(signalingOffer)), signalingOffer);
  assert.deepEqual(jsonValue(decodeRobotSessionReadinessReport(robotReadiness)), robotReadiness);
});

function jsonValue(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

test("object declaration rejects an empty box", () => {
  assert.throws(
    () => assertObjectDeclaration({
      contractVersion: CONTRACT_VERSION,
      declarationId: "declaration-1",
      requestId: "request-1",
      observationId: "observation-1",
      revision: 1,
      declaredBy: "operator-1",
      declaredAtUnixMs: 1_000,
      selection: { kind: "BOX", frameId: "camera", x: 0, y: 0, width: 0, height: 20 },
      manipulationIntent: "PICK",
      persistenceScope: "ATTEMPT_ONLY",
    }),
    (error) => error instanceof TeleoperationError && error.code === "OBJECT_SELECTION_INVALID",
  );
});

test("scene model binds grounded objects to immutable scene revisions", () => {
  const scene = new RuntimeSceneModel();
  scene.registerObservation({
    observationId: "observation-1",
    robotId: "robot-1",
    capturedAtUnixMs: 1_000,
    sceneRevision: "scene-1",
    calibrationVersion: "calibration-1",
    frameIds: ["camera"],
  });
  assert.throws(
    () => scene.publishGroundedObject({
      contractVersion: CONTRACT_VERSION,
      objectId: "object-1",
      requestId: "request-1",
      declarationId: "declaration-1",
      declarationRevision: 1,
      observationId: "observation-1",
      robotId: "robot-1",
      sceneRevision: "scene-2",
      revision: 1,
      status: "GROUNDED",
      pose: { frameId: "base_link", positionMeters: [1, 0, 0], orientationXyzw: [0, 0, 0, 1] },
      dimensionsMeters: [0.1, 0.1, 0.1],
      positionStdDevMeters: [0.01, 0.01, 0.01],
      groundedAtUnixMs: 1_100,
      validUntilUnixMs: 2_000,
      algorithm: { name: "test", version: "1" },
    }),
    (error) => error instanceof TeleoperationError && error.code === "SCENE_REVISION_MISMATCH",
  );
});
