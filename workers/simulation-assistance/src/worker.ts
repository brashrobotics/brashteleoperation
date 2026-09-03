import { TeleoperationError, fail, type GroundedObject, type ManipulationOutcome, type ManipulationPlanPreview } from "../../../packages/contracts/src/index.ts";
import type { AssistanceSnapshot } from "../../../services/assistance-orchestrator/src/index.ts";
import type { GroundingResult } from "../../../robot/interactive-perception/src/index.ts";
import type { RobotAssistancePort } from "./http-port.ts";

export interface AssistanceAutomationBackend {
  ground(snapshot: AssistanceSnapshot): GroundingResult | Promise<GroundingResult>;
  plan(snapshot: AssistanceSnapshot): ManipulationPlanPreview | Promise<ManipulationPlanPreview>;
  execute(snapshot: AssistanceSnapshot): ManipulationOutcome | Promise<ManipulationOutcome>;
  verify(snapshot: AssistanceSnapshot): { verified: boolean; reason: string } | Promise<{ verified: boolean; reason: string }>;
}

export interface RobotAssistanceWorkerOptions {
  requestId: string;
  port: RobotAssistancePort;
  backend: AssistanceAutomationBackend;
  pollIntervalMs?: number;
  maximumRetryDelayMs?: number;
  automaticStart?: boolean;
}

export interface RobotAssistanceWorkerSnapshot {
  requestId: string;
  running: boolean;
  closed: boolean;
  terminal: boolean;
  successfulTransitions: number;
  failedAttempts: number;
  lastStatus?: string;
  lastErrorCode?: string;
}

const terminal = new Set(["RESOLVED", "CANCELLED", "EXPIRED", "FAILED", "DIRECT_TELEOP_REQUIRED"]);

/** Simulation-only low-rate worker. All state changes still cross the
 * authenticated, revisioned control API; it has no physical command adapter. */
export class RobotAssistanceWorker {
  private readonly requestId: string;
  private readonly port: RobotAssistancePort;
  private readonly backend: AssistanceAutomationBackend;
  private readonly pollIntervalMs: number;
  private readonly maximumRetryDelayMs: number;
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<AssistanceSnapshot>;
  private closed = false;
  private reachedTerminal = false;
  private successfulTransitions = 0;
  private failedAttempts = 0;
  private lastStatus?: string;
  private lastErrorCode?: string;

  constructor(options: RobotAssistanceWorkerOptions) {
    if (!options.requestId.trim()) throw new Error("Simulation assistance worker requestId is required.");
    this.requestId = options.requestId;
    this.port = options.port;
    this.backend = options.backend;
    this.pollIntervalMs = options.pollIntervalMs ?? 250;
    this.maximumRetryDelayMs = options.maximumRetryDelayMs ?? 5_000;
    if (!Number.isSafeInteger(this.pollIntervalMs) || this.pollIntervalMs < 25
      || !Number.isSafeInteger(this.maximumRetryDelayMs) || this.maximumRetryDelayMs < this.pollIntervalMs) {
      throw new Error("Simulation assistance polling bounds are invalid.");
    }
    if (options.automaticStart ?? true) this.schedule(0);
  }

  runOnce(): Promise<AssistanceSnapshot> {
    if (this.closed) fail("ASSISTANCE_WORKER_CLOSED", "Simulation assistance worker is closed.");
    if (this.inFlight) return this.inFlight;
    const operation = this.step();
    this.inFlight = operation;
    return operation.finally(() => {
      if (this.inFlight === operation) this.inFlight = undefined;
    });
  }

  close(): RobotAssistanceWorkerSnapshot {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    return this.snapshot();
  }

  snapshot(): RobotAssistanceWorkerSnapshot {
    return {
      requestId: this.requestId,
      running: this.inFlight !== undefined,
      closed: this.closed,
      terminal: this.reachedTerminal,
      successfulTransitions: this.successfulTransitions,
      failedAttempts: this.failedAttempts,
      ...(this.lastStatus ? { lastStatus: this.lastStatus } : {}),
      ...(this.lastErrorCode ? { lastErrorCode: this.lastErrorCode } : {}),
    };
  }

  private async step(): Promise<AssistanceSnapshot> {
    let snapshot = await this.port.get(this.requestId);
    this.lastStatus = snapshot.status;
    if (terminal.has(snapshot.status)) {
      this.reachedTerminal = true;
      return snapshot;
    }
    if (snapshot.status === "GROUNDING") {
      if (!snapshot.declaration) fail("ASSISTANCE_WORKER_STATE_INVALID", "Grounding state has no declaration.");
      const result = await this.backend.ground(snapshot);
      snapshot = result.status === "GROUNDED"
        ? await this.port.recordGrounding(this.requestId, snapshot.revision, result.object)
        : await this.port.requestDeclarationCorrection(this.requestId, snapshot.revision, `${result.code}: ${result.message}`);
      this.successfulTransitions += 1;
    } else if (snapshot.status === "PLAN_PENDING") {
      try {
        snapshot = await this.port.recordPlan(this.requestId, snapshot.revision, await this.backend.plan(snapshot));
      } catch (error) {
        if (error instanceof TeleoperationError
          && ["GROUNDED_OBJECT_STALE", "GROUNDED_OBJECT_UNUSABLE", "MANIPULATION_TARGET_UNCERTAIN", "MANIPULATION_TARGET_UNREACHABLE"].includes(error.code)) {
          snapshot = await this.port.requestDeclarationCorrection(this.requestId, snapshot.revision, `${error.code}: ${error.message}`);
        } else {
          throw error;
        }
      }
      this.successfulTransitions += 1;
    } else if (snapshot.status === "EXECUTING") {
      snapshot = await this.port.recordOutcome(this.requestId, snapshot.revision, await this.backend.execute(snapshot));
      this.successfulTransitions += 1;
    } else if (snapshot.status === "VERIFYING") {
      const result = await this.backend.verify(snapshot);
      snapshot = await this.port.completeVerification(this.requestId, snapshot.revision, result.verified, result.reason);
      this.successfulTransitions += 1;
    }
    this.lastStatus = snapshot.status;
    this.lastErrorCode = undefined;
    if (terminal.has(snapshot.status)) this.reachedTerminal = true;
    return snapshot;
  }

  private schedule(delayMs: number): void {
    if (this.closed || this.reachedTerminal) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.runOnce().then(
        () => {
          this.failedAttempts = 0;
          this.schedule(this.pollIntervalMs);
        },
        (error) => {
          this.failedAttempts += 1;
          this.lastErrorCode = error instanceof TeleoperationError ? error.code : "ASSISTANCE_WORKER_ERROR";
          const retryDelay = Math.min(this.maximumRetryDelayMs, this.pollIntervalMs * 2 ** Math.min(this.failedAttempts, 6));
          this.schedule(retryDelay);
        },
      );
    }, delayMs);
    this.timer.unref();
  }
}
