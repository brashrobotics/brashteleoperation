import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import test from "node:test";
import { startControlPlaneApi } from "../../apps/control-plane-api/src/server.ts";
import { listenHttp } from "../../packages/http-runtime/src/index.ts";
import {
  FleetCommandLeaseCoordinator,
  HttpFleetTeleoperationPort,
  InMemoryRobotReadiness,
  type FleetHold,
} from "../../services/session-control/src/index.ts";

const controlToken = "control-test-token-at-least-16";
const fleetToken = "fleet-test-token-at-least-16";

test("control API grants only after Fleet stop confirmation and releases Fleet after local persistence", async (context) => {
  let fleetStopped = false;
  let hold: FleetHold | undefined;
  let fleetRequestCount = 0;
  const ordering: string[] = [];
  const fleetServer = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${fleetToken}`);
    if (request.method === "POST" && request.url === "/api/v1/teleoperation/holds") {
      fleetRequestCount += 1;
      const body = await readJson(request);
      hold ??= {
        holdId: body.requestId as string,
        robotId: body.robotId as string,
        state: "PAUSE_REQUESTED",
        revision: 1,
      };
      return sendHold(response, hold);
    }
    if (request.method === "GET" && request.url === "/api/v1/teleoperation/holds/session-fleet-1") {
      if (fleetStopped && hold?.state === "PAUSE_REQUESTED") {
        hold = { ...hold, state: "ROBOT_STOPPED", revision: 2 };
      }
      return sendHold(response, hold!);
    }
    if (request.method === "POST" && request.url === "/api/v1/teleoperation/holds/session-fleet-1/release") {
      const body = await readJson(request);
      assert.equal(body.expectedRevision, 2);
      ordering.push("fleet-release");
      hold = { ...hold!, state: "RELEASED", revision: 3, reason: body.reason as string };
      return sendHold(response, hold);
    }
    response.writeHead(404).end();
  });
  const fleet = await listenHttp(fleetServer);
  context.after(() => fleet.close());

  const fleetSessions = new FleetCommandLeaseCoordinator({
    fleet: new HttpFleetTeleoperationPort({ baseUrl: fleet.url, bearerToken: fleetToken }),
  });
  const robotReadiness = new InMemoryRobotReadiness();
  const control = await startControlPlaneApi({
    bearerToken: controlToken,
    authorizeCommandLease: async (session) => { await fleetSessions.authorize({ sessionId: session.sessionId, robotId: session.robotId }); },
    releaseCommandReservation: async (session) => {
      return (await fleetSessions.releaseTrackedWithResult(session.sessionId)).changed;
    },
    robotReadiness,
    afterMutation: () => { ordering.push("persist"); },
  });
  context.after(() => control.close());

  let response = await post(control.url, "/control/v1/sessions", {
    sessionId: "session-fleet-1",
    robotId: "robot-1",
    operatorId: "operator-1",
    scopes: ["CONTROL_BASE"],
  });
  assert.equal(response.status, 201);

  response = await post(control.url, "/control/v1/sessions/session-fleet-1/grant", {
    expectedRevision: 99,
    leaseDurationMs: 5_000,
  });
  assert.equal(response.status, 409);
  assert.equal(fleetRequestCount, 0);

  response = await post(control.url, "/control/v1/sessions/session-fleet-1/grant", {
    expectedRevision: 1,
    leaseDurationMs: 1,
  });
  assert.equal(response.status, 400);
  assert.equal(fleetRequestCount, 0);

  response = await post(control.url, "/control/v1/sessions/session-fleet-1/grant", {
    expectedRevision: 1,
    leaseDurationMs: 5_000,
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json() as Record<string, unknown>).code, "FLEET_RESERVATION_NOT_READY");

  fleetStopped = true;
  response = await post(control.url, "/control/v1/sessions/session-fleet-1/grant", {
    expectedRevision: 1,
    leaseDurationMs: 5_000,
  });
  assert.equal(response.status, 200);
  const granted = (await response.json() as { session: { revision: number; status: string } }).session;
  assert.equal(granted.status, "GRANTED");

  robotReadiness.record(control.sessions.getSession("session-fleet-1"), {
    contractVersion: { major: 1, minor: 0 },
    readinessId: "fleet-release-readiness",
    sessionId: "session-fleet-1",
    robotId: "robot-1",
    operatorId: "operator-1",
    leaseRevision: 1,
    ownershipRevision: 4,
    ownershipStatus: "NO_OWNER",
    reportedAtUnixMs: Date.now(),
  });

  ordering.length = 0;
  response = await post(control.url, "/control/v1/sessions/session-fleet-1/release", {
    expectedRevision: granted.revision,
    reason: "Robot edge acknowledged stopped ownership.",
  });
  assert.equal(response.status, 200);
  assert.equal(hold?.state, "RELEASED");
  assert.deepEqual(ordering, ["persist", "fleet-release", "persist"]);
});

async function post(baseUrl: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${controlToken}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function sendHold(response: ServerResponse, value: FleetHold): void {
  response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
    contractVersion: { major: 1, minor: 0 },
    hold: value,
  }));
}
