import assert from "node:assert/strict";
import test from "node:test";
import { CONTRACT_VERSION, TeleoperationError, type TeleopSessionLease } from "../../packages/contracts/src/index.ts";
import { MobileCommandController, type MobileReadiness } from "../../packages/operator-client-core/src/index.ts";

const READY: MobileReadiness = {
  appForeground: true,
  screenUnlocked: true,
  realtimeConnected: true,
  ownershipGranted: true,
  robotSafetyEnabled: true,
};

function lease(scopes: TeleopSessionLease["scopes"], expiresAtUnixMs = 20_000): TeleopSessionLease {
  return {
    contractVersion: CONTRACT_VERSION,
    sessionId: "mobile-session-1",
    robotId: "b2-unit-001",
    operatorId: "mobile-operator-1",
    scopes,
    revision: 1,
    issuedAtUnixMs: 10_000,
    expiresAtUnixMs,
  };
}

function baseController(now: () => number): MobileCommandController {
  let id = 0;
  return new MobileCommandController({
    lease: lease(["OBSERVE", "CONTROL_BASE"]),
    idGenerator: () => `mobile-command-${++id}`,
    nowUnixMs: now,
    commandLifetimeMs: 150,
    baseLimits: {
      maximumLinearXMetersPerSecond: 0.7,
      maximumLinearYMetersPerSecond: 0.4,
      maximumAngularZRadiansPerSecond: 0.8,
    },
  });
}

test("mobile base input produces bounded, expiring, sequenced canonical commands", () => {
  let now = 10_100;
  const controller = baseController(() => now);
  assert.equal(controller.snapshot().state, "OBSERVE_ONLY");
  assert.equal(controller.updateReadiness(READY).state, "READY");
  assert.equal(controller.setDeadman(true).state, "COMMANDING");
  assert.equal(controller.updateReadiness(READY).state, "COMMANDING");

  const first = controller.createBaseCommand(0.5, -2, 0.25, 0.6);
  assert.equal(first.commandId, "mobile-command-1");
  assert.equal(first.sequence, 1);
  assert.equal(first.expiresAtUnixMs - first.producedAtUnixMs, 150);
  assert.equal(first.deadman, true);
  assert.equal(first.intent.kind, "BASE_MOTION");
  if (first.intent.kind !== "BASE_MOTION") assert.fail("Expected base motion.");
  assert.equal(first.intent.linearXMetersPerSecond, 0.35);
  assert.equal(first.intent.linearYMetersPerSecond, -0.4);
  assert.equal(first.intent.angularZRadiansPerSecond, 0.2);
  assert.equal(first.intent.speedScale, 0.6);

  now += 20;
  assert.equal(controller.createBaseCommand(0, 0, 0).sequence, 2);
});

test("backgrounding clears input and foreground return requires a fresh deadman edge", () => {
  const controller = baseController(() => 10_100);
  controller.updateReadiness(READY);
  controller.setDeadman(true);
  controller.updateReadiness({ ...READY, appForeground: false });
  let snapshot = controller.snapshot();
  assert.equal(snapshot.state, "HOLDING");
  assert.equal(snapshot.deadmanHeld, false);
  assert.equal(snapshot.clutchHeld, false);
  assert.throws(
    () => controller.createBaseCommand(1, 0, 0),
    (error) => error instanceof TeleoperationError && error.code === "MOBILE_COMMAND_NOT_ARMED",
  );

  snapshot = controller.updateReadiness(READY);
  assert.equal(snapshot.state, "HOLDING");
  assert.throws(
    () => controller.createBaseCommand(1, 0, 0),
    (error) => error instanceof TeleoperationError && error.code === "MOBILE_COMMAND_NOT_ARMED",
  );
  assert.throws(
    () => controller.setDeadman(true),
    (error) => error instanceof TeleoperationError && error.code === "MOBILE_DEADMAN_RELEASE_REQUIRED",
  );
  controller.setDeadman(false);
  controller.setDeadman(true);
  assert.equal(controller.createBaseCommand(1, 0, 0).sequence, 1);
});

test("screen lock and connection loss each force a non-resuming hold", () => {
  const controller = baseController(() => 10_100);
  controller.updateReadiness(READY);
  controller.setDeadman(true);
  assert.equal(controller.updateReadiness({ ...READY, screenUnlocked: false }).state, "HOLDING");
  controller.updateReadiness(READY);
  controller.setDeadman(false);
  controller.setDeadman(true);
  assert.equal(controller.updateReadiness({ ...READY, realtimeConnected: false }).state, "HOLDING");
  assert.equal(controller.snapshot().deadmanHeld, false);
});

test("mobile Z1 motion requires manipulator scope, correct joint count, deadman, and clutch", () => {
  let id = 0;
  const controller = new MobileCommandController({
    lease: lease(["CONTROL_MANIPULATOR"]),
    idGenerator: () => `arm-command-${++id}`,
    nowUnixMs: () => 10_100,
    manipulatorLimits: {
      jointCount: 6,
      maximumCartesianLinearMetersPerSecond: 0.2,
      maximumCartesianAngularRadiansPerSecond: 0.4,
    },
  });
  controller.updateReadiness(READY);
  controller.setDeadman(true);
  assert.throws(
    () => controller.createJointJog([0, 0, 0, 0, 0, 0]),
    (error) => error instanceof TeleoperationError && error.code === "MOBILE_CLUTCH_REQUIRED",
  );
  controller.setClutch(true);
  assert.equal(controller.setDeadman(true).clutchHeld, true);
  assert.throws(
    () => controller.createJointJog([0, 0]),
    (error) => error instanceof TeleoperationError && error.code === "MOBILE_JOINT_COUNT_INVALID",
  );

  const joint = controller.createJointJog([2, -2, 0, 0, 0, 0], 0.5);
  assert.equal(joint.intent.kind, "ARM_MOTION");
  if (joint.intent.kind !== "ARM_MOTION") assert.fail("Expected arm motion.");
  assert.deepEqual(joint.intent.values, [1, -1, 0, 0, 0, 0]);
  assert.equal(joint.intent.clutch, true);

  const cartesian = controller.createCartesianTwist([1, -1, 0.5, 1, 0, -1]);
  assert.equal(cartesian.intent.kind, "ARM_MOTION");
  if (cartesian.intent.kind !== "ARM_MOTION") assert.fail("Expected arm motion.");
  assert.deepEqual(cartesian.intent.values, [0.2, -0.2, 0.1, 0.4, 0, -0.4]);
  assert.equal(controller.createGripperCommand(1.4, -0.2).intent.kind, "GRIPPER");
});

test("expired leases and controller restart cannot restore mobile motion", () => {
  let now = 10_100;
  const first = baseController(() => now);
  first.updateReadiness(READY);
  first.setDeadman(true);
  now = 20_000;
  assert.throws(
    () => first.createBaseCommand(1, 0, 0),
    (error) => error instanceof TeleoperationError && error.code === "MOBILE_LEASE_EXPIRED",
  );
  assert.equal(first.snapshot().state, "HOLDING");
  assert.equal(first.snapshot().deadmanHeld, false);

  now = 10_200;
  const restarted = baseController(() => now);
  assert.equal(restarted.snapshot().state, "OBSERVE_ONLY");
  assert.throws(
    () => restarted.createBaseCommand(1, 0, 0),
    (error) => error instanceof TeleoperationError && error.code === "MOBILE_COMMAND_NOT_ARMED",
  );
  restarted.close();
  assert.throws(
    () => restarted.setDeadman(true),
    (error) => error instanceof TeleoperationError && error.code === "MOBILE_CONTROLLER_CLOSED",
  );
});
