import { randomUUID } from "node:crypto";
import {
  clone,
  fail,
  type AssistanceRequest,
  type ManipulationIntent,
} from "../../../packages/contracts/src/index.ts";
import type { AssistanceSnapshot } from "../../assistance-orchestrator/src/index.ts";

export type RegistryVersionStatus =
  | "CANDIDATE"
  | "IN_REVIEW"
  | "APPROVED"
  | "VALIDATING"
  | "ACTIVE"
  | "REJECTED"
  | "DEPRECATED"
  | "ROLLED_BACK";

export interface EvidenceArtifactReference {
  artifactId: string;
  observationId: string;
  mediaType: string;
  sha256: string;
  byteLength: number;
  capturedAtUnixMs: number;
}

export interface RegistrySourceProvenance {
  requestId: string;
  taskId: string;
  robotId: string;
  declarationId: string;
  groundedObjectId: string;
  outcomeId: string;
}

export interface RegistryReview {
  reviewerId: string;
  reviewedAtUnixMs: number;
  approved: boolean;
  notes: string;
}

export interface RegistryValidation {
  evaluationId: string;
  artifactSha256: string;
  evaluatedAtUnixMs: number;
  passed: boolean;
  sampleCount: number;
  metrics: Readonly<Record<string, number>>;
  notes: string;
}

export interface ObjectRegistryVersion {
  versionId: string;
  objectClassId: string;
  version: number;
  revision: number;
  status: RegistryVersionStatus;
  semanticLabel: string;
  aliases: readonly string[];
  siteIds: readonly string[];
  robotCapabilities: readonly string[];
  supportedIntents: readonly ManipulationIntent[];
  source: RegistrySourceProvenance;
  evidence: readonly EvidenceArtifactReference[];
  createdBy: string;
  createdAtUnixMs: number;
  changedAtUnixMs: number;
  review?: RegistryReview;
  validation?: RegistryValidation;
  reason?: string;
}

export interface ActivationBinding {
  bindingKey: string;
  objectClassId: string;
  siteId: string;
  robotCapability: string;
  activeVersionId: string;
  previousVersionId?: string;
  activatedBy: string;
  activatedAtUnixMs: number;
}

export interface ObjectRegistryEvent {
  eventId: string;
  versionId: string;
  objectClassId: string;
  revision: number;
  status: RegistryVersionStatus;
  occurredAtUnixMs: number;
  reason?: string;
}

export interface ObjectRegistryState {
  schemaVersion: 1;
  versions: readonly ObjectRegistryVersion[];
  bindings: readonly ActivationBinding[];
  events: readonly ObjectRegistryEvent[];
}

export interface ObjectRegistryOptions {
  now?: () => number;
  idGenerator?: () => string;
  initialState?: ObjectRegistryState;
}

export interface CreateCandidateInput {
  objectClassId?: string;
  versionId?: string;
  semanticLabel: string;
  aliases?: readonly string[];
  siteIds: readonly string[];
  robotCapabilities: readonly string[];
  supportedIntents: readonly ManipulationIntent[];
  source: RegistrySourceProvenance;
  evidence: readonly EvidenceArtifactReference[];
  createdBy: string;
}

const terminalStatuses = new Set<RegistryVersionStatus>(["REJECTED", "ROLLED_BACK"]);

export class InMemoryObjectRegistry {
  private readonly versions = new Map<string, ObjectRegistryVersion>();
  private readonly bindings = new Map<string, ActivationBinding>();
  private readonly eventsByVersion = new Map<string, ObjectRegistryEvent[]>();
  private readonly now: () => number;
  private readonly idGenerator: () => string;

  constructor(options: ObjectRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.idGenerator = options.idGenerator ?? randomUUID;
    if (options.initialState) this.restore(options.initialState);
  }

  createCandidate(input: CreateCandidateInput): ObjectRegistryVersion {
    validateCandidate(input);
    const objectClassId = input.objectClassId?.trim() || this.idGenerator();
    const versionId = input.versionId?.trim() || this.idGenerator();
    const existing = this.versions.get(versionId);
    if (existing) {
      if (existing.objectClassId !== objectClassId || existing.source.requestId !== input.source.requestId) {
        fail("REGISTRY_VERSION_ID_COLLISION", `Registry version ${versionId} identifies different provenance.`);
      }
      return clone(existing);
    }
    const version = Math.max(
      0,
      ...[...this.versions.values()]
        .filter((candidate) => candidate.objectClassId === objectClassId)
        .map((candidate) => candidate.version),
    ) + 1;
    const now = this.now();
    const snapshot: ObjectRegistryVersion = {
      versionId,
      objectClassId,
      version,
      revision: 1,
      status: "CANDIDATE",
      semanticLabel: input.semanticLabel.trim(),
      aliases: unique(input.aliases ?? []),
      siteIds: unique(input.siteIds),
      robotCapabilities: unique(input.robotCapabilities),
      supportedIntents: [...new Set(input.supportedIntents)].sort(),
      source: clone(input.source),
      evidence: clone(input.evidence),
      createdBy: input.createdBy,
      createdAtUnixMs: now,
      changedAtUnixMs: now,
    };
    this.versions.set(versionId, snapshot);
    this.appendEvent(snapshot);
    return clone(snapshot);
  }

  createCandidateFromAssistance(input: {
    assistance: AssistanceSnapshot;
    evidence: readonly EvidenceArtifactReference[];
    siteIds: readonly string[];
    robotCapabilities: readonly string[];
    createdBy: string;
    objectClassId?: string;
    versionId?: string;
  }): ObjectRegistryVersion {
    const workflow = input.assistance;
    if (workflow.status !== "RESOLVED" || !workflow.outcome?.success || !workflow.declaration || !workflow.groundedObject) {
      fail("REGISTRY_SOURCE_NOT_RESOLVED", "Enrollment requires a resolved successful assistance interaction.");
    }
    if (workflow.declaration.persistenceScope !== "SITE_ENROLLMENT_CANDIDATE") {
      fail("REGISTRY_ENROLLMENT_NOT_REQUESTED", "The operator did not mark this declaration as an enrollment candidate.");
    }
    if (!workflow.declaration.semanticLabel?.trim()) {
      fail("REGISTRY_LABEL_REQUIRED", "Enrollment requires an operator-provided semantic label.");
    }
    return this.createCandidate({
      objectClassId: input.objectClassId,
      versionId: input.versionId,
      semanticLabel: workflow.declaration.semanticLabel,
      siteIds: input.siteIds,
      robotCapabilities: input.robotCapabilities,
      supportedIntents: [workflow.declaration.manipulationIntent],
      source: provenanceFromAssistance(workflow.request, workflow),
      evidence: input.evidence,
      createdBy: input.createdBy,
    });
  }

  submitForReview(versionId: string, expectedRevision: number): ObjectRegistryVersion {
    return this.transition(versionId, expectedRevision, ["CANDIDATE"], "IN_REVIEW");
  }

  recordReview(versionId: string, expectedRevision: number, review: RegistryReview): ObjectRegistryVersion {
    requireText(review.reviewerId, "reviewerId");
    requireText(review.notes, "review.notes");
    requireTime(review.reviewedAtUnixMs, "reviewedAtUnixMs");
    return this.transition(
      versionId,
      expectedRevision,
      ["IN_REVIEW"],
      review.approved ? "APPROVED" : "REJECTED",
      { review: clone(review) },
      review.notes,
    );
  }

  startValidation(versionId: string, expectedRevision: number): ObjectRegistryVersion {
    return this.transition(versionId, expectedRevision, ["APPROVED"], "VALIDATING");
  }

  recordValidation(versionId: string, expectedRevision: number, validation: RegistryValidation): ObjectRegistryVersion {
    requireText(validation.evaluationId, "evaluationId");
    if (!/^[a-f0-9]{64}$/i.test(validation.artifactSha256)) fail("REGISTRY_VALIDATION_INVALID", "Validation must bind one SHA-256 artifact digest.");
    requireText(validation.notes, "validation.notes");
    requireTime(validation.evaluatedAtUnixMs, "evaluatedAtUnixMs");
    if (!Number.isSafeInteger(validation.sampleCount) || validation.sampleCount < 1) {
      fail("REGISTRY_VALIDATION_INVALID", "Validation sampleCount must be positive.");
    }
    const metrics = Object.values(validation.metrics);
    if (metrics.length === 0 || metrics.some((metric) => !Number.isFinite(metric))) {
      fail("REGISTRY_VALIDATION_INVALID", "Validation requires finite evaluation metrics.");
    }
    return this.transition(
      versionId,
      expectedRevision,
      ["VALIDATING"],
      validation.passed ? "VALIDATING" : "REJECTED",
      { validation: clone(validation) },
      validation.notes,
    );
  }

  activate(input: {
    versionId: string;
    expectedRevision: number;
    siteId: string;
    robotCapability: string;
    activatedBy: string;
  }): ObjectRegistryVersion {
    const current = this.requireVersion(input.versionId);
    this.requireRevision(current, input.expectedRevision);
    this.requireStatus(current, ["VALIDATING", "ACTIVE"]);
    if (!current.validation?.passed) fail("REGISTRY_VALIDATION_REQUIRED", "Activation requires a passing recorded validation.");
    if (!current.siteIds.includes(input.siteId) || !current.robotCapabilities.includes(input.robotCapability)) {
      fail("REGISTRY_ACTIVATION_SCOPE_INVALID", "Activation scope is outside the reviewed candidate scope.");
    }
    requireText(input.activatedBy, "activatedBy");
    const bindingKey = bindingKeyFor(current.objectClassId, input.siteId, input.robotCapability);
    const previous = this.bindings.get(bindingKey);
    if (previous?.activeVersionId === current.versionId) return clone(current);
    const now = this.now();
    this.bindings.set(bindingKey, {
      bindingKey,
      objectClassId: current.objectClassId,
      siteId: input.siteId,
      robotCapability: input.robotCapability,
      activeVersionId: current.versionId,
      previousVersionId: previous?.activeVersionId,
      activatedBy: input.activatedBy,
      activatedAtUnixMs: now,
    });
    if (previous) this.markInactiveIfUnbound(previous.activeVersionId, "Superseded by a newer active registry version.", now);
    return this.replace(current, {
      status: "ACTIVE",
      revision: current.revision + 1,
      changedAtUnixMs: now,
      reason: `Activated for ${input.siteId}/${input.robotCapability}.`,
    });
  }

  rollback(input: {
    versionId: string;
    expectedRevision: number;
    siteId: string;
    robotCapability: string;
    rolledBackBy: string;
    reason: string;
  }): ObjectRegistryVersion {
    const current = this.requireVersion(input.versionId);
    this.requireRevision(current, input.expectedRevision);
    this.requireStatus(current, ["ACTIVE"]);
    requireText(input.rolledBackBy, "rolledBackBy");
    requireText(input.reason, "rollback.reason");
    const key = bindingKeyFor(current.objectClassId, input.siteId, input.robotCapability);
    const binding = this.bindings.get(key);
    if (!binding || binding.activeVersionId !== current.versionId) {
      fail("REGISTRY_BINDING_MISMATCH", "The requested version is not active for this scope.");
    }
    const now = this.now();
    if (binding.previousVersionId) {
      const previous = this.requireVersion(binding.previousVersionId);
      this.bindings.set(key, {
        ...binding,
        activeVersionId: previous.versionId,
        previousVersionId: undefined,
        activatedBy: input.rolledBackBy,
        activatedAtUnixMs: now,
      });
      if (previous.status !== "ACTIVE") {
        this.replace(previous, {
          status: "ACTIVE",
          revision: previous.revision + 1,
          changedAtUnixMs: now,
          reason: `Restored by rollback of ${current.versionId}.`,
        });
      }
    } else {
      this.bindings.delete(key);
    }
    return this.markInactiveIfUnbound(current.versionId, input.reason, now, "ROLLED_BACK");
  }

  resolve(objectClassId: string, siteId: string, robotCapability: string): ObjectRegistryVersion | undefined {
    const binding = this.bindings.get(bindingKeyFor(objectClassId, siteId, robotCapability));
    return binding ? clone(this.requireVersion(binding.activeVersionId)) : undefined;
  }

  getVersion(versionId: string): ObjectRegistryVersion {
    return clone(this.requireVersion(versionId));
  }

  listVersions(objectClassId?: string): readonly ObjectRegistryVersion[] {
    return clone([...this.versions.values()]
      .filter((version) => objectClassId === undefined || version.objectClassId === objectClassId)
      .sort((left, right) => right.changedAtUnixMs - left.changedAtUnixMs));
  }

  getEvents(versionId: string): readonly ObjectRegistryEvent[] {
    this.requireVersion(versionId);
    return clone(this.eventsByVersion.get(versionId) ?? []);
  }

  exportState(): ObjectRegistryState {
    return clone({
      schemaVersion: 1,
      versions: [...this.versions.values()],
      bindings: [...this.bindings.values()],
      events: [...this.eventsByVersion.values()].flat(),
    });
  }

  private transition(
    versionId: string,
    expectedRevision: number,
    allowed: readonly RegistryVersionStatus[],
    status: RegistryVersionStatus,
    changes: Partial<ObjectRegistryVersion> = {},
    reason?: string,
  ): ObjectRegistryVersion {
    const current = this.requireVersion(versionId);
    this.requireRevision(current, expectedRevision);
    this.requireStatus(current, allowed);
    return this.replace(current, {
      ...changes,
      status,
      revision: current.revision + 1,
      changedAtUnixMs: this.now(),
      reason,
    });
  }

  private markInactiveIfUnbound(
    versionId: string,
    reason: string,
    atUnixMs: number,
    status: "DEPRECATED" | "ROLLED_BACK" = "DEPRECATED",
  ): ObjectRegistryVersion {
    const version = this.requireVersion(versionId);
    if ([...this.bindings.values()].some((binding) => binding.activeVersionId === versionId)) return clone(version);
    return this.replace(version, {
      status,
      revision: version.revision + 1,
      changedAtUnixMs: atUnixMs,
      reason,
    });
  }

  private replace(current: ObjectRegistryVersion, changes: Partial<ObjectRegistryVersion>): ObjectRegistryVersion {
    const next = { ...current, ...changes };
    this.versions.set(current.versionId, next);
    this.appendEvent(next);
    return clone(next);
  }

  private appendEvent(version: ObjectRegistryVersion): void {
    const events = this.eventsByVersion.get(version.versionId) ?? [];
    events.push({
      eventId: this.idGenerator(),
      versionId: version.versionId,
      objectClassId: version.objectClassId,
      revision: version.revision,
      status: version.status,
      occurredAtUnixMs: version.changedAtUnixMs,
      reason: version.reason,
    });
    this.eventsByVersion.set(version.versionId, events);
  }

  private restore(state: ObjectRegistryState): void {
    if (state.schemaVersion !== 1 || !Array.isArray(state.versions) || !Array.isArray(state.bindings) || !Array.isArray(state.events)) {
      fail("REGISTRY_STATE_INVALID", "Persisted object-registry state is invalid or unsupported.");
    }
    for (const version of state.versions) {
      if (!version.versionId?.trim() || !version.objectClassId?.trim() || this.versions.has(version.versionId)
        || !Number.isSafeInteger(version.revision) || version.revision < 1) {
        fail("REGISTRY_STATE_INVALID", "Persisted registry version is malformed or duplicated.");
      }
      this.versions.set(version.versionId, clone(version));
    }
    for (const binding of state.bindings) {
      const active = this.versions.get(binding.activeVersionId);
      if (!active || active.objectClassId !== binding.objectClassId || this.bindings.has(binding.bindingKey)) {
        fail("REGISTRY_STATE_INVALID", "Persisted registry binding has invalid provenance.");
      }
      this.bindings.set(binding.bindingKey, clone(binding));
    }
    for (const event of state.events) {
      const version = this.versions.get(event.versionId);
      if (!version || event.objectClassId !== version.objectClassId || event.revision > version.revision) {
        fail("REGISTRY_STATE_INVALID", "Persisted registry event has invalid provenance.");
      }
      const events = this.eventsByVersion.get(event.versionId) ?? [];
      events.push(clone(event));
      this.eventsByVersion.set(event.versionId, events);
    }
    for (const version of this.versions.values()) {
      if (terminalStatuses.has(version.status)) continue;
      const lastEvent = this.eventsByVersion.get(version.versionId)?.at(-1);
      if (!lastEvent || lastEvent.revision !== version.revision) {
        fail("REGISTRY_STATE_INVALID", `Persisted events do not cover registry version ${version.versionId}.`);
      }
    }
  }

  private requireVersion(versionId: string): ObjectRegistryVersion {
    const version = this.versions.get(versionId);
    if (!version) fail("REGISTRY_VERSION_NOT_FOUND", `Registry version ${versionId} was not found.`);
    return version;
  }

  private requireRevision(version: ObjectRegistryVersion, expectedRevision: number): void {
    if (version.revision !== expectedRevision) {
      fail("REGISTRY_REVISION_MISMATCH", `Expected registry revision ${expectedRevision}, received ${version.revision}.`);
    }
  }

  private requireStatus(version: ObjectRegistryVersion, allowed: readonly RegistryVersionStatus[]): void {
    if (!allowed.includes(version.status)) {
      fail("REGISTRY_TRANSITION_INVALID", `Registry version cannot transition from ${version.status}.`);
    }
  }
}

function validateCandidate(input: CreateCandidateInput): void {
  for (const [field, value] of Object.entries({
    semanticLabel: input.semanticLabel,
    createdBy: input.createdBy,
    requestId: input.source.requestId,
    taskId: input.source.taskId,
    robotId: input.source.robotId,
    declarationId: input.source.declarationId,
    groundedObjectId: input.source.groundedObjectId,
    outcomeId: input.source.outcomeId,
  })) requireText(value, field);
  if (input.siteIds.length === 0 || input.robotCapabilities.length === 0 || input.supportedIntents.length === 0) {
    fail("REGISTRY_SCOPE_REQUIRED", "Candidate requires site, robot-capability, and manipulation-intent scopes.");
  }
  input.siteIds.forEach((value) => requireText(value, "siteId"));
  input.robotCapabilities.forEach((value) => requireText(value, "robotCapability"));
  if (input.evidence.length === 0) fail("REGISTRY_EVIDENCE_REQUIRED", "Candidate requires at least one evidence artifact.");
  for (const evidence of input.evidence) {
    requireText(evidence.artifactId, "artifactId");
    requireText(evidence.observationId, "observationId");
    requireText(evidence.mediaType, "mediaType");
    if (!/^[a-f0-9]{64}$/i.test(evidence.sha256) || !Number.isSafeInteger(evidence.byteLength) || evidence.byteLength < 1) {
      fail("REGISTRY_EVIDENCE_INVALID", "Evidence requires a SHA-256 digest and positive byte length.");
    }
    requireTime(evidence.capturedAtUnixMs, "capturedAtUnixMs");
  }
}

function provenanceFromAssistance(request: AssistanceRequest, workflow: AssistanceSnapshot): RegistrySourceProvenance {
  return {
    requestId: request.requestId,
    taskId: request.taskId,
    robotId: request.robotId,
    declarationId: workflow.declaration!.declarationId,
    groundedObjectId: workflow.groundedObject!.objectId,
    outcomeId: workflow.outcome!.outcomeId,
  };
}

function bindingKeyFor(objectClassId: string, siteId: string, robotCapability: string): string {
  return `${objectClassId}\u0000${siteId}\u0000${robotCapability}`;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()))].sort();
}

function requireText(value: string, field: string): void {
  if (!value?.trim()) fail("REGISTRY_FIELD_REQUIRED", `${field} is required.`, { field });
}

function requireTime(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) fail("REGISTRY_TIME_INVALID", `${field} must be a non-negative Unix time.`, { field });
}
