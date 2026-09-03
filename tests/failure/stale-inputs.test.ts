import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTRACT_VERSION,
  TeleoperationError,
  type TeleopCommandEnvelope,
  type TeleopSessionLease,
} from "../../packages/contracts/src/index.ts";
import { TeleopCommandValidator } from "../../edge/robot-agent/src/index.ts";
import { CommandArbiter } from "../../robot/command-arbiter/src/index.ts";

function command(): TeleopCommandEnvelope {
  return {
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
      linearXMetersPerSecond: 0.1,
      linearYMetersPerSecond: 0,
      angularZRadiansPerSecond: 0,
      speedScale: 0.2,
    },
  };
}

const lease: TeleopSessionLease = {
  contractVersion: CONTRACT_VERSION,
  sessionId: "session-1",
  robotId: "robot-1",
  operatorId: "operator-1",
  scopes: ["CONTROL_BASE"],
  revision: 1,
  issuedAtUnixMs: 900,
  expiresAtUnixMs: 2_000,
};

test("stale commands and expired leases fail closed", () => {
  assert.throws(
    () => new TeleopCommandValidator().validate(command(), lease, 1_250, 10),
    (error) => error instanceof TeleoperationError && error.code === "COMMAND_STALE",
  );
  assert.throws(
    () => new TeleopCommandValidator().validate(command(), { ...lease, expiresAtUnixMs: 1_100 }, 1_100, 10),
    (error) => error instanceof TeleoperationError && error.code === "COMMAND_LEASE_EXPIRED",
  );
});

test("commands are blocked throughout a stopped ownership handoff", () => {
  const validator = new TeleopCommandValidator();
  const validated = validator.validate(command(), lease, 1_100, 10);
  const arbiter = new CommandArbiter("robot-1", 900);
  let ownership = arbiter.requestOwnership({
    requestId: "owner-1",
    robotId: "robot-1",
    sourceId: "operator-1",
    authority: "DIRECT_TELEOP",
    actuatorGroup: "BASE",
    sessionId: "session-1",
    requestedAtUnixMs: 1_000,
  }, arbiter.snapshot().revision);
  assert.equal(ownership.status, "HANDOFF");
  assert.throws(
    () => arbiter.selectCommand(validated),
    (error) => error instanceof TeleoperationError && error.code === "COMMAND_OWNER_REQUIRED",
  );
  ownership = arbiter.acknowledgeStopped(ownership.revision, 1_001);
  assert.equal(arbiter.selectCommand(validated).command.commandId, "command-1");
  ownership = arbiter.forceStop(ownership.revision, 1_002, "Injected safety fault.");
  assert.equal(ownership.status, "HANDOFF");
  assert.throws(
    () => arbiter.selectCommand(validated),
    (error) => error instanceof TeleoperationError && error.code === "COMMAND_OWNER_REQUIRED",
  );
});
