import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTRACT_VERSION,
  type GroundedObject,
  type ManipulationApproval,
  type ObjectDeclaration,
} from "../../packages/contracts/src/index.ts";
import { SimulatedRobotAdapter } from "../../packages/robot-adapter-sdk/src/index.ts";
import { RuntimeSceneModel } from "../../packages/scene-model/src/index.ts";
import { CommandArbiter } from "../../robot/command-arbiter/src/index.ts";
import { InteractiveGrounder, type DepthObservation } from "../../robot/interactive-perception/src/index.ts";
import { SimulationManipulationExecutor } from "../../robot/manipulation-executor/src/index.ts";

test("operator box is grounded in RGB-D and exact approved plan executes in simulation", () => {
  let now = 10_000;
  let id = 0;
  const scene = new RuntimeSceneModel();
  const grounder = new InteractiveGrounder({ scene, now: () => now, idGenerator: () => `object-${++id}` });
  const declaration = makeDeclaration();
  const result = grounder.ground(declaration, makeObservation("observation-1", "scene-1", "calibration-1"));
  assert.equal(result.status, "GROUNDED");
  if (result.status !== "GROUNDED") return;
  assert.equal(result.object.pose.frameId, "base_link");
  assert.equal(result.object.status, "GROUNDED");

  const adapter = readyAdapter(() => now);
  const arbiter = new CommandArbiter("robot-1", now);
  const executor = new SimulationManipulationExecutor({
    robotId: "robot-1",
    scene,
    arbiter,
    adapter,
    now: () => now,
    idGenerator: () => `execution-${++id}`,
  });
  const plan = executor.createPlan({
    requestId: "request-1",
    objectId: result.object.objectId,
    objectRevision: result.object.revision,
    sceneRevision: result.object.sceneRevision,
  });
  const execution = executor.execute(plan, approvalFor(plan));
  assert.equal(execution.outcome.success, true);
  assert.deepEqual(execution.completedPhases, ["approach", "grasp", "lift", "verify"]);
  assert.equal(execution.ownership.status, "NO_OWNER");
  assert.equal(adapter.state().lifecycle, "DISABLED");
});

test("calibration change invalidates tracking and target revision change aborts execution", () => {
  let now = 20_000;
  let id = 0;
  const scene = new RuntimeSceneModel();
  const grounder = new InteractiveGrounder({ scene, now: () => now, idGenerator: () => `object-${++id}` });
  const declaration = makeDeclaration();
  const grounded = grounder.ground(declaration, makeObservation("observation-1", "scene-1", "calibration-1"));
  assert.equal(grounded.status, "GROUNDED");
  if (grounded.status !== "GROUNDED") return;

  const tracked = grounder.track(
    grounded.object,
    declaration,
    makeObservation("observation-2", "scene-2", "calibration-2"),
  );
  assert.equal(tracked.status, "NEEDS_INPUT");
  assert.equal(scene.getObject(grounded.object.objectId).status, "INVALIDATED");

  const secondScene = new RuntimeSceneModel();
  const secondGrounder = new InteractiveGrounder({ scene: secondScene, now: () => now, idGenerator: () => `second-${++id}` });
  const second = secondGrounder.ground(declaration, makeObservation("observation-1", "scene-1", "calibration-1"));
  assert.equal(second.status, "GROUNDED");
  if (second.status !== "GROUNDED") return;
  const adapter = readyAdapter(() => now);
  const executor = new SimulationManipulationExecutor({
    robotId: "robot-1",
    scene: secondScene,
    arbiter: new CommandArbiter("robot-1", now),
    adapter,
    now: () => now,
  });
  const plan = executor.createPlan({
    requestId: "request-1",
    objectId: second.object.objectId,
    objectRevision: second.object.revision,
    sceneRevision: second.object.sceneRevision,
  });
  secondScene.invalidateObject(second.object.objectId, "LOST", ++now);
  const execution = executor.execute(plan, approvalFor(plan));
  assert.equal(execution.outcome.success, false);
  assert.equal(execution.outcome.failureCode, "GROUNDED_OBJECT_REVISION_MISMATCH");
  assert.equal(execution.ownership.status, "NO_OWNER");
});

test("simulated downstream fault stops execution and clears ownership", () => {
  const now = 30_000;
  const scene = new RuntimeSceneModel();
  const grounder = new InteractiveGrounder({ scene, now: () => now, idGenerator: () => "object-1" });
  const result = grounder.ground(makeDeclaration(), makeObservation("observation-1", "scene-1", "calibration-1"));
  assert.equal(result.status, "GROUNDED");
  if (result.status !== "GROUNDED") return;
  const adapter = readyAdapter(() => now);
  adapter.injectNextCommandFailure("SIMULATED_Z1_DISCONNECT");
  const executor = new SimulationManipulationExecutor({
    robotId: "robot-1",
    scene,
    arbiter: new CommandArbiter("robot-1", now),
    adapter,
    now: () => now,
  });
  const plan = executor.createPlan({
    requestId: "request-1",
    objectId: result.object.objectId,
    objectRevision: result.object.revision,
    sceneRevision: result.object.sceneRevision,
  });
  const execution = executor.execute(plan, approvalFor(plan));
  assert.equal(execution.outcome.success, false);
  assert.equal(execution.outcome.failureCode, "SIMULATED_Z1_DISCONNECT");
  assert.equal(execution.ownership.status, "NO_OWNER");
});

function readyAdapter(now: () => number): SimulatedRobotAdapter {
  const adapter = new SimulatedRobotAdapter({
    capabilities: {
      robotId: "robot-1",
      profileVersion: "sim-b2-z1-v1",
      actuatorGroups: ["BASE", "MANIPULATOR"],
      armJointCount: 6,
      hasGripper: true,
      cameraFrames: ["camera_color"],
      simulation: true,
    },
    now,
    commandOutputEnabled: true,
  });
  adapter.configure("sim-b2-z1-v1");
  adapter.startObserveOnly();
  adapter.validateReadiness();
  return adapter;
}

function makeDeclaration(): ObjectDeclaration {
  return {
    contractVersion: CONTRACT_VERSION,
    declarationId: "declaration-1",
    requestId: "request-1",
    observationId: "observation-1",
    revision: 1,
    declaredBy: "operator-1",
    declaredAtUnixMs: 10_000,
    selection: { kind: "BOX", frameId: "camera_color", x: 2, y: 2, width: 4, height: 4 },
    semanticLabel: "container",
    manipulationIntent: "PICK",
    persistenceScope: "ATTEMPT_ONLY",
  };
}

function makeObservation(observationId: string, sceneRevision: string, calibrationVersion: string): DepthObservation {
  return {
    reference: {
      observationId,
      robotId: "robot-1",
      capturedAtUnixMs: 9_900,
      sceneRevision,
      calibrationVersion,
      frameIds: ["camera_color", "camera_depth"],
    },
    imageFrameId: "camera_color",
    poseFrameId: "base_link",
    intrinsics: { width: 10, height: 10, fx: 100, fy: 100, cx: 5, cy: 5 },
    depthMeters: Array.from({ length: 100 }, (_, index) => 0.55 + ((index % 3) * 0.001)),
    cameraOriginInPoseFrameMeters: [0, 0, 0],
  };
}

function approvalFor(plan: {
  requestId: string;
  planId: string;
  planRevision: number;
  objectRevision: number;
  sceneRevision: string;
}): ManipulationApproval {
  return {
    contractVersion: CONTRACT_VERSION,
    approvalId: "approval-1",
    requestId: plan.requestId,
    planId: plan.planId,
    planRevision: plan.planRevision,
    objectRevision: plan.objectRevision,
    sceneRevision: plan.sceneRevision,
    approvedBy: "operator-1",
    approvedAtUnixMs: 10_001,
  };
}
