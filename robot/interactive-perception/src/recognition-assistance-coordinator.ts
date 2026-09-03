import { randomUUID } from "node:crypto";
import {
  CONTRACT_VERSION,
  type AssistanceReason,
  type AssistanceRequest,
  type ObservationBundleReference,
  type RequestedHumanInput,
} from "../../../packages/contracts/src/index.ts";
import {
  type AssistanceSnapshot,
  InMemoryAssistanceOrchestrator,
} from "../../../services/assistance-orchestrator/src/index.ts";
import {
  type RecognitionCandidate,
  type RecognitionResult,
  RuntimeExemplarRecognizer,
} from "./exemplar-recognizer.ts";

export type RecognitionDecision =
  | { status: "AUTONOMY_READY"; recognition: Extract<RecognitionResult, { status: "RECOGNIZED" }> }
  | {
      status: "ASSISTANCE_OPENED";
      recognition: Extract<RecognitionResult, { status: "ASSISTANCE_REQUIRED" }>;
      assistance: AssistanceSnapshot;
    };

export interface RecognitionAssistanceCoordinatorOptions {
  recognizer: RuntimeExemplarRecognizer;
  assistance: InMemoryAssistanceOrchestrator;
  now?: () => number;
  idGenerator?: () => string;
  assistanceLifetimeMs?: number;
}

/** Turns a recognition miss into a revisioned human-assistance request. */
export class RecognitionAssistanceCoordinator {
  private readonly recognizer: RuntimeExemplarRecognizer;
  private readonly assistance: InMemoryAssistanceOrchestrator;
  private readonly now: () => number;
  private readonly idGenerator: () => string;
  private readonly assistanceLifetimeMs: number;

  constructor(options: RecognitionAssistanceCoordinatorOptions) {
    this.recognizer = options.recognizer;
    this.assistance = options.assistance;
    this.now = options.now ?? Date.now;
    this.idGenerator = options.idGenerator ?? randomUUID;
    this.assistanceLifetimeMs = options.assistanceLifetimeMs ?? 60_000;
    if (!Number.isSafeInteger(this.assistanceLifetimeMs) || this.assistanceLifetimeMs < 1_000) {
      throw new Error("Assistance lifetime must be an integer of at least one second.");
    }
  }

  recognizeOrRequest(input: {
    requestId?: string;
    robotId: string;
    taskId: string;
    siteId: string;
    robotCapability: string;
    observations: readonly ObservationBundleReference[];
    candidates: readonly RecognitionCandidate[];
  }): RecognitionDecision {
    const recognition = this.recognizer.recognize({
      siteId: input.siteId,
      robotCapability: input.robotCapability,
      candidates: input.candidates,
    });
    if (recognition.status === "RECOGNIZED") return { status: "AUTONOMY_READY", recognition };
    const createdAtUnixMs = this.now();
    const request: AssistanceRequest = {
      contractVersion: CONTRACT_VERSION,
      requestId: input.requestId?.trim() || this.idGenerator(),
      robotId: input.robotId,
      taskId: input.taskId,
      reason: recognition.reason,
      requestedInput: requestedInputFor(recognition.reason),
      observations: [...input.observations],
      createdAtUnixMs,
      expiresAtUnixMs: createdAtUnixMs + this.assistanceLifetimeMs,
    };
    return {
      status: "ASSISTANCE_OPENED",
      recognition,
      assistance: this.assistance.open(request),
    };
  }
}

function requestedInputFor(reason: AssistanceReason): RequestedHumanInput {
  return reason === "MULTIPLE_OBJECTS_AMBIGUOUS" ? "DISAMBIGUATE_TARGET" : "SELECT_TARGET";
}
