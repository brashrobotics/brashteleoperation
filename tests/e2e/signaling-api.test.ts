import assert from "node:assert/strict";
import test from "node:test";
import { startControlPlaneApi } from "../../apps/control-plane-api/src/server.ts";
import { CONTRACT_VERSION, type RealtimeSignalingPayload, type RealtimeSignalingPeerRole } from "../../packages/contracts/src/index.ts";
import { InMemoryRealtimeSignaling } from "../../services/realtime-signaling/src/index.ts";
import { InMemorySessionControl } from "../../services/session-control/src/index.ts";

const operatorToken = "signaling-operator-token-long";
const robotToken = "signaling-robot-token-long-value";

test("separately authenticated operator and robot peers complete signaling without activating control", async () => {
  const sessions = new InMemorySessionControl();
  const signaling = new InMemoryRealtimeSignaling();
  const operatorApi = await startControlPlaneApi({
    bearerToken: operatorToken,
    sessions,
    signaling,
    principal: { subject: "oidc:operator-1", operatorId: "operator-1", roles: ["SUPERVISOR"] },
  });
  const robotApi = await startControlPlaneApi({
    bearerToken: robotToken,
    sessions,
    signaling,
    principal: { subject: "spiffe:robot-1", operatorId: "edge-service", robotId: "robot-1", roles: ["ROBOT"] },
  });
  try {
    let response = await post(operatorApi.url, operatorToken, "/control/v1/sessions", {
      sessionId: "session-1",
      robotId: "robot-1",
      operatorId: "operator-1",
      scopes: ["OBSERVE"],
    });
    let session = response.body.session as { revision: number; status: string };
    response = await post(operatorApi.url, operatorToken, "/control/v1/sessions/session-1/grant", {
      expectedRevision: session.revision,
      leaseDurationMs: 10_000,
    });
    session = response.body.session as { revision: number; status: string };
    assert.equal(session.status, "GRANTED");

    response = await post(operatorApi.url, operatorToken, "/signaling/v1/exchanges", {
      signalingId: "signal-1",
      sessionId: "session-1",
    });
    let exchange = response.body.exchange as Exchange;
    assert.equal(exchange.status, "AWAITING_OFFER");
    exchange = await send(operatorApi.url, operatorToken, exchange, "offer-1", "OPERATOR", {
      kind: "OFFER",
      description: { type: "offer", sdp: "v=0\r\ns=operator\r\n" },
    });
    exchange = await send(robotApi.url, robotToken, exchange, "answer-1", "ROBOT_EDGE", {
      kind: "ANSWER",
      description: { type: "answer", sdp: "v=0\r\ns=edge\r\n" },
    });
    exchange = await send(operatorApi.url, operatorToken, exchange, "connected-operator", "OPERATOR", { kind: "CONNECTED" });
    exchange = await send(robotApi.url, robotToken, exchange, "connected-edge", "ROBOT_EDGE", { kind: "CONNECTED" });
    assert.equal(exchange.status, "CONNECTED");

    response = await get(robotApi.url, robotToken, "/signaling/v1/exchanges/signal-1");
    assert.equal(response.status, 200);
    assert.equal((response.body.exchange as Exchange).status, "CONNECTED");
    assert.equal(sessions.getSession("session-1").status, "GRANTED");
  } finally {
    await robotApi.close();
    await operatorApi.close();
  }
});

interface Exchange {
  signalingId: string;
  sessionId: string;
  revision: number;
  status: string;
}

async function send(
  baseUrl: string,
  token: string,
  exchange: Exchange,
  messageId: string,
  from: RealtimeSignalingPeerRole,
  payload: RealtimeSignalingPayload,
): Promise<Exchange> {
  const response = await post(baseUrl, token, `/signaling/v1/exchanges/${exchange.signalingId}/messages`, {
    expectedRevision: exchange.revision,
    message: {
      contractVersion: CONTRACT_VERSION,
      messageId,
      signalingId: exchange.signalingId,
      sessionId: exchange.sessionId,
      from,
      sentAtUnixMs: Date.now(),
      payload,
    },
  });
  assert.equal(response.status, 200);
  return response.body.exchange as Exchange;
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
  const response = await fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}
