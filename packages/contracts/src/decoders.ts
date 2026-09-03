import { fail } from "./errors.ts";
import type {
  ActuatorGroup,
  AssistanceReason,
  AssistanceRequest,
  ContractVersion,
  GroundedObject,
  GroundedObjectStatus,
  ManipulationApproval,
  ManipulationIntent,
  ManipulationOutcome,
  ManipulationPlanPreview,
  ObjectDeclaration,
  ObjectSelection,
  ObservationBundleReference,
  PersistenceScope,
  RequestedHumanInput,
  RealtimeIceCandidate,
  RealtimeSignalingMessage,
  RealtimeSignalingPayload,
  RobotSessionReadinessReport,
  SessionScope,
  TeleopCommandEnvelope,
  TeleopIntent,
  TeleopSessionLease,
} from "./index.ts";

const sessionScopes = ["OBSERVE", "DECLARE_OBJECT", "APPROVE_PLAN", "CONTROL_BASE", "CONTROL_MANIPULATOR", "SUPERVISE"] as const;
const assistanceReasons = [
  "OBJECT_NOT_RECOGNIZED",
  "MULTIPLE_OBJECTS_AMBIGUOUS",
  "OBJECT_POSE_UNCERTAIN",
  "NO_VALID_GRASP",
  "OBJECT_LOST",
  "GRASP_VERIFICATION_FAILED",
  "DESTINATION_UNKNOWN",
] as const;
const requestedInputs = ["SELECT_TARGET", "DISAMBIGUATE_TARGET", "PROVIDE_GRASP_HINT", "SELECT_DESTINATION", "APPROVE_PLAN", "DIRECT_TELEOP"] as const;
const manipulationIntents = ["PICK", "PLACE", "PUSH", "TURN", "INSPECT"] as const;
const persistenceScopes = ["ATTEMPT_ONLY", "CURRENT_SCENE", "SITE_ENROLLMENT_CANDIDATE"] as const;
const groundedStatuses = ["GROUNDED", "TRACKED", "LOST", "STALE", "INVALIDATED"] as const;

export function decodeTeleopSessionLease(value: unknown): TeleopSessionLease {
  const object = record(value, "lease");
  return {
    contractVersion: decodeVersion(object.contractVersion),
    sessionId: stringValue(object.sessionId, "sessionId"),
    robotId: stringValue(object.robotId, "robotId"),
    operatorId: stringValue(object.operatorId, "operatorId"),
    scopes: enumArray(object.scopes, sessionScopes, "scopes") as SessionScope[],
    revision: positiveInteger(object.revision, "revision"),
    issuedAtUnixMs: unixMs(object.issuedAtUnixMs, "issuedAtUnixMs"),
    expiresAtUnixMs: unixMs(object.expiresAtUnixMs, "expiresAtUnixMs"),
  };
}

export function decodeTeleopCommandEnvelope(value: unknown): TeleopCommandEnvelope {
  const object = record(value, "command");
  const actuatorGroup = enumValue(object.actuatorGroup, ["BASE", "MANIPULATOR"] as const, "actuatorGroup") as ActuatorGroup;
  return {
    contractVersion: decodeVersion(object.contractVersion),
    commandId: stringValue(object.commandId, "commandId"),
    sessionId: stringValue(object.sessionId, "sessionId"),
    robotId: stringValue(object.robotId, "robotId"),
    sourceId: stringValue(object.sourceId, "sourceId"),
    actuatorGroup,
    sequence: positiveInteger(object.sequence, "sequence"),
    producedAtUnixMs: unixMs(object.producedAtUnixMs, "producedAtUnixMs"),
    expiresAtUnixMs: unixMs(object.expiresAtUnixMs, "expiresAtUnixMs"),
    deadman: booleanValue(object.deadman, "deadman"),
    intent: decodeIntent(object.intent),
  };
}

export function decodeRealtimeSignalingMessage(value: unknown): RealtimeSignalingMessage {
  const object = record(value, "signalingMessage");
  return {
    contractVersion: decodeVersion(object.contractVersion),
    messageId: stringValue(object.messageId, "messageId"),
    signalingId: stringValue(object.signalingId, "signalingId"),
    sessionId: stringValue(object.sessionId, "sessionId"),
    from: enumValue(object.from, ["OPERATOR", "ROBOT_EDGE"] as const, "from"),
    sentAtUnixMs: unixMs(object.sentAtUnixMs, "sentAtUnixMs"),
    payload: decodeSignalingPayload(object.payload),
  };
}

export function decodeRobotSessionReadinessReport(value: unknown): RobotSessionReadinessReport {
  const object = record(value, "robotReadiness");
  const actuatorGroup = object.actuatorGroup === undefined
    ? undefined
    : enumValue(object.actuatorGroup, ["BASE", "MANIPULATOR"] as const, "actuatorGroup") as ActuatorGroup;
  return {
    contractVersion: decodeVersion(object.contractVersion),
    readinessId: stringValue(object.readinessId, "readinessId"),
    sessionId: stringValue(object.sessionId, "sessionId"),
    robotId: stringValue(object.robotId, "robotId"),
    operatorId: stringValue(object.operatorId, "operatorId"),
    leaseRevision: positiveInteger(object.leaseRevision, "leaseRevision"),
    ownershipRevision: positiveInteger(object.ownershipRevision, "ownershipRevision"),
    ownershipStatus: enumValue(object.ownershipStatus, ["NO_OWNER", "HANDOFF", "OWNED"] as const, "ownershipStatus"),
    ...(actuatorGroup === undefined ? {} : { actuatorGroup }),
    reportedAtUnixMs: unixMs(object.reportedAtUnixMs, "reportedAtUnixMs"),
  };
}

export function decodeAssistanceRequest(value: unknown): AssistanceRequest {
  const object = record(value, "request");
  return {
    contractVersion: decodeVersion(object.contractVersion),
    requestId: stringValue(object.requestId, "requestId"),
    robotId: stringValue(object.robotId, "robotId"),
    taskId: stringValue(object.taskId, "taskId"),
    reason: enumValue(object.reason, assistanceReasons, "reason") as AssistanceReason,
    requestedInput: enumValue(object.requestedInput, requestedInputs, "requestedInput") as RequestedHumanInput,
    observations: arrayValue(object.observations, "observations").map(decodeObservationBundleReference),
    createdAtUnixMs: unixMs(object.createdAtUnixMs, "createdAtUnixMs"),
    expiresAtUnixMs: unixMs(object.expiresAtUnixMs, "expiresAtUnixMs"),
  };
}

export function decodeObservationBundleReference(value: unknown): ObservationBundleReference {
  const object = record(value, "observation");
  return {
    observationId: stringValue(object.observationId, "observationId"),
    robotId: stringValue(object.robotId, "robotId"),
    capturedAtUnixMs: unixMs(object.capturedAtUnixMs, "capturedAtUnixMs"),
    sceneRevision: stringValue(object.sceneRevision, "sceneRevision"),
    calibrationVersion: stringValue(object.calibrationVersion, "calibrationVersion"),
    frameIds: stringArray(object.frameIds, "frameIds"),
  };
}

export function decodeObjectDeclaration(value: unknown): ObjectDeclaration {
  const object = record(value, "declaration");
  const graspHint = object.graspHint === undefined ? undefined : record(object.graspHint, "graspHint");
  return {
    contractVersion: decodeVersion(object.contractVersion),
    declarationId: stringValue(object.declarationId, "declarationId"),
    requestId: stringValue(object.requestId, "requestId"),
    observationId: stringValue(object.observationId, "observationId"),
    revision: positiveInteger(object.revision, "revision"),
    declaredBy: stringValue(object.declaredBy, "declaredBy"),
    declaredAtUnixMs: unixMs(object.declaredAtUnixMs, "declaredAtUnixMs"),
    selection: decodeObjectSelection(object.selection),
    semanticLabel: optionalString(object.semanticLabel, "semanticLabel"),
    manipulationIntent: enumValue(object.manipulationIntent, manipulationIntents, "manipulationIntent") as ManipulationIntent,
    persistenceScope: enumValue(object.persistenceScope, persistenceScopes, "persistenceScope") as PersistenceScope,
    graspHint: graspHint ? {
      frameId: stringValue(graspHint.frameId, "graspHint.frameId"),
      approachVector: numericTuple(graspHint.approachVector, 3, "graspHint.approachVector"),
    } : undefined,
  };
}

export function decodeGroundedObject(value: unknown): GroundedObject {
  const object = record(value, "groundedObject");
  const pose = record(object.pose, "pose");
  const algorithm = record(object.algorithm, "algorithm");
  return {
    contractVersion: decodeVersion(object.contractVersion),
    objectId: stringValue(object.objectId, "objectId"),
    requestId: stringValue(object.requestId, "requestId"),
    declarationId: stringValue(object.declarationId, "declarationId"),
    declarationRevision: positiveInteger(object.declarationRevision, "declarationRevision"),
    observationId: stringValue(object.observationId, "observationId"),
    robotId: stringValue(object.robotId, "robotId"),
    sceneRevision: stringValue(object.sceneRevision, "sceneRevision"),
    revision: positiveInteger(object.revision, "revision"),
    status: enumValue(object.status, groundedStatuses, "status") as GroundedObjectStatus,
    pose: {
      frameId: stringValue(pose.frameId, "pose.frameId"),
      positionMeters: numericTuple(pose.positionMeters, 3, "pose.positionMeters"),
      orientationXyzw: numericTuple(pose.orientationXyzw, 4, "pose.orientationXyzw"),
    },
    dimensionsMeters: numericTuple(object.dimensionsMeters, 3, "dimensionsMeters"),
    positionStdDevMeters: numericTuple(object.positionStdDevMeters, 3, "positionStdDevMeters"),
    groundedAtUnixMs: unixMs(object.groundedAtUnixMs, "groundedAtUnixMs"),
    validUntilUnixMs: unixMs(object.validUntilUnixMs, "validUntilUnixMs"),
    algorithm: {
      name: stringValue(algorithm.name, "algorithm.name"),
      version: stringValue(algorithm.version, "algorithm.version"),
    },
  };
}

export function decodeManipulationPlanPreview(value: unknown): ManipulationPlanPreview {
  const object = record(value, "plan");
  return {
    contractVersion: decodeVersion(object.contractVersion),
    planId: stringValue(object.planId, "planId"),
    requestId: stringValue(object.requestId, "requestId"),
    robotId: stringValue(object.robotId, "robotId"),
    objectId: stringValue(object.objectId, "objectId"),
    objectRevision: positiveInteger(object.objectRevision, "objectRevision"),
    sceneRevision: stringValue(object.sceneRevision, "sceneRevision"),
    planRevision: positiveInteger(object.planRevision, "planRevision"),
    generatedAtUnixMs: unixMs(object.generatedAtUnixMs, "generatedAtUnixMs"),
    approvalRequired: booleanValue(object.approvalRequired, "approvalRequired"),
    phases: stringArray(object.phases, "phases"),
    expectedOutcome: stringValue(object.expectedOutcome, "expectedOutcome"),
  };
}

export function decodeManipulationApproval(value: unknown): ManipulationApproval {
  const object = record(value, "approval");
  return {
    contractVersion: decodeVersion(object.contractVersion),
    approvalId: stringValue(object.approvalId, "approvalId"),
    requestId: stringValue(object.requestId, "requestId"),
    planId: stringValue(object.planId, "planId"),
    planRevision: positiveInteger(object.planRevision, "planRevision"),
    objectRevision: positiveInteger(object.objectRevision, "objectRevision"),
    sceneRevision: stringValue(object.sceneRevision, "sceneRevision"),
    approvedBy: stringValue(object.approvedBy, "approvedBy"),
    approvedAtUnixMs: unixMs(object.approvedAtUnixMs, "approvedAtUnixMs"),
  };
}

export function decodeManipulationOutcome(value: unknown): ManipulationOutcome {
  const object = record(value, "outcome");
  return {
    contractVersion: decodeVersion(object.contractVersion),
    outcomeId: stringValue(object.outcomeId, "outcomeId"),
    requestId: stringValue(object.requestId, "requestId"),
    planId: stringValue(object.planId, "planId"),
    planRevision: positiveInteger(object.planRevision, "planRevision"),
    success: booleanValue(object.success, "success"),
    verification: stringArray(object.verification, "verification"),
    completedAtUnixMs: unixMs(object.completedAtUnixMs, "completedAtUnixMs"),
    failureCode: optionalString(object.failureCode, "failureCode"),
  };
}

function decodeVersion(value: unknown): ContractVersion {
  const object = record(value, "contractVersion");
  return {
    major: nonNegativeInteger(object.major, "contractVersion.major"),
    minor: nonNegativeInteger(object.minor, "contractVersion.minor"),
  };
}

function decodeIntent(value: unknown): TeleopIntent {
  const object = record(value, "intent");
  const kind = enumValue(object.kind, ["BASE_MOTION", "ARM_MOTION", "GRIPPER"] as const, "intent.kind");
  if (kind === "BASE_MOTION") {
    return {
      kind,
      frameId: stringValue(object.frameId, "intent.frameId"),
      linearXMetersPerSecond: finiteNumber(object.linearXMetersPerSecond, "intent.linearXMetersPerSecond"),
      linearYMetersPerSecond: finiteNumber(object.linearYMetersPerSecond, "intent.linearYMetersPerSecond"),
      angularZRadiansPerSecond: finiteNumber(object.angularZRadiansPerSecond, "intent.angularZRadiansPerSecond"),
      speedScale: finiteNumber(object.speedScale, "intent.speedScale"),
    };
  }
  if (kind === "ARM_MOTION") {
    return {
      kind,
      mode: enumValue(object.mode, ["CARTESIAN_TWIST", "JOINT_JOG"] as const, "intent.mode"),
      frameId: stringValue(object.frameId, "intent.frameId"),
      values: numericArray(object.values, "intent.values"),
      speedScale: finiteNumber(object.speedScale, "intent.speedScale"),
      clutch: booleanValue(object.clutch, "intent.clutch"),
    };
  }
  return {
    kind,
    normalizedPosition: finiteNumber(object.normalizedPosition, "intent.normalizedPosition"),
    normalizedForceLimit: optionalFiniteNumber(object.normalizedForceLimit, "intent.normalizedForceLimit"),
  };
}

function decodeObjectSelection(value: unknown): ObjectSelection {
  const object = record(value, "selection");
  const kind = enumValue(object.kind, ["POINT", "BOX", "MASK"] as const, "selection.kind");
  const frameId = stringValue(object.frameId, "selection.frameId");
  if (kind === "POINT") return { kind, frameId, x: finiteNumber(object.x, "selection.x"), y: finiteNumber(object.y, "selection.y") };
  if (kind === "BOX") {
    return {
      kind,
      frameId,
      x: finiteNumber(object.x, "selection.x"),
      y: finiteNumber(object.y, "selection.y"),
      width: finiteNumber(object.width, "selection.width"),
      height: finiteNumber(object.height, "selection.height"),
    };
  }
  return { kind, frameId, maskArtifactId: stringValue(object.maskArtifactId, "selection.maskArtifactId") };
}

function decodeSignalingPayload(value: unknown): RealtimeSignalingPayload {
  const object = record(value, "payload");
  const kind = enumValue(object.kind, ["OFFER", "ANSWER", "ICE_CANDIDATE", "CONNECTED", "CLOSE"] as const, "payload.kind");
  if (kind === "OFFER" || kind === "ANSWER") {
    const description = record(object.description, "payload.description");
    return {
      kind,
      description: {
        type: enumValue(description.type, ["offer", "answer"] as const, "payload.description.type"),
        sdp: stringValue(description.sdp, "payload.description.sdp"),
      },
    };
  }
  if (kind === "ICE_CANDIDATE") {
    if (object.candidate === null) return { kind, candidate: null };
    const candidate = record(object.candidate, "payload.candidate");
    const decoded: RealtimeIceCandidate = {
      candidate: stringValue(candidate.candidate, "payload.candidate.candidate"),
      sdpMid: optionalString(candidate.sdpMid, "payload.candidate.sdpMid"),
      sdpMLineIndex: candidate.sdpMLineIndex === undefined
        ? undefined
        : nonNegativeInteger(candidate.sdpMLineIndex, "payload.candidate.sdpMLineIndex"),
      usernameFragment: optionalString(candidate.usernameFragment, "payload.candidate.usernameFragment"),
    };
    return { kind, candidate: decoded };
  }
  if (kind === "CLOSE") return { kind, reason: stringValue(object.reason, "payload.reason") };
  return { kind };
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("CONTRACT_OBJECT_REQUIRED", `${field} must be an object.`, { field });
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) fail("CONTRACT_STRING_REQUIRED", `${field} must be a non-empty string.`, { field });
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : stringValue(value, field);
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail("CONTRACT_NUMBER_INVALID", `${field} must be finite.`, { field });
  return value;
}

function optionalFiniteNumber(value: unknown, field: string): number | undefined {
  return value === undefined ? undefined : finiteNumber(value, field);
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail("CONTRACT_INTEGER_INVALID", `${field} must be a non-negative safe integer.`, { field });
  }
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  const number = nonNegativeInteger(value, field);
  if (number < 1) fail("CONTRACT_INTEGER_INVALID", `${field} must be positive.`, { field });
  return number;
}

function unixMs(value: unknown, field: string): number {
  return nonNegativeInteger(value, field);
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") fail("CONTRACT_BOOLEAN_REQUIRED", `${field} must be boolean.`, { field });
  return value;
}

function arrayValue(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) fail("CONTRACT_ARRAY_REQUIRED", `${field} must be an array.`, { field });
  return value;
}

function stringArray(value: unknown, field: string): string[] {
  return arrayValue(value, field).map((item, index) => stringValue(item, `${field}[${index}]`));
}

function numericArray(value: unknown, field: string): number[] {
  return arrayValue(value, field).map((item, index) => finiteNumber(item, `${field}[${index}]`));
}

function numericTuple<N extends number>(value: unknown, length: N, field: string): N extends 3 ? [number, number, number] : [number, number, number, number] {
  const numbers = numericArray(value, field);
  if (numbers.length !== length) fail("CONTRACT_TUPLE_INVALID", `${field} must contain exactly ${length} numbers.`, { field });
  return numbers as N extends 3 ? [number, number, number] : [number, number, number, number];
}

function enumValue<const T extends readonly string[]>(value: unknown, allowed: T, field: string): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    fail("CONTRACT_ENUM_INVALID", `${field} must be one of ${allowed.join(", ")}.`, { field });
  }
  return value as T[number];
}

function enumArray<const T extends readonly string[]>(value: unknown, allowed: T, field: string): T[number][] {
  return arrayValue(value, field).map((item, index) => enumValue(item, allowed, `${field}[${index}]`));
}
