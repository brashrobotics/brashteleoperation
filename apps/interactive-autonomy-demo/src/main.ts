import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EvidenceRecorder } from "../../../edge/evidence-recorder/src/index.ts";
import {
  CONTRACT_VERSION,
  type GroundedObject,
  type ManipulationApproval,
  type ObjectDeclaration,
  type ObservationBundleReference,
} from "../../../packages/contracts/src/index.ts";
import { SimulatedRobotAdapter } from "../../../packages/robot-adapter-sdk/src/index.ts";
import { RuntimeSceneModel } from "../../../packages/scene-model/src/index.ts";
import { CommandArbiter } from "../../../robot/command-arbiter/src/index.ts";
import {
  InteractiveGrounder,
  RecognitionAssistanceCoordinator,
  RuntimeExemplarRecognizer,
  type DepthObservation,
} from "../../../robot/interactive-perception/src/index.ts";
import { SimulationManipulationExecutor } from "../../../robot/manipulation-executor/src/index.ts";
import { InMemoryAssistanceOrchestrator } from "../../../services/assistance-orchestrator/src/index.ts";
import { InMemoryObjectRegistry } from "../../../services/object-registry/src/index.ts";
import { ExemplarLearningPipeline } from "../../../workers/learning-pipeline/src/index.ts";

export interface InteractiveAutonomyDemoResult {
  firstEncounter: {
    assistanceStatus: string;
    manipulationSucceeded: boolean;
    operatorDeclarationId: string;
  };
  enrollment: {
    registryVersionStatus: string;
    evaluationPassed: boolean;
    evidenceVerified: boolean;
    installedExemplarCount: number;
  };
  futureEncounter: {
    recognitionStatus: string;
    semanticLabel?: string;
    assistanceRequested: boolean;
    autonomousManipulationSucceeded: boolean;
  };
  physicalCommandOutputEnabled: false;
}

/**
 * Runs the complete learning loop without network or hardware dependencies.
 * Motion commands are accepted only by an explicitly enabled simulation adapter.
 */
export async function runInteractiveAutonomyDemo(evidenceDirectory: string): Promise<InteractiveAutonomyDemoResult> {
  let nowUnixMs = 1_800_000_000_000;
  let identifier = 0;
  const now = () => nowUnixMs;
  const idGenerator = () => `autonomy-demo-${++identifier}`;
  const robotId = "b2-unit-001";
  const operatorId = "operator-001";
  const siteId = "site-istanbul-lab";
  const robotCapability = "unitree-b2-z1";

  const scene = new RuntimeSceneModel();
  const assistance = new InMemoryAssistanceOrchestrator({ now, idGenerator });
  const grounder = new InteractiveGrounder({ scene, now, idGenerator, validityMs: 30_000 });
  const registry = new InMemoryObjectRegistry({ now, idGenerator });
  const evidence = await EvidenceRecorder.open({ rootDirectory: evidenceDirectory, now, idGenerator });
  const learning = new ExemplarLearningPipeline();
  const recognizer = new RuntimeExemplarRecognizer({ now });
  const recognitionCoordinator = new RecognitionAssistanceCoordinator({ recognizer, assistance, now, idGenerator });
  const adapter = createReadySimulationAdapter(robotId, now);
  const executor = new SimulationManipulationExecutor({
    robotId,
    scene,
    arbiter: new CommandArbiter(robotId, nowUnixMs),
    adapter,
    now,
    idGenerator,
  });

  // First encounter: recognition fails, so an operator declares the target once.
  const sourceObservation = depthObservation({
    observationId: "observation-source",
    sceneRevision: "scene-source-1",
    robotId,
    capturedAtUnixMs: nowUnixMs,
  });
  const sourceProposal: GroundedObject = {
    contractVersion: CONTRACT_VERSION,
    objectId: "generic-proposal-source",
    requestId: "autonomy-attempt-source",
    declarationId: "generic-proposal-source",
    declarationRevision: 1,
    observationId: sourceObservation.reference.observationId,
    robotId,
    sceneRevision: sourceObservation.reference.sceneRevision,
    revision: 1,
    status: "GROUNDED",
    pose: { frameId: "base_link", positionMeters: [0.01, 0.01, 0.55], orientationXyzw: [0, 0, 0, 1] },
    dimensionsMeters: [0.1, 0.1, 0.2],
    positionStdDevMeters: [0.005, 0.005, 0.005],
    groundedAtUnixMs: nowUnixMs,
    validUntilUnixMs: nowUnixMs + 30_000,
    algorithm: { name: "generic-geometry-proposer", version: "1.0.0" },
  };
  const initialDecision = recognitionCoordinator.recognizeOrRequest({
    requestId: "assistance-source",
    robotId,
    taskId: "pick-blue-parts-bin",
    siteId,
    robotCapability,
    observations: [sourceObservation.reference],
    candidates: [{ candidateId: "generic-proposal-source", object: sourceProposal, featureVector: [1, 0.02, 0] }],
  });
  if (initialDecision.status !== "ASSISTANCE_OPENED") throw new Error("Demo expected the first encounter to require assistance.");
  let workflow = initialDecision.assistance;
  workflow = assistance.assign(workflow.request.requestId, workflow.revision, operatorId);
  const declaration: ObjectDeclaration = {
    contractVersion: CONTRACT_VERSION,
    declarationId: "declaration-blue-parts-bin",
    requestId: workflow.request.requestId,
    observationId: sourceObservation.reference.observationId,
    revision: 1,
    declaredBy: operatorId,
    declaredAtUnixMs: ++nowUnixMs,
    selection: { kind: "BOX", frameId: sourceObservation.imageFrameId, x: 2, y: 2, width: 4, height: 4 },
    semanticLabel: "blue parts bin",
    manipulationIntent: "PICK",
    persistenceScope: "SITE_ENROLLMENT_CANDIDATE",
  };
  workflow = assistance.submitDeclaration(workflow.request.requestId, workflow.revision, declaration);
  const grounding = grounder.ground(declaration, sourceObservation);
  if (grounding.status !== "GROUNDED") throw new Error(`Demo grounding unexpectedly requested input: ${grounding.code}`);
  workflow = assistance.recordGrounding(workflow.request.requestId, workflow.revision, grounding.object);
  const firstPlan = executor.createPlan({
    requestId: workflow.request.requestId,
    objectId: grounding.object.objectId,
    objectRevision: grounding.object.revision,
    sceneRevision: grounding.object.sceneRevision,
  });
  workflow = assistance.recordPlan(workflow.request.requestId, workflow.revision, firstPlan);
  const firstApproval = exactApproval(firstPlan, operatorId, ++nowUnixMs, "approval-source");
  workflow = assistance.approve(workflow.request.requestId, workflow.revision, firstApproval);
  const firstExecution = executor.execute(firstPlan, firstApproval);
  workflow = assistance.recordOutcome(workflow.request.requestId, workflow.revision, firstExecution.outcome);
  workflow = assistance.completeVerification(
    workflow.request.requestId,
    workflow.revision,
    firstExecution.outcome.success,
    "Simulation confirmed gripper closure and target-revision stability.",
  );

  // Enrollment is deliberately gated by retained evidence, human review, and held-out evaluation.
  const evidenceArtifact = await evidence.record({
    artifactId: "evidence-source-features",
    observationId: sourceObservation.reference.observationId,
    robotId,
    requestId: workflow.request.requestId,
    mediaType: "application/json",
    capturedAtUnixMs: sourceObservation.reference.capturedAtUnixMs,
    retention: "LEARNING_CANDIDATE",
    redacted: true,
    consentId: "consent-demo-001",
    bytes: new TextEncoder().encode(JSON.stringify({ featureVector: [1, 0.02, 0], label: declaration.semanticLabel })),
  });
  const evidenceVerified = await evidence.verify(evidenceArtifact.artifactId);
  let version = registry.createCandidateFromAssistance({
    assistance: workflow,
    evidence: [evidence.reference(evidenceArtifact.artifactId)],
    siteIds: [siteId],
    robotCapabilities: [robotCapability],
    createdBy: operatorId,
    objectClassId: "object-class-blue-parts-bin",
    versionId: "registry-blue-parts-bin-v1",
  });
  version = registry.submitForReview(version.versionId, version.revision);
  version = registry.recordReview(version.versionId, version.revision, {
    reviewerId: "reviewer-001",
    reviewedAtUnixMs: ++nowUnixMs,
    approved: true,
    notes: "Declaration, evidence provenance, and successful grasp were reviewed.",
  });
  version = registry.startValidation(version.versionId, version.revision);
  const learned = learning.run({
    candidate: version,
    training: [
      { sampleId: "train-source-1", observationId: "observation-source", semanticLabel: "blue parts bin", vector: [1, 0.02, 0] },
    ],
    evaluation: [
      { sampleId: "evaluation-positive", observationId: "observation-held-out-positive", semanticLabel: "blue parts bin", vector: [0.99, 0.01, 0] },
      { sampleId: "evaluation-negative", observationId: "observation-held-out-negative", semanticLabel: "red extinguisher", vector: [0, 1, 0] },
    ],
    config: {
      featureExtractorName: "deterministic-demo-embedding",
      featureExtractorVersion: "1.0.0",
      similarityThreshold: 0.95,
      minimumPrecision: 1,
      minimumRecall: 1,
      randomSeed: 7,
    },
  });
  version = registry.recordValidation(version.versionId, version.revision, {
    evaluationId: learned.evaluation.evaluationId,
    artifactSha256: learned.evaluation.artifactSha256,
    evaluatedAtUnixMs: ++nowUnixMs,
    passed: learned.evaluation.passed,
    sampleCount: learned.evaluation.sampleCount,
    metrics: { precision: learned.evaluation.precision, recall: learned.evaluation.recall },
    notes: "Deterministic held-out exemplar evaluation completed.",
  });
  version = registry.activate({
    versionId: version.versionId,
    expectedRevision: version.revision,
    siteId,
    robotCapability,
    activatedBy: "release-manager-001",
  });
  recognizer.install({ artifact: learned.artifact, activeVersion: version, siteId, robotCapability });

  // Future encounter: generic perception proposes geometry and the reviewed exemplar identifies it.
  const futureReference: ObservationBundleReference = {
    observationId: "observation-future",
    robotId,
    capturedAtUnixMs: ++nowUnixMs,
    sceneRevision: "scene-future-1",
    calibrationVersion: "calibration-simulation-v1",
    frameIds: ["camera_color", "camera_depth"],
  };
  scene.registerObservation(futureReference);
  const futureObject: GroundedObject = {
    contractVersion: CONTRACT_VERSION,
    objectId: "object-future-blue-bin",
    requestId: "autonomous-attempt-future",
    declarationId: "generic-proposal-future",
    declarationRevision: 1,
    observationId: futureReference.observationId,
    robotId,
    sceneRevision: futureReference.sceneRevision,
    revision: 1,
    status: "TRACKED",
    pose: { frameId: "base_link", positionMeters: [0.02, 0.01, 0.56], orientationXyzw: [0, 0, 0, 1] },
    dimensionsMeters: [0.12, 0.1, 0.18],
    positionStdDevMeters: [0.004, 0.004, 0.006],
    groundedAtUnixMs: nowUnixMs,
    validUntilUnixMs: nowUnixMs + 30_000,
    algorithm: { name: "generic-geometry-proposer", version: "1.0.0" },
  };
  scene.publishGroundedObject(futureObject);
  const futureDecision = recognitionCoordinator.recognizeOrRequest({
    requestId: "assistance-future-should-not-open",
    robotId,
    taskId: "pick-blue-parts-bin-future",
    siteId,
    robotCapability,
    observations: [futureReference],
    candidates: [
      { candidateId: "future-blue-bin", object: futureObject, featureVector: [0.995, 0.015, 0] },
      { candidateId: "future-distractor", object: { ...futureObject, objectId: "object-future-distractor" }, featureVector: [0, 1, 0] },
    ],
  });
  let autonomousManipulationSucceeded = false;
  let semanticLabel: string | undefined;
  if (futureDecision.status === "AUTONOMY_READY") {
    semanticLabel = futureDecision.recognition.semanticLabel;
    adapter.startObserveOnly();
    adapter.validateReadiness();
    const futurePlan = executor.createPlan({
      requestId: futureObject.requestId,
      objectId: futureDecision.recognition.object.objectId,
      objectRevision: futureDecision.recognition.object.revision,
      sceneRevision: futureDecision.recognition.object.sceneRevision,
    });
    // This approval represents a reviewed autonomous policy, not an operator intervention.
    const policyApproval = exactApproval(futurePlan, "autonomy-policy", ++nowUnixMs, "approval-autonomy-policy");
    autonomousManipulationSucceeded = executor.execute(futurePlan, policyApproval).outcome.success;
  }

  return {
    firstEncounter: {
      assistanceStatus: workflow.status,
      manipulationSucceeded: firstExecution.outcome.success,
      operatorDeclarationId: declaration.declarationId,
    },
    enrollment: {
      registryVersionStatus: version.status,
      evaluationPassed: learned.evaluation.passed,
      evidenceVerified,
      installedExemplarCount: recognizer.installedCount(),
    },
    futureEncounter: {
      recognitionStatus: futureDecision.recognition.status,
      semanticLabel,
      assistanceRequested: futureDecision.status === "ASSISTANCE_OPENED",
      autonomousManipulationSucceeded,
    },
    physicalCommandOutputEnabled: false,
  };
}

function createReadySimulationAdapter(robotId: string, now: () => number): SimulatedRobotAdapter {
  const adapter = new SimulatedRobotAdapter({
    capabilities: {
      robotId,
      profileVersion: "b2-z1-simulation-v1",
      actuatorGroups: ["BASE", "MANIPULATOR"],
      armJointCount: 6,
      hasGripper: true,
      cameraFrames: ["camera_color", "camera_depth"],
      simulation: true,
    },
    now,
    commandOutputEnabled: true,
  });
  adapter.configure("b2-z1-simulation-v1");
  adapter.startObserveOnly();
  adapter.validateReadiness();
  return adapter;
}

function depthObservation(input: {
  observationId: string;
  sceneRevision: string;
  robotId: string;
  capturedAtUnixMs: number;
}): DepthObservation {
  return {
    reference: {
      observationId: input.observationId,
      robotId: input.robotId,
      capturedAtUnixMs: input.capturedAtUnixMs,
      sceneRevision: input.sceneRevision,
      calibrationVersion: "calibration-simulation-v1",
      frameIds: ["camera_color", "camera_depth"],
    },
    imageFrameId: "camera_color",
    poseFrameId: "base_link",
    intrinsics: { width: 10, height: 10, fx: 100, fy: 100, cx: 5, cy: 5 },
    depthMeters: Array.from({ length: 100 }, (_, index) => 0.55 + ((index % 3) * 0.001)),
    cameraOriginInPoseFrameMeters: [0, 0, 0],
  };
}

function exactApproval(
  plan: { requestId: string; planId: string; planRevision: number; objectRevision: number; sceneRevision: string },
  approvedBy: string,
  approvedAtUnixMs: number,
  approvalId: string,
): ManipulationApproval {
  return {
    contractVersion: CONTRACT_VERSION,
    approvalId,
    requestId: plan.requestId,
    planId: plan.planId,
    planRevision: plan.planRevision,
    objectRevision: plan.objectRevision,
    sceneRevision: plan.sceneRevision,
    approvedBy,
    approvedAtUnixMs,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const directory = await mkdtemp(join(tmpdir(), "brash-interactive-autonomy-demo-"));
  try {
    console.log(JSON.stringify(await runInteractiveAutonomyDemo(directory), null, 2));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
