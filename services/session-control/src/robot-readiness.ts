import { createHash, randomUUID } from "node:crypto";
import {
  assertRobotSessionReadinessReport,
  clone,
  decodeRobotSessionReadinessReport,
  fail,
  type RobotSessionReadinessReport,
} from "../../../packages/contracts/src/index.ts";
import type { SessionSnapshot } from "./session-control.ts";

export interface RobotReadinessRecord {
  sessionId: string;
  robotId: string;
  revision: number;
  receivedAtUnixMs: number;
  report: RobotSessionReadinessReport;
}

export interface RobotReadinessEvent {
  eventId: string;
  readinessId: string;
  sessionId: string;
  robotId: string;
  revision: number;
  leaseRevision: number;
  ownershipRevision: number;
  ownershipStatus: RobotSessionReadinessReport["ownershipStatus"];
  occurredAtUnixMs: number;
}

export interface RobotReadinessReceipt {
  readinessId: string;
  sha256: string;
}

export interface RobotReadinessState {
  schemaVersion: 1;
  records: readonly RobotReadinessRecord[];
  events: readonly RobotReadinessEvent[];
  receipts: readonly RobotReadinessReceipt[];
}

export interface RobotReadinessOptions {
  now?: () => number;
  idGenerator?: () => string;
  maximumReportAgeMs?: number;
  maximumFutureSkewMs?: number;
  maximumReports?: number;
  initialState?: RobotReadinessState;
}

const acceptedSessionStatuses = new Set(["GRANTED", "CONNECTING", "ACTIVE", "HOLDING"]);

export class InMemoryRobotReadiness {
  private readonly records = new Map<string, RobotReadinessRecord>();
  private readonly events: RobotReadinessEvent[] = [];
  private readonly receipts = new Map<string, RobotReadinessReceipt>();
  private readonly now: () => number;
  private readonly idGenerator: () => string;
  private readonly maximumReportAgeMs: number;
  private readonly maximumFutureSkewMs: number;
  private readonly maximumReports: number;

  constructor(options: RobotReadinessOptions = {}) {
    this.now = options.now ?? Date.now;
    this.idGenerator = options.idGenerator ?? randomUUID;
    this.maximumReportAgeMs = options.maximumReportAgeMs ?? 2_000;
    this.maximumFutureSkewMs = options.maximumFutureSkewMs ?? 500;
    this.maximumReports = options.maximumReports ?? 10_000;
    requirePositiveInteger(this.maximumReportAgeMs, "maximumReportAgeMs");
    requireNonNegativeInteger(this.maximumFutureSkewMs, "maximumFutureSkewMs");
    requirePositiveInteger(this.maximumReports, "maximumReports");
    if (options.initialState) this.restore(options.initialState);
  }

  record(session: SessionSnapshot, untrustedReport: unknown): RobotReadinessRecord {
    const report = decodeRobotSessionReadinessReport(untrustedReport);
    assertRobotSessionReadinessReport(report);
    this.validateIdentityAndLease(session, report);
    validateLengths(report);
    const now = this.checkedNow();
    if (report.reportedAtUnixMs > now + this.maximumFutureSkewMs) {
      fail("ROBOT_READINESS_FROM_FUTURE", "Robot readiness report is too far in the future.");
    }
    if (now - report.reportedAtUnixMs > this.maximumReportAgeMs) {
      fail("ROBOT_READINESS_STALE", "Robot readiness report is stale.");
    }
    if (report.ownershipStatus === "OWNED" && session.status !== "CONNECTING"
      && session.status !== "ACTIVE" && session.status !== "HOLDING") {
      fail("ROBOT_READINESS_SESSION_STATE_INVALID", `Robot cannot report owned readiness while session is ${session.status}.`);
    }
    validateScope(session, report);

    const sha256 = digest(report);
    const receipt = this.receipts.get(report.readinessId);
    if (receipt) {
      if (receipt.sha256 !== sha256) fail("ROBOT_READINESS_ID_COLLISION", "Readiness ID was replayed with different content.");
      return this.get(session.sessionId);
    }
    if (this.receipts.size >= this.maximumReports) {
      fail("ROBOT_READINESS_CAPACITY_EXCEEDED", "Robot readiness receipt capacity is exhausted.");
    }
    const previous = this.records.get(session.sessionId);
    if (previous && report.ownershipRevision < previous.report.ownershipRevision) {
      fail("ROBOT_READINESS_REVISION_STALE", "Robot readiness ownership revision moved backwards.");
    }
    if (previous && report.ownershipRevision === previous.report.ownershipRevision) {
      fail("ROBOT_READINESS_REVISION_COLLISION", "An ownership revision cannot describe different readiness state.");
    }
    const record: RobotReadinessRecord = {
      sessionId: session.sessionId,
      robotId: session.robotId,
      revision: (previous?.revision ?? 0) + 1,
      receivedAtUnixMs: now,
      report: clone(report),
    };
    this.records.set(session.sessionId, record);
    this.receipts.set(report.readinessId, { readinessId: report.readinessId, sha256 });
    this.events.push({
      eventId: this.idGenerator(),
      readinessId: report.readinessId,
      sessionId: report.sessionId,
      robotId: report.robotId,
      revision: record.revision,
      leaseRevision: report.leaseRevision,
      ownershipRevision: report.ownershipRevision,
      ownershipStatus: report.ownershipStatus,
      occurredAtUnixMs: now,
    });
    return clone(record);
  }

  requireOwnershipGranted(session: SessionSnapshot): RobotReadinessRecord {
    const record = this.requireFresh(session);
    if (record.report.ownershipStatus !== "OWNED") {
      fail("SESSION_OWNERSHIP_REQUIRED", "The authenticated robot edge has not reported session ownership.");
    }
    validateScope(session, record.report);
    return record;
  }

  requireOwnershipCleared(session: SessionSnapshot): RobotReadinessRecord {
    const record = this.requireFresh(session);
    if (record.report.ownershipStatus !== "NO_OWNER") {
      fail("SESSION_STOP_ACK_REQUIRED", "The authenticated robot edge has not reported cleared ownership.");
    }
    return record;
  }

  get(sessionId: string): RobotReadinessRecord {
    const record = this.records.get(sessionId);
    if (!record) fail("ROBOT_READINESS_NOT_FOUND", `No robot readiness exists for session ${sessionId}.`);
    return clone(record);
  }

  getEvents(sessionId: string): readonly RobotReadinessEvent[] {
    return clone(this.events.filter((event) => event.sessionId === sessionId));
  }

  exportState(): RobotReadinessState {
    return clone({
      schemaVersion: 1,
      records: [...this.records.values()],
      events: this.events,
      receipts: [...this.receipts.values()],
    });
  }

  private requireFresh(session: SessionSnapshot): RobotReadinessRecord {
    const record = this.get(session.sessionId);
    this.validateIdentityAndLease(session, record.report);
    const now = this.checkedNow();
    if (record.report.reportedAtUnixMs > now + this.maximumFutureSkewMs
      || now - record.report.reportedAtUnixMs > this.maximumReportAgeMs) {
      fail("ROBOT_READINESS_STALE", "Robot readiness must be refreshed before this session transition.");
    }
    return record;
  }

  private validateIdentityAndLease(session: SessionSnapshot, report: RobotSessionReadinessReport): void {
    if (!acceptedSessionStatuses.has(session.status) || !session.lease) {
      fail("ROBOT_READINESS_SESSION_STATE_INVALID", `Session ${session.sessionId} cannot accept readiness from ${session.status}.`);
    }
    if (report.sessionId !== session.sessionId || report.robotId !== session.robotId
      || report.operatorId !== session.operatorId) {
      fail("ROBOT_READINESS_IDENTITY_MISMATCH", "Robot readiness does not match the session identity tuple.");
    }
    if (report.leaseRevision !== session.lease.revision) {
      fail("ROBOT_READINESS_LEASE_REVISION_MISMATCH", "Robot readiness does not match the current lease revision.");
    }
    if (this.checkedNow() >= session.lease.expiresAtUnixMs) {
      fail("SESSION_LEASE_EXPIRED", "Robot readiness cannot authorize an expired session.");
    }
  }

  private restore(state: RobotReadinessState): void {
    if (state.schemaVersion !== 1 || !Array.isArray(state.records)
      || !Array.isArray(state.events) || !Array.isArray(state.receipts)) {
      fail("ROBOT_READINESS_STATE_INVALID", "Persisted robot readiness state is invalid or unsupported.");
    }
    if (state.receipts.length > this.maximumReports || state.events.length !== state.receipts.length) {
      fail("ROBOT_READINESS_STATE_INVALID", "Persisted robot readiness state exceeds bounds or has incomplete audit data.");
    }
    for (const stored of state.records) {
      const report = decodeRobotSessionReadinessReport(stored.report);
      assertRobotSessionReadinessReport(report);
      if (stored.sessionId !== report.sessionId || stored.robotId !== report.robotId
        || !Number.isSafeInteger(stored.revision) || stored.revision < 1
        || !Number.isSafeInteger(stored.receivedAtUnixMs) || stored.receivedAtUnixMs < 0
        || this.records.has(stored.sessionId)) {
        fail("ROBOT_READINESS_STATE_INVALID", "Persisted robot readiness record is malformed or duplicated.");
      }
      this.records.set(stored.sessionId, clone({ ...stored, report }));
    }
    for (const receipt of state.receipts) {
      if (!receipt.readinessId?.trim() || !/^[a-f0-9]{64}$/.test(receipt.sha256)
        || this.receipts.has(receipt.readinessId)) {
        fail("ROBOT_READINESS_STATE_INVALID", "Persisted robot readiness receipt is malformed or duplicated.");
      }
      this.receipts.set(receipt.readinessId, clone(receipt));
    }
    for (const event of state.events) {
      if (!event.eventId?.trim() || !event.readinessId?.trim() || !event.sessionId?.trim()
        || !event.robotId?.trim() || !this.receipts.has(event.readinessId)
        || !Number.isSafeInteger(event.revision) || event.revision < 1
        || !Number.isSafeInteger(event.leaseRevision) || event.leaseRevision < 1
        || !Number.isSafeInteger(event.ownershipRevision) || event.ownershipRevision < 1
        || !["NO_OWNER", "HANDOFF", "OWNED"].includes(event.ownershipStatus)
        || !Number.isSafeInteger(event.occurredAtUnixMs) || event.occurredAtUnixMs < 0) {
        fail("ROBOT_READINESS_STATE_INVALID", "Persisted robot readiness event has invalid provenance.");
      }
      this.events.push(clone(event));
    }
    for (const record of this.records.values()) {
      if (this.receipts.get(record.report.readinessId)?.sha256 !== digest(record.report)) {
        fail("ROBOT_READINESS_STATE_INVALID", "Persisted robot readiness record does not match its receipt digest.");
      }
    }
  }

  private checkedNow(): number {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("Robot readiness clock must return non-negative Unix milliseconds.");
    return now;
  }
}

function validateScope(session: SessionSnapshot, report: RobotSessionReadinessReport): void {
  if (report.ownershipStatus === "NO_OWNER") return;
  const requiredScope = report.actuatorGroup === "BASE" ? "CONTROL_BASE" : "CONTROL_MANIPULATOR";
  if (!session.scopes.includes(requiredScope)) {
    fail("ROBOT_READINESS_SCOPE_MISMATCH", `Robot readiness ${report.actuatorGroup} ownership is not in the session scope.`);
  }
}

function validateLengths(report: RobotSessionReadinessReport): void {
  for (const value of [report.readinessId, report.sessionId, report.robotId, report.operatorId]) {
    if (value.length > 128) fail("ROBOT_READINESS_FIELD_TOO_LONG", "Robot readiness identity field exceeds 128 characters.");
  }
}

function digest(report: RobotSessionReadinessReport): string {
  return createHash("sha256").update(JSON.stringify(report)).digest("hex");
}

function requirePositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} must be a positive safe integer.`);
}

function requireNonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be a non-negative safe integer.`);
}
