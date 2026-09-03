import { fail, TeleoperationError } from "./errors.ts";

export { fail, TeleoperationError } from "./errors.ts";
export * from "./lease-signing.ts";

export const CONTRACT_VERSION = Object.freeze({ major: 1, minor: 0 });

export interface ContractVersion {
  major: number;
  minor: number;
}

export type SessionScope =
  | "OBSERVE"
  | "DECLARE_OBJECT"
  | "APPROVE_PLAN"
  | "CONTROL_BASE"
  | "CONTROL_MANIPULATOR"
  | "SUPERVISE";

export type ActuatorGroup = "BASE" | "MANIPULATOR";
export type CommandAuthority = "LOCAL_SERVICE" | "DIRECT_TELEOP" | "AUTONOMOUS_EXECUTOR";

export interface TeleopSessionLease {
  contractVersion: ContractVersion;
  sessionId: string;
  robotId: string;
  operatorId: string;
  scopes: readonly SessionScope[];
  revision: number;
  issuedAtUnixMs: number;
  expiresAtUnixMs: number;
}

export interface RobotSessionReadinessReport {
  contractVersion: ContractVersion;
  readinessId: string;
  sessionId: string;
  robotId: string;
  operatorId: string;
  leaseRevision: number;
  ownershipRevision: number;
  ownershipStatus: CommandOwnershipStatus;
  actuatorGroup?: ActuatorGroup;
  reportedAtUnixMs: number;
}

export interface BaseMotionIntent {
  kind: "BASE_MOTION";
  frameId: string;
  linearXMetersPerSecond: number;
  linearYMetersPerSecond: number;
  angularZRadiansPerSecond: number;
  speedScale: number;
}

export interface ArmMotionIntent {
  kind: "ARM_MOTION";
  mode: "CARTESIAN_TWIST" | "JOINT_JOG";
  frameId: string;
  values: readonly number[];
  speedScale: number;
  clutch: boolean;
}

export interface GripperIntent {
  kind: "GRIPPER";
  normalizedPosition: number;
  normalizedForceLimit?: number;
}

export type TeleopIntent = BaseMotionIntent | ArmMotionIntent | GripperIntent;

export interface TeleopCommandEnvelope {
  contractVersion: ContractVersion;
  commandId: string;
  sessionId: string;
  robotId: string;
  sourceId: string;
  actuatorGroup: ActuatorGroup;
  sequence: number;
  producedAtUnixMs: number;
  expiresAtUnixMs: number;
  deadman: boolean;
  intent: TeleopIntent;
}

export type RealtimeSignalingPeerRole = "OPERATOR" | "ROBOT_EDGE";

export interface RealtimeSessionDescription {
  type: "offer" | "answer";
  sdp: string;
}

export interface RealtimeIceCandidate {
  candidate: string;
  sdpMid?: string;
  sdpMLineIndex?: number;
  usernameFragment?: string;
}

export type RealtimeSignalingPayload =
  | { kind: "OFFER"; description: RealtimeSessionDescription }
  | { kind: "ANSWER"; description: RealtimeSessionDescription }
  | { kind: "ICE_CANDIDATE"; candidate: RealtimeIceCandidate | null }
  | { kind: "CONNECTED" }
  | { kind: "CLOSE"; reason: string };

export interface RealtimeSignalingMessage {
  contractVersion: ContractVersion;
  messageId: string;
  signalingId: string;
  sessionId: string;
  from: RealtimeSignalingPeerRole;
  sentAtUnixMs: number;
  payload: RealtimeSignalingPayload;
}

export interface ValidatedTeleopCommand {
  command: TeleopCommandEnvelope;
  arrivalMonotonicMs: number;
}

export function assertRealtimeSignalingMessage(message: RealtimeSignalingMessage): void {
  assertContractVersion(message.contractVersion);
  assertNonEmpty(message.messageId, "messageId");
  assertNonEmpty(message.signalingId, "signalingId");
  assertNonEmpty(message.sessionId, "sessionId");
  assertUnixMs(message.sentAtUnixMs, "sentAtUnixMs");
  if (message.from !== "OPERATOR" && message.from !== "ROBOT_EDGE") {
    fail("SIGNALING_PEER_ROLE_INVALID", "Signaling message has an invalid peer role.");
  }
  const payload = message.payload;
  if (payload.kind === "OFFER" || payload.kind === "ANSWER") {
    const expected = payload.kind === "OFFER" ? "offer" : "answer";
    if (payload.description.type !== expected) {
      fail("SIGNALING_DESCRIPTION_TYPE_INVALID", `${payload.kind} requires a ${expected} session description.`);
    }
    assertNonEmpty(payload.description.sdp, "payload.description.sdp");
  } else if (payload.kind === "ICE_CANDIDATE") {
    if (payload.candidate !== null) {
      assertNonEmpty(payload.candidate.candidate, "payload.candidate.candidate");
      if (payload.candidate.sdpMid !== undefined) assertNonEmpty(payload.candidate.sdpMid, "payload.candidate.sdpMid");
      if (payload.candidate.usernameFragment !== undefined) {
        assertNonEmpty(payload.candidate.usernameFragment, "payload.candidate.usernameFragment");
      }
      if (payload.candidate.sdpMLineIndex !== undefined
        && (!Number.isSafeInteger(payload.candidate.sdpMLineIndex) || payload.candidate.sdpMLineIndex < 0)) {
        fail("SIGNALING_MLINE_INDEX_INVALID", "ICE candidate sdpMLineIndex must be a non-negative integer.");
      }
    }
  } else if (payload.kind === "CLOSE") {
    assertNonEmpty(payload.reason, "payload.reason");
  } else if (payload.kind !== "CONNECTED") {
    fail("SIGNALING_PAYLOAD_INVALID", "Signaling message payload is invalid.");
  }
}

export interface CommandOwnershipRequest {
  requestId: string;
  robotId: string;
  sourceId: string;
  authority: CommandAuthority;
  actuatorGroup: ActuatorGroup;
  sessionId?: string;
  requestedAtUnixMs: number;
}

export type CommandOwnershipStatus = "NO_OWNER" | "HANDOFF" | "OWNED";

export interface CommandOwner {
  sourceId: string;
  authority: CommandAuthority;
  actuatorGroup: ActuatorGroup;
  sessionId?: string;
}

export interface CommandOwnershipState {
  robotId: string;
  revision: number;
  status: CommandOwnershipStatus;
  owner?: CommandOwner;
  pendingOwner?: CommandOwner;
  reason?: string;
  changedAtUnixMs: number;
}

export function assertRobotSessionReadinessReport(report: RobotSessionReadinessReport): void {
  assertContractVersion(report.contractVersion);
  assertNonEmpty(report.readinessId, "readinessId");
  assertNonEmpty(report.sessionId, "sessionId");
  assertNonEmpty(report.robotId, "robotId");
  assertNonEmpty(report.operatorId, "operatorId");
  if (!Number.isSafeInteger(report.leaseRevision) || report.leaseRevision < 1
    || !Number.isSafeInteger(report.ownershipRevision) || report.ownershipRevision < 1) {
    fail("ROBOT_READINESS_REVISION_INVALID", "Readiness lease and ownership revisions must be positive safe integers.");
  }
  if (!["NO_OWNER", "HANDOFF", "OWNED"].includes(report.ownershipStatus)) {
    fail("ROBOT_READINESS_STATUS_INVALID", "Readiness ownership status is invalid.");
  }
  if ((report.ownershipStatus === "HANDOFF" || report.ownershipStatus === "OWNED")
    && report.actuatorGroup !== "BASE" && report.actuatorGroup !== "MANIPULATOR") {
    fail("ROBOT_READINESS_ACTUATOR_REQUIRED", `${report.ownershipStatus} readiness requires an actuator group.`);
  }
  if (report.ownershipStatus === "NO_OWNER" && report.actuatorGroup !== undefined) {
    fail("ROBOT_READINESS_ACTUATOR_INVALID", "NO_OWNER readiness cannot identify an actuator group.");
  }
  assertUnixMs(report.reportedAtUnixMs, "reportedAtUnixMs");
}

export type AssistanceReason =
  | "OBJECT_NOT_RECOGNIZED"
  | "MULTIPLE_OBJECTS_AMBIGUOUS"
  | "OBJECT_POSE_UNCERTAIN"
  | "NO_VALID_GRASP"
  | "OBJECT_LOST"
  | "GRASP_VERIFICATION_FAILED"
  | "DESTINATION_UNKNOWN";

export type RequestedHumanInput =
  | "SELECT_TARGET"
  | "DISAMBIGUATE_TARGET"
  | "PROVIDE_GRASP_HINT"
  | "SELECT_DESTINATION"
  | "APPROVE_PLAN"
  | "DIRECT_TELEOP";

export interface ObservationBundleReference {
  observationId: string;
  robotId: string;
  capturedAtUnixMs: number;
  sceneRevision: string;
  calibrationVersion: string;
  frameIds: readonly string[];
}

export interface AssistanceRequest {
  contractVersion: ContractVersion;
  requestId: string;
  robotId: string;
  taskId: string;
  reason: AssistanceReason;
  requestedInput: RequestedHumanInput;
  observations: readonly ObservationBundleReference[];
  createdAtUnixMs: number;
  expiresAtUnixMs: number;
}

export type ObjectSelection =
  | { kind: "POINT"; frameId: string; x: number; y: number }
  | { kind: "BOX"; frameId: string; x: number; y: number; width: number; height: number }
  | { kind: "MASK"; frameId: string; maskArtifactId: string };

export type ManipulationIntent = "PICK" | "PLACE" | "PUSH" | "TURN" | "INSPECT";
export type PersistenceScope = "ATTEMPT_ONLY" | "CURRENT_SCENE" | "SITE_ENROLLMENT_CANDIDATE";

export interface ObjectDeclaration {
  contractVersion: ContractVersion;
  declarationId: string;
  requestId: string;
  observationId: string;
  revision: number;
  declaredBy: string;
  declaredAtUnixMs: number;
  selection: ObjectSelection;
  semanticLabel?: string;
  manipulationIntent: ManipulationIntent;
  persistenceScope: PersistenceScope;
  graspHint?: {
    frameId: string;
    approachVector: readonly [number, number, number];
  };
}

export interface Pose3 {
  frameId: string;
  positionMeters: readonly [number, number, number];
  orientationXyzw: readonly [number, number, number, number];
}

export type GroundedObjectStatus = "GROUNDED" | "TRACKED" | "LOST" | "STALE" | "INVALIDATED";

export interface GroundedObject {
  contractVersion: ContractVersion;
  objectId: string;
  requestId: string;
  declarationId: string;
  declarationRevision: number;
  observationId: string;
  robotId: string;
  sceneRevision: string;
  revision: number;
  status: GroundedObjectStatus;
  pose: Pose3;
  dimensionsMeters: readonly [number, number, number];
  positionStdDevMeters: readonly [number, number, number];
  groundedAtUnixMs: number;
  validUntilUnixMs: number;
  algorithm: { name: string; version: string };
}

export interface ManipulationPlanPreview {
  contractVersion: ContractVersion;
  planId: string;
  requestId: string;
  robotId: string;
  objectId: string;
  objectRevision: number;
  sceneRevision: string;
  planRevision: number;
  generatedAtUnixMs: number;
  approvalRequired: boolean;
  phases: readonly string[];
  expectedOutcome: string;
}

export interface ManipulationApproval {
  contractVersion: ContractVersion;
  approvalId: string;
  requestId: string;
  planId: string;
  planRevision: number;
  objectRevision: number;
  sceneRevision: string;
  approvedBy: string;
  approvedAtUnixMs: number;
}

export interface ManipulationOutcome {
  contractVersion: ContractVersion;
  outcomeId: string;
  requestId: string;
  planId: string;
  planRevision: number;
  success: boolean;
  verification: readonly string[];
  completedAtUnixMs: number;
  failureCode?: string;
}

export function assertContractVersion(version: ContractVersion): void {
  if (version.major !== CONTRACT_VERSION.major) {
    fail("CONTRACT_MAJOR_UNSUPPORTED", `Contract major version ${version.major} is unsupported.`);
  }
  if (!Number.isInteger(version.minor) || version.minor < 0) {
    fail("CONTRACT_MINOR_INVALID", "Contract minor version must be a non-negative integer.");
  }
}

export function assertNonEmpty(value: string, field: string): void {
  if (!value.trim()) fail("CONTRACT_FIELD_REQUIRED", `${field} is required.`, { field });
}

export function assertUnixMs(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail("CONTRACT_TIME_INVALID", `${field} must be a non-negative Unix time in milliseconds.`, { field, value });
  }
}

export function assertFiniteNumber(value: number, field: string): void {
  if (!Number.isFinite(value)) fail("CONTRACT_NUMBER_INVALID", `${field} must be finite.`, { field, value });
}

export function assertObservationBundle(observation: ObservationBundleReference): void {
  assertNonEmpty(observation.observationId, "observationId");
  assertNonEmpty(observation.robotId, "robotId");
  assertNonEmpty(observation.sceneRevision, "sceneRevision");
  assertNonEmpty(observation.calibrationVersion, "calibrationVersion");
  assertUnixMs(observation.capturedAtUnixMs, "capturedAtUnixMs");
  if (observation.frameIds.length === 0 || observation.frameIds.some((frame) => !frame.trim())) {
    fail("OBSERVATION_FRAMES_INVALID", "An observation bundle requires at least one valid frame ID.");
  }
}

export function assertObjectDeclaration(declaration: ObjectDeclaration): void {
  assertContractVersion(declaration.contractVersion);
  assertNonEmpty(declaration.declarationId, "declarationId");
  assertNonEmpty(declaration.requestId, "requestId");
  assertNonEmpty(declaration.observationId, "observationId");
  assertNonEmpty(declaration.declaredBy, "declaredBy");
  assertUnixMs(declaration.declaredAtUnixMs, "declaredAtUnixMs");
  if (!Number.isInteger(declaration.revision) || declaration.revision < 1) {
    fail("DECLARATION_REVISION_INVALID", "Declaration revision must be a positive integer.");
  }
  const selection = declaration.selection;
  if (selection.kind !== "POINT" && selection.kind !== "BOX" && selection.kind !== "MASK") {
    fail("OBJECT_SELECTION_INVALID", `Unknown object selection kind ${String((selection as { kind?: unknown }).kind)}.`);
  }
  assertNonEmpty(selection.frameId, "selection.frameId");
  if (selection.kind === "POINT") {
    assertFiniteNumber(selection.x, "selection.x");
    assertFiniteNumber(selection.y, "selection.y");
  } else if (selection.kind === "BOX") {
    for (const [field, value] of Object.entries({ x: selection.x, y: selection.y, width: selection.width, height: selection.height })) {
      assertFiniteNumber(value, `selection.${field}`);
    }
    if (selection.width <= 0 || selection.height <= 0) {
      fail("OBJECT_SELECTION_INVALID", "Box width and height must be positive.");
    }
  } else {
    assertNonEmpty(selection.maskArtifactId, "selection.maskArtifactId");
  }
  if (declaration.semanticLabel !== undefined && !declaration.semanticLabel.trim()) {
    fail("SEMANTIC_LABEL_INVALID", "semanticLabel cannot be blank when supplied.");
  }
  if (!["PICK", "PLACE", "PUSH", "TURN", "INSPECT"].includes(declaration.manipulationIntent)) {
    fail("MANIPULATION_INTENT_INVALID", "Object declaration manipulation intent is invalid.");
  }
  if (!["ATTEMPT_ONLY", "CURRENT_SCENE", "SITE_ENROLLMENT_CANDIDATE"].includes(declaration.persistenceScope)) {
    fail("PERSISTENCE_SCOPE_INVALID", "Object declaration persistence scope is invalid.");
  }
  if (declaration.graspHint) {
    assertNonEmpty(declaration.graspHint.frameId, "graspHint.frameId");
    if (declaration.graspHint.approachVector.length !== 3) fail("GRASP_HINT_INVALID", "Grasp approach vector must contain three values.");
    declaration.graspHint.approachVector.forEach((value, index) => assertFiniteNumber(value, `graspHint.approachVector[${index}]`));
  }
}

export function assertGroundedObject(object: GroundedObject): void {
  assertContractVersion(object.contractVersion);
  for (const [field, value] of Object.entries({
    objectId: object.objectId,
    requestId: object.requestId,
    declarationId: object.declarationId,
    observationId: object.observationId,
    robotId: object.robotId,
    sceneRevision: object.sceneRevision,
  })) assertNonEmpty(value, field);
  if (!Number.isInteger(object.revision) || object.revision < 1
    || !Number.isInteger(object.declarationRevision) || object.declarationRevision < 1) {
    fail("GROUNDED_OBJECT_REVISION_INVALID", "Grounded object and declaration revisions must be positive.");
  }
  if (!["GROUNDED", "TRACKED", "LOST", "STALE", "INVALIDATED"].includes(object.status)) {
    fail("GROUNDED_OBJECT_STATUS_INVALID", "Grounded object status is invalid.");
  }
  if (object.validUntilUnixMs <= object.groundedAtUnixMs) {
    fail("GROUNDED_OBJECT_VALIDITY_INVALID", "Grounded object validity must end after grounding time.");
  }
  assertUnixMs(object.groundedAtUnixMs, "groundedAtUnixMs");
  assertUnixMs(object.validUntilUnixMs, "validUntilUnixMs");
  if (object.pose.positionMeters.length !== 3 || object.pose.orientationXyzw.length !== 4
    || object.dimensionsMeters.length !== 3 || object.positionStdDevMeters.length !== 3) {
    fail("GROUNDED_OBJECT_GEOMETRY_INVALID", "Grounded object vectors have invalid dimensions.");
  }
  [...object.pose.positionMeters, ...object.pose.orientationXyzw, ...object.dimensionsMeters, ...object.positionStdDevMeters]
    .forEach((value, index) => assertFiniteNumber(value, `groundedObject.numeric[${index}]`));
  if (object.dimensionsMeters.some((value) => value <= 0) || object.positionStdDevMeters.some((value) => value < 0)) {
    fail("GROUNDED_OBJECT_GEOMETRY_INVALID", "Dimensions must be positive and uncertainty cannot be negative.");
  }
  assertNonEmpty(object.pose.frameId, "pose.frameId");
  const orientationNorm = Math.sqrt(object.pose.orientationXyzw.reduce((total, value) => total + value ** 2, 0));
  if (Math.abs(orientationNorm - 1) > 1e-3) fail("GROUNDED_OBJECT_ORIENTATION_INVALID", "Pose orientation must be a normalized quaternion.");
  assertNonEmpty(object.algorithm.name, "algorithm.name");
  assertNonEmpty(object.algorithm.version, "algorithm.version");
}

export function assertManipulationPlanPreview(plan: ManipulationPlanPreview): void {
  assertContractVersion(plan.contractVersion);
  for (const [field, value] of Object.entries({
    planId: plan.planId, requestId: plan.requestId, robotId: plan.robotId,
    objectId: plan.objectId, sceneRevision: plan.sceneRevision, expectedOutcome: plan.expectedOutcome,
  })) assertNonEmpty(value, field);
  if (!Number.isInteger(plan.planRevision) || plan.planRevision < 1
    || !Number.isInteger(plan.objectRevision) || plan.objectRevision < 1) {
    fail("PLAN_REVISION_INVALID", "Plan and object revisions must be positive.");
  }
  assertUnixMs(plan.generatedAtUnixMs, "generatedAtUnixMs");
  if (typeof plan.approvalRequired !== "boolean" || plan.phases.length === 0 || plan.phases.some((phase) => !phase.trim())) {
    fail("PLAN_INVALID", "Plan requires an approval policy and non-empty phases.");
  }
}

export function assertManipulationApproval(approval: ManipulationApproval): void {
  assertContractVersion(approval.contractVersion);
  for (const [field, value] of Object.entries({
    approvalId: approval.approvalId, requestId: approval.requestId, planId: approval.planId,
    sceneRevision: approval.sceneRevision, approvedBy: approval.approvedBy,
  })) assertNonEmpty(value, field);
  if (!Number.isInteger(approval.planRevision) || approval.planRevision < 1
    || !Number.isInteger(approval.objectRevision) || approval.objectRevision < 1) {
    fail("APPROVAL_REVISION_INVALID", "Approval plan and object revisions must be positive.");
  }
  assertUnixMs(approval.approvedAtUnixMs, "approvedAtUnixMs");
}

export function assertManipulationOutcome(outcome: ManipulationOutcome): void {
  assertContractVersion(outcome.contractVersion);
  for (const [field, value] of Object.entries({ outcomeId: outcome.outcomeId, requestId: outcome.requestId, planId: outcome.planId })) {
    assertNonEmpty(value, field);
  }
  if (!Number.isInteger(outcome.planRevision) || outcome.planRevision < 1) fail("OUTCOME_REVISION_INVALID", "Outcome plan revision must be positive.");
  if (typeof outcome.success !== "boolean" || outcome.verification.length === 0 || outcome.verification.some((item) => !item.trim())) {
    fail("OUTCOME_INVALID", "Outcome requires a boolean result and verification evidence.");
  }
  if (!outcome.success && !outcome.failureCode?.trim()) fail("OUTCOME_FAILURE_CODE_REQUIRED", "Failed outcome requires a failure code.");
  if (outcome.success && outcome.failureCode !== undefined) fail("OUTCOME_FAILURE_CODE_INVALID", "Successful outcome cannot carry a failure code.");
  assertUnixMs(outcome.completedAtUnixMs, "completedAtUnixMs");
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}

export function isTeleoperationError(error: unknown, code?: string): error is TeleoperationError {
  return error instanceof TeleoperationError && (code === undefined || error.code === code);
}

export * from "./decoders.ts";
