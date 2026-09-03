import {
  clone,
  decodeAssistanceRequest,
  decodeGroundedObject,
  decodeManipulationApproval,
  decodeManipulationOutcome,
  decodeManipulationPlanPreview,
  decodeObjectDeclaration,
  fail,
  type GroundedObject,
  type ManipulationOutcome,
  type ManipulationPlanPreview,
} from "../../../packages/contracts/src/index.ts";
import type {
  AssistanceSnapshot,
  AssistanceStatus,
} from "../../../services/assistance-orchestrator/src/index.ts";

export interface RobotAssistancePort {
  get(requestId: string): Promise<AssistanceSnapshot>;
  recordGrounding(requestId: string, expectedRevision: number, groundedObject: GroundedObject): Promise<AssistanceSnapshot>;
  requestDeclarationCorrection(requestId: string, expectedRevision: number, reason: string): Promise<AssistanceSnapshot>;
  recordPlan(requestId: string, expectedRevision: number, plan: ManipulationPlanPreview): Promise<AssistanceSnapshot>;
  recordOutcome(requestId: string, expectedRevision: number, outcome: ManipulationOutcome): Promise<AssistanceSnapshot>;
  completeVerification(requestId: string, expectedRevision: number, verified: boolean, reason: string): Promise<AssistanceSnapshot>;
}

export interface HttpRobotAssistancePortOptions {
  controlPlaneUrl: string;
  bearerToken: string;
  requestTimeoutMs?: number;
  maximumResponseBytes?: number;
  fetchImplementation?: typeof fetch;
}

export class HttpRobotAssistancePort implements RobotAssistancePort {
  private readonly controlPlaneUrl: URL;
  private readonly bearerToken: string;
  private readonly requestTimeoutMs: number;
  private readonly maximumResponseBytes: number;
  private readonly fetchImplementation: typeof fetch;

  constructor(options: HttpRobotAssistancePortOptions) {
    this.controlPlaneUrl = validatedBaseUrl(options.controlPlaneUrl);
    if (options.bearerToken.length < 16 || options.bearerToken.length > 4_096
      || options.bearerToken.trim() !== options.bearerToken) {
      throw new Error("Robot assistance bearer token must contain 16 to 4096 characters without surrounding whitespace.");
    }
    this.bearerToken = options.bearerToken;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 2_000;
    this.maximumResponseBytes = options.maximumResponseBytes ?? 128 * 1_024;
    if (!Number.isSafeInteger(this.requestTimeoutMs) || this.requestTimeoutMs < 25 || this.requestTimeoutMs > 30_000) {
      throw new Error("Robot assistance request timeout must be between 25 and 30000 milliseconds.");
    }
    if (!Number.isSafeInteger(this.maximumResponseBytes) || this.maximumResponseBytes < 1_024
      || this.maximumResponseBytes > 1024 * 1_024) {
      throw new Error("Robot assistance response bound must be between 1024 and 1048576 bytes.");
    }
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  get(requestId: string): Promise<AssistanceSnapshot> {
    return this.request(requestId, "GET");
  }

  recordGrounding(requestId: string, expectedRevision: number, groundedObject: GroundedObject): Promise<AssistanceSnapshot> {
    return this.request(requestId, "POST", "groundings", { expectedRevision, groundedObject });
  }

  requestDeclarationCorrection(requestId: string, expectedRevision: number, reason: string): Promise<AssistanceSnapshot> {
    return this.request(requestId, "POST", "declaration-correction", { expectedRevision, reason });
  }

  recordPlan(requestId: string, expectedRevision: number, plan: ManipulationPlanPreview): Promise<AssistanceSnapshot> {
    return this.request(requestId, "POST", "plans", { expectedRevision, plan });
  }

  recordOutcome(requestId: string, expectedRevision: number, outcome: ManipulationOutcome): Promise<AssistanceSnapshot> {
    return this.request(requestId, "POST", "outcomes", { expectedRevision, outcome });
  }

  completeVerification(requestId: string, expectedRevision: number, verified: boolean, reason: string): Promise<AssistanceSnapshot> {
    return this.request(requestId, "POST", "verification", { expectedRevision, verified, reason });
  }

  private async request(
    requestId: string,
    method: "GET" | "POST",
    action?: string,
    body?: Record<string, unknown>,
  ): Promise<AssistanceSnapshot> {
    if (!requestId.trim()) fail("ASSISTANCE_WORKER_REQUEST_ID_REQUIRED", "Assistance request ID is required.");
    const path = `assistance/v1/requests/${encodeURIComponent(requestId)}${action ? `/${action}` : ""}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    let response: Response;
    try {
      response = await this.fetchImplementation(new URL(path, this.controlPlaneUrl), {
        method,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.bearerToken}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: "error",
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timeout);
      if (controller.signal.aborted) fail("ASSISTANCE_WORKER_TIMEOUT", "Control plane did not respond before the worker timeout.");
      fail("ASSISTANCE_WORKER_UNAVAILABLE", "Control-plane assistance endpoint is unavailable.", {
        cause: error instanceof Error ? error.name : "unknown",
      });
    }
    let bytes: Buffer;
    try {
      bytes = await readBounded(response, this.maximumResponseBytes);
    } catch (error) {
      if (controller.signal.aborted) fail("ASSISTANCE_WORKER_TIMEOUT", "Control plane did not complete its response before timeout.");
      throw error;
    } finally {
      clearTimeout(timeout);
    }
    if (response.status === 401 || response.status === 403) {
      fail("ASSISTANCE_WORKER_AUTHENTICATION_FAILED", "Control plane rejected the robot assistance identity.", { status: response.status });
    }
    if (!response.ok) {
      fail("ASSISTANCE_WORKER_REMOTE_REJECTED", "Control plane rejected the assistance transition.", { status: response.status });
    }
    if (response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      fail("ASSISTANCE_WORKER_RESPONSE_INVALID", "Control-plane assistance response must use application/json.");
    }
    let document: unknown;
    try {
      document = JSON.parse(bytes.toString("utf8"));
    } catch {
      fail("ASSISTANCE_WORKER_RESPONSE_INVALID", "Control-plane assistance response is not valid JSON.");
    }
    const snapshot = decodeSnapshot(requiredRecord(document).assistance);
    if (snapshot.request.requestId !== requestId) {
      fail("ASSISTANCE_WORKER_RESPONSE_INVALID", "Control plane returned a different assistance request.");
    }
    return snapshot;
  }
}

const statuses = new Set<AssistanceStatus>([
  "OPEN", "ASSIGNED", "DECLARATION_PENDING", "GROUNDING", "PLAN_PENDING",
  "APPROVAL_PENDING", "EXECUTING", "VERIFYING", "RESOLVED", "CANCELLED",
  "EXPIRED", "FAILED", "DIRECT_TELEOP_REQUIRED",
]);

function decodeSnapshot(value: unknown): AssistanceSnapshot {
  const input = requiredRecord(value);
  const request = decodeAssistanceRequest(input.request);
  if (typeof input.status !== "string" || !statuses.has(input.status as AssistanceStatus)
    || !Number.isSafeInteger(input.revision) || (input.revision as number) < 1
    || !Number.isSafeInteger(input.changedAtUnixMs) || (input.changedAtUnixMs as number) < 0) {
    fail("ASSISTANCE_WORKER_RESPONSE_INVALID", "Assistance snapshot status, revision, or timestamp is invalid.");
  }
  const assignedOperatorId = optionalText(input.assignedOperatorId, "assignedOperatorId");
  const reason = optionalText(input.reason, "reason");
  return clone({
    request,
    status: input.status as AssistanceStatus,
    revision: input.revision as number,
    changedAtUnixMs: input.changedAtUnixMs as number,
    ...(assignedOperatorId ? { assignedOperatorId } : {}),
    ...(input.declaration === undefined ? {} : { declaration: decodeObjectDeclaration(input.declaration) }),
    ...(input.groundedObject === undefined ? {} : { groundedObject: decodeGroundedObject(input.groundedObject) }),
    ...(input.plan === undefined ? {} : { plan: decodeManipulationPlanPreview(input.plan) }),
    ...(input.approval === undefined ? {} : { approval: decodeManipulationApproval(input.approval) }),
    ...(input.outcome === undefined ? {} : { outcome: decodeManipulationOutcome(input.outcome) }),
    ...(reason ? { reason } : {}),
  });
}

function requiredRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("ASSISTANCE_WORKER_RESPONSE_INVALID", "Control-plane assistance response is malformed.");
  }
  return value as Record<string, unknown>;
}

function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    fail("ASSISTANCE_WORKER_RESPONSE_INVALID", `${field} must be a non-empty string when present.`);
  }
  return value;
}

async function readBounded(response: Response, maximumBytes: number): Promise<Buffer> {
  const advertised = Number(response.headers.get("content-length"));
  if (Number.isFinite(advertised) && advertised > maximumBytes) {
    await response.body?.cancel();
    fail("ASSISTANCE_WORKER_RESPONSE_TOO_LARGE", "Control-plane assistance response is oversized.");
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        fail("ASSISTANCE_WORKER_RESPONSE_TOO_LARGE", "Control-plane assistance response is oversized.");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function validatedBaseUrl(value: string): URL {
  const url = new URL(value);
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const loopback = host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
  if (url.username || url.password || url.search || url.hash
    || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) {
    throw new Error("Control-plane URL must use HTTPS, except for loopback development.");
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}
