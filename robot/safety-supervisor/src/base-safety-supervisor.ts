import {
  clone,
  fail,
  type CommandOwnershipState,
  type ValidatedTeleopCommand,
} from "../../../packages/contracts/src/index.ts";

export interface BaseSafetyProfile {
  robotId: string;
  commandTimeoutMs: number;
  maximumLinearXMetersPerSecond: number;
  maximumLinearYMetersPerSecond: number;
  maximumAngularZRadiansPerSecond: number;
  maximumLinearAccelerationMetersPerSecondSquared: number;
  maximumAngularAccelerationRadiansPerSecondSquared: number;
}

export interface BaseSafetyInterlocks {
  vendorSafetyOk: boolean;
  controllerHealthy: boolean;
  robotStateFresh: boolean;
}

export type BaseSafetyStatus = "DISARMED" | "READY" | "ENABLED" | "HOLDING" | "PROTECTIVE_STOP" | "FAULT";

export interface SafeBaseCommand {
  robotId: string;
  sourceCommandId?: string;
  linearXMetersPerSecond: number;
  linearYMetersPerSecond: number;
  angularZRadiansPerSecond: number;
  generatedAtMonotonicMs: number;
  limited: boolean;
  stopReason?: string;
}

export interface BaseSafetyState {
  robotId: string;
  revision: number;
  status: BaseSafetyStatus;
  changedAtUnixMs: number;
  reason: string;
  output: SafeBaseCommand;
  lastAcceptedCommandId?: string;
}

export class BaseSafetySupervisor {
  private readonly profile: BaseSafetyProfile;
  private interlocks: BaseSafetyInterlocks = {
    vendorSafetyOk: false,
    controllerHealthy: false,
    robotStateFresh: false,
  };
  private state: BaseSafetyState;
  private lastOutputAtMonotonicMs: number;
  private lastCommandArrivalMonotonicMs?: number;

  constructor(profile: BaseSafetyProfile, createdAtUnixMs: number, createdAtMonotonicMs = 0) {
    validateProfile(profile);
    this.profile = clone(profile);
    this.lastOutputAtMonotonicMs = createdAtMonotonicMs;
    this.state = {
      robotId: profile.robotId,
      revision: 1,
      status: "DISARMED",
      changedAtUnixMs: createdAtUnixMs,
      reason: "Safety supervisor initialized disarmed.",
      output: stopCommand(profile.robotId, createdAtMonotonicMs, "Safety supervisor is disarmed."),
    };
  }

  updateInterlocks(interlocks: BaseSafetyInterlocks, atUnixMs: number, atMonotonicMs: number): BaseSafetyState {
    this.interlocks = { ...interlocks };
    const failed = failedInterlocks(interlocks);
    if (failed.length > 0 && (this.state.status === "ENABLED" || this.state.status === "READY")) {
      return this.stop("PROTECTIVE_STOP", atUnixMs, atMonotonicMs, `Interlocks failed: ${failed.join(", ")}.`);
    }
    return this.snapshot();
  }

  prepare(expectedRevision: number, atUnixMs: number, atMonotonicMs: number): BaseSafetyState {
    this.requireRevision(expectedRevision);
    const failed = failedInterlocks(this.interlocks);
    if (failed.length > 0) fail("SAFETY_INTERLOCK_FAILED", `Cannot prepare while interlocks fail: ${failed.join(", ")}.`);
    if (this.state.status === "FAULT") fail("SAFETY_FAULT_LATCHED", "A fault cannot be cleared by prepare.");
    return this.transition("READY", atUnixMs, stopCommand(this.profile.robotId, atMonotonicMs, "Ready; awaiting ownership enable."), "All required base interlocks are ready.");
  }

  enable(
    ownership: CommandOwnershipState,
    expectedRevision: number,
    atUnixMs: number,
    atMonotonicMs: number,
  ): BaseSafetyState {
    this.requireRevision(expectedRevision);
    if (this.state.status !== "READY") fail("SAFETY_NOT_READY", `Cannot enable from ${this.state.status}.`);
    this.requireBaseOwnership(ownership);
    const failed = failedInterlocks(this.interlocks);
    if (failed.length > 0) fail("SAFETY_INTERLOCK_FAILED", `Cannot enable while interlocks fail: ${failed.join(", ")}.`);
    this.lastOutputAtMonotonicMs = atMonotonicMs;
    this.lastCommandArrivalMonotonicMs = atMonotonicMs;
    return this.transition("ENABLED", atUnixMs, stopCommand(this.profile.robotId, atMonotonicMs), "Base command path enabled with zero output.");
  }

  accept(
    selected: ValidatedTeleopCommand,
    ownership: CommandOwnershipState,
    expectedRevision: number,
    nowUnixMs: number,
    nowMonotonicMs: number,
  ): BaseSafetyState {
    this.requireRevision(expectedRevision);
    if (this.state.status !== "ENABLED") fail("SAFETY_NOT_ENABLED", `Cannot accept a command from ${this.state.status}.`);
    this.requireBaseOwnership(ownership);
    if (selected.command.robotId !== this.profile.robotId || selected.command.intent.kind !== "BASE_MOTION") {
      fail("SAFETY_COMMAND_MISMATCH", "Safety supervisor received a non-base or wrong-robot command.");
    }
    if (ownership.owner?.sourceId !== selected.command.sourceId || ownership.owner.sessionId !== selected.command.sessionId) {
      fail("SAFETY_OWNERSHIP_MISMATCH", "Selected command does not match current ownership.");
    }
    if (nowMonotonicMs < selected.arrivalMonotonicMs) fail("SAFETY_TIME_INVALID", "Local monotonic time moved backwards.");
    if (nowMonotonicMs - selected.arrivalMonotonicMs >= this.profile.commandTimeoutMs) {
      this.stop("HOLDING", nowUnixMs, nowMonotonicMs, "Selected command exceeded the robot-local freshness timeout.");
      fail("SAFETY_COMMAND_STALE", "Selected command exceeded the robot-local freshness timeout.");
    }
    const failed = failedInterlocks(this.interlocks);
    if (failed.length > 0) {
      this.stop("PROTECTIVE_STOP", nowUnixMs, nowMonotonicMs, `Interlocks failed: ${failed.join(", ")}.`);
      fail("SAFETY_INTERLOCK_FAILED", "A required interlock failed while accepting the command.");
    }

    const intent = selected.command.intent;
    const scale = intent.speedScale;
    const desiredX = clamp(intent.linearXMetersPerSecond, this.profile.maximumLinearXMetersPerSecond * scale);
    const desiredY = clamp(intent.linearYMetersPerSecond, this.profile.maximumLinearYMetersPerSecond * scale);
    const desiredYaw = clamp(intent.angularZRadiansPerSecond, this.profile.maximumAngularZRadiansPerSecond * scale);
    const elapsedSeconds = Math.max(0, nowMonotonicMs - this.lastOutputAtMonotonicMs) / 1_000;
    const output: SafeBaseCommand = {
      robotId: this.profile.robotId,
      sourceCommandId: selected.command.commandId,
      linearXMetersPerSecond: approach(
        this.state.output.linearXMetersPerSecond,
        desiredX,
        this.profile.maximumLinearAccelerationMetersPerSecondSquared * elapsedSeconds,
      ),
      linearYMetersPerSecond: approach(
        this.state.output.linearYMetersPerSecond,
        desiredY,
        this.profile.maximumLinearAccelerationMetersPerSecondSquared * elapsedSeconds,
      ),
      angularZRadiansPerSecond: approach(
        this.state.output.angularZRadiansPerSecond,
        desiredYaw,
        this.profile.maximumAngularAccelerationRadiansPerSecondSquared * elapsedSeconds,
      ),
      generatedAtMonotonicMs: nowMonotonicMs,
      limited: desiredX !== intent.linearXMetersPerSecond
        || desiredY !== intent.linearYMetersPerSecond
        || desiredYaw !== intent.angularZRadiansPerSecond,
    };
    output.limited = output.limited
      || output.linearXMetersPerSecond !== desiredX
      || output.linearYMetersPerSecond !== desiredY
      || output.angularZRadiansPerSecond !== desiredYaw;
    this.lastOutputAtMonotonicMs = nowMonotonicMs;
    this.lastCommandArrivalMonotonicMs = selected.arrivalMonotonicMs;
    this.state = {
      ...this.state,
      revision: this.state.revision + 1,
      changedAtUnixMs: nowUnixMs,
      reason: output.limited ? "Base command accepted with safety limiting." : "Base command accepted.",
      output,
      lastAcceptedCommandId: selected.command.commandId,
    };
    return this.snapshot();
  }

  tick(expectedRevision: number, nowUnixMs: number, nowMonotonicMs: number): BaseSafetyState {
    this.requireRevision(expectedRevision);
    if (this.state.status === "ENABLED"
      && this.lastCommandArrivalMonotonicMs !== undefined
      && nowMonotonicMs - this.lastCommandArrivalMonotonicMs >= this.profile.commandTimeoutMs) {
      return this.stop("HOLDING", nowUnixMs, nowMonotonicMs, "Base command stream timed out.");
    }
    return this.snapshot();
  }

  hold(expectedRevision: number, atUnixMs: number, atMonotonicMs: number, reason: string): BaseSafetyState {
    this.requireRevision(expectedRevision);
    if (!reason.trim()) fail("SAFETY_REASON_REQUIRED", "A hold reason is required.");
    return this.stop("HOLDING", atUnixMs, atMonotonicMs, reason);
  }

  fault(expectedRevision: number, atUnixMs: number, atMonotonicMs: number, reason: string): BaseSafetyState {
    this.requireRevision(expectedRevision);
    if (!reason.trim()) fail("SAFETY_REASON_REQUIRED", "A fault reason is required.");
    return this.stop("FAULT", atUnixMs, atMonotonicMs, reason);
  }

  snapshot(): BaseSafetyState {
    return clone(this.state);
  }

  private stop(status: "HOLDING" | "PROTECTIVE_STOP" | "FAULT", atUnixMs: number, atMonotonicMs: number, reason: string): BaseSafetyState {
    this.lastOutputAtMonotonicMs = atMonotonicMs;
    this.lastCommandArrivalMonotonicMs = undefined;
    return this.transition(status, atUnixMs, stopCommand(this.profile.robotId, atMonotonicMs, reason), reason);
  }

  private transition(status: BaseSafetyStatus, atUnixMs: number, output: SafeBaseCommand, reason: string): BaseSafetyState {
    this.state = {
      ...this.state,
      revision: this.state.revision + 1,
      status,
      changedAtUnixMs: atUnixMs,
      reason,
      output,
    };
    return this.snapshot();
  }

  private requireBaseOwnership(ownership: CommandOwnershipState): void {
    if (ownership.robotId !== this.profile.robotId
      || ownership.status !== "OWNED"
      || ownership.owner?.actuatorGroup !== "BASE") {
      fail("SAFETY_BASE_OWNERSHIP_REQUIRED", "An active base owner is required.");
    }
  }

  private requireRevision(expectedRevision: number): void {
    if (this.state.revision !== expectedRevision) {
      fail("SAFETY_REVISION_MISMATCH", `Expected safety revision ${expectedRevision}, received ${this.state.revision}.`);
    }
  }
}

function validateProfile(profile: BaseSafetyProfile): void {
  if (!profile.robotId.trim()) throw new Error("Base safety profile requires robotId.");
  for (const [name, value] of Object.entries(profile).filter(([name]) => name !== "robotId")) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive and finite.`);
  }
}

function failedInterlocks(interlocks: BaseSafetyInterlocks): string[] {
  return Object.entries(interlocks).filter(([, ready]) => !ready).map(([name]) => name);
}

function clamp(value: number, maximumMagnitude: number): number {
  return Math.max(-maximumMagnitude, Math.min(maximumMagnitude, value));
}

function approach(current: number, target: number, maximumDelta: number): number {
  if (target > current) return Math.min(target, current + maximumDelta);
  return Math.max(target, current - maximumDelta);
}

function stopCommand(robotId: string, atMonotonicMs: number, stopReason?: string): SafeBaseCommand {
  return {
    robotId,
    linearXMetersPerSecond: 0,
    linearYMetersPerSecond: 0,
    angularZRadiansPerSecond: 0,
    generatedAtMonotonicMs: atMonotonicMs,
    limited: false,
    stopReason,
  };
}
