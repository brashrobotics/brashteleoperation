import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CONTRACT_VERSION } from "../../packages/contracts/src/index.ts";
import { ControlPlaneRuntime } from "../../services/control-plane-runtime/src/index.ts";

test("control-plane restart invalidates and durably scrubs active signaling material", async () => {
  const directory = await mkdtemp(join(tmpdir(), "brash-signaling-restart-"));
  const stateFilePath = join(directory, "control.json");
  let now = 1_000;
  try {
    let runtime = await ControlPlaneRuntime.open({ stateFilePath, now: () => now });
    let session = runtime.sessions.requestSession({
      sessionId: "session-1",
      robotId: "robot-1",
      operatorId: "operator-1",
      scopes: ["OBSERVE"],
    });
    session = runtime.sessions.grantSession(session.sessionId, session.revision, 4_000);
    let exchange = runtime.signaling.createExchange({
      signalingId: "signal-1",
      sessionId: session.sessionId,
      robotId: session.robotId,
      operatorId: session.operatorId,
      leaseExpiresAtUnixMs: session.lease!.expiresAtUnixMs,
    });
    exchange = runtime.signaling.submitMessage(exchange.signalingId, exchange.revision, {
      contractVersion: CONTRACT_VERSION,
      messageId: "offer-1",
      signalingId: exchange.signalingId,
      sessionId: session.sessionId,
      from: "OPERATOR",
      sentAtUnixMs: now,
      payload: { kind: "OFFER", description: { type: "offer", sdp: "v=0\r\ns=temporary secret\r\n" } },
    });
    assert.equal(exchange.messages.length, 1);
    await runtime.persist();

    now += 100;
    runtime = await ControlPlaneRuntime.open({ stateFilePath, now: () => now });
    exchange = runtime.signaling.getExchange("signal-1");
    assert.equal(exchange.status, "EXPIRED");
    assert.equal(exchange.messages.length, 0);
    assert.equal(runtime.signaling.getEvents("signal-1").at(-1)?.type, "SIGNALING_RESTART_INVALIDATED");
    const revisionAfterInvalidation = exchange.revision;

    runtime = await ControlPlaneRuntime.open({ stateFilePath, now: () => now });
    exchange = runtime.signaling.getExchange("signal-1");
    assert.equal(exchange.revision, revisionAfterInvalidation);
    assert.equal(exchange.messages.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
