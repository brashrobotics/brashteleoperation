import assert from "node:assert/strict";
import test from "node:test";
import { startControlPlaneApi } from "../../apps/control-plane-api/src/server.ts";
import { CONTRACT_VERSION } from "../../packages/contracts/src/index.ts";
import { StaticBearerIdentityProvider } from "../../packages/identity/src/index.ts";
import type { DepthObservation } from "../../robot/interactive-perception/src/index.ts";
import type { AssistanceSnapshot } from "../../services/assistance-orchestrator/src/index.ts";
import {
  HttpRobotAssistancePort,
  RobotAssistanceWorker,
  SimulationAssistanceBackend,
} from "../../workers/simulation-assistance/src/index.ts";

const operatorToken = "simulation-worker-operator-token";
const robotToken = "simulation-worker-robot-token";

test("robot worker completes declared-object simulation only after exact operator approval", async (context) => {
  const api = await startControlPlaneApi({
    identityProvider: new StaticBearerIdentityProvider([
      { token: operatorToken, principal: { subject: "oidc:operator-1", operatorId: "operator-1", roles: ["ADMIN"] } },
      { token: robotToken, principal: { subject: "spiffe:robot-1", operatorId: "edge-service", robotId: "robot-1", roles: ["ROBOT"] } },
    ]),
    allowUncoordinatedCommandLeases: true,
  });
  context.after(() => api.close());

  const now = Date.now();
  const reference = {
    observationId: "worker-observation-1",
    robotId: "robot-1",
    capturedAtUnixMs: now,
    sceneRevision: "worker-scene-1",
    calibrationVersion: "worker-calibration-1",
    frameIds: ["camera_color", "camera_depth"],
  };
  let response = await post(api.url, robotToken, "/assistance/v1/requests", {
    contractVersion: CONTRACT_VERSION,
    requestId: "worker-request-1",
    robotId: "robot-1",
    taskId: "worker-task-1",
    reason: "OBJECT_NOT_RECOGNIZED",
    requestedInput: "SELECT_TARGET",
    observations: [reference],
    createdAtUnixMs: now,
    expiresAtUnixMs: now + 60_000,
  });
  assert.equal(response.status, 201);
  let snapshot = response.body.assistance as AssistanceSnapshot;

  response = await post(api.url, operatorToken, "/assistance/v1/requests/worker-request-1/assign", {
    expectedRevision: snapshot.revision,
    operatorId: "operator-1",
  });
  snapshot = response.body.assistance as AssistanceSnapshot;
  response = await post(api.url, operatorToken, "/assistance/v1/requests/worker-request-1/declarations", {
    expectedRevision: snapshot.revision,
    declaration: {
      contractVersion: CONTRACT_VERSION,
      declarationId: "worker-declaration-1",
      requestId: "worker-request-1",
      observationId: reference.observationId,
      revision: 1,
      declaredBy: "operator-1",
      declaredAtUnixMs: now + 1,
      selection: { kind: "BOX", frameId: "camera_color", x: 4, y: 4, width: 12, height: 12 },
      semanticLabel: "blue simulation tote",
      manipulationIntent: "PICK",
      persistenceScope: "ATTEMPT_ONLY",
    },
  });
  snapshot = response.body.assistance as AssistanceSnapshot;
  assert.equal(snapshot.status, "GROUNDING");

  const depthObservation: DepthObservation = {
    reference,
    imageFrameId: "camera_color",
    poseFrameId: "base_link",
    intrinsics: { width: 24, height: 24, fx: 120, fy: 120, cx: 12, cy: 12 },
    depthMeters: Array.from({ length: 24 * 24 }, () => 0.4),
    cameraOriginInPoseFrameMeters: [0.1, 0, 0],
  };
  let generatedId = 0;
  const worker = new RobotAssistanceWorker({
    requestId: "worker-request-1",
    port: new HttpRobotAssistancePort({ controlPlaneUrl: api.url, bearerToken: robotToken }),
    backend: new SimulationAssistanceBackend({
      robotId: "robot-1",
      observations: new Map([[reference.observationId, depthObservation]]),
      idGenerator: () => `worker-generated-${++generatedId}`,
    }),
    automaticStart: false,
  });
  context.after(() => worker.close());

  snapshot = await worker.runOnce();
  assert.equal(snapshot.status, "PLAN_PENDING");
  assert.equal(snapshot.groundedObject?.observationId, reference.observationId);
  snapshot = await worker.runOnce();
  assert.equal(snapshot.status, "APPROVAL_PENDING");
  assert.deepEqual(snapshot.plan?.phases, ["approach", "grasp", "lift", "verify"]);

  const waiting = await worker.runOnce();
  assert.equal(waiting.revision, snapshot.revision);
  assert.equal(waiting.status, "APPROVAL_PENDING");
  assert.equal(worker.snapshot().successfulTransitions, 2);

  response = await post(api.url, operatorToken, "/assistance/v1/requests/worker-request-1/approvals", {
    expectedRevision: snapshot.revision,
    approval: {
      contractVersion: CONTRACT_VERSION,
      approvalId: "worker-approval-1",
      requestId: snapshot.request.requestId,
      planId: snapshot.plan!.planId,
      planRevision: snapshot.plan!.planRevision,
      objectRevision: snapshot.groundedObject!.revision,
      sceneRevision: snapshot.plan!.sceneRevision,
      approvedBy: "operator-1",
      approvedAtUnixMs: now + 2,
    },
  });
  assert.equal((response.body.assistance as AssistanceSnapshot).status, "EXECUTING");

  snapshot = await worker.runOnce();
  assert.equal(snapshot.status, "VERIFYING");
  assert.equal(snapshot.outcome?.success, true);
  assert.ok(snapshot.outcome?.verification.includes("simulated-gripper-closed"));
  snapshot = await worker.runOnce();
  assert.equal(snapshot.status, "RESOLVED");
  assert.match(snapshot.reason ?? "", /Simulation verified/);
  assert.equal(worker.snapshot().terminal, true);
  assert.equal(worker.snapshot().successfulTransitions, 4);
});

async function post(baseUrl: string, token: string, path: string, body: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}
