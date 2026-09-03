import { randomUUID } from "node:crypto";
import {
  CONTRACT_VERSION,
  clone,
  fail,
  type SessionScope,
  type TeleopSessionLease,
} from "../../../packages/contracts/src/index.ts";

export type SessionStatus =
  | "REQUESTED"
  | "GRANTED"
  | "CONNECTING"
  | "ACTIVE"
  | "HOLDING"
  | "RELEASED"
  | "EXPIRED"
  | "REVOKED"
  | "FAULTED";

export interface SessionSnapshot {
  sessionId: string;
  robotId: string;
  operatorId: string;
  scopes: readonly SessionScope[];
  status: SessionStatus;
  revision: number;
  requestedAtUnixMs: number;
  changedAtUnixMs: number;
  lease?: TeleopSessionLease;
  reason?: string;
}

export interface SessionEvent {
  eventId: string;
  sessionId: string;
  robotId: string;
  revision: number;
  type: `SESSION_${SessionStatus}`;
  occurredAtUnixMs: number;
  reason?: string;
}

export interface SessionControlOptions {
  now?: () => number;
  idGenerator?: () => string;
  minimumLeaseMs?: number;
  maximumLeaseMs?: number;
  initialState?: SessionControlState;
}

export interface SessionControlState {
  schemaVersion: 1;
  sessions: readonly SessionSnapshot[];
  events: readonly SessionEvent[];
}

const terminalStatuses = new Set<SessionStatus>(["RELEASED", "EXPIRED", "REVOKED", "FAULTED"]);
const commandScopes = new Set<SessionScope>(["CONTROL_BASE", "CONTROL_MANIPULATOR"]);

export class InMemorySessionControl {
  private readonly sessions = new Map<string, SessionSnapshot>();
  private readonly eventsBySession = new Map<string, SessionEvent[]>();
  private readonly now: () => number;
  private readonly idGenerator: () => string;
  private readonly minimumLeaseMs: number;
  private readonly maximumLeaseMs: number;

  constructor(options: SessionControlOptions = {}) {
    this.now = options.now ?? Date.now;
    this.idGenerator = options.idGenerator ?? randomUUID;
    this.minimumLeaseMs = options.minimumLeaseMs ?? 1_000;
    this.maximumLeaseMs = options.maximumLeaseMs ?? 60 * 60 * 1_000;
    if (this.minimumLeaseMs <= 0 || this.maximumLeaseMs < this.minimumLeaseMs) {
      throw new Error("Session lease bounds are invalid.");
    }
    if (options.initialState) this.restore(options.initialState);
  }

  requestSession(input: {
    robotId: string;
    operatorId: string;
    scopes: readonly SessionScope[];
    sessionId?: string;
  }): SessionSnapshot {
    const now = this.now();
    const sessionId = input.sessionId ?? this.idGenerator();
    if (!input.robotId.trim()) fail("ROBOT_ID_REQUIRED", "robotId is required.");
    if (!input.operatorId.trim()) fail("OPERATOR_ID_REQUIRED", "operatorId is required.");
    if (input.scopes.length === 0) fail("SESSION_SCOPES_REQUIRED", "At least one session scope is required.");
    const scopes = [...new Set(input.scopes)].sort();
    const existing = this.sessions.get(sessionId);
    if (existing) {
      const same = existing.robotId === input.robotId
        && existing.operatorId === input.operatorId
        && JSON.stringify(existing.scopes) === JSON.stringify(scopes);
      if (!same) fail("SESSION_ID_COLLISION", `Session ${sessionId} already identifies another request.`);
      return clone(existing);
    }
    const snapshot: SessionSnapshot = {
      sessionId,
      robotId: input.robotId,
      operatorId: input.operatorId,
      scopes,
      status: "REQUESTED",
      revision: 1,
      requestedAtUnixMs: now,
      changedAtUnixMs: now,
    };
    this.sessions.set(sessionId, snapshot);
    this.appendEvent(snapshot);
    return clone(snapshot);
  }

  grantSession(sessionId: string, expectedRevision: number, leaseDurationMs: number): SessionSnapshot {
    const session = this.validateGrant(sessionId, expectedRevision, leaseDurationMs);
    const now = this.now();
    const revision = session.revision + 1;
    const lease: TeleopSessionLease = {
      contractVersion: CONTRACT_VERSION,
      sessionId,
      robotId: session.robotId,
      operatorId: session.operatorId,
      scopes: [...session.scopes],
      revision: 1,
      issuedAtUnixMs: now,
      expiresAtUnixMs: now + leaseDurationMs,
    };
    return this.replace(session, { status: "GRANTED", revision, changedAtUnixMs: now, lease, reason: undefined });
  }

  validateGrant(sessionId: string, expectedRevision: number, leaseDurationMs: number): SessionSnapshot {
    const session = this.requireSession(sessionId);
    this.requireRevision(session, expectedRevision);
    this.requireStatus(session, ["REQUESTED"]);
    if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < this.minimumLeaseMs || leaseDurationMs > this.maximumLeaseMs) {
      fail(
        "SESSION_LEASE_DURATION_INVALID",
        `Lease duration must be between ${this.minimumLeaseMs} and ${this.maximumLeaseMs} milliseconds.`,
      );
    }
    this.expireDue(this.now());
    if (this.hasCommandScope(session.scopes)) {
      const conflict = [...this.sessions.values()].find((candidate) =>
        candidate.sessionId !== sessionId
        && candidate.robotId === session.robotId
        && !terminalStatuses.has(candidate.status)
        && this.hasCommandScope(candidate.scopes)
        && candidate.status !== "REQUESTED",
      );
      if (conflict) fail("SESSION_COMMAND_CONFLICT", `Robot ${session.robotId} already has commanding session ${conflict.sessionId}.`);
    }
    return clone(session);
  }

  markConnecting(sessionId: string, expectedRevision: number): SessionSnapshot {
    return this.transition(sessionId, expectedRevision, ["GRANTED"], "CONNECTING");
  }

  activate(sessionId: string, expectedRevision: number, robotOwnershipGranted: boolean): SessionSnapshot {
    const session = this.requireLiveLease(sessionId);
    this.requireRevision(session, expectedRevision);
    this.requireStatus(session, ["CONNECTING", "HOLDING"]);
    if (this.hasCommandScope(session.scopes) && !robotOwnershipGranted) {
      fail("SESSION_OWNERSHIP_REQUIRED", "A commanding session cannot become active before robot-local ownership is granted.");
    }
    return this.transition(sessionId, expectedRevision, ["CONNECTING", "HOLDING"], "ACTIVE");
  }

  hold(sessionId: string, expectedRevision: number, reason: string): SessionSnapshot {
    if (!reason.trim()) fail("SESSION_REASON_REQUIRED", "A hold reason is required.");
    return this.transition(sessionId, expectedRevision, ["ACTIVE"], "HOLDING", reason);
  }

  release(sessionId: string, expectedRevision: number, robotStopped: boolean, reason = "Released by operator."): SessionSnapshot {
    const session = this.requireSession(sessionId);
    if (session.status === "RELEASED") return clone(session);
    this.requireRevision(session, expectedRevision);
    const now = this.now();
    if (session.lease && now >= session.lease.expiresAtUnixMs) {
      this.expireDue(now);
      fail("SESSION_LEASE_EXPIRED", `Session ${sessionId} has expired.`);
    }
    if (terminalStatuses.has(session.status)) fail("SESSION_TERMINAL", `Session ${sessionId} is ${session.status}.`);
    if (this.hasCommandScope(session.scopes) && !robotStopped) {
      fail("SESSION_STOP_ACK_REQUIRED", "A commanding session cannot be released before the robot acknowledges stopped ownership.");
    }
    return this.transition(sessionId, expectedRevision, [session.status], "RELEASED", reason);
  }

  revoke(sessionId: string, expectedRevision: number, reason: string): SessionSnapshot {
    const session = this.requireSession(sessionId);
    if (session.status === "REVOKED") return clone(session);
    if (!reason.trim()) fail("SESSION_REASON_REQUIRED", "A revocation reason is required.");
    this.requireRevision(session, expectedRevision);
    if (terminalStatuses.has(session.status)) fail("SESSION_TERMINAL", `Session ${sessionId} is ${session.status}.`);
    return this.transition(sessionId, expectedRevision, [session.status], "REVOKED", reason);
  }

  renewSession(sessionId: string, expectedRevision: number, leaseDurationMs: number): SessionSnapshot {
    const session = this.requireLiveLease(sessionId);
    this.requireRevision(session, expectedRevision);
    if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < this.minimumLeaseMs || leaseDurationMs > this.maximumLeaseMs) {
      fail("SESSION_LEASE_DURATION_INVALID", "Lease duration is outside configured bounds.");
    }
    const now = this.now();
    const lease = { ...session.lease!, revision: session.lease!.revision + 1, issuedAtUnixMs: now, expiresAtUnixMs: now + leaseDurationMs };
    return this.replace(session, { revision: session.revision + 1, changedAtUnixMs: now, lease });
  }

  expireDue(atUnixMs = this.now()): SessionSnapshot[] {
    const expired: SessionSnapshot[] = [];
    for (const session of this.sessions.values()) {
      if (!terminalStatuses.has(session.status) && session.lease && atUnixMs >= session.lease.expiresAtUnixMs) {
        expired.push(this.replace(session, {
          status: "EXPIRED",
          revision: session.revision + 1,
          changedAtUnixMs: atUnixMs,
          reason: "Session lease expired.",
        }));
      }
    }
    return expired;
  }

  getSession(sessionId: string): SessionSnapshot {
    return clone(this.requireSession(sessionId));
  }

  getEvents(sessionId: string): readonly SessionEvent[] {
    this.requireSession(sessionId);
    return clone(this.eventsBySession.get(sessionId) ?? []);
  }

  listSessions(): readonly SessionSnapshot[] {
    return clone([...this.sessions.values()].sort((left, right) => right.changedAtUnixMs - left.changedAtUnixMs));
  }

  exportState(): SessionControlState {
    return clone({
      schemaVersion: 1,
      sessions: [...this.sessions.values()],
      events: [...this.eventsBySession.values()].flat(),
    });
  }

  private restore(state: SessionControlState): void {
    if (state.schemaVersion !== 1 || !Array.isArray(state.sessions) || !Array.isArray(state.events)) {
      fail("SESSION_STATE_INVALID", "Persisted session state is invalid or unsupported.");
    }
    for (const session of state.sessions) {
      if (!session.sessionId?.trim() || !session.robotId?.trim() || !session.operatorId?.trim()
        || !Number.isSafeInteger(session.revision) || session.revision < 1 || this.sessions.has(session.sessionId)) {
        fail("SESSION_STATE_INVALID", "Persisted session snapshot is malformed or duplicated.");
      }
      this.sessions.set(session.sessionId, clone(session));
    }
    for (const event of state.events) {
      const session = this.sessions.get(event.sessionId);
      if (!session || event.robotId !== session.robotId || !Number.isSafeInteger(event.revision)
        || event.revision < 1 || event.revision > session.revision) {
        fail("SESSION_STATE_INVALID", "Persisted session event has invalid provenance.");
      }
      const events = this.eventsBySession.get(event.sessionId) ?? [];
      events.push(clone(event));
      this.eventsBySession.set(event.sessionId, events);
    }
    for (const session of this.sessions.values()) {
      const events = this.eventsBySession.get(session.sessionId) ?? [];
      if (events.length === 0 || events.at(-1)?.revision !== session.revision) {
        fail("SESSION_STATE_INVALID", `Persisted events do not cover session ${session.sessionId}.`);
      }
    }
  }

  private transition(
    sessionId: string,
    expectedRevision: number,
    allowed: readonly SessionStatus[],
    status: SessionStatus,
    reason?: string,
  ): SessionSnapshot {
    const session = this.requireSession(sessionId);
    this.requireRevision(session, expectedRevision);
    this.requireStatus(session, allowed);
    const now = this.now();
    if (status !== "EXPIRED" && session.lease && now >= session.lease.expiresAtUnixMs) {
      this.replace(session, {
        status: "EXPIRED",
        revision: session.revision + 1,
        changedAtUnixMs: now,
        reason: "Session lease expired.",
      });
      fail("SESSION_LEASE_EXPIRED", `Session ${sessionId} has expired.`);
    }
    return this.replace(session, { status, revision: session.revision + 1, changedAtUnixMs: now, reason });
  }

  private replace(session: SessionSnapshot, changes: Partial<SessionSnapshot>): SessionSnapshot {
    const next = { ...session, ...changes };
    this.sessions.set(session.sessionId, next);
    this.appendEvent(next);
    return clone(next);
  }

  private appendEvent(session: SessionSnapshot): void {
    const events = this.eventsBySession.get(session.sessionId) ?? [];
    events.push({
      eventId: this.idGenerator(),
      sessionId: session.sessionId,
      robotId: session.robotId,
      revision: session.revision,
      type: `SESSION_${session.status}`,
      occurredAtUnixMs: session.changedAtUnixMs,
      reason: session.reason,
    });
    this.eventsBySession.set(session.sessionId, events);
  }

  private requireSession(sessionId: string): SessionSnapshot {
    const session = this.sessions.get(sessionId);
    if (!session) fail("SESSION_NOT_FOUND", `Session ${sessionId} was not found.`);
    return session;
  }

  private requireLiveLease(sessionId: string): SessionSnapshot {
    const session = this.requireSession(sessionId);
    if (!session.lease) fail("SESSION_LEASE_REQUIRED", `Session ${sessionId} has no lease.`);
    if (this.now() >= session.lease.expiresAtUnixMs) {
      this.expireDue(this.now());
      fail("SESSION_LEASE_EXPIRED", `Session ${sessionId} has expired.`);
    }
    return session;
  }

  private requireRevision(session: SessionSnapshot, expectedRevision: number): void {
    if (session.revision !== expectedRevision) {
      fail("SESSION_REVISION_MISMATCH", `Expected session revision ${expectedRevision}, received ${session.revision}.`);
    }
  }

  private requireStatus(session: SessionSnapshot, allowed: readonly SessionStatus[]): void {
    if (!allowed.includes(session.status)) {
      fail("SESSION_TRANSITION_INVALID", `Session ${session.sessionId} cannot transition from ${session.status}.`);
    }
  }

  private hasCommandScope(scopes: readonly SessionScope[]): boolean {
    return scopes.some((scope) => commandScopes.has(scope));
  }
}
