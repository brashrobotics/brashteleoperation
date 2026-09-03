import { randomUUID } from "node:crypto";
import {
  CONTRACT_VERSION,
  TeleoperationError,
  assertManipulationApproval,
  assertManipulationPlanPreview,
  fail,
  type CommandOwnershipState,
  type GroundedObject,
  type ManipulationApproval,
  type ManipulationOutcome,
  type ManipulationPlanPreview,
} from "../../../packages/contracts/src/index.ts";
import type { RobotAdapter } from "../../../packages/robot-adapter-sdk/src/index.ts";
import { RuntimeSceneModel } from "../../../packages/scene-model/src/index.ts";
import { CommandArbiter } from "../../command-arbiter/src/index.ts";

export interface ManipulationExecutionResult {
  outcome: ManipulationOutcome;
  completedPhases: readonly string[];
  ownership: CommandOwnershipState;
}

export interface SimulationManipulationExecutorOptions {
  robotId: string;
  sourceId?: string;
  scene: RuntimeSceneModel;
  arbiter: CommandArbiter;
  adapter: RobotAdapter;
  now?: () => number;
  idGenerator?: () => string;
  maximumReachMeters?: number;
  maximumPositionStdDevMeters?: number;
}

export class SimulationManipulationExecutor {
  private readonly robotId: string;
  private readonly sourceId: string;
  private readonly scene: RuntimeSceneModel;
  private readonly arbiter: CommandArbiter;
  private readonly adapter: RobotAdapter;
  private readonly now: () => number;
  private readonly idGenerator: () => string;
  private readonly maximumReachMeters: number;
  private readonly maximumPositionStdDevMeters: number;

  constructor(options: SimulationManipulationExecutorOptions) {
    this.robotId = options.robotId;
    this.sourceId = options.sourceId ?? "simulation-manipulation-executor";
    this.scene = options.scene;
    this.arbiter = options.arbiter;
    this.adapter = options.adapter;
    this.now = options.now ?? Date.now;
    this.idGenerator = options.idGenerator ?? randomUUID;
    this.maximumReachMeters = options.maximumReachMeters ?? 0.9;
    this.maximumPositionStdDevMeters = options.maximumPositionStdDevMeters ?? 0.04;
    const capabilities = this.adapter.capabilities();
    if (!capabilities.simulation) throw new Error("SimulationManipulationExecutor refuses non-simulation adapters.");
    if (capabilities.robotId !== this.robotId) throw new Error("Executor robotId does not match adapter capabilities.");
  }

  createPlan(input: {
    requestId: string;
    objectId: string;
    objectRevision: number;
    sceneRevision: string;
    planRevision?: number;
  }): ManipulationPlanPreview {
    const object = this.scene.requireUsableObject(
      input.objectId,
      input.objectRevision,
      input.sceneRevision,
      this.now(),
    );
    this.validateGeometry(object);
    const capabilities = this.adapter.capabilities();
    if (!capabilities.actuatorGroups.includes("MANIPULATOR") || !capabilities.hasGripper || capabilities.armJointCount < 1) {
      fail("MANIPULATION_CAPABILITY_UNAVAILABLE", "Adapter does not expose the required arm and gripper capabilities.");
    }
    return {
      contractVersion: CONTRACT_VERSION,
      planId: this.idGenerator(),
      requestId: input.requestId,
      robotId: this.robotId,
      objectId: object.objectId,
      objectRevision: object.revision,
      sceneRevision: object.sceneRevision,
      planRevision: input.planRevision ?? 1,
      generatedAtUnixMs: this.now(),
      approvalRequired: true,
      phases: ["approach", "grasp", "lift", "verify"],
      expectedOutcome: "Target remains secured after a simulated lift.",
    };
  }

  execute(plan: ManipulationPlanPreview, approval: ManipulationApproval): ManipulationExecutionResult {
    assertManipulationPlanPreview(plan);
    assertManipulationApproval(approval);
    validateApproval(plan, approval);
    const completedPhases: string[] = [];
    let ownership = this.arbiter.snapshot();
    let failureCode: string | undefined;
    try {
      if (ownership.status !== "NO_OWNER") {
        fail("MANIPULATION_OWNERSHIP_BUSY", "Autonomous execution requires an explicitly released command owner.");
      }
      const object = this.scene.requireUsableObject(plan.objectId, plan.objectRevision, plan.sceneRevision, this.now());
      this.validateGeometry(object);
      const adapterState = this.adapter.state();
      if (!adapterState.baseStopped) fail("MANIPULATION_BASE_NOT_STOPPED", "Base must be stopped before manipulation.");
      if (adapterState.lifecycle !== "READY" && adapterState.lifecycle !== "ENABLED") {
        fail("MANIPULATION_ADAPTER_NOT_READY", `Adapter is ${adapterState.lifecycle}.`);
      }
      ownership = this.arbiter.requestOwnership({
        requestId: this.idGenerator(),
        robotId: this.robotId,
        sourceId: this.sourceId,
        authority: "AUTONOMOUS_EXECUTOR",
        actuatorGroup: "MANIPULATOR",
        requestedAtUnixMs: this.now(),
      }, ownership.revision);
      ownership = this.arbiter.acknowledgeStopped(ownership.revision, this.now());
      this.adapter.enable("MANIPULATOR");

      for (const phase of plan.phases) {
        this.scene.requireUsableObject(plan.objectId, plan.objectRevision, plan.sceneRevision, this.now());
        this.executePhase(phase);
        completedPhases.push(phase);
      }
    } catch (error) {
      failureCode = error instanceof TeleoperationError ? error.code : "MANIPULATION_EXECUTION_ERROR";
    }

    const success = failureCode === undefined && completedPhases.includes("verify");
    ownership = this.cleanupOwnership(ownership);
    const outcome: ManipulationOutcome = {
      contractVersion: CONTRACT_VERSION,
      outcomeId: this.idGenerator(),
      requestId: plan.requestId,
      planId: plan.planId,
      planRevision: plan.planRevision,
      success,
      verification: success
        ? ["simulated-gripper-closed", "target-revision-stable-through-lift"]
        : [`execution-stopped-after:${completedPhases.at(-1) ?? "none"}`],
      completedAtUnixMs: this.now(),
      failureCode,
    };
    return { outcome, completedPhases, ownership };
  }

  private executePhase(phase: string): void {
    const jointCount = this.adapter.capabilities().armJointCount;
    const expiresAtUnixMs = this.now() + 250;
    if (phase === "approach") {
      const positions = Array.from({ length: jointCount }, (_, index) => index === 1 ? -0.35 : index === 2 ? 0.55 : 0);
      this.adapter.command({
        kind: "ARM_JOINT_POSITIONS",
        actuatorGroup: "MANIPULATOR",
        commandId: this.idGenerator(),
        expiresAtUnixMs,
        positionsRadians: positions,
      });
      return;
    }
    if (phase === "grasp") {
      this.adapter.command({
        kind: "GRIPPER_POSITION",
        actuatorGroup: "MANIPULATOR",
        commandId: this.idGenerator(),
        expiresAtUnixMs,
        normalizedPosition: 0.75,
        normalizedForceLimit: 0.3,
      });
      return;
    }
    if (phase === "lift") {
      const positions = Array.from({ length: jointCount }, (_, index) => index === 1 ? -0.2 : index === 2 ? 0.35 : 0);
      this.adapter.command({
        kind: "ARM_JOINT_POSITIONS",
        actuatorGroup: "MANIPULATOR",
        commandId: this.idGenerator(),
        expiresAtUnixMs,
        positionsRadians: positions,
      });
      return;
    }
    if (phase === "verify") {
      if (this.adapter.state().gripperPosition < 0.5) fail("MANIPULATION_GRASP_NOT_VERIFIED", "Simulated gripper did not reach grasp range.");
      return;
    }
    fail("MANIPULATION_PHASE_UNSUPPORTED", `Unsupported manipulation phase ${phase}.`);
  }

  private cleanupOwnership(ownership: CommandOwnershipState): CommandOwnershipState {
    try {
      const lifecycle = this.adapter.state().lifecycle;
      if (lifecycle !== "DISABLED" && lifecycle !== "STOPPED") this.adapter.disable("Manipulation execution ended.");
    } catch {
      // Ownership cleanup still proceeds when the adapter cannot acknowledge disable.
    }
    try {
      let current = this.arbiter.snapshot();
      if (current.status === "OWNED" && current.owner?.sourceId === this.sourceId) {
        current = this.arbiter.releaseOwnership(this.sourceId, current.revision, this.now(), "Manipulation execution ended.");
      } else if (current.status === "HANDOFF") {
        current = this.arbiter.forceStop(current.revision, this.now(), "Manipulation handoff aborted.");
      }
      if (current.status === "HANDOFF") current = this.arbiter.acknowledgeStopped(current.revision, this.now());
      return current;
    } catch {
      return ownership;
    }
  }

  private validateGeometry(object: GroundedObject): void {
    const [x, y, z] = object.pose.positionMeters;
    const reach = Math.sqrt((x ** 2) + (y ** 2) + (z ** 2));
    if (reach > this.maximumReachMeters || z <= 0) {
      fail("MANIPULATION_TARGET_UNREACHABLE", "Grounded target lies outside the configured simulated reach envelope.");
    }
    if (object.positionStdDevMeters.some((value) => value > this.maximumPositionStdDevMeters)) {
      fail("MANIPULATION_TARGET_UNCERTAIN", "Grounded target uncertainty exceeds the planning limit.");
    }
  }
}

function validateApproval(plan: ManipulationPlanPreview, approval: ManipulationApproval): void {
  if (approval.requestId !== plan.requestId
    || approval.planId !== plan.planId
    || approval.planRevision !== plan.planRevision
    || approval.objectRevision !== plan.objectRevision
    || approval.sceneRevision !== plan.sceneRevision) {
    fail("MANIPULATION_APPROVAL_MISMATCH", "Approval is not bound to the exact plan, object, and scene revisions.");
  }
}
