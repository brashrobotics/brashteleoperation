import assert from "node:assert/strict";
import test from "node:test";
import { LocalRobotAgent } from "../../edge/robot-agent/src/index.ts";
import { CONTRACT_VERSION, type TeleopSessionLease } from "../../packages/contracts/src/index.ts";
import { MobileCommandController, type MobileReadiness } from "../../packages/operator-client-core/src/index.ts";

test("mobile command envelopes enter the normal edge path and interruption ends in robot-local hold", () => {
  let nowUnixMs = 10_000;
  let nowMonotonicMs = 0;
  const lease: TeleopSessionLease = {
    contractVersion: CONTRACT_VERSION,
    sessionId: "mobile-session-1",
    robotId: "b2-unit-001",
    operatorId: "mobile-operator-1",
    scopes: ["OBSERVE", "CONTROL_BASE"],
    revision: 1,
    issuedAtUnixMs: nowUnixMs,
    expiresAtUnixMs: nowUnixMs + 10_000,
  };
  const agent = new LocalRobotAgent({
    robotId: lease.robotId,
    nowUnixMs: () => nowUnixMs,
    nowMonotonicMs: () => nowMonotonicMs,
    idGenerator: () => "ownership-1",
    baseSafetyProfile: {
      robotId: lease.robotId,
      commandTimeoutMs: 250,
      maximumLinearXMetersPerSecond: 0.7,
      maximumLinearYMetersPerSecond: 0.4,
      maximumAngularZRadiansPerSecond: 0.8,
      maximumLinearAccelerationMetersPerSecondSquared: 1,
      maximumAngularAccelerationRadiansPerSecondSquared: 1,
    },
  });
  agent.installLease(lease);
  let edge = agent.requestOwnership(lease.sessionId, "BASE");
  edge = agent.acknowledgeStopped(edge.ownership.revision, {
    observedAtUnixMs: nowUnixMs,
    controllerStateFresh: true,
    baseStopped: true,
    manipulatorHolding: true,
  });
  edge = agent.updateBaseInterlocks({ vendorSafetyOk: true, controllerHealthy: true, robotStateFresh: true });
  edge = agent.prepareBaseSafety(edge.baseSafety.revision);
  edge = agent.enableBaseSafety(edge.baseSafety.revision);

  let commandId = 0;
  const client = new MobileCommandController({
    lease,
    idGenerator: () => `mobile-command-${++commandId}`,
    nowUnixMs: () => nowUnixMs,
    baseLimits: {
      maximumLinearXMetersPerSecond: 0.7,
      maximumLinearYMetersPerSecond: 0.4,
      maximumAngularZRadiansPerSecond: 0.8,
    },
  });
  const ready: MobileReadiness = {
    appForeground: true,
    screenUnlocked: true,
    realtimeConnected: true,
    ownershipGranted: true,
    robotSafetyEnabled: true,
  };
  client.updateReadiness(ready);
  client.setDeadman(true);
  nowUnixMs += 100;
  nowMonotonicMs += 100;
  edge = agent.acceptCommand(client.createBaseCommand(0.5, 0, 0, 1));
  assert.equal(edge.baseSafety.status, "ENABLED");
  assert.equal(edge.baseSafety.lastAcceptedCommandId, "mobile-command-1");
  assert.ok(edge.baseSafety.output.linearXMetersPerSecond > 0);

  client.updateReadiness({ ...ready, appForeground: false });
  assert.equal(client.snapshot().state, "HOLDING");
  assert.equal(client.snapshot().deadmanHeld, false);
  nowUnixMs += 251;
  nowMonotonicMs += 251;
  edge = agent.tick();
  assert.equal(edge.baseSafety.status, "HOLDING");
  assert.equal(edge.baseSafety.output.linearXMetersPerSecond, 0);
});
