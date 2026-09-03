import assert from "node:assert/strict";
import test from "node:test";
import { startControlPlaneApi } from "../../apps/control-plane-api/src/server.ts";
import { CONTRACT_VERSION } from "../../packages/contracts/src/index.ts";
import { StaticBearerIdentityProvider } from "../../packages/identity/src/index.ts";
import { InMemoryRobotReadiness, InMemorySessionControl } from "../../services/session-control/src/index.ts";
import { InMemoryAssistanceOrchestrator } from "../../services/assistance-orchestrator/src/index.ts";
import {
  HttpRobotReadinessPublisher,
  LocalRobotAgent,
  RobotReadinessReporter,
} from "../../edge/robot-agent/src/index.ts";
import { startRobotAgentTestServer } from "../../edge/robot-agent/src/server.ts";

test("networked loopback stack completes direct control and unknown-object assistance", async () => {
  let nowUnixMs = 10_000;
  let nowMonotonicMs = 0;
  let id = 0;
  const idGenerator = () => `e2e-${++id}`;
  const sessions = new InMemorySessionControl({ now: () => nowUnixMs, idGenerator });
  const robotReadiness = new InMemoryRobotReadiness({ now: () => nowUnixMs, idGenerator });
  const assistance = new InMemoryAssistanceOrchestrator({ now: () => nowUnixMs, idGenerator });
  const agent = new LocalRobotAgent({
    robotId: "b2-unit-001",
    nowUnixMs: () => nowUnixMs,
    nowMonotonicMs: () => nowMonotonicMs,
    idGenerator,
    baseSafetyProfile: {
      robotId: "b2-unit-001",
      commandTimeoutMs: 250,
      maximumLinearXMetersPerSecond: 0.7,
      maximumLinearYMetersPerSecond: 0.4,
      maximumAngularZRadiansPerSecond: 0.7,
      maximumLinearAccelerationMetersPerSecondSquared: 0.5,
      maximumAngularAccelerationRadiansPerSecondSquared: 0.7,
    },
  });
  const controlToken = "control-e2e-token-long";
  const edgeToken = "edge-e2e-token-long-value";
  const robotControlToken = "robot-control-e2e-token-long";
  const control = await startControlPlaneApi({
    identityProvider: new StaticBearerIdentityProvider([
      { token: controlToken, principal: { subject: "test:operator-1", operatorId: "operator-1", roles: ["ADMIN"] } },
      { token: robotControlToken, principal: { subject: "test:robot-b2-unit-001", operatorId: "edge-service", robotId: "b2-unit-001", roles: ["ROBOT"] } },
    ]),
    sessions,
    assistance,
    allowUncoordinatedCommandLeases: true,
    robotReadiness,
  });
  const readinessReporter = new RobotReadinessReporter({
    publisher: new HttpRobotReadinessPublisher({ controlPlaneUrl: control.url, bearerToken: robotControlToken }),
    now: () => nowUnixMs,
    automaticDelivery: false,
  });
  const edge = await startRobotAgentTestServer({
    bearerToken: edgeToken,
    agent,
    onReadinessReport: (report) => { readinessReporter.enqueue(report); },
  });
  try {
    const unauthorized = await getJson(`${edge.url}/edge/v1/state`);
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.body.code, "UNAUTHORIZED");

    const impersonation = await postJson(`${control.url}/control/v1/sessions`, controlToken, {
      robotId: "b2-unit-001",
      operatorId: "operator-attacker",
      scopes: ["OBSERVE"],
    });
    assert.equal(impersonation.status, 403);
    assert.equal(impersonation.body.code, "ACTOR_IDENTITY_MISMATCH");

    let response = await postJson(`${control.url}/control/v1/sessions`, controlToken, {
      sessionId: "session-direct-1",
      robotId: "b2-unit-001",
      operatorId: "operator-1",
      scopes: ["OBSERVE", "CONTROL_BASE"],
    });
    assert.equal(response.status, 201);
    let session = response.body.session as Record<string, unknown>;

    response = await postJson(`${control.url}/control/v1/sessions/session-direct-1/grant`, controlToken, {
      expectedRevision: session.revision,
      leaseDurationMs: 10_000,
    });
    session = response.body.session as Record<string, unknown>;
    const lease = session.lease;

    response = await postJson(`${edge.url}/edge/v1/leases`, edgeToken, { lease });
    assert.equal((response.body.state as AgentState).installedLeases.length, 1);

    response = await postJson(`${control.url}/control/v1/sessions/session-direct-1/connecting`, controlToken, {
      expectedRevision: session.revision,
    });
    session = response.body.session as Record<string, unknown>;

    response = await postJson(`${edge.url}/edge/v1/ownership/request`, edgeToken, {
      sessionId: "session-direct-1",
      actuatorGroup: "BASE",
    });
    let edgeState = response.body.state as AgentState;
    assert.equal(edgeState.ownership.status, "HANDOFF");
    response = await postJson(`${edge.url}/edge/v1/ownership/stopped-ack`, edgeToken, {
      expectedRevision: edgeState.ownership.revision,
      evidence: { observedAtUnixMs: nowUnixMs, controllerStateFresh: true, baseStopped: true, manipulatorHolding: true },
    });
    edgeState = response.body.state as AgentState;
    assert.equal(edgeState.ownership.status, "OWNED");

    assert.equal((await readinessReporter.flushNow()).queuedSessions, 0);

    response = await postJson(`${control.url}/control/v1/sessions/session-direct-1/activate`, controlToken, {
      expectedRevision: session.revision,
    });
    session = response.body.session as Record<string, unknown>;
    assert.equal(session.status, "ACTIVE");

    response = await postJson(`${edge.url}/edge/v1/safety/interlocks`, edgeToken, {
      interlocks: { vendorSafetyOk: true, controllerHealthy: true, robotStateFresh: true },
    });
    edgeState = response.body.state as AgentState;
    response = await postJson(`${edge.url}/edge/v1/safety/prepare`, edgeToken, {
      expectedRevision: edgeState.baseSafety.revision,
    });
    edgeState = response.body.state as AgentState;
    response = await postJson(`${edge.url}/edge/v1/safety/enable`, edgeToken, {
      expectedRevision: edgeState.baseSafety.revision,
    });
    edgeState = response.body.state as AgentState;
    assert.equal(edgeState.baseSafety.status, "ENABLED");

    nowUnixMs += 100;
    nowMonotonicMs += 100;
    const command = {
      contractVersion: CONTRACT_VERSION,
      commandId: "command-1",
      sessionId: "session-direct-1",
      robotId: "b2-unit-001",
      sourceId: "operator-1",
      actuatorGroup: "BASE",
      sequence: 1,
      producedAtUnixMs: nowUnixMs,
      expiresAtUnixMs: nowUnixMs + 200,
      deadman: true,
      intent: {
        kind: "BASE_MOTION",
        frameId: "base_link",
        linearXMetersPerSecond: 0.3,
        linearYMetersPerSecond: 0,
        angularZRadiansPerSecond: 0,
        speedScale: 0.5,
      },
    };
    response = await postJson(`${edge.url}/edge/v1/commands`, edgeToken, { command });
    edgeState = response.body.state as AgentState;
    assert.equal(edgeState.baseSafety.lastAcceptedCommandId, "command-1");
    assert.equal(edgeState.baseSafety.output.linearXMetersPerSecond, 0.05);

    const replay = await postJson(`${edge.url}/edge/v1/commands`, edgeToken, { command });
    assert.equal(replay.status, 400);
    assert.equal(replay.body.code, "COMMAND_SEQUENCE_REPLAY");

    response = await postJson(`${edge.url}/edge/v1/safety/hold`, edgeToken, {
      expectedRevision: edgeState.baseSafety.revision,
      reason: "Operator released deadman.",
    });
    edgeState = response.body.state as AgentState;
    assert.equal(edgeState.baseSafety.output.linearXMetersPerSecond, 0);
    response = await postJson(`${edge.url}/edge/v1/ownership/release`, edgeToken, {
      expectedRevision: edgeState.ownership.revision,
      reason: "Direct-control work complete.",
    });
    edgeState = response.body.state as AgentState;
    response = await postJson(`${edge.url}/edge/v1/ownership/stopped-ack`, edgeToken, {
      expectedRevision: edgeState.ownership.revision,
      evidence: { observedAtUnixMs: nowUnixMs, controllerStateFresh: true, baseStopped: true, manipulatorHolding: true },
    });
    edgeState = response.body.state as AgentState;
    assert.equal(edgeState.ownership.status, "NO_OWNER");

    assert.equal((await readinessReporter.flushNow()).queuedSessions, 0);

    response = await postJson(`${control.url}/control/v1/sessions/session-direct-1/release`, controlToken, {
      expectedRevision: session.revision,
      reason: "Edge acknowledged stopped ownership.",
    });
    assert.equal((response.body.session as Record<string, unknown>).status, "RELEASED");

    const observation = {
      observationId: "observation-1",
      robotId: "b2-unit-001",
      capturedAtUnixMs: nowUnixMs,
      sceneRevision: "scene-1",
      calibrationVersion: "calibration-1",
      frameIds: ["camera_color", "camera_depth"],
    };
    response = await postJson(`${control.url}/assistance/v1/requests`, controlToken, {
      contractVersion: CONTRACT_VERSION,
      requestId: "assistance-1",
      robotId: "b2-unit-001",
      taskId: "task-1",
      reason: "OBJECT_NOT_RECOGNIZED",
      requestedInput: "SELECT_TARGET",
      observations: [observation],
      createdAtUnixMs: nowUnixMs,
      expiresAtUnixMs: nowUnixMs + 30_000,
    });
    let workflow = response.body.assistance as AssistanceState;
    response = await postJson(`${control.url}/assistance/v1/requests/assistance-1/assign`, controlToken, {
      expectedRevision: workflow.revision,
      operatorId: "operator-1",
    });
    workflow = response.body.assistance as AssistanceState;
    response = await postJson(`${control.url}/assistance/v1/requests/assistance-1/declarations`, controlToken, {
      expectedRevision: workflow.revision,
      declaration: {
        contractVersion: CONTRACT_VERSION,
        declarationId: "declaration-1",
        requestId: "assistance-1",
        observationId: "observation-1",
        revision: 1,
        declaredBy: "operator-1",
        declaredAtUnixMs: nowUnixMs + 1,
        selection: { kind: "BOX", frameId: "camera_color", x: 10, y: 20, width: 30, height: 40 },
        semanticLabel: "operator-declared-container",
        manipulationIntent: "PICK",
        persistenceScope: "ATTEMPT_ONLY",
      },
    });
    workflow = response.body.assistance as AssistanceState;
    response = await postJson(`${control.url}/assistance/v1/requests/assistance-1/groundings`, robotControlToken, {
      expectedRevision: workflow.revision,
      groundedObject: {
        contractVersion: CONTRACT_VERSION,
        objectId: "object-1",
        requestId: "assistance-1",
        declarationId: "declaration-1",
        declarationRevision: 1,
        observationId: "observation-1",
        robotId: "b2-unit-001",
        sceneRevision: "scene-1",
        revision: 1,
        status: "TRACKED",
        pose: { frameId: "base_link", positionMeters: [0.6, 0, 0.3], orientationXyzw: [0, 0, 0, 1] },
        dimensionsMeters: [0.1, 0.1, 0.2],
        positionStdDevMeters: [0.01, 0.01, 0.02],
        groundedAtUnixMs: nowUnixMs + 2,
        validUntilUnixMs: nowUnixMs + 5_000,
        algorithm: { name: "e2e-grounder", version: "1" },
      },
    });
    workflow = response.body.assistance as AssistanceState;
    response = await postJson(`${control.url}/assistance/v1/requests/assistance-1/plans`, robotControlToken, {
      expectedRevision: workflow.revision,
      plan: {
        contractVersion: CONTRACT_VERSION,
        planId: "plan-1",
        requestId: "assistance-1",
        robotId: "b2-unit-001",
        objectId: "object-1",
        objectRevision: 1,
        sceneRevision: "scene-1",
        planRevision: 1,
        generatedAtUnixMs: nowUnixMs + 3,
        approvalRequired: true,
        phases: ["approach", "grasp", "lift", "verify"],
        expectedOutcome: "object lifted and tracked",
      },
    });
    workflow = response.body.assistance as AssistanceState;
    const staleApproval = await postJson(`${control.url}/assistance/v1/requests/assistance-1/approvals`, controlToken, {
      expectedRevision: workflow.revision,
      approval: {
        contractVersion: CONTRACT_VERSION,
        approvalId: "approval-stale",
        requestId: "assistance-1",
        planId: "plan-1",
        planRevision: 2,
        objectRevision: 1,
        sceneRevision: "scene-1",
        approvedBy: "operator-1",
        approvedAtUnixMs: nowUnixMs + 4,
      },
    });
    assert.equal(staleApproval.status, 409);
    assert.equal(staleApproval.body.code, "APPROVAL_REVISION_MISMATCH");

    response = await postJson(`${control.url}/assistance/v1/requests/assistance-1/approvals`, controlToken, {
      expectedRevision: workflow.revision,
      approval: {
        contractVersion: CONTRACT_VERSION,
        approvalId: "approval-1",
        requestId: "assistance-1",
        planId: "plan-1",
        planRevision: 1,
        objectRevision: 1,
        sceneRevision: "scene-1",
        approvedBy: "operator-1",
        approvedAtUnixMs: nowUnixMs + 4,
      },
    });
    workflow = response.body.assistance as AssistanceState;
    response = await postJson(`${control.url}/assistance/v1/requests/assistance-1/outcomes`, robotControlToken, {
      expectedRevision: workflow.revision,
      outcome: {
        contractVersion: CONTRACT_VERSION,
        outcomeId: "outcome-1",
        requestId: "assistance-1",
        planId: "plan-1",
        planRevision: 1,
        success: true,
        verification: ["gripper-state", "object-tracked-after-lift"],
        completedAtUnixMs: nowUnixMs + 5,
      },
    });
    workflow = response.body.assistance as AssistanceState;
    response = await postJson(`${control.url}/assistance/v1/requests/assistance-1/verification`, robotControlToken, {
      expectedRevision: workflow.revision,
      verified: true,
      reason: "Independent simulated verification signals agree.",
    });
    workflow = response.body.assistance as AssistanceState;
    assert.equal(workflow.status, "RESOLVED");
    const eventResponse = await getJson(`${control.url}/assistance/v1/requests/assistance-1/events`, controlToken);
    assert.equal((eventResponse.body.events as unknown[]).length, 9);
  } finally {
    readinessReporter.close();
    await Promise.all([control.close(), edge.close()]);
  }
});

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
}

interface AgentState {
  installedLeases: unknown[];
  ownership: { status: string; revision: number };
  baseSafety: {
    status: string;
    revision: number;
    lastAcceptedCommandId?: string;
    output: { linearXMetersPerSecond: number };
  };
}

interface AssistanceState {
  revision: number;
  status: string;
}

async function postJson(url: string, token: string, body: unknown): Promise<JsonResponse> {
  return requestJson(url, { method: "POST", token, body });
}

async function getJson(url: string, token?: string): Promise<JsonResponse> {
  return requestJson(url, { method: "GET", token });
}

async function requestJson(url: string, options: { method: string; token?: string; body?: unknown }): Promise<JsonResponse> {
  const response = await fetch(url, {
    method: options.method,
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}
