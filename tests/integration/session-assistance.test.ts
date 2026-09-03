import assert from "node:assert/strict";
import test from "node:test";
import { CONTRACT_VERSION, TeleoperationError } from "../../packages/contracts/src/index.ts";
import { InMemorySessionControl } from "../../services/session-control/src/index.ts";
import { InMemoryAssistanceOrchestrator } from "../../services/assistance-orchestrator/src/index.ts";

test("only one commanding session can be granted for a robot", () => {
  let now = 1_000;
  const sessions = new InMemorySessionControl({ now: () => now, idGenerator: (() => { let id = 0; return () => `id-${++id}`; })() });
  let first = sessions.requestSession({ sessionId: "first", robotId: "robot-1", operatorId: "operator-1", scopes: ["CONTROL_BASE"] });
  first = sessions.grantSession(first.sessionId, first.revision, 2_000);
  const second = sessions.requestSession({ sessionId: "second", robotId: "robot-1", operatorId: "operator-2", scopes: ["CONTROL_MANIPULATOR"] });
  assert.throws(
    () => sessions.grantSession(second.sessionId, second.revision, 2_000),
    (error) => error instanceof TeleoperationError && error.code === "SESSION_COMMAND_CONFLICT",
  );

  now = 3_001;
  sessions.expireDue();
  const granted = sessions.grantSession(second.sessionId, second.revision, 2_000);
  assert.equal(granted.status, "GRANTED");
  assert.equal(sessions.getSession(first.sessionId).status, "EXPIRED");
});

test("assistance approval is bound to the exact plan revision", () => {
  const now = 10_000;
  const orchestrator = new InMemoryAssistanceOrchestrator({ now: () => now, idGenerator: (() => { let id = 0; return () => `event-${++id}`; })() });
  const observation = {
    observationId: "observation-1",
    robotId: "robot-1",
    capturedAtUnixMs: now,
    sceneRevision: "scene-1",
    calibrationVersion: "calibration-1",
    frameIds: ["camera"],
  };
  let workflow = orchestrator.open({
    contractVersion: CONTRACT_VERSION,
    requestId: "request-1",
    robotId: "robot-1",
    taskId: "task-1",
    reason: "OBJECT_NOT_RECOGNIZED",
    requestedInput: "SELECT_TARGET",
    observations: [observation],
    createdAtUnixMs: now,
    expiresAtUnixMs: now + 10_000,
  });
  workflow = orchestrator.assign("request-1", workflow.revision, "operator-1");
  workflow = orchestrator.submitDeclaration("request-1", workflow.revision, {
    contractVersion: CONTRACT_VERSION,
    declarationId: "declaration-1",
    requestId: "request-1",
    observationId: "observation-1",
    revision: 1,
    declaredBy: "operator-1",
    declaredAtUnixMs: now + 1,
    selection: { kind: "POINT", frameId: "camera", x: 10, y: 20 },
    manipulationIntent: "PICK",
    persistenceScope: "ATTEMPT_ONLY",
  });
  workflow = orchestrator.requestDeclarationCorrection("request-1", workflow.revision, "Depth was missing at the first point.");
  assert.throws(
    () => orchestrator.submitDeclaration("request-1", workflow.revision, {
      ...workflow.declaration!, declarationId: "replacement-id", revision: 2, selection: { kind: "POINT", frameId: "camera", x: 11, y: 21 },
    }),
    (error) => error instanceof TeleoperationError && error.code === "DECLARATION_REVISION_MISMATCH",
  );
  workflow = orchestrator.submitDeclaration("request-1", workflow.revision, {
    ...workflow.declaration!, revision: 2, selection: { kind: "POINT", frameId: "camera", x: 11, y: 21 },
  });
  workflow = orchestrator.recordGrounding("request-1", workflow.revision, {
    contractVersion: CONTRACT_VERSION,
    objectId: "object-1",
    requestId: "request-1",
    declarationId: "declaration-1",
    declarationRevision: 2,
    observationId: "observation-1",
    robotId: "robot-1",
    sceneRevision: "scene-1",
    revision: 1,
    status: "TRACKED",
    pose: { frameId: "base_link", positionMeters: [1, 0, 0], orientationXyzw: [0, 0, 0, 1] },
    dimensionsMeters: [0.1, 0.1, 0.1],
    positionStdDevMeters: [0.01, 0.01, 0.01],
    groundedAtUnixMs: now + 2,
    validUntilUnixMs: now + 5_000,
    algorithm: { name: "test-grounder", version: "1" },
  });
  workflow = orchestrator.recordPlan("request-1", workflow.revision, {
    contractVersion: CONTRACT_VERSION,
    planId: "plan-1",
    requestId: "request-1",
    robotId: "robot-1",
    objectId: "object-1",
    objectRevision: 1,
    sceneRevision: "scene-1",
    planRevision: 2,
    generatedAtUnixMs: now + 3,
    approvalRequired: true,
    phases: ["approach", "grasp"],
    expectedOutcome: "object grasped",
  });
  assert.throws(
    () => orchestrator.approve("request-1", workflow.revision, {
      contractVersion: CONTRACT_VERSION,
      approvalId: "approval-stale",
      requestId: "request-1",
      planId: "plan-1",
      planRevision: 1,
      objectRevision: 1,
      sceneRevision: "scene-1",
      approvedBy: "operator-1",
      approvedAtUnixMs: now + 4,
    }),
    (error) => error instanceof TeleoperationError && error.code === "APPROVAL_REVISION_MISMATCH",
  );
});
