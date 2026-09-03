import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTRACT_VERSION,
  TeleoperationError,
  type RealtimeSignalingMessage,
  type RealtimeSignalingPayload,
  type RealtimeSignalingPeerRole,
} from "../../packages/contracts/src/index.ts";
import { InMemoryRealtimeSignaling } from "../../services/realtime-signaling/src/index.ts";

test("bounded signaling completes offer/answer negotiation idempotently and scrubs on close", () => {
  let now = 10_000;
  let id = 0;
  const signaling = new InMemoryRealtimeSignaling({ now: () => now, idGenerator: () => `event-${++id}` });
  let exchange = signaling.createExchange({
    signalingId: "signal-1",
    sessionId: "session-1",
    robotId: "robot-1",
    operatorId: "operator-1",
    leaseExpiresAtUnixMs: 20_000,
  });
  assert.equal(exchange.status, "AWAITING_OFFER");

  assert.throws(
    () => signaling.submitMessage("signal-1", exchange.revision, message("candidate-before-offer", "signal-1", "OPERATOR", {
      kind: "ICE_CANDIDATE", candidate: { candidate: "candidate:1 1 UDP 1 192.0.2.1 5000 typ host" },
    }, now)),
    (error) => error instanceof TeleoperationError && error.code === "SIGNALING_CANDIDATE_STATE_INVALID",
  );

  const offer = message("offer-1", "signal-1", "OPERATOR", {
    kind: "OFFER", description: { type: "offer", sdp: "v=0\r\ns=BRASH operator\r\n" },
  }, now);
  exchange = signaling.submitMessage("signal-1", exchange.revision, offer);
  assert.equal(exchange.status, "AWAITING_ANSWER");
  assert.equal(exchange.revision, 2);
  assert.equal(signaling.submitMessage("signal-1", 1, offer).revision, 2);
  assert.throws(
    () => signaling.submitMessage("signal-1", exchange.revision, { ...offer, sentAtUnixMs: now + 1 }),
    (error) => error instanceof TeleoperationError && error.code === "SIGNALING_MESSAGE_ID_COLLISION",
  );

  exchange = signaling.submitMessage("signal-1", exchange.revision, message("candidate-1", "signal-1", "OPERATOR", {
    kind: "ICE_CANDIDATE", candidate: { candidate: "candidate:1 1 UDP 1 192.0.2.1 5000 typ host", sdpMid: "0", sdpMLineIndex: 0 },
  }, now));
  exchange = signaling.submitMessage("signal-1", exchange.revision, message("answer-1", "signal-1", "ROBOT_EDGE", {
    kind: "ANSWER", description: { type: "answer", sdp: "v=0\r\ns=BRASH edge\r\n" },
  }, now));
  assert.equal(exchange.status, "CONNECTING");
  exchange = signaling.submitMessage("signal-1", exchange.revision, message("connected-operator", "signal-1", "OPERATOR", {
    kind: "CONNECTED",
  }, now));
  assert.equal(exchange.status, "CONNECTING");
  exchange = signaling.submitMessage("signal-1", exchange.revision, message("connected-edge", "signal-1", "ROBOT_EDGE", {
    kind: "CONNECTED",
  }, now));
  assert.equal(exchange.status, "CONNECTED");
  assert.deepEqual(exchange.connectedPeers, ["OPERATOR", "ROBOT_EDGE"]);

  exchange = signaling.submitMessage("signal-1", exchange.revision, message("close-1", "signal-1", "OPERATOR", {
    kind: "CLOSE", reason: "Operator ended the connection.",
  }, now));
  assert.equal(exchange.status, "CLOSED");
  assert.equal(exchange.messages.length, 0);
  assert.equal(exchange.messageReceipts.length, 6);
  assert.doesNotMatch(JSON.stringify(signaling.getEvents("signal-1")), /BRASH operator|candidate:1/);
});

test("signaling expiry and restart invalidate and scrub active negotiation material", () => {
  let now = 1_000;
  const signaling = new InMemoryRealtimeSignaling({ now: () => now, idGenerator: incrementalIds("event") });
  let exchange = signaling.createExchange({
    signalingId: "signal-expire",
    sessionId: "session-expire",
    robotId: "robot-1",
    operatorId: "operator-1",
    leaseExpiresAtUnixMs: 2_000,
  });
  exchange = signaling.submitMessage("signal-expire", exchange.revision, message("offer-expire", "signal-expire", "OPERATOR", {
    kind: "OFFER", description: { type: "offer", sdp: "v=0\r\ns=temporary\r\n" },
  }, now));
  now = 2_000;
  exchange = signaling.getExchange("signal-expire");
  assert.equal(exchange.status, "EXPIRED");
  assert.equal(exchange.messages.length, 0);

  now = 3_000;
  const active = new InMemoryRealtimeSignaling({ now: () => now, idGenerator: incrementalIds("active") });
  let restartExchange = active.createExchange({
    signalingId: "signal-restart",
    sessionId: "session-restart",
    robotId: "robot-1",
    operatorId: "operator-1",
    leaseExpiresAtUnixMs: 10_000,
  });
  restartExchange = active.submitMessage("signal-restart", restartExchange.revision, message("offer-restart", "signal-restart", "OPERATOR", {
    kind: "OFFER", description: { type: "offer", sdp: "v=0\r\ns=restart\r\n" },
  }, now));
  const restored = new InMemoryRealtimeSignaling({ now: () => now, idGenerator: incrementalIds("restored"), initialState: active.exportState() });
  const invalidated = restored.invalidateActiveAfterRestart();
  assert.equal(invalidated.length, 1);
  assert.equal(invalidated[0]?.status, "EXPIRED");
  assert.equal(invalidated[0]?.messages.length, 0);
  assert.equal(restored.getEvents("signal-restart").at(-1)?.type, "SIGNALING_RESTART_INVALIDATED");
});

test("signaling rejects wrong peer roles, stale messages, oversized SDP, and session conflicts", () => {
  const now = 50_000;
  const signaling = new InMemoryRealtimeSignaling({
    now: () => now,
    idGenerator: incrementalIds("event"),
    maximumMessageAgeMs: 1_000,
    maximumSdpBytes: 32,
  });
  const exchange = signaling.createExchange({
    signalingId: "signal-guard",
    sessionId: "session-guard",
    robotId: "robot-1",
    operatorId: "operator-1",
    leaseExpiresAtUnixMs: 60_000,
  });
  assert.throws(
    () => signaling.createExchange({ signalingId: "other", sessionId: "session-guard", robotId: "robot-1", operatorId: "operator-1", leaseExpiresAtUnixMs: 60_000 }),
    (error) => error instanceof TeleoperationError && error.code === "SIGNALING_SESSION_CONFLICT",
  );
  assert.throws(
    () => signaling.submitMessage("signal-guard", exchange.revision, message("wrong-role", "signal-guard", "ROBOT_EDGE", {
      kind: "OFFER", description: { type: "offer", sdp: "v=0" },
    }, now)),
    (error) => error instanceof TeleoperationError && error.code === "SIGNALING_OFFER_ROLE_INVALID",
  );
  assert.throws(
    () => signaling.submitMessage("signal-guard", exchange.revision, message("stale", "signal-guard", "OPERATOR", {
      kind: "OFFER", description: { type: "offer", sdp: "v=0" },
    }, now - 1_001)),
    (error) => error instanceof TeleoperationError && error.code === "SIGNALING_MESSAGE_STALE",
  );
  assert.throws(
    () => signaling.submitMessage("signal-guard", exchange.revision, message("large", "signal-guard", "OPERATOR", {
      kind: "OFFER", description: { type: "offer", sdp: "v=0".padEnd(33, "x") },
    }, now)),
    (error) => error instanceof TeleoperationError && error.code === "SIGNALING_SDP_TOO_LARGE",
  );
});

function message(
  messageId: string,
  signalingId: string,
  from: RealtimeSignalingPeerRole,
  payload: RealtimeSignalingPayload,
  sentAtUnixMs: number,
): RealtimeSignalingMessage {
  return {
    contractVersion: CONTRACT_VERSION,
    messageId,
    signalingId,
    sessionId: signalingId.replace("signal", "session"),
    from,
    sentAtUnixMs,
    payload,
  };
}

function incrementalIds(prefix: string): () => string {
  let value = 0;
  return () => `${prefix}-${++value}`;
}
