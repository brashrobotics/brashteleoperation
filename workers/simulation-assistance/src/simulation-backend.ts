import { randomUUID } from "node:crypto";
import {
  TeleoperationError,
  clone,
  fail,
  type ManipulationOutcome,
} from "../../../packages/contracts/src/index.ts";
import { SimulatedRobotAdapter } from "../../../packages/robot-adapter-sdk/src/index.ts";
import { RuntimeSceneModel } from "../../../packages/scene-model/src/index.ts";
import { CommandArbiter } from "../../../robot/command-arbiter/src/index.ts";
import { InteractiveGrounder, type DepthObservation, type GroundingResult } from "../../../robot/interactive-perception/src/index.ts";
import { SimulationManipulationExecutor } from "../../../robot/manipulation-executor/src/index.ts";
import type { AssistanceSnapshot } from "../../../services/assistance-orchestrator/src/index.ts";
import type { AssistanceAutomationBackend } from "./worker.ts";

export interface SimulationAssistanceBackendOptions {
  robotId: string;
  observations: ReadonlyMap<string, DepthObservation>;
  armJointCount?: number;
  maximumReachMeters?: number;
  maximumPositionStdDevMeters?: number;
  groundingValidityMs?: number;
  now?: () => number;
  idGenerator?: () => string;
}

export class SimulationAssistanceBackend implements AssistanceAutomationBackend {
  private readonly robotId: string;
  private readonly observations: ReadonlyMap<string, DepthObservation>;
  private readonly scene = new RuntimeSceneModel();
  private readonly grounder: InteractiveGrounder;
  private readonly adapter: SimulatedRobotAdapter;
  private readonly executor: SimulationManipulationExecutor;
  private readonly executionReceipts = new Map<string, ManipulationOutcome>();

  constructor(options: SimulationAssistanceBackendOptions) {
    if (!options.robotId.trim() || options.observations.size === 0) {
      throw new Error("Simulation assistance backend requires a robot and depth observation.");
    }
    this.robotId = options.robotId;
    this.observations = new Map(options.observations);
    const now = options.now ?? Date.now;
    const idGenerator = options.idGenerator ?? randomUUID;
    const jointCount = options.armJointCount ?? 6;
    this.grounder = new InteractiveGrounder({
      scene: this.scene,
      now,
      idGenerator,
      validityMs: options.groundingValidityMs ?? 5 * 60_000,
      maximumPositionStdDevMeters: options.maximumPositionStdDevMeters ?? 0.04,
      algorithmName: "brash-compose-rgbd-grounder",
      algorithmVersion: "0.1.0",
    });
    this.adapter = new SimulatedRobotAdapter({
      capabilities: {
        robotId: options.robotId,
        profileVersion: "b2-z1-sim-v1",
        actuatorGroups: ["BASE", "MANIPULATOR"],
        armJointCount: jointCount,
        hasGripper: true,
        cameraFrames: [...new Set([...this.observations.values()].map((item) => item.imageFrameId))],
        simulation: true,
      },
      now,
      commandOutputEnabled: true,
    });
    this.adapter.configure("b2-z1-sim-v1");
    this.adapter.startObserveOnly();
    this.adapter.validateReadiness();
    this.executor = new SimulationManipulationExecutor({
      robotId: options.robotId,
      scene: this.scene,
      arbiter: new CommandArbiter(options.robotId, now()),
      adapter: this.adapter,
      now,
      idGenerator,
      maximumReachMeters: options.maximumReachMeters ?? 0.9,
      maximumPositionStdDevMeters: options.maximumPositionStdDevMeters ?? 0.04,
    });
  }

  ground(snapshot: AssistanceSnapshot): GroundingResult {
    if (snapshot.request.robotId !== this.robotId || !snapshot.declaration) {
      fail("ASSISTANCE_WORKER_STATE_INVALID", "Grounding snapshot is missing robot-bound declaration state.");
    }
    const observation = this.observations.get(snapshot.declaration.observationId);
    if (!observation) fail("ASSISTANCE_WORKER_OBSERVATION_NOT_FOUND", "Depth observation is unavailable to the simulation worker.");
    return this.grounder.ground(snapshot.declaration, observation);
  }

  plan(snapshot: AssistanceSnapshot) {
    if (!snapshot.groundedObject) fail("ASSISTANCE_WORKER_STATE_INVALID", "Planning state has no grounded object.");
    this.synchronizeScene(snapshot);
    return this.executor.createPlan({
      requestId: snapshot.request.requestId,
      objectId: snapshot.groundedObject.objectId,
      objectRevision: snapshot.groundedObject.revision,
      sceneRevision: snapshot.groundedObject.sceneRevision,
    });
  }

  execute(snapshot: AssistanceSnapshot): ManipulationOutcome {
    if (!snapshot.plan || !snapshot.approval || !snapshot.groundedObject) {
      fail("ASSISTANCE_WORKER_STATE_INVALID", "Execution state lacks plan, approval, or grounded object.");
    }
    const receiptKey = `${snapshot.request.requestId}:${snapshot.plan.planId}:${snapshot.plan.planRevision}`;
    const existing = this.executionReceipts.get(receiptKey);
    if (existing) return clone(existing);
    this.synchronizeScene(snapshot);
    if (this.adapter.state().lifecycle === "DISABLED") {
      this.adapter.startObserveOnly();
      this.adapter.validateReadiness();
    }
    const outcome = this.executor.execute(snapshot.plan, snapshot.approval).outcome;
    this.executionReceipts.set(receiptKey, clone(outcome));
    return outcome;
  }

  verify(snapshot: AssistanceSnapshot): { verified: boolean; reason: string } {
    if (!snapshot.outcome) fail("ASSISTANCE_WORKER_STATE_INVALID", "Verification state has no outcome.");
    return snapshot.outcome.success
      ? { verified: true, reason: "Simulation verified gripper closure and stable target revision." }
      : { verified: false, reason: `Simulation execution failed: ${snapshot.outcome.failureCode ?? "unknown failure"}.` };
  }

  private synchronizeScene(snapshot: AssistanceSnapshot): void {
    const object = snapshot.groundedObject;
    if (!object) return;
    const observation = snapshot.request.observations.find((item) => item.observationId === object.observationId);
    if (!observation) fail("ASSISTANCE_WORKER_OBSERVATION_NOT_FOUND", "Grounded object observation is absent from its assistance request.");
    this.scene.registerObservation(observation);
    try {
      const current = this.scene.getObject(object.objectId);
      if (current.revision === object.revision && JSON.stringify(current) === JSON.stringify(object)) return;
      if (current.revision >= object.revision) fail("GROUNDED_OBJECT_REVISION_STALE", "Control-plane object revision conflicts with simulation scene state.");
    } catch (error) {
      if (!(error instanceof TeleoperationError) || error.code !== "GROUNDED_OBJECT_NOT_FOUND") throw error;
    }
    this.scene.publishGroundedObject(object);
  }
}
