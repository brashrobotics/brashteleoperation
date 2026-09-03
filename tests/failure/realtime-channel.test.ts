import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { LocalRobotAgent, RealtimeCommandChannel } from "../../edge/robot-agent/src/index.ts";
import { CONTRACT_VERSION, Ed25519LeaseSigner, Ed25519LeaseVerifier } from "../../packages/contracts/src/index.ts";

test("heartbeat loss revokes lease, zeros output, and never resumes a command", () => {
  let nowUnixMs = 10_000;
  let nowMonotonicMs = 0;
  const agent = new LocalRobotAgent({
    robotId: "robot-1",
    nowUnixMs: () => nowUnixMs,
    nowMonotonicMs: () => nowMonotonicMs,
    baseSafetyProfile: {
      robotId: "robot-1",
      commandTimeoutMs: 250,
      maximumLinearXMetersPerSecond: 0.7,
      maximumLinearYMetersPerSecond: 0.4,
      maximumAngularZRadiansPerSecond: 0.7,
      maximumLinearAccelerationMetersPerSecondSquared: 0.5,
      maximumAngularAccelerationRadiansPerSecondSquared: 0.7,
    },
  });
  const channel = new RealtimeCommandChannel({
    sessionId: "session-1",
    agent,
    nowUnixMs: () => nowUnixMs,
    nowMonotonicMs: () => nowMonotonicMs,
    heartbeatTimeoutMs: 100,
  });
  channel.open({
    contractVersion: CONTRACT_VERSION,
    sessionId: "session-1",
    robotId: "robot-1",
    operatorId: "operator-1",
    scopes: ["CONTROL_BASE"],
    revision: 1,
    issuedAtUnixMs: nowUnixMs,
    expiresAtUnixMs: nowUnixMs + 5_000,
  });
  let state = agent.requestOwnership("session-1", "BASE");
  state = agent.acknowledgeStopped(state.ownership.revision, {
    observedAtUnixMs: nowUnixMs, controllerStateFresh: true, baseStopped: true, manipulatorHolding: true,
  });
  state = agent.updateBaseInterlocks({ vendorSafetyOk: true, controllerHealthy: true, robotStateFresh: true });
  state = agent.prepareBaseSafety(state.baseSafety.revision);
  state = agent.enableBaseSafety(state.baseSafety.revision);

  nowUnixMs += 10;
  nowMonotonicMs += 10;
  const acknowledgement = channel.receive({
    contractVersion: CONTRACT_VERSION,
    commandId: "command-1",
    sessionId: "session-1",
    robotId: "robot-1",
    sourceId: "operator-1",
    actuatorGroup: "BASE",
    sequence: 1,
    producedAtUnixMs: nowUnixMs,
    expiresAtUnixMs: nowUnixMs + 200,
    deadman: true,
    intent: {
      kind: "BASE_MOTION",
      frameId: "base_link",
      linearXMetersPerSecond: 0.2,
      linearYMetersPerSecond: 0,
      angularZRadiansPerSecond: 0,
      speedScale: 1,
    },
  });
  assert.equal(acknowledgement.accepted, true);
  assert.ok(acknowledgement.acceptedOutput && "linearXMetersPerSecond" in acknowledgement.acceptedOutput
    && acknowledgement.acceptedOutput.linearXMetersPerSecond > 0);

  nowUnixMs += 101;
  nowMonotonicMs += 101;
  assert.equal(channel.tick(), "HOLDING");
  state = agent.state();
  assert.equal(state.baseSafety.output.linearXMetersPerSecond, 0);
  assert.equal(state.baseSafety.status, "HOLDING");
  assert.equal(state.installedLeases.length, 0);
  assert.equal(state.ownership.status, "HANDOFF");
  assert.equal(channel.snapshot().events.at(-1)?.type, "CHANNEL_HOLD");
});

test("invalid realtime payload returns a bounded rejection acknowledgement", () => {
  const agent = new LocalRobotAgent({
    robotId: "robot-1",
    baseSafetyProfile: {
      robotId: "robot-1", commandTimeoutMs: 250, maximumLinearXMetersPerSecond: 1,
      maximumLinearYMetersPerSecond: 1, maximumAngularZRadiansPerSecond: 1,
      maximumLinearAccelerationMetersPerSecondSquared: 1, maximumAngularAccelerationRadiansPerSecondSquared: 1,
    },
  });
  const now = Date.now();
  const channel = new RealtimeCommandChannel({ sessionId: "session-1", agent, maximumEvents: 2 });
  channel.open({
    contractVersion: CONTRACT_VERSION, sessionId: "session-1", robotId: "robot-1", operatorId: "operator-1",
    scopes: ["CONTROL_BASE"], revision: 1, issuedAtUnixMs: now, expiresAtUnixMs: now + 5_000,
  });
  const rejected = channel.receive({ commandId: "bad", unexpected: true });
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.commandId, "bad");
  assert.ok(rejected.rejectionCode);
});

test("realtime channel opens with a signed lease and rejects invalid resource bounds", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const now = 50_000;
  const agent = new LocalRobotAgent({
    robotId: "robot-1",
    nowUnixMs: () => now,
    leaseVerifier: new Ed25519LeaseVerifier(new Map([["key-1", publicKey]])),
    requireSignedLeases: true,
    baseSafetyProfile: {
      robotId: "robot-1", commandTimeoutMs: 250, maximumLinearXMetersPerSecond: 1,
      maximumLinearYMetersPerSecond: 1, maximumAngularZRadiansPerSecond: 1,
      maximumLinearAccelerationMetersPerSecondSquared: 1, maximumAngularAccelerationRadiansPerSecondSquared: 1,
    },
  });
  const channel = new RealtimeCommandChannel({ sessionId: "session-signed", agent });
  const signed = new Ed25519LeaseSigner("key-1", privateKey).sign({
    contractVersion: CONTRACT_VERSION,
    sessionId: "session-signed",
    robotId: "robot-1",
    operatorId: "operator-1",
    scopes: ["CONTROL_BASE"],
    revision: 1,
    issuedAtUnixMs: now,
    expiresAtUnixMs: now + 5_000,
  });
  assert.equal(channel.openSigned(signed).installedLeases.length, 1);
  assert.throws(() => new RealtimeCommandChannel({ sessionId: "bad", agent, maximumEvents: 0 }));
  assert.throws(() => new RealtimeCommandChannel({ sessionId: "bad", agent, heartbeatTimeoutMs: -1 }));
});
