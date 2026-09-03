import { randomUUID } from "node:crypto";
import {
  CONTRACT_VERSION,
  assertContractVersion,
  clone,
  decodeTeleopSessionLease,
  fail,
  type ActuatorGroup,
  type CommandOwnershipState,
  type TeleopCommandEnvelope,
  type TeleopSessionLease,
  type LeaseSignatureVerifier,
  type RobotSessionReadinessReport,
} from "../../../packages/contracts/src/index.ts";
import { CommandArbiter } from "../../../robot/command-arbiter/src/index.ts";
import {
  BaseSafetySupervisor,
  ManipulatorSafetySupervisor,
  type BaseSafetyInterlocks,
  type BaseSafetyProfile,
  type BaseSafetyState,
  type ManipulatorSafetyInterlocks,
  type ManipulatorSafetyProfile,
  type ManipulatorSafetyState,
} from "../../../robot/safety-supervisor/src/index.ts";
import { TeleopCommandValidator } from "./command-validator.ts";

export interface LocalRobotAgentOptions {
  robotId: string;
  baseSafetyProfile: BaseSafetyProfile;
  nowUnixMs?: () => number;
  nowMonotonicMs?: () => number;
  idGenerator?: () => string;
  leaseVerifier?: LeaseSignatureVerifier;
  requireSignedLeases?: boolean;
  manipulatorSafetyProfile?: ManipulatorSafetyProfile;
}

export interface LocalRobotAgentState {
  robotId: string;
  installedLeases: readonly TeleopSessionLease[];
  ownership: CommandOwnershipState;
  baseSafety: BaseSafetyState;
  manipulatorSafety?: ManipulatorSafetyState;
}

export interface RobotStoppedEvidence {
  observedAtUnixMs: number;
  controllerStateFresh: boolean;
  baseStopped: boolean;
  manipulatorHolding: boolean;
}

export class LocalRobotAgent {
  private readonly robotId: string;
  private readonly leases = new Map<string, TeleopSessionLease>();
  private readonly validator = new TeleopCommandValidator();
  private readonly arbiter: CommandArbiter;
  private readonly safety: BaseSafetySupervisor;
  private readonly manipulatorSafety?: ManipulatorSafetySupervisor;
  private readonly nowUnixMs: () => number;
  private readonly nowMonotonicMs: () => number;
  private readonly idGenerator: () => string;
  private readonly leaseVerifier?: LeaseSignatureVerifier;
  private readonly requireSignedLeases: boolean;

  constructor(options: LocalRobotAgentOptions) {
    if (options.robotId !== options.baseSafetyProfile.robotId) {
      throw new Error("Robot agent and base safety profile IDs must match.");
    }
    this.robotId = options.robotId;
    this.nowUnixMs = options.nowUnixMs ?? Date.now;
    this.nowMonotonicMs = options.nowMonotonicMs ?? (() => performance.now());
    this.idGenerator = options.idGenerator ?? randomUUID;
    this.leaseVerifier = options.leaseVerifier;
    this.requireSignedLeases = options.requireSignedLeases ?? false;
    if (this.requireSignedLeases && !this.leaseVerifier) throw new Error("Signed leases require a leaseVerifier.");
    this.arbiter = new CommandArbiter(this.robotId, this.nowUnixMs());
    this.safety = new BaseSafetySupervisor(options.baseSafetyProfile, this.nowUnixMs(), this.nowMonotonicMs());
    if (options.manipulatorSafetyProfile) {
      if (options.manipulatorSafetyProfile.robotId !== this.robotId) throw new Error("Robot agent and manipulator safety profile IDs must match.");
      this.manipulatorSafety = new ManipulatorSafetySupervisor(options.manipulatorSafetyProfile, this.nowUnixMs(), this.nowMonotonicMs());
    }
  }

  installLease(lease: TeleopSessionLease): LocalRobotAgentState {
    if (this.requireSignedLeases) fail("SESSION_LEASE_SIGNATURE_REQUIRED", "Robot agent requires a signed lease envelope.");
    return this.installVerifiedLease(lease);
  }

  installSignedLease(envelope: unknown, expectedSessionId?: string): LocalRobotAgentState {
    if (!this.leaseVerifier) fail("SESSION_LEASE_SIGNATURE_UNSUPPORTED", "Robot agent has no lease verification keys.");
    const lease = this.leaseVerifier.verify(envelope);
    if (expectedSessionId !== undefined && lease.sessionId !== expectedSessionId) {
      fail("REALTIME_CHANNEL_SESSION_MISMATCH", "Signed lease belongs to another channel session.");
    }
    return this.installVerifiedLease(lease);
  }

  private installVerifiedLease(lease: TeleopSessionLease): LocalRobotAgentState {
    const decoded = decodeTeleopSessionLease(lease);
    assertContractVersion(decoded.contractVersion);
    if (decoded.robotId !== this.robotId) fail("ROBOT_ID_MISMATCH", "Lease targets another robot.");
    if (this.nowUnixMs() >= decoded.expiresAtUnixMs) fail("SESSION_LEASE_EXPIRED", "Cannot install an expired lease.");
    if (decoded.expiresAtUnixMs <= decoded.issuedAtUnixMs) fail("SESSION_LEASE_INVALID", "Lease expiry must follow issue time.");
    if (decoded.scopes.length === 0) fail("SESSION_SCOPES_REQUIRED", "Lease requires at least one scope.");
    const existing = this.leases.get(decoded.sessionId);
    if (existing) {
      if (decoded.revision < existing.revision) fail("SESSION_LEASE_REVISION_STALE", "Installed lease revision is newer.");
      if (decoded.revision === existing.revision) {
        if (JSON.stringify(existing) !== JSON.stringify(decoded)) fail("SESSION_LEASE_REVISION_COLLISION", "Lease revision identifies different data.");
        return this.state();
      }
      if (existing.robotId !== decoded.robotId || existing.operatorId !== decoded.operatorId) {
        fail("SESSION_LEASE_IDENTITY_CHANGED", "A lease renewal cannot change robot or operator identity.");
      }
      if (JSON.stringify([...existing.scopes].sort()) !== JSON.stringify([...decoded.scopes].sort())) {
        fail("SESSION_LEASE_SCOPES_CHANGED", "A lease renewal cannot change its authorization scopes.");
      }
    }
    this.leases.set(decoded.sessionId, clone(decoded));
    return this.state();
  }

  revokeLease(sessionId: string, reason: string): LocalRobotAgentState {
    if (!reason.trim()) fail("SESSION_REASON_REQUIRED", "A lease revocation reason is required.");
    if (!this.leases.has(sessionId)) fail("SESSION_LEASE_NOT_FOUND", `Lease ${sessionId} is not installed.`);
    this.clearOwnedSession(sessionId, reason);
    this.leases.delete(sessionId);
    this.validator.clearSession(sessionId);
    return this.state();
  }

  requestOwnership(sessionId: string, actuatorGroup: ActuatorGroup): LocalRobotAgentState {
    if (actuatorGroup === "MANIPULATOR" && !this.manipulatorSafety) {
      fail("EDGE_ACTUATOR_UNSUPPORTED", "Manipulator ownership requires a configured manipulator safety supervisor.");
    }
    const lease = this.requireLiveLease(sessionId);
    const requiredScope = actuatorGroup === "BASE" ? "CONTROL_BASE" : "CONTROL_MANIPULATOR";
    if (!lease.scopes.includes(requiredScope)) fail("OWNERSHIP_SCOPE_DENIED", `Lease does not grant ${requiredScope}.`);
    this.arbiter.requestOwnership({
      requestId: this.idGenerator(),
      robotId: this.robotId,
      sourceId: lease.operatorId,
      authority: "DIRECT_TELEOP",
      actuatorGroup,
      sessionId,
      requestedAtUnixMs: this.nowUnixMs(),
    }, this.arbiter.snapshot().revision);
    return this.state();
  }

  acknowledgeStopped(expectedOwnershipRevision: number, evidence: RobotStoppedEvidence): LocalRobotAgentState {
    const now = this.nowUnixMs();
    if (!Number.isSafeInteger(evidence.observedAtUnixMs) || evidence.observedAtUnixMs > now + 100
      || now - evidence.observedAtUnixMs > 500 || !evidence.controllerStateFresh || !evidence.baseStopped) {
      fail("ROBOT_STOP_EVIDENCE_INVALID", "Stopped acknowledgement requires fresh controller state and a stopped base.");
    }
    const ownership = this.arbiter.snapshot();
    const group = ownership.pendingOwner?.actuatorGroup ?? ownership.owner?.actuatorGroup;
    if (group === "MANIPULATOR" && !evidence.manipulatorHolding) {
      fail("ROBOT_STOP_EVIDENCE_INVALID", "Manipulator handoff requires confirmed arm hold.");
    }
    this.arbiter.acknowledgeStopped(expectedOwnershipRevision, this.nowUnixMs());
    return this.state();
  }

  createReadinessReport(sessionId: string, readinessId = this.idGenerator()): RobotSessionReadinessReport {
    if (!readinessId.trim()) fail("ROBOT_READINESS_ID_REQUIRED", "readinessId is required.");
    const lease = this.requireLiveLease(sessionId);
    const ownership = this.arbiter.snapshot();
    const boundOwner = ownership.owner?.sessionId === sessionId ? ownership.owner : undefined;
    const boundPendingOwner = ownership.pendingOwner?.sessionId === sessionId ? ownership.pendingOwner : undefined;
    if (ownership.status !== "NO_OWNER" && !boundOwner && !boundPendingOwner) {
      fail("ROBOT_READINESS_SESSION_OWNERSHIP_MISMATCH", "Robot ownership belongs to another session.");
    }
    const actuatorGroup = boundPendingOwner?.actuatorGroup ?? boundOwner?.actuatorGroup;
    return {
      contractVersion: CONTRACT_VERSION,
      readinessId,
      sessionId,
      robotId: this.robotId,
      operatorId: lease.operatorId,
      leaseRevision: lease.revision,
      ownershipRevision: ownership.revision,
      ownershipStatus: ownership.status,
      ...(actuatorGroup === undefined ? {} : { actuatorGroup }),
      reportedAtUnixMs: this.nowUnixMs(),
    };
  }

  releaseOwnership(expectedOwnershipRevision: number, reason: string): LocalRobotAgentState {
    const ownership = this.arbiter.snapshot();
    if (!ownership.owner) fail("COMMAND_OWNER_REQUIRED", "No owner can be released.");
    this.holdSafetyIfNeeded(reason);
    this.arbiter.releaseOwnership(ownership.owner.sourceId, expectedOwnershipRevision, this.nowUnixMs(), reason);
    return this.state();
  }

  updateBaseInterlocks(interlocks: BaseSafetyInterlocks): LocalRobotAgentState {
    this.safety.updateInterlocks(interlocks, this.nowUnixMs(), this.nowMonotonicMs());
    return this.state();
  }

  prepareBaseSafety(expectedSafetyRevision: number): LocalRobotAgentState {
    this.safety.prepare(expectedSafetyRevision, this.nowUnixMs(), this.nowMonotonicMs());
    return this.state();
  }

  enableBaseSafety(expectedSafetyRevision: number): LocalRobotAgentState {
    this.safety.enable(this.arbiter.snapshot(), expectedSafetyRevision, this.nowUnixMs(), this.nowMonotonicMs());
    return this.state();
  }

  acceptCommand(command: TeleopCommandEnvelope): LocalRobotAgentState {
    const lease = this.requireLiveLease(command.sessionId);
    const validated = this.validator.validate(command, lease, this.nowUnixMs(), this.nowMonotonicMs());
    const selected = this.arbiter.selectCommand(validated);
    if (command.actuatorGroup === "BASE") {
      this.safety.accept(selected, this.arbiter.snapshot(), this.safety.snapshot().revision, this.nowUnixMs(), this.nowMonotonicMs());
    } else {
      const manipulatorSafety = this.requireManipulatorSafety();
      manipulatorSafety.accept(selected, this.arbiter.snapshot(), manipulatorSafety.snapshot().revision, this.nowUnixMs(), this.nowMonotonicMs());
    }
    return this.state();
  }

  holdBaseSafety(expectedSafetyRevision: number, reason: string): LocalRobotAgentState {
    this.safety.hold(expectedSafetyRevision, this.nowUnixMs(), this.nowMonotonicMs(), reason);
    return this.state();
  }

  updateManipulatorInterlocks(interlocks: ManipulatorSafetyInterlocks): LocalRobotAgentState {
    this.requireManipulatorSafety().updateInterlocks(interlocks, this.nowUnixMs(), this.nowMonotonicMs());
    return this.state();
  }

  prepareManipulatorSafety(expectedRevision: number): LocalRobotAgentState {
    this.requireManipulatorSafety().prepare(expectedRevision, this.nowUnixMs(), this.nowMonotonicMs());
    return this.state();
  }

  enableManipulatorSafety(expectedRevision: number): LocalRobotAgentState {
    this.requireManipulatorSafety().enable(this.arbiter.snapshot(), expectedRevision, this.nowUnixMs(), this.nowMonotonicMs());
    return this.state();
  }

  holdManipulatorSafety(expectedRevision: number, reason: string): LocalRobotAgentState {
    this.requireManipulatorSafety().hold(expectedRevision, this.nowUnixMs(), this.nowMonotonicMs(), reason);
    return this.state();
  }

  tick(): LocalRobotAgentState {
    const nowUnixMs = this.nowUnixMs();
    const expired = [...this.leases.values()].filter((lease) => nowUnixMs >= lease.expiresAtUnixMs);
    for (const lease of expired) {
      this.clearOwnedSession(lease.sessionId, "Installed lease expired.");
      this.leases.delete(lease.sessionId);
      this.validator.clearSession(lease.sessionId);
    }
    this.safety.tick(this.safety.snapshot().revision, nowUnixMs, this.nowMonotonicMs());
    if (this.manipulatorSafety) {
      this.manipulatorSafety.tick(this.manipulatorSafety.snapshot().revision, nowUnixMs, this.nowMonotonicMs());
    }
    return this.state();
  }

  state(): LocalRobotAgentState {
    return {
      robotId: this.robotId,
      installedLeases: [...this.leases.values()].map(clone),
      ownership: this.arbiter.snapshot(),
      baseSafety: this.safety.snapshot(),
      manipulatorSafety: this.manipulatorSafety?.snapshot(),
    };
  }

  private requireLiveLease(sessionId: string): TeleopSessionLease {
    const lease = this.leases.get(sessionId);
    if (!lease) fail("SESSION_LEASE_NOT_FOUND", `Lease ${sessionId} is not installed.`);
    if (this.nowUnixMs() >= lease.expiresAtUnixMs) {
      this.clearOwnedSession(sessionId, "Installed lease expired.");
      this.leases.delete(sessionId);
      this.validator.clearSession(sessionId);
      fail("SESSION_LEASE_EXPIRED", `Lease ${sessionId} has expired.`);
    }
    return lease;
  }

  private clearOwnedSession(sessionId: string, reason: string): void {
    const ownership = this.arbiter.snapshot();
    const ownsSession = ownership.owner?.sessionId === sessionId || ownership.pendingOwner?.sessionId === sessionId;
    if (!ownsSession) return;
    this.holdSafetyIfNeeded(reason);
    this.arbiter.forceStop(this.arbiter.snapshot().revision, this.nowUnixMs(), reason);
  }

  private holdSafetyIfNeeded(reason: string): void {
    const safety = this.safety.snapshot();
    if (safety.status === "READY" || safety.status === "ENABLED") {
      this.safety.hold(safety.revision, this.nowUnixMs(), this.nowMonotonicMs(), reason);
    }
    if (this.manipulatorSafety) {
      const manipulator = this.manipulatorSafety.snapshot();
      if (manipulator.status === "READY" || manipulator.status === "ENABLED") {
        this.manipulatorSafety.hold(manipulator.revision, this.nowUnixMs(), this.nowMonotonicMs(), reason);
      }
    }
  }

  private requireManipulatorSafety(): ManipulatorSafetySupervisor {
    if (!this.manipulatorSafety) fail("EDGE_ACTUATOR_UNSUPPORTED", "Manipulator safety is not configured.");
    return this.manipulatorSafety;
  }
}
