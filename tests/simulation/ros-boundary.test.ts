import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadRobotProfile } from "../../config/robot-profiles/src/index.ts";
import { TeleoperationError } from "../../packages/contracts/src/index.ts";
import { UnitreeB2Z1RosBoundary, DEFAULT_B2_Z1_TOPICS } from "../../robot/adapters/unitree-b2-z1/src/index.ts";
import { CommandArbiter } from "../../robot/command-arbiter/src/index.ts";
import { BaseSafetySupervisor, ManipulatorSafetySupervisor } from "../../robot/safety-supervisor/src/index.ts";

test("ROS boundary publishes only guarded simulation output and keeps physical output disabled", async () => {
  const profileDirectory = fileURLToPath(new URL("../../config/robot-profiles/", import.meta.url));
  const simulation = await loadRobotProfile(`${profileDirectory}/b2-z1.simulation.json`);
  const physical = await loadRobotProfile(`${profileDirectory}/b2-z1.physical-candidate.json`);
  const published: Array<{ topic: string; type: string; message: unknown }> = [];
  const publisher = { publish: (topic: string, type: string, message: unknown) => published.push({ topic, type, message }) };
  const boundary = new UnitreeB2Z1RosBoundary({
    robotId: "robot-1",
    profile: simulation,
    topics: DEFAULT_B2_Z1_TOPICS,
    publisher,
    allowSimulationPublish: true,
  });
  const telemetry = boundary.ingest({
    sourceTimestampUnixMs: 1_000,
    observedAtUnixMs: 1_010,
    twist: { linearX: 0, linearY: 0, angularZ: 0 },
    jointPositionsRadians: [0, 0, 0, 0, 0, 0],
    controllerHealthy: true,
  });
  assert.equal(telemetry.armJointPositionsRadians.length, 6);
  assert.equal(boundary.state(1_100).controllerHealthy, true);

  const arbiter = new CommandArbiter("robot-1", 1_000);
  let ownership = arbiter.requestOwnership({
    requestId: "ownership-1",
    robotId: "robot-1",
    sourceId: "operator-1",
    authority: "DIRECT_TELEOP",
    actuatorGroup: "BASE",
    sessionId: "session-1",
    requestedAtUnixMs: 1_000,
  }, arbiter.snapshot().revision);
  ownership = arbiter.acknowledgeStopped(ownership.revision, 1_001);
  const safety = new BaseSafetySupervisor({
    robotId: "robot-1",
    commandTimeoutMs: 250,
    maximumLinearXMetersPerSecond: 0.7,
    maximumLinearYMetersPerSecond: 0.4,
    maximumAngularZRadiansPerSecond: 0.7,
    maximumLinearAccelerationMetersPerSecondSquared: 0.5,
    maximumAngularAccelerationRadiansPerSecondSquared: 0.7,
  }, 1_000, 0);
  safety.updateInterlocks({ vendorSafetyOk: true, controllerHealthy: true, robotStateFresh: true }, 1_001, 1);
  safety.prepare(safety.snapshot().revision, 1_002, 2);
  const enabled = safety.enable(ownership, safety.snapshot().revision, 1_003, 3);
  boundary.publishSimulatedBaseCommand({ ownership, safety: enabled, expectedSafetyRevision: enabled.revision });
  assert.equal(published[0]?.topic, "/b2/command/cmd_vel");

  const armArbiter = new CommandArbiter("robot-1", 1_000);
  let armOwnership = armArbiter.requestOwnership({
    requestId: "ownership-arm-1",
    robotId: "robot-1",
    sourceId: "operator-1",
    authority: "DIRECT_TELEOP",
    actuatorGroup: "MANIPULATOR",
    sessionId: "session-arm-1",
    requestedAtUnixMs: 1_000,
  }, armArbiter.snapshot().revision);
  armOwnership = armArbiter.acknowledgeStopped(armOwnership.revision, 1_001);
  const armSafety = new ManipulatorSafetySupervisor({
    robotId: "robot-1",
    commandTimeoutMs: 200,
    jointCount: 6,
    maximumJointJogRadiansPerSecond: [0.5, 0.5, 0.5, 0.7, 0.7, 0.7],
    maximumCartesianLinearMetersPerSecond: 0.12,
    maximumCartesianAngularRadiansPerSecond: 0.4,
  }, 1_000, 0);
  armSafety.updateInterlocks({
    vendorSafetyOk: true,
    controllerHealthy: true,
    robotStateFresh: true,
    baseStopped: true,
    stableStance: true,
    withinJointLimits: true,
    collisionFree: true,
  }, 1_001, 1);
  armSafety.prepare(armSafety.snapshot().revision, 1_002, 2);
  armSafety.enable(armOwnership, armSafety.snapshot().revision, 1_003, 3);
  const armEnabled = armSafety.accept({
    arrivalMonotonicMs: 4,
    command: {
      contractVersion: { major: 1, minor: 0 },
      commandId: "arm-command-1",
      sessionId: "session-arm-1",
      robotId: "robot-1",
      sourceId: "operator-1",
      actuatorGroup: "MANIPULATOR",
      sequence: 1,
      producedAtUnixMs: 1_004,
      expiresAtUnixMs: 1_200,
      deadman: true,
      intent: { kind: "ARM_MOTION", mode: "JOINT_JOG", frameId: "z1_world", values: [0.2, 0, 0, 0, 0, 0], speedScale: 1, clutch: true },
    },
  }, armOwnership, armSafety.snapshot().revision, 1_004, 4);
  boundary.publishSimulatedManipulatorCommand({
    ownership: armOwnership,
    safety: armEnabled,
    expectedSafetyRevision: armEnabled.revision,
  });
  assert.equal(published[1]?.topic, "/b2/z1/servo_node/delta_joint_cmds");
  assert.equal(published[1]?.type, "control_msgs/msg/JointJog");

  const physicalBoundary = new UnitreeB2Z1RosBoundary({
    robotId: "robot-1",
    profile: physical,
    topics: DEFAULT_B2_Z1_TOPICS,
    publisher,
    allowSimulationPublish: true,
  });
  assert.throws(
    () => physicalBoundary.publishSimulatedBaseCommand({ ownership, safety: enabled, expectedSafetyRevision: enabled.revision }),
    (error) => error instanceof TeleoperationError && error.code === "PHYSICAL_COMMAND_PATH_DISABLED",
  );
  assert.throws(
    () => physicalBoundary.publishSimulatedManipulatorCommand({ ownership: armOwnership, safety: armEnabled, expectedSafetyRevision: armEnabled.revision }),
    (error) => error instanceof TeleoperationError && error.code === "PHYSICAL_COMMAND_PATH_DISABLED",
  );
  assert.equal(physicalBoundary.physicalCommandPathStatus().enabled, false);
});

test("ROS boundary rejects direct guarded-hardware output topics", async () => {
  const profileDirectory = fileURLToPath(new URL("../../config/robot-profiles/", import.meta.url));
  const simulation = await loadRobotProfile(`${profileDirectory}/b2-z1.simulation.json`);
  assert.throws(
    () => new UnitreeB2Z1RosBoundary({
      robotId: "robot-1",
      profile: simulation,
      topics: { ...DEFAULT_B2_Z1_TOPICS, baseCommandInput: "hardware/cmd_vel_guarded" },
      publisher: { publish: () => undefined },
    }),
    (error) => error instanceof TeleoperationError && error.code === "ROS_TOPIC_PROFILE_UNSAFE",
  );
});
