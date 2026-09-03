import assert from "node:assert/strict";
import test from "node:test";
import { CONTRACT_VERSION, TeleoperationError, type CommandOwnershipState, type ValidatedTeleopCommand } from "../../packages/contracts/src/index.ts";
import { BaseSafetySupervisor } from "../../robot/safety-supervisor/src/index.ts";

const ownership: CommandOwnershipState = {
  robotId: "robot-1",
  revision: 3,
  status: "OWNED",
  owner: { sourceId: "operator-1", authority: "DIRECT_TELEOP", actuatorGroup: "BASE", sessionId: "session-1" },
  changedAtUnixMs: 1_000,
};

const selected: ValidatedTeleopCommand = {
  arrivalMonotonicMs: 10,
  command: {
    contractVersion: CONTRACT_VERSION,
    commandId: "command-1",
    sessionId: "session-1",
    robotId: "robot-1",
    sourceId: "operator-1",
    actuatorGroup: "BASE",
    sequence: 1,
    producedAtUnixMs: 1_000,
    expiresAtUnixMs: 1_250,
    deadman: true,
    intent: {
      kind: "BASE_MOTION",
      frameId: "base_link",
      linearXMetersPerSecond: 1,
      linearYMetersPerSecond: 0,
      angularZRadiansPerSecond: 0,
      speedScale: 1,
    },
  },
};

function createSupervisor(): BaseSafetySupervisor {
  return new BaseSafetySupervisor({
    robotId: "robot-1",
    commandTimeoutMs: 250,
    maximumLinearXMetersPerSecond: 0.7,
    maximumLinearYMetersPerSecond: 0.4,
    maximumAngularZRadiansPerSecond: 0.7,
    maximumLinearAccelerationMetersPerSecondSquared: 0.5,
    maximumAngularAccelerationRadiansPerSecondSquared: 0.7,
  }, 900, 0);
}

test("base safety supervisor requires interlocks and limits acceleration", () => {
  const supervisor = createSupervisor();
  assert.throws(
    () => supervisor.prepare(supervisor.snapshot().revision, 1_000, 0),
    (error) => error instanceof TeleoperationError && error.code === "SAFETY_INTERLOCK_FAILED",
  );
  supervisor.updateInterlocks({ vendorSafetyOk: true, controllerHealthy: true, robotStateFresh: true }, 1_000, 0);
  let state = supervisor.prepare(supervisor.snapshot().revision, 1_001, 0);
  state = supervisor.enable(ownership, state.revision, 1_002, 0);
  state = supervisor.accept(selected, ownership, state.revision, 1_100, 100);
  assert.equal(state.status, "ENABLED");
  assert.equal(state.output.linearXMetersPerSecond, 0.05);
  assert.equal(state.output.limited, true);
});

test("command timeout enters holding with zero output and no automatic resume", () => {
  const supervisor = createSupervisor();
  supervisor.updateInterlocks({ vendorSafetyOk: true, controllerHealthy: true, robotStateFresh: true }, 1_000, 0);
  let state = supervisor.prepare(supervisor.snapshot().revision, 1_001, 0);
  state = supervisor.enable(ownership, state.revision, 1_002, 0);
  state = supervisor.accept(selected, ownership, state.revision, 1_100, 100);
  state = supervisor.tick(state.revision, 1_260, 260);
  assert.equal(state.status, "HOLDING");
  assert.equal(state.output.linearXMetersPerSecond, 0);
  assert.throws(
    () => supervisor.accept({ ...selected, arrivalMonotonicMs: 261 }, ownership, state.revision, 1_261, 261),
    (error) => error instanceof TeleoperationError && error.code === "SAFETY_NOT_ENABLED",
  );
});
