import assert from "node:assert/strict";
import test from "node:test";
import { CONTRACT_VERSION, TeleoperationError } from "../../packages/contracts/src/index.ts";
import { LocalRobotAgent } from "../../edge/robot-agent/src/index.ts";

function fixture() {
  let nowUnixMs = 1_000;
  let nowMonotonicMs = 0;
  const agent = new LocalRobotAgent({
    robotId: "robot-1",
    nowUnixMs: () => nowUnixMs,
    nowMonotonicMs: () => nowMonotonicMs,
    idGenerator: () => "ownership-1",
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
  const lease = {
    contractVersion: CONTRACT_VERSION,
    sessionId: "session-1",
    robotId: "robot-1",
    operatorId: "operator-1",
    scopes: ["CONTROL_BASE"] as const,
    revision: 1,
    issuedAtUnixMs: nowUnixMs,
    expiresAtUnixMs: nowUnixMs + 1_000,
  };
  return {
    agent,
    lease,
    setTime(unixMs: number, monotonicMs: number) {
      nowUnixMs = unixMs;
      nowMonotonicMs = monotonicMs;
    },
  };
}

test("revoking a lease during stopped handoff clears the pending owner", () => {
  const { agent, lease } = fixture();
  agent.installLease(lease);
  let state = agent.requestOwnership(lease.sessionId, "BASE");
  assert.equal(state.ownership.status, "HANDOFF");
  assert.equal(state.ownership.pendingOwner?.sessionId, lease.sessionId);
  state = agent.revokeLease(lease.sessionId, "Operator authorization revoked.");
  assert.equal(state.ownership.status, "HANDOFF");
  assert.equal(state.ownership.pendingOwner, undefined);
  assert.throws(
    () => agent.acknowledgeStopped(state.ownership.revision, { ...stoppedEvidence(1_000), baseStopped: false }),
    (error) => error instanceof TeleoperationError && error.code === "ROBOT_STOP_EVIDENCE_INVALID",
  );
  state = agent.acknowledgeStopped(state.ownership.revision, stoppedEvidence(1_000));
  assert.equal(state.ownership.status, "NO_OWNER");
});

test("initial edge agent refuses manipulator ownership until its safety path exists", () => {
  const { agent, lease } = fixture();
  agent.installLease({ ...lease, scopes: ["CONTROL_MANIPULATOR"] });
  assert.throws(
    () => agent.requestOwnership(lease.sessionId, "MANIPULATOR"),
    (error) => error instanceof TeleoperationError && error.code === "EDGE_ACTUATOR_UNSUPPORTED",
  );
});

test("lease expiry removes authorization and forces owned base into handoff", () => {
  const { agent, lease, setTime } = fixture();
  agent.installLease(lease);
  let state = agent.requestOwnership(lease.sessionId, "BASE");
  state = agent.acknowledgeStopped(state.ownership.revision, stoppedEvidence(1_000));
  agent.updateBaseInterlocks({ vendorSafetyOk: true, controllerHealthy: true, robotStateFresh: true });
  state = agent.prepareBaseSafety(state.baseSafety.revision);
  state = agent.enableBaseSafety(state.baseSafety.revision);
  assert.equal(state.baseSafety.status, "ENABLED");
  setTime(lease.expiresAtUnixMs, 1_000);
  state = agent.tick();
  assert.equal(state.installedLeases.length, 0);
  assert.equal(state.ownership.status, "HANDOFF");
  assert.equal(state.ownership.pendingOwner, undefined);
  assert.equal(state.baseSafety.status, "HOLDING");
  state = agent.acknowledgeStopped(state.ownership.revision, stoppedEvidence(2_000));
  assert.equal(state.ownership.status, "NO_OWNER");
});

function stoppedEvidence(observedAtUnixMs: number) {
  return { observedAtUnixMs, controllerStateFresh: true, baseStopped: true, manipulatorHolding: true };
}
