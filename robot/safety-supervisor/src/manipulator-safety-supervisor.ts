import {
  clone,
  fail,
  type CommandOwnershipState,
  type ValidatedTeleopCommand,
} from "../../../packages/contracts/src/index.ts";

export interface ManipulatorSafetyProfile {
  robotId: string;
  commandTimeoutMs: number;
  jointCount: number;
  maximumJointJogRadiansPerSecond: readonly number[];
  maximumCartesianLinearMetersPerSecond: number;
  maximumCartesianAngularRadiansPerSecond: number;
}

export interface ManipulatorSafetyInterlocks {
  vendorSafetyOk: boolean;
  controllerHealthy: boolean;
  robotStateFresh: boolean;
  baseStopped: boolean;
  stableStance: boolean;
  withinJointLimits: boolean;
  collisionFree: boolean;
}

export type ManipulatorSafetyStatus = "DISARMED" | "READY" | "ENABLED" | "HOLDING" | "PROTECTIVE_STOP" | "FAULT";

export type SafeManipulatorCommand =
  | { kind: "HOLD"; robotId: string; generatedAtMonotonicMs: number; stopReason?: string }
  | { kind: "JOINT_JOG"; robotId: string; sourceCommandId: string; velocitiesRadiansPerSecond: readonly number[]; generatedAtMonotonicMs: number; limited: boolean }
  | { kind: "CARTESIAN_TWIST"; robotId: string; sourceCommandId: string; values: readonly number[]; frameId: string; generatedAtMonotonicMs: number; limited: boolean }
  | { kind: "GRIPPER"; robotId: string; sourceCommandId: string; normalizedPosition: number; normalizedForceLimit?: number; generatedAtMonotonicMs: number; limited: false };

export interface ManipulatorSafetyState {
  robotId: string;
  revision: number;
  status: ManipulatorSafetyStatus;
  changedAtUnixMs: number;
  reason: string;
  output: SafeManipulatorCommand;
  lastAcceptedCommandId?: string;
}

export class ManipulatorSafetySupervisor {
  private readonly profile: ManipulatorSafetyProfile;
  private interlocks: ManipulatorSafetyInterlocks = {
    vendorSafetyOk: false,
    controllerHealthy: false,
    robotStateFresh: false,
    baseStopped: false,
    stableStance: false,
    withinJointLimits: false,
    collisionFree: false,
  };
  private state: ManipulatorSafetyState;
  private lastCommandArrivalMonotonicMs?: number;

  constructor(profile: ManipulatorSafetyProfile, createdAtUnixMs: number, createdAtMonotonicMs = 0) {
    validateProfile(profile);
    this.profile = clone(profile);
    this.state = {
      robotId: profile.robotId,
      revision: 1,
      status: "DISARMED",
      changedAtUnixMs: createdAtUnixMs,
      reason: "Manipulator safety initialized disarmed.",
      output: holdCommand(profile.robotId, createdAtMonotonicMs, "Manipulator safety is disarmed."),
    };
  }

  updateInterlocks(interlocks: ManipulatorSafetyInterlocks, atUnixMs: number, atMonotonicMs: number): ManipulatorSafetyState {
    this.interlocks = { ...interlocks };
    const failed = failedInterlocks(interlocks);
    if (failed.length > 0 && (this.state.status === "READY" || this.state.status === "ENABLED")) {
      return this.stop("PROTECTIVE_STOP", atUnixMs, atMonotonicMs, `Manipulator interlocks failed: ${failed.join(", ")}.`);
    }
    return this.snapshot();
  }

  prepare(expectedRevision: number, atUnixMs: number, atMonotonicMs: number): ManipulatorSafetyState {
    this.requireRevision(expectedRevision);
    const failed = failedInterlocks(this.interlocks);
    if (failed.length > 0) fail("MANIPULATOR_INTERLOCK_FAILED", `Cannot prepare while interlocks fail: ${failed.join(", ")}.`);
    if (this.state.status === "FAULT") fail("MANIPULATOR_FAULT_LATCHED", "A fault cannot be cleared by prepare.");
    return this.transition("READY", atUnixMs, holdCommand(this.profile.robotId, atMonotonicMs, "Ready; awaiting manipulator ownership."), "All manipulator interlocks are ready.");
  }

  enable(ownership: CommandOwnershipState, expectedRevision: number, atUnixMs: number, atMonotonicMs: number): ManipulatorSafetyState {
    this.requireRevision(expectedRevision);
    if (this.state.status !== "READY") fail("MANIPULATOR_NOT_READY", `Cannot enable from ${this.state.status}.`);
    this.requireOwnership(ownership);
    const failed = failedInterlocks(this.interlocks);
    if (failed.length > 0) fail("MANIPULATOR_INTERLOCK_FAILED", `Cannot enable while interlocks fail: ${failed.join(", ")}.`);
    this.lastCommandArrivalMonotonicMs = atMonotonicMs;
    return this.transition("ENABLED", atUnixMs, holdCommand(this.profile.robotId, atMonotonicMs), "Manipulator command path enabled in hold.");
  }

  accept(
    selected: ValidatedTeleopCommand,
    ownership: CommandOwnershipState,
    expectedRevision: number,
    atUnixMs: number,
    atMonotonicMs: number,
  ): ManipulatorSafetyState {
    this.requireRevision(expectedRevision);
    if (this.state.status !== "ENABLED") fail("MANIPULATOR_NOT_ENABLED", `Cannot accept from ${this.state.status}.`);
    this.requireOwnership(ownership);
    if (selected.command.robotId !== this.profile.robotId || selected.command.intent.kind === "BASE_MOTION") {
      fail("MANIPULATOR_COMMAND_MISMATCH", "Manipulator safety received an incompatible command.");
    }
    if (ownership.owner?.sourceId !== selected.command.sourceId || ownership.owner.sessionId !== selected.command.sessionId) {
      fail("MANIPULATOR_OWNERSHIP_MISMATCH", "Command does not match manipulator ownership.");
    }
    if (atMonotonicMs < selected.arrivalMonotonicMs) fail("MANIPULATOR_TIME_INVALID", "Local monotonic time moved backwards.");
    if (atMonotonicMs - selected.arrivalMonotonicMs >= this.profile.commandTimeoutMs) {
      this.stop("HOLDING", atUnixMs, atMonotonicMs, "Manipulator command exceeded local freshness timeout.");
      fail("MANIPULATOR_COMMAND_STALE", "Manipulator command exceeded local freshness timeout.");
    }
    const failed = failedInterlocks(this.interlocks);
    if (failed.length > 0) {
      this.stop("PROTECTIVE_STOP", atUnixMs, atMonotonicMs, `Manipulator interlocks failed: ${failed.join(", ")}.`);
      fail("MANIPULATOR_INTERLOCK_FAILED", "A manipulator interlock failed while accepting a command.");
    }
    const intent = selected.command.intent;
    let output: SafeManipulatorCommand;
    if (intent.kind === "GRIPPER") {
      output = {
        kind: "GRIPPER",
        robotId: this.profile.robotId,
        sourceCommandId: selected.command.commandId,
        normalizedPosition: intent.normalizedPosition,
        normalizedForceLimit: intent.normalizedForceLimit,
        generatedAtMonotonicMs: atMonotonicMs,
        limited: false,
      };
    } else if (intent.mode === "JOINT_JOG") {
      if (intent.values.length !== this.profile.jointCount) {
        fail("MANIPULATOR_JOINT_COUNT_INVALID", `Joint jog requires ${this.profile.jointCount} values.`);
      }
      let limited = false;
      const velocities = intent.values.map((value, index) => {
        const normalized = clamp(value, 1);
        if (normalized !== value) limited = true;
        return normalized * this.profile.maximumJointJogRadiansPerSecond[index]! * intent.speedScale;
      });
      output = {
        kind: "JOINT_JOG",
        robotId: this.profile.robotId,
        sourceCommandId: selected.command.commandId,
        velocitiesRadiansPerSecond: velocities,
        generatedAtMonotonicMs: atMonotonicMs,
        limited,
      };
    } else {
      let limited = false;
      const values = intent.values.map((value, index) => {
        const maximum = index < 3 ? this.profile.maximumCartesianLinearMetersPerSecond : this.profile.maximumCartesianAngularRadiansPerSecond;
        const bounded = clamp(value, maximum * intent.speedScale);
        if (bounded !== value) limited = true;
        return bounded;
      });
      output = {
        kind: "CARTESIAN_TWIST",
        robotId: this.profile.robotId,
        sourceCommandId: selected.command.commandId,
        values,
        frameId: intent.frameId,
        generatedAtMonotonicMs: atMonotonicMs,
        limited,
      };
    }
    this.lastCommandArrivalMonotonicMs = selected.arrivalMonotonicMs;
    this.state = {
      ...this.state,
      revision: this.state.revision + 1,
      changedAtUnixMs: atUnixMs,
      reason: output.limited ? "Manipulator command accepted with limiting." : "Manipulator command accepted.",
      output,
      lastAcceptedCommandId: selected.command.commandId,
    };
    return this.snapshot();
  }

  tick(expectedRevision: number, atUnixMs: number, atMonotonicMs: number): ManipulatorSafetyState {
    this.requireRevision(expectedRevision);
    if (this.state.status === "ENABLED" && this.lastCommandArrivalMonotonicMs !== undefined
      && atMonotonicMs - this.lastCommandArrivalMonotonicMs >= this.profile.commandTimeoutMs) {
      return this.stop("HOLDING", atUnixMs, atMonotonicMs, "Manipulator command stream timed out.");
    }
    return this.snapshot();
  }

  hold(expectedRevision: number, atUnixMs: number, atMonotonicMs: number, reason: string): ManipulatorSafetyState {
    this.requireRevision(expectedRevision);
    if (!reason.trim()) fail("MANIPULATOR_REASON_REQUIRED", "A hold reason is required.");
    return this.stop("HOLDING", atUnixMs, atMonotonicMs, reason);
  }

  snapshot(): ManipulatorSafetyState {
    return clone(this.state);
  }

  private stop(status: "HOLDING" | "PROTECTIVE_STOP" | "FAULT", atUnixMs: number, atMonotonicMs: number, reason: string): ManipulatorSafetyState {
    this.lastCommandArrivalMonotonicMs = undefined;
    return this.transition(status, atUnixMs, holdCommand(this.profile.robotId, atMonotonicMs, reason), reason);
  }

  private transition(status: ManipulatorSafetyStatus, atUnixMs: number, output: SafeManipulatorCommand, reason: string): ManipulatorSafetyState {
    this.state = { ...this.state, revision: this.state.revision + 1, status, changedAtUnixMs: atUnixMs, reason, output };
    return this.snapshot();
  }

  private requireOwnership(ownership: CommandOwnershipState): void {
    if (ownership.robotId !== this.profile.robotId || ownership.status !== "OWNED" || ownership.owner?.actuatorGroup !== "MANIPULATOR") {
      fail("MANIPULATOR_OWNERSHIP_REQUIRED", "Active manipulator ownership is required.");
    }
  }

  private requireRevision(expectedRevision: number): void {
    if (this.state.revision !== expectedRevision) fail("MANIPULATOR_REVISION_MISMATCH", "Manipulator safety revision changed.");
  }
}

function validateProfile(profile: ManipulatorSafetyProfile): void {
  if (!profile.robotId.trim() || !Number.isSafeInteger(profile.jointCount) || profile.jointCount < 1
    || profile.maximumJointJogRadiansPerSecond.length !== profile.jointCount) throw new Error("Manipulator safety profile identity or joint count is invalid.");
  const numeric = [profile.commandTimeoutMs, ...profile.maximumJointJogRadiansPerSecond,
    profile.maximumCartesianLinearMetersPerSecond, profile.maximumCartesianAngularRadiansPerSecond];
  if (numeric.some((value) => !Number.isFinite(value) || value <= 0)) throw new Error("Manipulator safety limits must be positive and finite.");
}

function failedInterlocks(interlocks: ManipulatorSafetyInterlocks): string[] {
  return Object.entries(interlocks).filter(([, ready]) => !ready).map(([name]) => name);
}

function clamp(value: number, maximumMagnitude: number): number {
  return Math.max(-maximumMagnitude, Math.min(maximumMagnitude, value));
}

function holdCommand(robotId: string, atMonotonicMs: number, stopReason?: string): SafeManipulatorCommand {
  return { kind: "HOLD", robotId, generatedAtMonotonicMs: atMonotonicMs, stopReason };
}
