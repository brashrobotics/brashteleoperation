import assert from "node:assert/strict";
import test from "node:test";
import { startControlPlaneApi } from "../../apps/control-plane-api/src/server.ts";
import { LocalRobotAgent } from "../../edge/robot-agent/src/index.ts";
import { StaticBearerIdentityProvider } from "../../packages/identity/src/index.ts";
import { InMemoryRobotReadiness, InMemorySessionControl } from "../../services/session-control/src/index.ts";

const operatorToken = "readiness-operator-token-long";
const robotToken = "readiness-robot-token-long";
const wrongRobotToken = "readiness-wrong-robot-token-long";

test("operator claims cannot replace authenticated robot ownership and cleared-state reports", async (context) => {
  let now = 10_000;
  const sessions = new InMemorySessionControl({ now: () => now });
  const readiness = new InMemoryRobotReadiness({ now: () => now });
  const agent = new LocalRobotAgent({
    robotId: "robot-1",
    nowUnixMs: () => now,
    nowMonotonicMs: () => now,
    baseSafetyProfile: {
      robotId: "robot-1",
      commandTimeoutMs: 250,
      maximumLinearXMetersPerSecond: 0.5,
      maximumLinearYMetersPerSecond: 0.3,
      maximumAngularZRadiansPerSecond: 0.5,
      maximumLinearAccelerationMetersPerSecondSquared: 0.5,
      maximumAngularAccelerationRadiansPerSecondSquared: 0.5,
    },
  });
  const api = await startControlPlaneApi({
    identityProvider: new StaticBearerIdentityProvider([
      { token: operatorToken, principal: { subject: "oidc:operator-1", operatorId: "operator-1", roles: ["ADMIN"] } },
      { token: robotToken, principal: { subject: "spiffe:robot-1", operatorId: "edge-service", robotId: "robot-1", roles: ["ROBOT"] } },
      { token: wrongRobotToken, principal: { subject: "spiffe:robot-2", operatorId: "edge-service", robotId: "robot-2", roles: ["ROBOT"] } },
    ]),
    sessions,
    robotReadiness: readiness,
    allowUncoordinatedCommandLeases: true,
  });
  context.after(() => api.close());

  let response = await post(api.url, operatorToken, "/control/v1/sessions", {
    sessionId: "session-1",
    robotId: "robot-1",
    operatorId: "operator-1",
    scopes: ["CONTROL_BASE"],
  });
  let session = response.body.session as SessionView;
  response = await post(api.url, operatorToken, "/control/v1/sessions/session-1/grant", {
    expectedRevision: session.revision,
    leaseDurationMs: 5_000,
  });
  session = response.body.session as SessionView;
  agent.installLease(session.lease!);
  response = await post(api.url, operatorToken, "/control/v1/sessions/session-1/connecting", {
    expectedRevision: session.revision,
  });
  session = response.body.session as SessionView;
  let edge = agent.requestOwnership("session-1", "BASE");
  edge = agent.acknowledgeStopped(edge.ownership.revision, {
    observedAtUnixMs: now,
    controllerStateFresh: true,
    baseStopped: true,
    manipulatorHolding: true,
  });
  const ownedReport = agent.createReadinessReport("session-1", "readiness-owned");

  response = await post(api.url, operatorToken, "/control/v1/sessions/session-1/activate", {
    expectedRevision: session.revision,
    robotOwnershipGranted: true,
  });
  assert.equal(response.status, 404);
  assert.equal(response.body.code, "ROBOT_READINESS_NOT_FOUND");

  response = await post(api.url, operatorToken, "/control/v1/sessions/session-1/robot-readiness", { report: ownedReport });
  assert.equal(response.status, 403);
  response = await post(api.url, wrongRobotToken, "/control/v1/sessions/session-1/robot-readiness", { report: ownedReport });
  assert.equal(response.status, 403);
  assert.equal(response.body.code, "ROBOT_IDENTITY_MISMATCH");
  response = await post(api.url, robotToken, "/control/v1/sessions/session-1/robot-readiness", { report: ownedReport });
  assert.equal(response.status, 200);

  response = await post(api.url, operatorToken, "/control/v1/sessions/session-1/activate", {
    expectedRevision: session.revision,
  });
  assert.equal(response.status, 200);
  session = response.body.session as SessionView;
  assert.equal(session.status, "ACTIVE");

  response = await post(api.url, operatorToken, "/control/v1/sessions/session-1/release", {
    expectedRevision: session.revision,
    robotStopped: true,
  });
  assert.equal(response.status, 400);
  assert.equal(response.body.code, "SESSION_STOP_ACK_REQUIRED");

  edge = agent.releaseOwnership(edge.ownership.revision, "Operator ended session.");
  edge = agent.acknowledgeStopped(edge.ownership.revision, {
    observedAtUnixMs: now,
    controllerStateFresh: true,
    baseStopped: true,
    manipulatorHolding: true,
  });
  response = await post(api.url, robotToken, "/control/v1/sessions/session-1/robot-readiness", {
    report: agent.createReadinessReport("session-1", "readiness-cleared"),
  });
  assert.equal(response.status, 200);
  response = await post(api.url, operatorToken, "/control/v1/sessions/session-1/release", {
    expectedRevision: session.revision,
    reason: "Robot edge reported cleared ownership.",
  });
  assert.equal(response.status, 200);
  assert.equal((response.body.session as SessionView).status, "RELEASED");
});

test("robot assistance writes are bound to the authenticated robot identity", async (context) => {
  const api = await startControlPlaneApi({
    identityProvider: new StaticBearerIdentityProvider([
      { token: operatorToken, principal: { subject: "oidc:operator-1", operatorId: "operator-1", roles: ["ADMIN"] } },
      { token: robotToken, principal: { subject: "spiffe:robot-1", operatorId: "edge-service", robotId: "robot-1", roles: ["ROBOT"] } },
      { token: wrongRobotToken, principal: { subject: "spiffe:robot-2", operatorId: "edge-service", robotId: "robot-2", roles: ["ROBOT"] } },
    ]),
    allowUncoordinatedCommandLeases: true,
  });
  context.after(() => api.close());
  const now = Date.now();
  const request = {
    contractVersion: { major: 1, minor: 0 },
    requestId: "assistance-robot-binding",
    robotId: "robot-1",
    taskId: "task-1",
    reason: "OBJECT_NOT_RECOGNIZED",
    requestedInput: "SELECT_TARGET",
    observations: [{
      observationId: "observation-1",
      robotId: "robot-1",
      capturedAtUnixMs: now,
      sceneRevision: "scene-1",
      calibrationVersion: "cal-1",
      frameIds: ["camera_rgb", "camera_depth"],
    }],
    createdAtUnixMs: now,
    expiresAtUnixMs: now + 60_000,
  };

  let response = await post(api.url, wrongRobotToken, "/assistance/v1/requests", request);
  assert.equal(response.status, 403);
  assert.equal(response.body.code, "ROBOT_IDENTITY_MISMATCH");
  response = await post(api.url, robotToken, "/assistance/v1/requests", request);
  assert.equal(response.status, 201);
  let workflow = response.body.assistance as { revision: number };

  response = await get(api.url, wrongRobotToken, "/assistance/v1/requests/assistance-robot-binding");
  assert.equal(response.status, 403);
  assert.equal(response.body.code, "ROBOT_IDENTITY_MISMATCH");
  response = await get(api.url, robotToken, "/assistance/v1/requests/assistance-robot-binding");
  assert.equal(response.status, 200);
  response = await get(api.url, wrongRobotToken, "/assistance/v1/requests");
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.requests, []);

  response = await post(api.url, operatorToken, "/assistance/v1/requests/assistance-robot-binding/assign", {
    expectedRevision: workflow.revision,
    operatorId: "operator-1",
  });
  workflow = response.body.assistance as { revision: number };
  response = await post(api.url, operatorToken, "/assistance/v1/requests/assistance-robot-binding/declarations", {
    expectedRevision: workflow.revision,
    declaration: {
      contractVersion: { major: 1, minor: 0 },
      declarationId: "declaration-1",
      requestId: "assistance-robot-binding",
      observationId: "observation-1",
      revision: 1,
      declaredBy: "operator-1",
      declaredAtUnixMs: now + 1,
      selection: { kind: "BOX", frameId: "camera_rgb", x: 1, y: 1, width: 10, height: 10 },
      semanticLabel: "blue bin",
      manipulationIntent: "PICK",
      persistenceScope: "ATTEMPT_ONLY",
    },
  });
  workflow = response.body.assistance as { revision: number };

  response = await post(api.url, operatorToken, "/assistance/v1/requests/assistance-robot-binding/groundings", {
    expectedRevision: workflow.revision,
    groundedObject: {},
  });
  assert.equal(response.status, 403);
  assert.equal(response.body.code, "FORBIDDEN");
  response = await post(api.url, wrongRobotToken, "/assistance/v1/requests/assistance-robot-binding/groundings", {
    expectedRevision: workflow.revision,
    groundedObject: {},
  });
  assert.equal(response.status, 403);
  assert.equal(response.body.code, "ROBOT_IDENTITY_MISMATCH");
  response = await post(api.url, robotToken, "/assistance/v1/requests/assistance-robot-binding/groundings", {
    expectedRevision: workflow.revision,
    groundedObject: {},
  });
  assert.equal(response.status, 400);
  assert.notEqual(response.body.code, "ROBOT_IDENTITY_MISMATCH");
});

interface SessionView {
  revision: number;
  status: string;
  lease?: Parameters<LocalRobotAgent["installLease"]>[0];
}

async function post(baseUrl: string, token: string, path: string, body: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function get(baseUrl: string, token: string, path: string) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}
