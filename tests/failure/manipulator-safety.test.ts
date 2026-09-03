import assert from "node:assert/strict";
import test from "node:test";
import { LocalRobotAgent } from "../../edge/robot-agent/src/index.ts";
import { CONTRACT_VERSION, TeleoperationError } from "../../packages/contracts/src/index.ts";

test("direct Z1 joint jog requires stopped stance interlocks and times out to hold", () => {
  let nowUnixMs = 10_000;
  let nowMonotonicMs = 0;
  const agent = createAgent(() => nowUnixMs, () => nowMonotonicMs);
  agent.installLease({
    contractVersion: CONTRACT_VERSION,
    sessionId: "session-arm",
    robotId: "robot-1",
    operatorId: "operator-1",
    scopes: ["CONTROL_MANIPULATOR"],
    revision: 1,
    issuedAtUnixMs: nowUnixMs,
    expiresAtUnixMs: nowUnixMs + 5_000,
  });
  let state = agent.requestOwnership("session-arm", "MANIPULATOR");
  state = agent.acknowledgeStopped(state.ownership.revision, {
    observedAtUnixMs: nowUnixMs, controllerStateFresh: true, baseStopped: true, manipulatorHolding: true,
  });
  state = agent.updateManipulatorInterlocks({
    vendorSafetyOk: true,
    controllerHealthy: true,
    robotStateFresh: true,
    baseStopped: true,
    stableStance: true,
    withinJointLimits: true,
    collisionFree: true,
  });
  state = agent.prepareManipulatorSafety(state.manipulatorSafety!.revision);
  state = agent.enableManipulatorSafety(state.manipulatorSafety!.revision);

  nowUnixMs += 20;
  nowMonotonicMs += 20;
  state = agent.acceptCommand({
    contractVersion: CONTRACT_VERSION,
    commandId: "arm-command-1",
    sessionId: "session-arm",
    robotId: "robot-1",
    sourceId: "operator-1",
    actuatorGroup: "MANIPULATOR",
    sequence: 1,
    producedAtUnixMs: nowUnixMs,
    expiresAtUnixMs: nowUnixMs + 150,
    deadman: true,
    intent: { kind: "ARM_MOTION", mode: "JOINT_JOG", frameId: "z1_world", values: [2, 0, 0, 0, 0, 0], speedScale: 0.5, clutch: true },
  });
  assert.equal(state.manipulatorSafety?.output.kind, "JOINT_JOG");
  if (state.manipulatorSafety?.output.kind === "JOINT_JOG") {
    assert.equal(state.manipulatorSafety.output.velocitiesRadiansPerSecond[0], 0.25);
    assert.equal(state.manipulatorSafety.output.limited, true);
  }

  nowUnixMs += 200;
  nowMonotonicMs += 200;
  state = agent.tick();
  assert.equal(state.manipulatorSafety?.status, "HOLDING");
  assert.equal(state.manipulatorSafety?.output.kind, "HOLD");
});

test("direct Z1 preparation fails if base is not stopped", () => {
  const agent = createAgent(() => 1_000, () => 0);
  const state = agent.updateManipulatorInterlocks({
    vendorSafetyOk: true,
    controllerHealthy: true,
    robotStateFresh: true,
    baseStopped: false,
    stableStance: true,
    withinJointLimits: true,
    collisionFree: true,
  });
  assert.throws(
    () => agent.prepareManipulatorSafety(state.manipulatorSafety!.revision),
    (error) => error instanceof TeleoperationError && error.code === "MANIPULATOR_INTERLOCK_FAILED",
  );
});

function createAgent(nowUnixMs: () => number, nowMonotonicMs: () => number): LocalRobotAgent {
  return new LocalRobotAgent({
    robotId: "robot-1",
    nowUnixMs,
    nowMonotonicMs,
    baseSafetyProfile: {
      robotId: "robot-1", commandTimeoutMs: 250, maximumLinearXMetersPerSecond: 1,
      maximumLinearYMetersPerSecond: 1, maximumAngularZRadiansPerSecond: 1,
      maximumLinearAccelerationMetersPerSecondSquared: 1, maximumAngularAccelerationRadiansPerSecondSquared: 1,
    },
    manipulatorSafetyProfile: {
      robotId: "robot-1",
      commandTimeoutMs: 150,
      jointCount: 6,
      maximumJointJogRadiansPerSecond: [0.5, 0.5, 0.5, 0.7, 0.7, 0.7],
      maximumCartesianLinearMetersPerSecond: 0.1,
      maximumCartesianAngularRadiansPerSecond: 0.4,
    },
  });
}
