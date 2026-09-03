import { fileURLToPath } from "node:url";
import {
  CONTRACT_VERSION,
  type AssistanceRequest,
  type GroundedObject,
  type ManipulationApproval,
  type ManipulationOutcome,
  type ManipulationPlanPreview,
  type ObjectDeclaration,
  type ObservationBundleReference,
  type TeleopCommandEnvelope,
} from "../../../packages/contracts/src/index.ts";
import { RuntimeSceneModel } from "../../../packages/scene-model/src/index.ts";
import { InMemorySessionControl } from "../../../services/session-control/src/index.ts";
import { InMemoryAssistanceOrchestrator } from "../../../services/assistance-orchestrator/src/index.ts";
import { TeleopCommandValidator } from "../../../edge/robot-agent/src/index.ts";
import { CommandArbiter } from "../../../robot/command-arbiter/src/index.ts";
import { BaseSafetySupervisor } from "../../../robot/safety-supervisor/src/index.ts";

export interface VerticalSliceResult {
  directSessionStatus: string;
  ownershipStatus: string;
  acceptedCommandId: string;
  acceptedLinearXMetersPerSecond: number;
  safetyStatus: string;
  assistanceStatus: string;
  groundedObjectStatus: string;
  assistanceEventTypes: readonly string[];
}

export function runVerticalSlice(): VerticalSliceResult {
  let nowUnixMs = 1_800_000_000_000;
  let idCounter = 0;
  const now = () => nowUnixMs;
  const idGenerator = () => `demo-${++idCounter}`;

  const sessions = new InMemorySessionControl({ now, idGenerator });
  const commandValidator = new TeleopCommandValidator({ maximumCommandLifetimeMs: 500 });
  const arbiter = new CommandArbiter("b2-unit-001", nowUnixMs);
  const safety = new BaseSafetySupervisor({
    robotId: "b2-unit-001",
    commandTimeoutMs: 250,
    maximumLinearXMetersPerSecond: 0.7,
    maximumLinearYMetersPerSecond: 0.4,
    maximumAngularZRadiansPerSecond: 0.7,
    maximumLinearAccelerationMetersPerSecondSquared: 0.5,
    maximumAngularAccelerationRadiansPerSecondSquared: 0.7,
  }, nowUnixMs, 0);

  let directSession = sessions.requestSession({
    sessionId: "session-direct-001",
    robotId: "b2-unit-001",
    operatorId: "operator-001",
    scopes: ["OBSERVE", "CONTROL_BASE"],
  });
  directSession = sessions.grantSession(directSession.sessionId, directSession.revision, 30_000);
  directSession = sessions.markConnecting(directSession.sessionId, directSession.revision);

  let ownership = arbiter.requestOwnership({
    requestId: "ownership-direct-001",
    robotId: "b2-unit-001",
    sourceId: "operator-001",
    authority: "DIRECT_TELEOP",
    actuatorGroup: "BASE",
    sessionId: directSession.sessionId,
    requestedAtUnixMs: nowUnixMs,
  }, arbiter.snapshot().revision);
  ownership = arbiter.acknowledgeStopped(ownership.revision, nowUnixMs + 1);
  directSession = sessions.activate(directSession.sessionId, directSession.revision, ownership.status === "OWNED");
  safety.updateInterlocks({ vendorSafetyOk: true, controllerHealthy: true, robotStateFresh: true }, nowUnixMs + 1, 0);
  let safetyState = safety.prepare(safety.snapshot().revision, nowUnixMs + 2, 0);
  safetyState = safety.enable(ownership, safetyState.revision, nowUnixMs + 3, 0);

  const command: TeleopCommandEnvelope = {
    contractVersion: CONTRACT_VERSION,
    commandId: "command-base-001",
    sessionId: directSession.sessionId,
    robotId: directSession.robotId,
    sourceId: directSession.operatorId,
    actuatorGroup: "BASE",
    sequence: 1,
    producedAtUnixMs: nowUnixMs + 5,
    expiresAtUnixMs: nowUnixMs + 255,
    deadman: true,
    intent: {
      kind: "BASE_MOTION",
      frameId: "base_link",
      linearXMetersPerSecond: 0.1,
      linearYMetersPerSecond: 0,
      angularZRadiansPerSecond: 0,
      speedScale: 0.25,
    },
  };
  const validated = commandValidator.validate(command, directSession.lease!, nowUnixMs + 10, 10);
  const selected = arbiter.selectCommand(validated);
  safetyState = safety.accept(selected, ownership, safetyState.revision, nowUnixMs + 110, 110);
  const acceptedSafetyState = safetyState;

  safetyState = safety.hold(safetyState.revision, nowUnixMs + 19, 120, "Direct-control demonstration complete.");
  ownership = arbiter.releaseOwnership("operator-001", ownership.revision, nowUnixMs + 20, "Direct-control demonstration complete.");
  ownership = arbiter.acknowledgeStopped(ownership.revision, nowUnixMs + 21);
  directSession = sessions.release(directSession.sessionId, directSession.revision, ownership.status === "NO_OWNER");

  let assistanceSession = sessions.requestSession({
    sessionId: "session-assistance-001",
    robotId: "b2-unit-001",
    operatorId: "operator-001",
    scopes: ["OBSERVE", "DECLARE_OBJECT", "APPROVE_PLAN"],
  });
  assistanceSession = sessions.grantSession(assistanceSession.sessionId, assistanceSession.revision, 60_000);
  assistanceSession = sessions.markConnecting(assistanceSession.sessionId, assistanceSession.revision);
  assistanceSession = sessions.activate(assistanceSession.sessionId, assistanceSession.revision, false);

  const observation: ObservationBundleReference = {
    observationId: "observation-rgbd-001",
    robotId: "b2-unit-001",
    capturedAtUnixMs: nowUnixMs + 100,
    sceneRevision: "scene-001",
    calibrationVersion: "calibration-sim-001",
    frameIds: ["d435i_color_optical_frame", "d435i_depth_optical_frame"],
  };
  const assistanceRequest: AssistanceRequest = {
    contractVersion: CONTRACT_VERSION,
    requestId: "assistance-001",
    robotId: "b2-unit-001",
    taskId: "pick-task-001",
    reason: "OBJECT_NOT_RECOGNIZED",
    requestedInput: "SELECT_TARGET",
    observations: [observation],
    createdAtUnixMs: nowUnixMs + 101,
    expiresAtUnixMs: nowUnixMs + 60_000,
  };
  const assistance = new InMemoryAssistanceOrchestrator({ now, idGenerator });
  const scene = new RuntimeSceneModel();
  scene.registerObservation(observation);

  let workflow = assistance.open(assistanceRequest);
  workflow = assistance.assign(workflow.request.requestId, workflow.revision, "operator-001");
  const declaration: ObjectDeclaration = {
    contractVersion: CONTRACT_VERSION,
    declarationId: "declaration-001",
    requestId: workflow.request.requestId,
    observationId: observation.observationId,
    revision: 1,
    declaredBy: "operator-001",
    declaredAtUnixMs: nowUnixMs + 200,
    selection: { kind: "BOX", frameId: "d435i_color_optical_frame", x: 320, y: 220, width: 80, height: 110 },
    semanticLabel: "unrecognized-container",
    manipulationIntent: "PICK",
    persistenceScope: "SITE_ENROLLMENT_CANDIDATE",
  };
  workflow = assistance.submitDeclaration(workflow.request.requestId, workflow.revision, declaration);

  const groundedObject: GroundedObject = {
    contractVersion: CONTRACT_VERSION,
    objectId: "grounded-object-001",
    requestId: workflow.request.requestId,
    declarationId: declaration.declarationId,
    declarationRevision: declaration.revision,
    observationId: observation.observationId,
    robotId: workflow.request.robotId,
    sceneRevision: observation.sceneRevision,
    revision: 1,
    status: "TRACKED",
    pose: {
      frameId: "base_link",
      positionMeters: [0.65, 0.05, 0.3],
      orientationXyzw: [0, 0, 0, 1],
    },
    dimensionsMeters: [0.12, 0.08, 0.2],
    positionStdDevMeters: [0.005, 0.005, 0.01],
    groundedAtUnixMs: nowUnixMs + 250,
    validUntilUnixMs: nowUnixMs + 10_000,
    algorithm: { name: "deterministic-demo-grounder", version: "0.1.0" },
  };
  scene.publishGroundedObject(groundedObject);
  workflow = assistance.recordGrounding(workflow.request.requestId, workflow.revision, groundedObject);

  const usableObject = scene.requireUsableObject(
    groundedObject.objectId,
    groundedObject.revision,
    groundedObject.sceneRevision,
    nowUnixMs + 300,
  );
  const plan: ManipulationPlanPreview = {
    contractVersion: CONTRACT_VERSION,
    planId: "plan-001",
    requestId: workflow.request.requestId,
    robotId: workflow.request.robotId,
    objectId: usableObject.objectId,
    objectRevision: usableObject.revision,
    sceneRevision: usableObject.sceneRevision,
    planRevision: 1,
    generatedAtUnixMs: nowUnixMs + 350,
    approvalRequired: true,
    phases: ["approach", "grasp", "lift", "verify"],
    expectedOutcome: "Object lifted 0.10 m while remaining tracked in the gripper.",
  };
  workflow = assistance.recordPlan(workflow.request.requestId, workflow.revision, plan);
  const approval: ManipulationApproval = {
    contractVersion: CONTRACT_VERSION,
    approvalId: "approval-001",
    requestId: workflow.request.requestId,
    planId: plan.planId,
    planRevision: plan.planRevision,
    objectRevision: groundedObject.revision,
    sceneRevision: groundedObject.sceneRevision,
    approvedBy: "operator-001",
    approvedAtUnixMs: nowUnixMs + 400,
  };
  workflow = assistance.approve(workflow.request.requestId, workflow.revision, approval);
  const outcome: ManipulationOutcome = {
    contractVersion: CONTRACT_VERSION,
    outcomeId: "outcome-001",
    requestId: workflow.request.requestId,
    planId: plan.planId,
    planRevision: plan.planRevision,
    success: true,
    verification: ["gripper-position-within-grasp-range", "object-tracked-after-lift"],
    completedAtUnixMs: nowUnixMs + 1_000,
  };
  workflow = assistance.recordOutcome(workflow.request.requestId, workflow.revision, outcome);
  workflow = assistance.completeVerification(workflow.request.requestId, workflow.revision, true, "Two independent simulated checks passed.");
  assistanceSession = sessions.release(assistanceSession.sessionId, assistanceSession.revision, true);

  return {
    directSessionStatus: directSession.status,
    ownershipStatus: ownership.status,
    acceptedCommandId: selected.command.commandId,
    acceptedLinearXMetersPerSecond: acceptedSafetyState.output.linearXMetersPerSecond,
    safetyStatus: safetyState.status,
    assistanceStatus: workflow.status,
    groundedObjectStatus: usableObject.status,
    assistanceEventTypes: assistance.getEvents(workflow.request.requestId).map((event) => event.type),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log(JSON.stringify(runVerticalSlice(), null, 2));
}
