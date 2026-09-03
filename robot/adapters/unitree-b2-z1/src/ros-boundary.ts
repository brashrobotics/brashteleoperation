import type { RobotProfile } from "../../../../config/robot-profiles/src/index.ts";
import { clone, fail, type CommandOwnershipState } from "../../../../packages/contracts/src/index.ts";
import type { BaseSafetyState, ManipulatorSafetyState } from "../../../safety-supervisor/src/index.ts";

export interface B2Z1RosTopics {
  namespace: string;
  baseCommandInput: string;
  baseGuardEnable: string;
  baseOdometry: string;
  jointStates: string;
  armTrajectory: string;
  armJointJog: string;
  armCartesianTwist: string;
  gripperCommand: string;
  rgbImage: string;
  depthImage: string;
}

export interface Ros2PublishPort {
  publish(topic: string, messageType: string, message: unknown): void;
}

export interface NormalizedB2Z1Telemetry {
  robotId: string;
  sourceTimestampUnixMs: number;
  observedAtUnixMs: number;
  baseLinearXMetersPerSecond: number;
  baseLinearYMetersPerSecond: number;
  baseAngularZRadiansPerSecond: number;
  armJointPositionsRadians: readonly number[];
  controllerHealthy: boolean;
}

export interface RawB2Z1Telemetry {
  sourceTimestampUnixMs: number;
  observedAtUnixMs: number;
  twist: { linearX: number; linearY: number; angularZ: number };
  jointPositionsRadians: readonly number[];
  controllerHealthy: boolean;
}

export class UnitreeB2Z1RosBoundary {
  private readonly robotId: string;
  private readonly profile: RobotProfile;
  private readonly topics: B2Z1RosTopics;
  private readonly publisher: Ros2PublishPort;
  private readonly allowSimulationPublish: boolean;
  private telemetry?: NormalizedB2Z1Telemetry;

  constructor(input: {
    robotId: string;
    profile: RobotProfile;
    topics: B2Z1RosTopics;
    publisher: Ros2PublishPort;
    allowSimulationPublish?: boolean;
  }) {
    if (!input.robotId.trim()) throw new Error("robotId is required.");
    validateTopics(input.topics);
    this.robotId = input.robotId;
    this.profile = clone(input.profile);
    this.topics = clone(input.topics);
    this.publisher = input.publisher;
    this.allowSimulationPublish = input.allowSimulationPublish ?? false;
  }

  ingest(sample: RawB2Z1Telemetry): NormalizedB2Z1Telemetry {
    const numeric = [sample.sourceTimestampUnixMs, sample.observedAtUnixMs, sample.twist.linearX, sample.twist.linearY,
      sample.twist.angularZ, ...sample.jointPositionsRadians];
    if (numeric.some((value) => !Number.isFinite(value))) fail("ROS_TELEMETRY_INVALID", "B2/Z1 telemetry contains non-finite values.");
    if (sample.jointPositionsRadians.length !== 6) fail("ROS_Z1_JOINT_COUNT_INVALID", "Expected six Z1 joint positions.");
    if (sample.observedAtUnixMs < sample.sourceTimestampUnixMs) fail("ROS_TELEMETRY_TIME_INVALID", "Observed time precedes source time.");
    this.telemetry = {
      robotId: this.robotId,
      sourceTimestampUnixMs: sample.sourceTimestampUnixMs,
      observedAtUnixMs: sample.observedAtUnixMs,
      baseLinearXMetersPerSecond: sample.twist.linearX,
      baseLinearYMetersPerSecond: sample.twist.linearY,
      baseAngularZRadiansPerSecond: sample.twist.angularZ,
      armJointPositionsRadians: [...sample.jointPositionsRadians],
      controllerHealthy: sample.controllerHealthy,
    };
    return clone(this.telemetry);
  }

  state(nowUnixMs: number, maximumAgeMs = 500): NormalizedB2Z1Telemetry {
    if (!this.telemetry) fail("ROS_TELEMETRY_UNAVAILABLE", "No B2/Z1 telemetry has been observed.");
    if (nowUnixMs - this.telemetry.observedAtUnixMs > maximumAgeMs) fail("ROS_TELEMETRY_STALE", "B2/Z1 telemetry is stale.");
    return clone(this.telemetry);
  }

  publishSimulatedBaseCommand(input: {
    ownership: CommandOwnershipState;
    safety: BaseSafetyState;
    expectedSafetyRevision: number;
  }): void {
    this.requireSimulationOutput();
    if (input.ownership.status !== "OWNED" || input.ownership.owner?.actuatorGroup !== "BASE") {
      fail("ROS_OWNERSHIP_REQUIRED", "Base publication requires current base ownership.");
    }
    if (input.safety.status !== "ENABLED" || input.safety.revision !== input.expectedSafetyRevision) {
      fail("ROS_SAFETY_STATE_INVALID", "Base publication requires the exact enabled safety revision.");
    }
    const output = input.safety.output;
    this.publisher.publish(scoped(this.topics.namespace, this.topics.baseCommandInput), "geometry_msgs/msg/Twist", {
      linear: { x: output.linearXMetersPerSecond, y: output.linearYMetersPerSecond, z: 0 },
      angular: { x: 0, y: 0, z: output.angularZRadiansPerSecond },
    });
  }

  publishSimulatedManipulatorCommand(input: {
    ownership: CommandOwnershipState;
    safety: ManipulatorSafetyState;
    expectedSafetyRevision: number;
  }): void {
    this.requireSimulationOutput();
    if (input.ownership.status !== "OWNED" || input.ownership.owner?.actuatorGroup !== "MANIPULATOR") {
      fail("ROS_OWNERSHIP_REQUIRED", "Manipulator publication requires current manipulator ownership.");
    }
    if (input.safety.status !== "ENABLED" || input.safety.revision !== input.expectedSafetyRevision) {
      fail("ROS_SAFETY_STATE_INVALID", "Manipulator publication requires the exact enabled safety revision.");
    }
    const output = input.safety.output;
    if (output.kind === "HOLD") {
      fail("ROS_MANIPULATOR_HOLD_ACTIVE", "A hold state does not publish a motion command.");
    }
    if (output.kind === "JOINT_JOG") {
      this.publisher.publish(scoped(this.topics.namespace, this.topics.armJointJog), "control_msgs/msg/JointJog", {
        header: { frame_id: this.profile.frames.armRoot },
        joint_names: Array.from({ length: output.velocitiesRadiansPerSecond.length }, (_, index) => `joint${index + 1}`),
        velocities: [...output.velocitiesRadiansPerSecond],
      });
      return;
    }
    if (output.kind === "CARTESIAN_TWIST") {
      const [linearX, linearY, linearZ, angularX, angularY, angularZ] = output.values;
      this.publisher.publish(scoped(this.topics.namespace, this.topics.armCartesianTwist), "geometry_msgs/msg/TwistStamped", {
        header: { frame_id: output.frameId },
        twist: {
          linear: { x: linearX, y: linearY, z: linearZ },
          angular: { x: angularX, y: angularY, z: angularZ },
        },
      });
      return;
    }
    this.publisher.publish(scoped(this.topics.namespace, this.topics.gripperCommand), "control_msgs/msg/GripperCommand", {
      position: output.normalizedPosition,
      max_effort: output.normalizedForceLimit ?? 0,
    });
  }

  physicalCommandPathStatus(): { enabled: false; reason: string } {
    return {
      enabled: false,
      reason: "Physical Unitree B2W/Z1 publication is intentionally absent until commissioning completes.",
    };
  }

  topicProfile(): B2Z1RosTopics {
    return clone(this.topics);
  }

  private requireSimulationOutput(): void {
    if (!this.profile.simulation) fail("PHYSICAL_COMMAND_PATH_DISABLED", "This adapter boundary cannot publish physical B2W/Z1 commands.");
    if (!this.profile.commandOutputEnabled || !this.allowSimulationPublish) {
      fail("ROS_SIMULATION_OUTPUT_LOCKED", "Simulation ROS publication requires profile and runtime opt-in.");
    }
  }
}

export const DEFAULT_B2_Z1_TOPICS: B2Z1RosTopics = Object.freeze({
  namespace: "b2",
  baseCommandInput: "command/cmd_vel",
  baseGuardEnable: "safety/enable",
  baseOdometry: "state/odom",
  jointStates: "joint_states",
  armTrajectory: "z1/joint_trajectory_controller/joint_trajectory",
  armJointJog: "z1/servo_node/delta_joint_cmds",
  armCartesianTwist: "z1/servo_node/delta_twist_cmds",
  gripperCommand: "z1/gripper_controller/command",
  rgbImage: "sensor/d435i/color/image_raw",
  depthImage: "sensor/d435i/aligned_depth_to_color/image_raw",
});

function validateTopics(topics: B2Z1RosTopics): void {
  for (const [field, value] of Object.entries(topics)) {
    if (!value.trim() || value.includes("..") || value.includes("//") || value.startsWith("/")) {
      fail("ROS_TOPIC_PROFILE_INVALID", `${field} must be a non-empty relative ROS name.`);
    }
  }
  if (topics.baseCommandInput.includes("hardware/cmd_vel")) {
    fail("ROS_TOPIC_PROFILE_UNSAFE", "Teleoperation must publish before the B2 velocity guard, never to its hardware output.");
  }
}

function scoped(namespace: string, topic: string): string {
  return `/${namespace}/${topic}`;
}
