import {
  assertContractVersion,
  assertFiniteNumber,
  assertNonEmpty,
  assertUnixMs,
  clone,
  fail,
  type SessionScope,
  type TeleopCommandEnvelope,
  type TeleopSessionLease,
  type ValidatedTeleopCommand,
} from "../../../packages/contracts/src/index.ts";

export interface CommandValidatorOptions {
  maximumCommandLifetimeMs?: number;
  maximumFutureClockSkewMs?: number;
}

export class TeleopCommandValidator {
  private readonly lastSequenceBySession = new Map<string, number>();
  private readonly maximumCommandLifetimeMs: number;
  private readonly maximumFutureClockSkewMs: number;

  constructor(options: CommandValidatorOptions = {}) {
    this.maximumCommandLifetimeMs = options.maximumCommandLifetimeMs ?? 500;
    this.maximumFutureClockSkewMs = options.maximumFutureClockSkewMs ?? 100;
    if (this.maximumCommandLifetimeMs <= 0 || this.maximumFutureClockSkewMs < 0) {
      throw new Error("Command validator timing limits are invalid.");
    }
  }

  validate(
    command: TeleopCommandEnvelope,
    lease: TeleopSessionLease,
    nowUnixMs: number,
    arrivalMonotonicMs: number,
  ): ValidatedTeleopCommand {
    this.assertShape(command);
    assertContractVersion(lease.contractVersion);
    assertUnixMs(nowUnixMs, "nowUnixMs");
    assertFiniteNumber(arrivalMonotonicMs, "arrivalMonotonicMs");
    if (arrivalMonotonicMs < 0) fail("COMMAND_ARRIVAL_TIME_INVALID", "arrivalMonotonicMs cannot be negative.");
    if (command.sessionId !== lease.sessionId || command.robotId !== lease.robotId || command.sourceId !== lease.operatorId) {
      fail("COMMAND_LEASE_MISMATCH", "Command identity does not match the installed session lease.");
    }
    if (nowUnixMs >= lease.expiresAtUnixMs) fail("COMMAND_LEASE_EXPIRED", "The installed session lease has expired.");
    if (command.expiresAtUnixMs > lease.expiresAtUnixMs) {
      fail("COMMAND_EXCEEDS_LEASE", "Command expiry cannot extend beyond the session lease.");
    }
    if (command.producedAtUnixMs > nowUnixMs + this.maximumFutureClockSkewMs) {
      fail("COMMAND_CLOCK_SKEW", "Command production time is too far in the future.");
    }
    if (nowUnixMs >= command.expiresAtUnixMs) fail("COMMAND_STALE", "Command has expired.");
    if (command.expiresAtUnixMs - command.producedAtUnixMs > this.maximumCommandLifetimeMs) {
      fail("COMMAND_LIFETIME_INVALID", "Command lifetime exceeds the configured maximum.");
    }
    if (!command.deadman) fail("COMMAND_DEADMAN_RELEASED", "Command deadman is not active.");
    const requiredScope: SessionScope = command.actuatorGroup === "BASE" ? "CONTROL_BASE" : "CONTROL_MANIPULATOR";
    if (!lease.scopes.includes(requiredScope)) fail("COMMAND_SCOPE_DENIED", `Lease does not grant ${requiredScope}.`);
    const previous = this.lastSequenceBySession.get(command.sessionId);
    if (previous !== undefined && command.sequence <= previous) {
      fail("COMMAND_SEQUENCE_REPLAY", `Command sequence ${command.sequence} is not newer than ${previous}.`);
    }
    this.lastSequenceBySession.set(command.sessionId, command.sequence);
    return { command: clone(command), arrivalMonotonicMs };
  }

  clearSession(sessionId: string): void {
    this.lastSequenceBySession.delete(sessionId);
  }

  private assertShape(command: TeleopCommandEnvelope): void {
    assertContractVersion(command.contractVersion);
    for (const [field, value] of Object.entries({
      commandId: command.commandId,
      sessionId: command.sessionId,
      robotId: command.robotId,
      sourceId: command.sourceId,
    })) assertNonEmpty(value, field);
    if (!Number.isSafeInteger(command.sequence) || command.sequence < 1) {
      fail("COMMAND_SEQUENCE_INVALID", "Command sequence must be a positive safe integer.");
    }
    assertUnixMs(command.producedAtUnixMs, "producedAtUnixMs");
    assertUnixMs(command.expiresAtUnixMs, "expiresAtUnixMs");
    if (command.expiresAtUnixMs <= command.producedAtUnixMs) {
      fail("COMMAND_EXPIRY_INVALID", "Command expiry must follow production time.");
    }
    if (command.actuatorGroup !== "BASE" && command.actuatorGroup !== "MANIPULATOR") {
      fail("COMMAND_ACTUATOR_INVALID", `Unknown actuator group ${String(command.actuatorGroup)}.`);
    }
    if (command.intent.kind !== "BASE_MOTION" && command.intent.kind !== "ARM_MOTION" && command.intent.kind !== "GRIPPER") {
      fail("COMMAND_INTENT_INVALID", `Unknown command intent ${String((command.intent as { kind?: unknown }).kind)}.`);
    }
    if (command.actuatorGroup === "BASE" && command.intent.kind !== "BASE_MOTION") {
      fail("COMMAND_ACTUATOR_MISMATCH", "BASE commands require a base-motion intent.");
    }
    if (command.actuatorGroup === "MANIPULATOR" && command.intent.kind === "BASE_MOTION") {
      fail("COMMAND_ACTUATOR_MISMATCH", "MANIPULATOR commands cannot carry a base-motion intent.");
    }
    if (command.intent.kind === "BASE_MOTION") {
      assertNonEmpty(command.intent.frameId, "intent.frameId");
      for (const [field, value] of Object.entries({
        linearXMetersPerSecond: command.intent.linearXMetersPerSecond,
        linearYMetersPerSecond: command.intent.linearYMetersPerSecond,
        angularZRadiansPerSecond: command.intent.angularZRadiansPerSecond,
        speedScale: command.intent.speedScale,
      })) assertFiniteNumber(value, `intent.${field}`);
      if (command.intent.speedScale < 0 || command.intent.speedScale > 1) {
        fail("COMMAND_SPEED_SCALE_INVALID", "Base speedScale must be between 0 and 1.");
      }
    } else if (command.intent.kind === "ARM_MOTION") {
      assertNonEmpty(command.intent.frameId, "intent.frameId");
      if (command.intent.values.length === 0 || command.intent.values.some((value) => !Number.isFinite(value))) {
        fail("COMMAND_ARM_VALUES_INVALID", "Arm values must be a non-empty finite array.");
      }
      if (command.intent.speedScale < 0 || command.intent.speedScale > 1) {
        fail("COMMAND_SPEED_SCALE_INVALID", "Arm speedScale must be between 0 and 1.");
      }
      if (command.intent.mode === "CARTESIAN_TWIST" && command.intent.values.length !== 6) {
        fail("COMMAND_ARM_VALUES_INVALID", "Cartesian arm twist requires exactly six values.");
      }
      if (!command.intent.clutch) fail("COMMAND_CLUTCH_RELEASED", "Arm motion requires an active clutch.");
    } else {
      assertFiniteNumber(command.intent.normalizedPosition, "intent.normalizedPosition");
      if (command.intent.normalizedPosition < 0 || command.intent.normalizedPosition > 1) {
        fail("COMMAND_GRIPPER_POSITION_INVALID", "Gripper position must be normalized between 0 and 1.");
      }
      if (command.intent.normalizedForceLimit !== undefined) {
        assertFiniteNumber(command.intent.normalizedForceLimit, "intent.normalizedForceLimit");
        if (command.intent.normalizedForceLimit < 0 || command.intent.normalizedForceLimit > 1) {
          fail("COMMAND_GRIPPER_FORCE_INVALID", "Gripper force limit must be normalized between 0 and 1.");
        }
      }
    }
  }
}
