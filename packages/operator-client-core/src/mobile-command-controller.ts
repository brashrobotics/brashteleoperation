import {
  CONTRACT_VERSION,
  clone,
  decodeTeleopSessionLease,
  fail,
  type TeleopCommandEnvelope,
  type TeleopSessionLease,
} from "../../contracts/src/index.ts";

export type MobileCommandState = "OBSERVE_ONLY" | "READY" | "COMMANDING" | "HOLDING" | "CLOSED";

export interface MobileReadiness {
  appForeground: boolean;
  screenUnlocked: boolean;
  realtimeConnected: boolean;
  ownershipGranted: boolean;
  robotSafetyEnabled: boolean;
}

export interface MobileBaseCommandLimits {
  maximumLinearXMetersPerSecond: number;
  maximumLinearYMetersPerSecond: number;
  maximumAngularZRadiansPerSecond: number;
}

export interface MobileManipulatorCommandLimits {
  jointCount: number;
  maximumCartesianLinearMetersPerSecond: number;
  maximumCartesianAngularRadiansPerSecond: number;
}

export interface MobileCommandControllerOptions {
  lease: TeleopSessionLease;
  idGenerator: () => string;
  baseLimits?: MobileBaseCommandLimits;
  manipulatorLimits?: MobileManipulatorCommandLimits;
  nowUnixMs?: () => number;
  commandLifetimeMs?: number;
}

export interface MobileCommandSnapshot {
  state: MobileCommandState;
  readiness: MobileReadiness;
  deadmanHeld: boolean;
  deadmanReleaseRequired: boolean;
  clutchHeld: boolean;
  nextSequence: number;
  sessionId: string;
  robotId: string;
  operatorId: string;
  leaseExpiresAtUnixMs: number;
  lastHoldReason?: string;
}

const NOT_READY: MobileReadiness = Object.freeze({
  appForeground: false,
  screenUnlocked: false,
  realtimeConnected: false,
  ownershipGranted: false,
  robotSafetyEnabled: false,
});

/**
 * Transport-neutral input gate for a mobile operator client.
 *
 * This class is deliberately not a safety controller. It only prevents a
 * client from producing commands when its own readiness signals are absent.
 * Edge validation, command arbitration, local timeouts, and vendor safety are
 * still authoritative.
 */
export class MobileCommandController {
  private readonly lease: TeleopSessionLease;
  private readonly idGenerator: () => string;
  private readonly nowUnixMs: () => number;
  private readonly commandLifetimeMs: number;
  private readonly baseLimits?: MobileBaseCommandLimits;
  private readonly manipulatorLimits?: MobileManipulatorCommandLimits;
  private readiness: MobileReadiness = { ...NOT_READY };
  private state: MobileCommandState = "OBSERVE_ONLY";
  private deadmanHeld = false;
  private deadmanReleaseRequired = false;
  private clutchHeld = false;
  private nextSequence = 1;
  private interrupted = false;
  private lastHoldReason?: string;

  constructor(options: MobileCommandControllerOptions) {
    this.lease = clone(decodeTeleopSessionLease(options.lease));
    if (this.lease.expiresAtUnixMs <= this.lease.issuedAtUnixMs) {
      fail("MOBILE_LEASE_INVALID", "The mobile client lease must expire after it is issued.");
    }
    if (!Number.isSafeInteger(options.commandLifetimeMs ?? 150)
      || (options.commandLifetimeMs ?? 150) < 20
      || (options.commandLifetimeMs ?? 150) > 500) {
      fail("MOBILE_COMMAND_LIFETIME_INVALID", "Mobile command lifetime must be an integer from 20 to 500 ms.");
    }
    if (typeof options.idGenerator !== "function") fail("MOBILE_ID_GENERATOR_REQUIRED", "A command ID generator is required.");
    this.idGenerator = options.idGenerator;
    this.nowUnixMs = options.nowUnixMs ?? Date.now;
    this.commandLifetimeMs = options.commandLifetimeMs ?? 150;
    this.baseLimits = options.baseLimits ? validateBaseLimits(options.baseLimits) : undefined;
    this.manipulatorLimits = options.manipulatorLimits ? validateManipulatorLimits(options.manipulatorLimits) : undefined;
  }

  updateReadiness(readiness: MobileReadiness): MobileCommandSnapshot {
    this.requireOpen();
    this.readiness = validateReadiness(readiness);
    if (!allReady(this.readiness)) {
      this.enterHold(missingReadinessReason(this.readiness), this.deadmanHeld || this.deadmanReleaseRequired);
    } else if (!this.interrupted) {
      if (!this.deadmanHeld) this.state = "READY";
      this.lastHoldReason = undefined;
    } else {
      // Foreground/network recovery is intentionally not an arming event.
      this.state = "HOLDING";
    }
    return this.snapshot();
  }

  setDeadman(held: boolean): MobileCommandSnapshot {
    this.requireOpen();
    if (!held) {
      this.deadmanReleaseRequired = false;
      this.enterHold("Operator released the deadman control.", false);
      return this.snapshot();
    }
    this.requireLiveLease();
    if (this.deadmanHeld && this.state === "COMMANDING" && allReady(this.readiness)) return this.snapshot();
    if (!allReady(this.readiness)) {
      fail("MOBILE_NOT_READY", "Every client and robot readiness signal must be true before holding deadman.");
    }
    if (this.deadmanReleaseRequired) {
      fail("MOBILE_DEADMAN_RELEASE_REQUIRED", "Release deadman before pressing it again after an interruption.");
    }
    this.deadmanHeld = true;
    this.clutchHeld = false;
    this.interrupted = false;
    this.lastHoldReason = undefined;
    this.state = "COMMANDING";
    return this.snapshot();
  }

  setClutch(held: boolean): MobileCommandSnapshot {
    this.requireOpen();
    if (held) {
      this.requireLiveLease();
      if (!this.deadmanHeld || this.state !== "COMMANDING" || !allReady(this.readiness)) {
        fail("MOBILE_DEADMAN_REQUIRED", "Manipulator clutch requires a held deadman control and complete readiness.");
      }
    }
    this.clutchHeld = held;
    return this.snapshot();
  }

  interrupt(reason: string): MobileCommandSnapshot {
    this.requireOpen();
    if (!reason.trim()) fail("MOBILE_HOLD_REASON_REQUIRED", "An input interruption requires a reason.");
    return this.enterHold(reason, this.deadmanHeld || this.deadmanReleaseRequired);
  }

  private enterHold(reason: string, requireDeadmanRelease: boolean): MobileCommandSnapshot {
    this.deadmanHeld = false;
    this.deadmanReleaseRequired = requireDeadmanRelease;
    this.clutchHeld = false;
    this.interrupted = true;
    this.lastHoldReason = reason;
    this.state = "HOLDING";
    return this.snapshot();
  }

  createBaseCommand(
    normalizedLinearX: number,
    normalizedLinearY: number,
    normalizedAngularZ: number,
    speedScale = 1,
    frameId = "base_link",
  ): TeleopCommandEnvelope {
    this.requireCommanding("CONTROL_BASE", false);
    if (!this.baseLimits) fail("MOBILE_BASE_LIMITS_REQUIRED", "Base command limits were not configured.");
    const normalized = normalizedVector([normalizedLinearX, normalizedLinearY, normalizedAngularZ], "base");
    return this.envelope("BASE", {
      kind: "BASE_MOTION",
      frameId: requiredText(frameId, "frameId"),
      linearXMetersPerSecond: normalized[0]! * this.baseLimits.maximumLinearXMetersPerSecond,
      linearYMetersPerSecond: normalized[1]! * this.baseLimits.maximumLinearYMetersPerSecond,
      angularZRadiansPerSecond: normalized[2]! * this.baseLimits.maximumAngularZRadiansPerSecond,
      speedScale: normalizedScale(speedScale),
    });
  }

  createJointJog(normalizedJointVelocities: readonly number[], speedScale = 1, frameId = "z1_base_link"): TeleopCommandEnvelope {
    this.requireCommanding("CONTROL_MANIPULATOR", true);
    if (!this.manipulatorLimits) fail("MOBILE_MANIPULATOR_LIMITS_REQUIRED", "Manipulator command limits were not configured.");
    if (normalizedJointVelocities.length !== this.manipulatorLimits.jointCount) {
      fail("MOBILE_JOINT_COUNT_INVALID", `Joint jog requires ${this.manipulatorLimits.jointCount} values.`);
    }
    return this.envelope("MANIPULATOR", {
      kind: "ARM_MOTION",
      mode: "JOINT_JOG",
      frameId: requiredText(frameId, "frameId"),
      values: normalizedVector(normalizedJointVelocities, "jointJog"),
      speedScale: normalizedScale(speedScale),
      clutch: true,
    });
  }

  createCartesianTwist(normalizedValues: readonly number[], speedScale = 1, frameId = "z1_base_link"): TeleopCommandEnvelope {
    this.requireCommanding("CONTROL_MANIPULATOR", true);
    if (!this.manipulatorLimits) fail("MOBILE_MANIPULATOR_LIMITS_REQUIRED", "Manipulator command limits were not configured.");
    if (normalizedValues.length !== 6) fail("MOBILE_CARTESIAN_VALUES_INVALID", "Cartesian twist requires six normalized values.");
    const bounded = normalizedVector(normalizedValues, "cartesianTwist");
    const values = bounded.map((value, index) => value * (index < 3
      ? this.manipulatorLimits!.maximumCartesianLinearMetersPerSecond
      : this.manipulatorLimits!.maximumCartesianAngularRadiansPerSecond));
    return this.envelope("MANIPULATOR", {
      kind: "ARM_MOTION",
      mode: "CARTESIAN_TWIST",
      frameId: requiredText(frameId, "frameId"),
      values,
      speedScale: normalizedScale(speedScale),
      clutch: true,
    });
  }

  createGripperCommand(normalizedPosition: number, normalizedForceLimit?: number): TeleopCommandEnvelope {
    this.requireCommanding("CONTROL_MANIPULATOR", true);
    const force = normalizedForceLimit === undefined ? undefined : normalizedUnit(normalizedForceLimit, "normalizedForceLimit");
    return this.envelope("MANIPULATOR", {
      kind: "GRIPPER",
      normalizedPosition: normalizedUnit(normalizedPosition, "normalizedPosition"),
      normalizedForceLimit: force,
    });
  }

  close(): MobileCommandSnapshot {
    if (this.state !== "CLOSED") {
      this.deadmanHeld = false;
      this.deadmanReleaseRequired = true;
      this.clutchHeld = false;
      this.interrupted = true;
      this.lastHoldReason = "Client command controller closed.";
      this.state = "CLOSED";
    }
    return this.snapshot();
  }

  snapshot(): MobileCommandSnapshot {
    return clone({
      state: this.state,
      readiness: this.readiness,
      deadmanHeld: this.deadmanHeld,
      deadmanReleaseRequired: this.deadmanReleaseRequired,
      clutchHeld: this.clutchHeld,
      nextSequence: this.nextSequence,
      sessionId: this.lease.sessionId,
      robotId: this.lease.robotId,
      operatorId: this.lease.operatorId,
      leaseExpiresAtUnixMs: this.lease.expiresAtUnixMs,
      lastHoldReason: this.lastHoldReason,
    });
  }

  private envelope(
    actuatorGroup: "BASE" | "MANIPULATOR",
    intent: TeleopCommandEnvelope["intent"],
  ): TeleopCommandEnvelope {
    const producedAtUnixMs = this.requireLiveLease();
    const commandId = requiredText(this.idGenerator(), "commandId");
    const expiresAtUnixMs = Math.min(producedAtUnixMs + this.commandLifetimeMs, this.lease.expiresAtUnixMs);
    if (expiresAtUnixMs <= producedAtUnixMs) {
      this.interrupt("The control lease expired before a command could be produced.");
      fail("MOBILE_LEASE_EXPIRED", "The control lease has expired.");
    }
    const command: TeleopCommandEnvelope = {
      contractVersion: CONTRACT_VERSION,
      commandId,
      sessionId: this.lease.sessionId,
      robotId: this.lease.robotId,
      sourceId: this.lease.operatorId,
      actuatorGroup,
      sequence: this.nextSequence,
      producedAtUnixMs,
      expiresAtUnixMs,
      deadman: true,
      intent,
    };
    this.nextSequence += 1;
    return clone(command);
  }

  private requireCommanding(scope: "CONTROL_BASE" | "CONTROL_MANIPULATOR", clutchRequired: boolean): void {
    this.requireOpen();
    this.requireLiveLease();
    if (!this.lease.scopes.includes(scope)) fail("MOBILE_SCOPE_DENIED", `Lease does not grant ${scope}.`);
    if (!allReady(this.readiness) || !this.deadmanHeld || this.state !== "COMMANDING") {
      fail("MOBILE_COMMAND_NOT_ARMED", "A fresh deadman edge and all readiness signals are required to produce commands.");
    }
    if (clutchRequired && !this.clutchHeld) fail("MOBILE_CLUTCH_REQUIRED", "Manipulator commands require a held clutch.");
  }

  private requireLiveLease(): number {
    const now = this.nowUnixMs();
    if (!Number.isSafeInteger(now) || now < 0) fail("MOBILE_CLOCK_INVALID", "Client clock must return Unix milliseconds.");
    if (now >= this.lease.expiresAtUnixMs) {
      this.interrupt("The control lease expired.");
      fail("MOBILE_LEASE_EXPIRED", "The control lease has expired.");
    }
    return now;
  }

  private requireOpen(): void {
    if (this.state === "CLOSED") fail("MOBILE_CONTROLLER_CLOSED", "The command controller is closed.");
  }
}

function allReady(value: MobileReadiness): boolean {
  return value.appForeground && value.screenUnlocked && value.realtimeConnected
    && value.ownershipGranted && value.robotSafetyEnabled;
}

function validateReadiness(value: MobileReadiness): MobileReadiness {
  for (const [field, entry] of Object.entries(value)) {
    if (typeof entry !== "boolean") fail("MOBILE_READINESS_INVALID", `${field} must be boolean.`);
  }
  return clone(value);
}

function missingReadinessReason(value: MobileReadiness): string {
  const missing = Object.entries(value).filter(([, ready]) => !ready).map(([name]) => name);
  return `Command input interrupted: ${missing.join(", ")}.`;
}

function validateBaseLimits(value: MobileBaseCommandLimits): MobileBaseCommandLimits {
  positiveFinite(value.maximumLinearXMetersPerSecond, "maximumLinearXMetersPerSecond");
  positiveFinite(value.maximumLinearYMetersPerSecond, "maximumLinearYMetersPerSecond");
  positiveFinite(value.maximumAngularZRadiansPerSecond, "maximumAngularZRadiansPerSecond");
  return clone(value);
}

function validateManipulatorLimits(value: MobileManipulatorCommandLimits): MobileManipulatorCommandLimits {
  if (!Number.isSafeInteger(value.jointCount) || value.jointCount < 1) fail("MOBILE_LIMIT_INVALID", "jointCount must be positive.");
  positiveFinite(value.maximumCartesianLinearMetersPerSecond, "maximumCartesianLinearMetersPerSecond");
  positiveFinite(value.maximumCartesianAngularRadiansPerSecond, "maximumCartesianAngularRadiansPerSecond");
  return clone(value);
}

function positiveFinite(value: number, field: string): void {
  if (!Number.isFinite(value) || value <= 0) fail("MOBILE_LIMIT_INVALID", `${field} must be positive and finite.`);
}

function normalizedVector(values: readonly number[], field: string): number[] {
  return values.map((value, index) => {
    if (!Number.isFinite(value)) fail("MOBILE_INPUT_INVALID", `${field}[${index}] must be finite.`);
    return Math.max(-1, Math.min(1, value));
  });
}

function normalizedScale(value: number): number {
  return normalizedUnit(value, "speedScale");
}

function normalizedUnit(value: number, field: string): number {
  if (!Number.isFinite(value)) fail("MOBILE_INPUT_INVALID", `${field} must be finite.`);
  return Math.max(0, Math.min(1, value));
}

function requiredText(value: string, field: string): string {
  if (!value.trim()) fail("MOBILE_INPUT_INVALID", `${field} is required.`);
  return value;
}
