import { clone, fail, type ActuatorGroup } from "../../contracts/src/index.ts";

export type AdapterLifecycle =
  | "NEW"
  | "CONFIGURED"
  | "OBSERVE_ONLY"
  | "READY"
  | "ENABLED"
  | "DISABLED"
  | "STOPPED"
  | "FAULT";

export interface RobotCapabilities {
  robotId: string;
  profileVersion: string;
  actuatorGroups: readonly ActuatorGroup[];
  armJointCount: number;
  hasGripper: boolean;
  cameraFrames: readonly string[];
  simulation: boolean;
}

export interface AdapterState {
  robotId: string;
  lifecycle: AdapterLifecycle;
  revision: number;
  sourceTimestampUnixMs: number;
  observedAtUnixMs: number;
  enabledGroups: readonly ActuatorGroup[];
  baseStopped: boolean;
  armJointPositions: readonly number[];
  gripperPosition: number;
  lastCommandId?: string;
  faultReason?: string;
}

export type AdapterCommand =
  | {
      kind: "BASE_VELOCITY";
      commandId: string;
      actuatorGroup: "BASE";
      expiresAtUnixMs: number;
      linearXMetersPerSecond: number;
      linearYMetersPerSecond: number;
      angularZRadiansPerSecond: number;
    }
  | {
      kind: "ARM_JOINT_POSITIONS";
      commandId: string;
      actuatorGroup: "MANIPULATOR";
      expiresAtUnixMs: number;
      positionsRadians: readonly number[];
    }
  | {
      kind: "GRIPPER_POSITION";
      commandId: string;
      actuatorGroup: "MANIPULATOR";
      expiresAtUnixMs: number;
      normalizedPosition: number;
      normalizedForceLimit?: number;
    };

export interface AdapterCommandAcknowledgement {
  commandId: string;
  acceptedAtUnixMs: number;
  stateRevision: number;
}

export interface RobotAdapter {
  capabilities(): RobotCapabilities;
  configure(profileVersion: string): AdapterState;
  startObserveOnly(): AdapterState;
  validateReadiness(): AdapterState;
  enable(group: ActuatorGroup): AdapterState;
  disable(reason: string): AdapterState;
  stop(reason: string): AdapterState;
  command(command: AdapterCommand): AdapterCommandAcknowledgement;
  state(): AdapterState;
}

export interface SimulatedRobotAdapterOptions {
  capabilities: RobotCapabilities;
  now?: () => number;
  commandOutputEnabled?: boolean;
}

export class SimulatedRobotAdapter implements RobotAdapter {
  private snapshot: AdapterState;
  private readonly descriptor: RobotCapabilities;
  private readonly now: () => number;
  private readonly commandOutputEnabled: boolean;
  private failNextCode?: string;

  constructor(options: SimulatedRobotAdapterOptions) {
    if (!options.capabilities.simulation) throw new Error("SimulatedRobotAdapter requires simulation=true.");
    this.descriptor = clone(options.capabilities);
    this.now = options.now ?? Date.now;
    this.commandOutputEnabled = options.commandOutputEnabled ?? false;
    const now = this.now();
    this.snapshot = {
      robotId: this.descriptor.robotId,
      lifecycle: "NEW",
      revision: 1,
      sourceTimestampUnixMs: now,
      observedAtUnixMs: now,
      enabledGroups: [],
      baseStopped: true,
      armJointPositions: Array.from({ length: this.descriptor.armJointCount }, () => 0),
      gripperPosition: 0,
    };
  }

  capabilities(): RobotCapabilities {
    return clone(this.descriptor);
  }

  configure(profileVersion: string): AdapterState {
    if (this.snapshot.lifecycle !== "NEW" && this.snapshot.lifecycle !== "STOPPED") {
      fail("ADAPTER_TRANSITION_INVALID", `Cannot configure from ${this.snapshot.lifecycle}.`);
    }
    if (profileVersion !== this.descriptor.profileVersion) fail("ADAPTER_PROFILE_MISMATCH", "Robot profile version does not match adapter capabilities.");
    return this.transition("CONFIGURED");
  }

  startObserveOnly(): AdapterState {
    this.requireLifecycle(["CONFIGURED", "DISABLED"]);
    return this.transition("OBSERVE_ONLY", { enabledGroups: [] });
  }

  validateReadiness(): AdapterState {
    this.requireLifecycle(["OBSERVE_ONLY"]);
    return this.transition("READY");
  }

  enable(group: ActuatorGroup): AdapterState {
    this.requireLifecycle(["READY", "ENABLED"]);
    if (!this.commandOutputEnabled) fail("ADAPTER_COMMAND_OUTPUT_LOCKED", "Simulator command output requires explicit opt-in.");
    if (!this.descriptor.actuatorGroups.includes(group)) fail("ADAPTER_CAPABILITY_UNSUPPORTED", `Actuator group ${group} is unavailable.`);
    if (group === "MANIPULATOR" && !this.snapshot.baseStopped) {
      fail("ADAPTER_BASE_NOT_STOPPED", "Manipulator cannot be enabled while the base is moving.");
    }
    return this.transition("ENABLED", { enabledGroups: uniqueGroups([...this.snapshot.enabledGroups, group]) });
  }

  disable(reason: string): AdapterState {
    requireText(reason, "reason");
    if (this.snapshot.lifecycle === "DISABLED") return this.state();
    this.requireLifecycle(["OBSERVE_ONLY", "READY", "ENABLED", "FAULT"]);
    return this.transition("DISABLED", { enabledGroups: [], baseStopped: true, faultReason: undefined });
  }

  stop(reason: string): AdapterState {
    requireText(reason, "reason");
    if (this.snapshot.lifecycle === "STOPPED") return this.state();
    return this.transition("STOPPED", { enabledGroups: [], baseStopped: true, faultReason: undefined });
  }

  command(command: AdapterCommand): AdapterCommandAcknowledgement {
    this.requireLifecycle(["ENABLED"]);
    if (!this.snapshot.enabledGroups.includes(command.actuatorGroup)) fail("ADAPTER_GROUP_NOT_ENABLED", `${command.actuatorGroup} is not enabled.`);
    if (!command.commandId.trim()) fail("ADAPTER_COMMAND_ID_REQUIRED", "commandId is required.");
    const now = this.now();
    if (now >= command.expiresAtUnixMs) fail("ADAPTER_COMMAND_EXPIRED", `Command ${command.commandId} has expired.`);
    if (this.failNextCode) {
      const code = this.failNextCode;
      this.failNextCode = undefined;
      this.transition("FAULT", { enabledGroups: [], baseStopped: true, faultReason: code });
      fail(code, `Injected simulator failure for ${command.commandId}.`);
    }
    if (command.kind === "ARM_JOINT_POSITIONS") {
      if (command.positionsRadians.length !== this.descriptor.armJointCount
        || command.positionsRadians.some((value) => !Number.isFinite(value) || Math.abs(value) > Math.PI * 2)) {
        fail("ADAPTER_ARM_COMMAND_INVALID", "Arm joint command has invalid count or range.");
      }
      this.update({ armJointPositions: [...command.positionsRadians], baseStopped: true, lastCommandId: command.commandId });
    } else if (command.kind === "GRIPPER_POSITION") {
      if (!this.descriptor.hasGripper) fail("ADAPTER_CAPABILITY_UNSUPPORTED", "Gripper is unavailable.");
      if (!Number.isFinite(command.normalizedPosition) || command.normalizedPosition < 0 || command.normalizedPosition > 1) {
        fail("ADAPTER_GRIPPER_COMMAND_INVALID", "Gripper position must be between zero and one.");
      }
      this.update({ gripperPosition: command.normalizedPosition, lastCommandId: command.commandId });
    } else {
      const values = [command.linearXMetersPerSecond, command.linearYMetersPerSecond, command.angularZRadiansPerSecond];
      if (values.some((value) => !Number.isFinite(value))) fail("ADAPTER_BASE_COMMAND_INVALID", "Base velocity values must be finite.");
      const stopped = values.every((value) => value === 0);
      this.update({ baseStopped: stopped, lastCommandId: command.commandId });
    }
    return { commandId: command.commandId, acceptedAtUnixMs: now, stateRevision: this.snapshot.revision };
  }

  state(): AdapterState {
    return clone(this.snapshot);
  }

  injectNextCommandFailure(code = "SIMULATOR_COMMAND_FAILURE"): void {
    requireText(code, "code");
    this.failNextCode = code;
  }

  private transition(lifecycle: AdapterLifecycle, changes: Partial<AdapterState> = {}): AdapterState {
    this.update({ ...changes, lifecycle });
    return this.state();
  }

  private update(changes: Partial<AdapterState>): void {
    const now = this.now();
    this.snapshot = {
      ...this.snapshot,
      ...changes,
      revision: this.snapshot.revision + 1,
      sourceTimestampUnixMs: now,
      observedAtUnixMs: now,
    };
  }

  private requireLifecycle(allowed: readonly AdapterLifecycle[]): void {
    if (!allowed.includes(this.snapshot.lifecycle)) {
      fail("ADAPTER_TRANSITION_INVALID", `Adapter operation is not allowed from ${this.snapshot.lifecycle}.`);
    }
  }
}

function uniqueGroups(groups: readonly ActuatorGroup[]): ActuatorGroup[] {
  return [...new Set(groups)].sort();
}

function requireText(value: string, field: string): void {
  if (!value.trim()) fail("ADAPTER_FIELD_REQUIRED", `${field} is required.`);
}
