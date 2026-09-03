import { randomUUID } from "node:crypto";
import {
  assertContractVersion,
  assertGroundedObject,
  assertManipulationApproval,
  assertManipulationOutcome,
  assertManipulationPlanPreview,
  assertObjectDeclaration,
  assertObservationBundle,
  clone,
  fail,
  type AssistanceRequest,
  type GroundedObject,
  type ManipulationApproval,
  type ManipulationOutcome,
  type ManipulationPlanPreview,
  type ObjectDeclaration,
} from "../../../packages/contracts/src/index.ts";

export type AssistanceStatus =
  | "OPEN"
  | "ASSIGNED"
  | "DECLARATION_PENDING"
  | "GROUNDING"
  | "PLAN_PENDING"
  | "APPROVAL_PENDING"
  | "EXECUTING"
  | "VERIFYING"
  | "RESOLVED"
  | "CANCELLED"
  | "EXPIRED"
  | "FAILED"
  | "DIRECT_TELEOP_REQUIRED";

export interface AssistanceSnapshot {
  request: AssistanceRequest;
  status: AssistanceStatus;
  revision: number;
  changedAtUnixMs: number;
  assignedOperatorId?: string;
  declaration?: ObjectDeclaration;
  groundedObject?: GroundedObject;
  plan?: ManipulationPlanPreview;
  approval?: ManipulationApproval;
  outcome?: ManipulationOutcome;
  reason?: string;
}

export interface AssistanceEvent {
  eventId: string;
  requestId: string;
  revision: number;
  type: `ASSISTANCE_${AssistanceStatus}`;
  occurredAtUnixMs: number;
  reason?: string;
}

export interface AssistanceOrchestratorOptions {
  now?: () => number;
  idGenerator?: () => string;
  initialState?: AssistanceOrchestratorState;
}

export interface AssistanceOrchestratorState {
  schemaVersion: 1;
  requests: readonly AssistanceSnapshot[];
  events: readonly AssistanceEvent[];
}

const terminal = new Set<AssistanceStatus>(["RESOLVED", "CANCELLED", "EXPIRED", "FAILED", "DIRECT_TELEOP_REQUIRED"]);

export class InMemoryAssistanceOrchestrator {
  private readonly requests = new Map<string, AssistanceSnapshot>();
  private readonly eventsByRequest = new Map<string, AssistanceEvent[]>();
  private readonly now: () => number;
  private readonly idGenerator: () => string;

  constructor(options: AssistanceOrchestratorOptions = {}) {
    this.now = options.now ?? Date.now;
    this.idGenerator = options.idGenerator ?? randomUUID;
    if (options.initialState) this.restore(options.initialState);
  }

  open(request: AssistanceRequest): AssistanceSnapshot {
    assertContractVersion(request.contractVersion);
    if (!request.requestId.trim() || !request.robotId.trim() || !request.taskId.trim()) {
      fail("ASSISTANCE_ID_REQUIRED", "requestId, robotId, and taskId are required.");
    }
    if (request.observations.length === 0) fail("ASSISTANCE_OBSERVATION_REQUIRED", "At least one observation is required.");
    request.observations.forEach(assertObservationBundle);
    if (request.observations.some((observation) => observation.robotId !== request.robotId)) {
      fail("ROBOT_ID_MISMATCH", "Every assistance observation must belong to the requested robot.");
    }
    if (request.expiresAtUnixMs <= request.createdAtUnixMs || this.now() >= request.expiresAtUnixMs) {
      fail("ASSISTANCE_EXPIRY_INVALID", "Assistance expiry must follow creation and be in the future.");
    }
    const existing = this.requests.get(request.requestId);
    if (existing) {
      if (JSON.stringify(existing.request) !== JSON.stringify(request)) {
        fail("ASSISTANCE_REQUEST_ID_COLLISION", `Request ${request.requestId} identifies different data.`);
      }
      return clone(existing);
    }
    const snapshot: AssistanceSnapshot = {
      request: clone(request),
      status: "OPEN",
      revision: 1,
      changedAtUnixMs: this.now(),
    };
    this.requests.set(request.requestId, snapshot);
    this.appendEvent(snapshot);
    return clone(snapshot);
  }

  assign(requestId: string, expectedRevision: number, operatorId: string): AssistanceSnapshot {
    if (!operatorId.trim()) fail("OPERATOR_ID_REQUIRED", "operatorId is required.");
    const assigned = this.transition(requestId, expectedRevision, ["OPEN"], "ASSIGNED", { assignedOperatorId: operatorId });
    return this.transition(requestId, assigned.revision, ["ASSIGNED"], "DECLARATION_PENDING");
  }

  submitDeclaration(requestId: string, expectedRevision: number, declaration: ObjectDeclaration): AssistanceSnapshot {
    assertObjectDeclaration(declaration);
    const current = this.require(requestId);
    this.requireRevision(current, expectedRevision);
    this.requireStatus(current, ["DECLARATION_PENDING"]);
    if (declaration.requestId !== requestId) fail("DECLARATION_REQUEST_MISMATCH", "Declaration belongs to another assistance request.");
    if (declaration.declaredBy !== current.assignedOperatorId) fail("DECLARATION_OPERATOR_MISMATCH", "Only the assigned operator may declare the target.");
    if (!current.request.observations.some((observation) => observation.observationId === declaration.observationId)) {
      fail("DECLARATION_OBSERVATION_MISMATCH", "Declaration must reference an immutable observation from the request.");
    }
    if (current.declaration && (declaration.declarationId !== current.declaration.declarationId
      || declaration.revision !== current.declaration.revision + 1)) {
      fail("DECLARATION_REVISION_MISMATCH", "A corrected declaration must retain its ID and increment revision exactly once.");
    }
    return this.transition(requestId, expectedRevision, ["DECLARATION_PENDING"], "GROUNDING", { declaration: clone(declaration) });
  }

  requestDeclarationCorrection(requestId: string, expectedRevision: number, reason: string): AssistanceSnapshot {
    if (!reason.trim()) fail("ASSISTANCE_REASON_REQUIRED", "A correction reason is required.");
    const current = this.require(requestId);
    this.requireRevision(current, expectedRevision);
    this.requireStatus(current, ["GROUNDING", "PLAN_PENDING", "APPROVAL_PENDING"]);
    return this.transition(requestId, expectedRevision, [current.status], "DECLARATION_PENDING", {
      groundedObject: undefined,
      plan: undefined,
      approval: undefined,
    }, reason);
  }

  recordGrounding(requestId: string, expectedRevision: number, object: GroundedObject): AssistanceSnapshot {
    assertGroundedObject(object);
    const current = this.require(requestId);
    this.requireRevision(current, expectedRevision);
    this.requireStatus(current, ["GROUNDING"]);
    if (!current.declaration) fail("DECLARATION_REQUIRED", "Grounding requires a declaration.");
    if (object.requestId !== requestId
      || object.declarationId !== current.declaration.declarationId
      || object.declarationRevision !== current.declaration.revision
      || object.observationId !== current.declaration.observationId
      || object.robotId !== current.request.robotId) {
      fail("GROUNDING_PROVENANCE_MISMATCH", "Grounded object does not match the active declaration and request.");
    }
    const observation = current.request.observations.find((candidate) => candidate.observationId === object.observationId)!;
    if (object.sceneRevision !== observation.sceneRevision) {
      fail("GROUNDING_SCENE_MISMATCH", "Grounded object scene revision does not match the immutable observation.");
    }
    return this.transition(requestId, expectedRevision, ["GROUNDING"], "PLAN_PENDING", { groundedObject: clone(object) });
  }

  recordPlan(requestId: string, expectedRevision: number, plan: ManipulationPlanPreview): AssistanceSnapshot {
    assertManipulationPlanPreview(plan);
    const current = this.require(requestId);
    this.requireRevision(current, expectedRevision);
    this.requireStatus(current, ["PLAN_PENDING"]);
    if (!current.groundedObject) fail("GROUNDED_OBJECT_REQUIRED", "A plan requires a grounded object.");
    if ((current.groundedObject.status !== "GROUNDED" && current.groundedObject.status !== "TRACKED")
      || this.now() >= current.groundedObject.validUntilUnixMs) {
      fail("GROUNDED_OBJECT_UNUSABLE", "A plan cannot be created for a stale, lost, or invalid grounded object.");
    }
    if (plan.requestId !== requestId
      || plan.robotId !== current.request.robotId
      || plan.objectId !== current.groundedObject.objectId
      || plan.objectRevision !== current.groundedObject.revision
      || plan.sceneRevision !== current.groundedObject.sceneRevision) {
      fail("PLAN_PROVENANCE_MISMATCH", "Plan does not match the current grounded object and scene revision.");
    }
    if (!Number.isInteger(plan.planRevision) || plan.planRevision < 1 || plan.phases.length === 0) {
      fail("PLAN_INVALID", "Plan revision must be positive and contain at least one phase.");
    }
    return this.transition(
      requestId,
      expectedRevision,
      ["PLAN_PENDING"],
      plan.approvalRequired ? "APPROVAL_PENDING" : "EXECUTING",
      { plan: clone(plan) },
    );
  }

  approve(requestId: string, expectedRevision: number, approval: ManipulationApproval): AssistanceSnapshot {
    assertManipulationApproval(approval);
    const current = this.require(requestId);
    this.requireRevision(current, expectedRevision);
    this.requireStatus(current, ["APPROVAL_PENDING"]);
    if (!current.plan || !current.groundedObject) fail("PLAN_REQUIRED", "Approval requires the active plan and grounded object.");
    if (approval.requestId !== requestId
      || approval.planId !== current.plan.planId
      || approval.planRevision !== current.plan.planRevision
      || approval.objectRevision !== current.groundedObject.revision
      || approval.sceneRevision !== current.plan.sceneRevision) {
      fail("APPROVAL_REVISION_MISMATCH", "Approval does not reference the exact active plan, object, and scene revisions.");
    }
    if (approval.approvedBy !== current.assignedOperatorId) fail("APPROVAL_OPERATOR_MISMATCH", "Only the assigned operator may approve the plan.");
    return this.transition(requestId, expectedRevision, ["APPROVAL_PENDING"], "EXECUTING", { approval: clone(approval) });
  }

  recordOutcome(requestId: string, expectedRevision: number, outcome: ManipulationOutcome): AssistanceSnapshot {
    assertManipulationOutcome(outcome);
    const current = this.require(requestId);
    this.requireRevision(current, expectedRevision);
    this.requireStatus(current, ["EXECUTING"]);
    if (!current.plan) fail("PLAN_REQUIRED", "Execution outcome requires an active plan.");
    if (outcome.requestId !== requestId || outcome.planId !== current.plan.planId || outcome.planRevision !== current.plan.planRevision) {
      fail("OUTCOME_PLAN_MISMATCH", "Outcome does not match the active plan revision.");
    }
    if (outcome.verification.length === 0) fail("OUTCOME_EVIDENCE_REQUIRED", "Outcome requires verification evidence.");
    if (!outcome.success && !outcome.failureCode?.trim()) fail("OUTCOME_FAILURE_CODE_REQUIRED", "Failed outcome requires a failure code.");
    return this.transition(requestId, expectedRevision, ["EXECUTING"], "VERIFYING", { outcome: clone(outcome) });
  }

  completeVerification(requestId: string, expectedRevision: number, verified: boolean, reason: string): AssistanceSnapshot {
    const current = this.require(requestId);
    this.requireRevision(current, expectedRevision);
    this.requireStatus(current, ["VERIFYING"]);
    if (!reason.trim()) fail("VERIFICATION_REASON_REQUIRED", "Verification reason is required.");
    if (verified && !current.outcome?.success) fail("VERIFICATION_CONTRADICTS_OUTCOME", "A failed outcome cannot be resolved as verified success.");
    return this.transition(requestId, expectedRevision, ["VERIFYING"], verified ? "RESOLVED" : "FAILED", {}, reason);
  }

  requireDirectTeleop(requestId: string, expectedRevision: number, reason: string): AssistanceSnapshot {
    if (!reason.trim()) fail("ASSISTANCE_REASON_REQUIRED", "Escalation reason is required.");
    const current = this.require(requestId);
    if (terminal.has(current.status)) fail("ASSISTANCE_TERMINAL", `Request ${requestId} is ${current.status}.`);
    return this.transition(requestId, expectedRevision, [current.status], "DIRECT_TELEOP_REQUIRED", {}, reason);
  }

  expireDue(atUnixMs = this.now()): AssistanceSnapshot[] {
    const expired: AssistanceSnapshot[] = [];
    for (const snapshot of this.requests.values()) {
      if (!terminal.has(snapshot.status) && atUnixMs > snapshot.request.expiresAtUnixMs) {
        expired.push(this.transition(
          snapshot.request.requestId,
          snapshot.revision,
          [snapshot.status],
          "EXPIRED",
          {},
          "Assistance request expired.",
          atUnixMs,
        ));
      }
    }
    return expired;
  }

  get(requestId: string): AssistanceSnapshot {
    return clone(this.require(requestId));
  }

  getEvents(requestId: string): readonly AssistanceEvent[] {
    this.require(requestId);
    return clone(this.eventsByRequest.get(requestId) ?? []);
  }

  listRequests(): readonly AssistanceSnapshot[] {
    return clone([...this.requests.values()].sort((left, right) => right.changedAtUnixMs - left.changedAtUnixMs));
  }

  exportState(): AssistanceOrchestratorState {
    return clone({
      schemaVersion: 1,
      requests: [...this.requests.values()],
      events: [...this.eventsByRequest.values()].flat(),
    });
  }

  private restore(state: AssistanceOrchestratorState): void {
    if (state.schemaVersion !== 1 || !Array.isArray(state.requests) || !Array.isArray(state.events)) {
      fail("ASSISTANCE_STATE_INVALID", "Persisted assistance state is invalid or unsupported.");
    }
    for (const snapshot of state.requests) {
      const requestId = snapshot.request?.requestId;
      if (!requestId?.trim() || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 1
        || this.requests.has(requestId)) {
        fail("ASSISTANCE_STATE_INVALID", "Persisted assistance snapshot is malformed or duplicated.");
      }
      this.requests.set(requestId, clone(snapshot));
    }
    for (const event of state.events) {
      const snapshot = this.requests.get(event.requestId);
      if (!snapshot || !Number.isSafeInteger(event.revision) || event.revision < 1 || event.revision > snapshot.revision) {
        fail("ASSISTANCE_STATE_INVALID", "Persisted assistance event has invalid provenance.");
      }
      const events = this.eventsByRequest.get(event.requestId) ?? [];
      events.push(clone(event));
      this.eventsByRequest.set(event.requestId, events);
    }
    for (const snapshot of this.requests.values()) {
      const events = this.eventsByRequest.get(snapshot.request.requestId) ?? [];
      if (events.length === 0 || events.at(-1)?.revision !== snapshot.revision) {
        fail("ASSISTANCE_STATE_INVALID", `Persisted events do not cover request ${snapshot.request.requestId}.`);
      }
    }
  }

  private transition(
    requestId: string,
    expectedRevision: number,
    allowed: readonly AssistanceStatus[],
    status: AssistanceStatus,
    changes: Partial<AssistanceSnapshot> = {},
    reason?: string,
    atUnixMs = this.now(),
  ): AssistanceSnapshot {
    const current = this.require(requestId);
    this.requireRevision(current, expectedRevision);
    this.requireStatus(current, allowed);
    if (status !== "EXPIRED" && !terminal.has(current.status) && atUnixMs >= current.request.expiresAtUnixMs) {
      const expired: AssistanceSnapshot = {
        ...current,
        status: "EXPIRED",
        revision: current.revision + 1,
        changedAtUnixMs: atUnixMs,
        reason: "Assistance request expired.",
      };
      this.requests.set(requestId, expired);
      this.appendEvent(expired);
      fail("ASSISTANCE_EXPIRED", `Assistance request ${requestId} has expired.`);
    }
    const next: AssistanceSnapshot = {
      ...current,
      ...changes,
      status,
      revision: current.revision + 1,
      changedAtUnixMs: atUnixMs,
      reason,
    };
    this.requests.set(requestId, next);
    this.appendEvent(next);
    return clone(next);
  }

  private require(requestId: string): AssistanceSnapshot {
    const request = this.requests.get(requestId);
    if (!request) fail("ASSISTANCE_NOT_FOUND", `Assistance request ${requestId} was not found.`);
    return request;
  }

  private requireRevision(snapshot: AssistanceSnapshot, expectedRevision: number): void {
    if (snapshot.revision !== expectedRevision) {
      fail("ASSISTANCE_REVISION_MISMATCH", `Expected assistance revision ${expectedRevision}, received ${snapshot.revision}.`);
    }
  }

  private requireStatus(snapshot: AssistanceSnapshot, allowed: readonly AssistanceStatus[]): void {
    if (!allowed.includes(snapshot.status)) {
      fail("ASSISTANCE_TRANSITION_INVALID", `Assistance request cannot transition from ${snapshot.status}.`);
    }
  }

  private appendEvent(snapshot: AssistanceSnapshot): void {
    const requestId = snapshot.request.requestId;
    const events = this.eventsByRequest.get(requestId) ?? [];
    events.push({
      eventId: this.idGenerator(),
      requestId,
      revision: snapshot.revision,
      type: `ASSISTANCE_${snapshot.status}`,
      occurredAtUnixMs: snapshot.changedAtUnixMs,
      reason: snapshot.reason,
    });
    this.eventsByRequest.set(requestId, events);
  }
}
