import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import test from "node:test";
import { TeleoperationError } from "../../packages/contracts/src/index.ts";
import { listenHttp } from "../../packages/http-runtime/src/index.ts";
import {
  FleetReservationCoordinator,
  HttpFleetTeleoperationPort,
  type FleetHold,
} from "../../services/session-control/src/index.ts";

const token = "fleet-test-token-at-least-16";

test("HTTP Fleet adapter performs an authenticated, revisioned hold lifecycle", async (context) => {
  let hold: FleetHold | undefined;
  const received: Array<{ method?: string; path?: string; authorization?: string; idempotencyKey?: string; body?: unknown }> = [];
  const server = createServer(async (request, response) => {
    const body = request.method === "POST" ? await readJson(request) : undefined;
    received.push({
      method: request.method,
      path: request.url,
      authorization: request.headers.authorization,
      idempotencyKey: request.headers["idempotency-key"] as string | undefined,
      body,
    });
    if (request.method === "POST" && request.url === "/api/v1/teleoperation/holds") {
      const input = body as Record<string, unknown>;
      hold ??= {
        holdId: input.requestId as string,
        robotId: input.robotId as string,
        missionId: input.missionId as string,
        state: "PAUSE_REQUESTED",
        revision: 1,
        reason: input.reason as string,
      };
      return sendDocument(response, hold);
    }
    if (request.method === "GET" && request.url === "/api/v1/teleoperation/holds/session-1") {
      hold = { ...hold!, state: "ROBOT_STOPPED", revision: 2, reason: "Robot adapter confirmed stopped." };
      return sendDocument(response, hold);
    }
    if (request.method === "POST" && request.url === "/api/v1/teleoperation/holds/session-1/release") {
      const input = body as Record<string, unknown>;
      assert.equal(input.expectedRevision, 2);
      hold = { ...hold!, state: "RELEASED", revision: 3, reason: input.reason as string };
      return sendDocument(response, hold);
    }
    response.writeHead(404).end();
  });
  const running = await listenHttp(server);
  context.after(() => running.close());

  const fleet = new HttpFleetTeleoperationPort({ baseUrl: running.url, bearerToken: token });
  const coordinator = new FleetReservationCoordinator({ fleet, now: () => 1_000 });
  let reservation = await coordinator.request({
    reservationId: "session-1",
    robotId: "robot-1",
    missionId: "mission-1",
    reason: "Unknown object requires human assistance.",
  });
  assert.equal(reservation.status, "WAITING_FOR_ROBOT_STOP");
  reservation = await coordinator.reconcile(reservation.reservationId, reservation.revision);
  assert.equal(reservation.status, "RESERVED");
  coordinator.requireAdmission("session-1", "robot-1");
  reservation = await coordinator.release("session-1", reservation.revision, "Robot-local ownership is stopped.");
  assert.equal(reservation.status, "RELEASED");

  assert.deepEqual(received.map((item) => [item.method, item.path]), [
    ["POST", "/api/v1/teleoperation/holds"],
    ["GET", "/api/v1/teleoperation/holds/session-1"],
    ["POST", "/api/v1/teleoperation/holds/session-1/release"],
  ]);
  assert.ok(received.every((item) => item.authorization === `Bearer ${token}`));
  assert.equal(received[0]?.idempotencyKey, "session-1");
  assert.equal(received[2]?.idempotencyKey, "session-1:release:2");
  assert.deepEqual((received[0]?.body as Record<string, unknown>).contractVersion, { major: 1, minor: 0 });
});

test("HTTP Fleet adapter fails closed on timeout, authentication failure, malformed data, and oversized data", async (context) => {
  let mode: "timeout" | "auth" | "invalid" | "oversize" = "timeout";
  const server = createServer((_request, response) => {
    if (mode === "timeout") {
      setTimeout(() => sendDocument(response, sampleHold()), 100);
      return;
    }
    if (mode === "auth") {
      response.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ code: "FORBIDDEN" }));
      return;
    }
    if (mode === "invalid") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        contractVersion: { major: 2, minor: 0 },
        hold: sampleHold(),
      }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
      contractVersion: { major: 1, minor: 0 },
      hold: sampleHold(),
      padding: "x".repeat(512),
    }));
  });
  const running = await listenHttp(server);
  context.after(() => running.close());
  const timeoutFleet = new HttpFleetTeleoperationPort({
    baseUrl: running.url,
    bearerToken: token,
    requestTimeoutMs: 25,
    maximumResponseBytes: 256,
  });

  await rejectsWithCode(() => timeoutFleet.inspectHold("hold-1"), "FLEET_REQUEST_TIMEOUT");
  const fleet = new HttpFleetTeleoperationPort({
    baseUrl: running.url,
    bearerToken: token,
    requestTimeoutMs: 1_000,
    maximumResponseBytes: 256,
  });
  mode = "auth";
  await rejectsWithCode(() => fleet.inspectHold("hold-1"), "FLEET_AUTHENTICATION_FAILED");
  mode = "invalid";
  await rejectsWithCode(() => fleet.inspectHold("hold-1"), "FLEET_RESPONSE_INVALID");
  mode = "oversize";
  await rejectsWithCode(() => fleet.inspectHold("hold-1"), "FLEET_RESPONSE_TOO_LARGE");

  assert.throws(
    () => new HttpFleetTeleoperationPort({ baseUrl: "http://fleet.example.test", bearerToken: token }),
    /HTTPS/,
  );
});

function sampleHold(): FleetHold {
  return { holdId: "hold-1", robotId: "robot-1", state: "ROBOT_STOPPED", revision: 2 };
}

function sendDocument(response: ServerResponse, hold: FleetHold): void {
  response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
    contractVersion: { major: 1, minor: 0 },
    hold,
  }));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function rejectsWithCode(operation: () => Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(operation, (error) => error instanceof TeleoperationError && error.code === code);
}
