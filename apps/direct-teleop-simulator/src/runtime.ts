import { randomUUID } from "node:crypto";
import { fail } from "../../../packages/contracts/src/index.ts";

interface Lease {
  sessionId: string;
  robotId: string;
  operatorId: string;
  revision: number;
  expiresAtUnixMs: number;
}

interface Session {
  sessionId: string;
  robotId: string;
  operatorId: string;
  scopes: string[];
  revision: number;
  status: string;
  lease?: Lease;
}

interface EdgeState {
  robotId: string;
  ownership: {
    revision: number;
    status: string;
  };
  baseSafety: {
    revision: number;
    status: string;
    reason: string;
    output: {
      linearXMetersPerSecond: number;
      angularZRadiansPerSecond: number;
    };
  };
}

interface ApiResponse {
  session?: Session;
  sessions?: Session[];
  signedLease?: unknown;
  state?: EdgeState;
  accessToken?: string;
  grant?: { expiresAtUnixMs?: number };
  code?: string;
  message?: string;
}

export interface DirectTeleopState {
  connected: boolean;
  robotId: string;
  sessionId?: string;
  sessionStatus?: string;
  leaseExpiresAtUnixMs?: number;
  ownership: string;
  safety: string;
  safetyReason?: string;
  acceptedLinearXMetersPerSecond: number;
  acceptedAngularZRadiansPerSecond: number;
}

export interface DirectCameraFrame {
  bytes: Uint8Array;
  mediaType: string;
  cameraId: string;
  sensorFrameId: string;
  sequence: number;
  sourceTimestampUnixMs: number;
}

export interface DirectTeleopRuntimeOptions {
  controlUrl: string;
  edgeUrl: string;
  mediaUrl: string;
  controlToken: string;
  edgeToken: string;
  operatorId: string;
  robotId: string;
  cameraId?: string;
  leaseDurationMs?: number;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Server-side credential and session adapter for the loopback-only direct demo.
 * The browser never receives an API token, lease, or media grant.
 */
export class DirectTeleopRuntime {
  private readonly controlUrl: string;
  private readonly edgeUrl: string;
  private readonly mediaUrl: string;
  private readonly controlToken: string;
  private readonly edgeToken: string;
  private readonly operatorId: string;
  private readonly robotId: string;
  private readonly cameraId: string;
  private readonly leaseDurationMs: number;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private session?: Session;
  private lease?: Lease;
  private edgeState?: EdgeState;
  private sequence = 1;
  private connectOperation?: Promise<DirectTeleopState>;
  private motionQueue: Promise<void> = Promise.resolve();
  private mediaAccessToken?: string;
  private mediaAccessExpiresAtUnixMs = 0;

  constructor(options: DirectTeleopRuntimeOptions) {
    this.controlUrl = normalizedLoopbackUrl(options.controlUrl, "control");
    this.edgeUrl = normalizedLoopbackUrl(options.edgeUrl, "edge");
    this.mediaUrl = normalizedLoopbackUrl(options.mediaUrl, "media");
    this.controlToken = requiredSecret(options.controlToken, "control token");
    this.edgeToken = requiredSecret(options.edgeToken, "edge token");
    this.operatorId = requiredIdentity(options.operatorId, "operator ID");
    this.robotId = requiredIdentity(options.robotId, "robot ID");
    this.cameraId = requiredIdentity(options.cameraId ?? "b2w-sim-front", "camera ID");
    this.leaseDurationMs = options.leaseDurationMs ?? 300_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 2_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    if (!Number.isSafeInteger(this.leaseDurationMs) || this.leaseDurationMs < 5_000 || this.leaseDurationMs > 300_000) {
      throw new Error("Direct simulation lease duration must be between 5 and 300 seconds.");
    }
    if (!Number.isSafeInteger(this.requestTimeoutMs) || this.requestTimeoutMs < 100 || this.requestTimeoutMs > 10_000) {
      throw new Error("Direct simulation request timeout must be between 100 ms and 10 seconds.");
    }
  }

  connect(): Promise<DirectTeleopState> {
    if (this.session?.status === "ACTIVE" && this.lease && Date.now() < this.lease.expiresAtUnixMs) {
      return this.state();
    }
    if (this.connectOperation) return this.connectOperation;
    this.connectOperation = this.connectInternal().finally(() => {
      this.connectOperation = undefined;
    });
    return this.connectOperation;
  }

  async state(): Promise<DirectTeleopState> {
    if (this.session?.status === "ACTIVE") {
      try {
        this.edgeState = requireEdgeState(await this.edgeRequest("/edge/v1/state"));
      } catch {
        return this.snapshot(false);
      }
    }
    return this.snapshot(Boolean(this.session?.status === "ACTIVE" && this.edgeState));
  }

  command(input: { linear: number; yaw: number; speedScale: number; deadman: boolean }): Promise<DirectTeleopState> {
    return this.serializeMotion(async () => {
      validateCommandInput(input);
      if (!input.deadman) fail("DIRECT_TELEOP_DEADMAN_REQUIRED", "A held direct-control input is required.");
      await this.requireActiveSession();
      this.edgeState = await this.enableBaseSafety(5_000);
      const now = Date.now();
      const lease = this.lease!;
      this.edgeState = requireEdgeState(await this.edgeRequest("/edge/v1/commands", {
        command: {
          contractVersion: { major: 1, minor: 0 },
          commandId: randomUUID(),
          sessionId: lease.sessionId,
          robotId: lease.robotId,
          sourceId: lease.operatorId,
          actuatorGroup: "BASE",
          sequence: this.sequence++,
          producedAtUnixMs: now,
          expiresAtUnixMs: Math.min(now + 150, lease.expiresAtUnixMs),
          deadman: true,
          intent: {
            kind: "BASE_MOTION",
            frameId: "base_link",
            linearXMetersPerSecond: input.linear * 0.7,
            linearYMetersPerSecond: 0,
            angularZRadiansPerSecond: input.yaw * 0.7,
            speedScale: input.speedScale,
          },
        },
      }));
      return this.snapshot(true);
    });
  }

  hold(reason = "Direct-console deadman released."): Promise<DirectTeleopState> {
    return this.serializeMotion(async () => {
      if (!this.session || !this.lease) return this.snapshot(false);
      this.edgeState = requireEdgeState(await this.edgeRequest("/edge/v1/state"));
      if (this.edgeState.baseSafety.status === "ENABLED") {
        this.edgeState = requireEdgeState(await this.edgeRequest("/edge/v1/safety/hold", {
          expectedRevision: this.edgeState.baseSafety.revision,
          reason,
        }));
      }
      return this.snapshot(true);
    });
  }

  release(): Promise<DirectTeleopState> {
    return this.serializeMotion(async () => {
      if (!this.session || !this.lease) return this.snapshot(false);
      try {
        this.edgeState = await this.holdInternal("Direct simulator session released.");
        if (this.edgeState.ownership.status === "OWNED") {
          this.edgeState = requireEdgeState(await this.edgeRequest("/edge/v1/ownership/release", {
            expectedRevision: this.edgeState.ownership.revision,
            reason: "Direct simulator session released.",
          }));
        }
        if (this.edgeState.ownership.status !== "NO_OWNER") {
          this.edgeState = await this.waitForEdgeState((candidate) => candidate.ownership.status === "NO_OWNER", 5_000);
        }
        this.session = await this.releaseSession(this.session, 5_000);
      } finally {
        try {
          await this.edgeRequest(`/edge/v1/leases/${encodeURIComponent(this.lease.sessionId)}/revoke`, {
            reason: "Direct simulator session released.",
          });
        } finally {
          this.session = undefined;
          this.lease = undefined;
          this.edgeState = undefined;
          this.sequence = 1;
          this.mediaAccessToken = undefined;
          this.mediaAccessExpiresAtUnixMs = 0;
        }
      }
      return this.snapshot(false);
    });
  }

  async cameraFrame(): Promise<DirectCameraFrame> {
    await this.requireActiveSession();
    if (!this.mediaAccessToken || Date.now() >= this.mediaAccessExpiresAtUnixMs - 5_000) {
      const access = await this.request(this.mediaUrl, this.controlToken, `/media/v1/cameras/${encodeURIComponent(this.cameraId)}/access`, {
        sessionId: this.session!.sessionId,
        lifetimeMs: 30_000,
      });
      if (typeof access.accessToken !== "string" || access.accessToken.length < 1 || access.accessToken.length > 8_000
        || !Number.isSafeInteger(access.grant?.expiresAtUnixMs)) {
        fail("DIRECT_TELEOP_MEDIA_INVALID", "Media gateway returned an invalid camera grant.");
      }
      this.mediaAccessToken = access.accessToken;
      this.mediaAccessExpiresAtUnixMs = access.grant!.expiresAtUnixMs!;
    }
    const response = await this.fetchWithTimeout(
      `${this.mediaUrl}/media/v1/cameras/${encodeURIComponent(this.cameraId)}/live`,
      { headers: { authorization: `Bearer ${this.mediaAccessToken}` }, redirect: "error" },
      "media gateway",
    );
    if (!response.ok) await failFromResponse(response, "DIRECT_TELEOP_MEDIA_UNAVAILABLE");
    const mediaType = response.headers.get("content-type")?.split(";", 1)[0] ?? "";
    const cameraId = response.headers.get("x-brash-camera-id") ?? "";
    const sensorFrameId = response.headers.get("x-brash-sensor-frame-id") ?? "";
    const sequence = Number(response.headers.get("x-brash-frame-sequence"));
    const sourceTimestampUnixMs = Number(response.headers.get("x-brash-source-timestamp-unix-ms"));
    if (!["image/jpeg", "image/png", "image/webp", "image/avif"].includes(mediaType)
      || cameraId !== this.cameraId || !sensorFrameId || !Number.isSafeInteger(sequence) || sequence < 1
      || !Number.isSafeInteger(sourceTimestampUnixMs) || sourceTimestampUnixMs > Date.now() + 1_000) {
      fail("DIRECT_TELEOP_MEDIA_INVALID", "Live camera response has invalid provenance.");
    }
    const advertised = Number(response.headers.get("content-length"));
    if (Number.isFinite(advertised) && advertised > 8 * 1024 * 1024) {
      fail("DIRECT_TELEOP_MEDIA_TOO_LARGE", "Live camera frame exceeds 8 MiB.");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength < 1 || bytes.byteLength > 8 * 1024 * 1024) {
      fail("DIRECT_TELEOP_MEDIA_TOO_LARGE", "Live camera frame has an invalid size.");
    }
    return { bytes, mediaType, cameraId, sensorFrameId, sequence, sourceTimestampUnixMs };
  }

  private async connectInternal(): Promise<DirectTeleopState> {
    await this.cleanupAbandonedDirectSessions();
    const sessionId = `b2w-direct-console-${randomUUID()}`;
    this.session = requireSession(await this.controlRequest("/control/v1/sessions", {
      sessionId,
      robotId: this.robotId,
      operatorId: this.operatorId,
      scopes: ["OBSERVE", "CONTROL_BASE"],
    }));
    const granted = await this.controlRequest(`/control/v1/sessions/${sessionId}/grant`, {
      expectedRevision: this.session.revision,
      leaseDurationMs: this.leaseDurationMs,
    });
    this.session = requireSession(granted);
    this.lease = this.session.lease;
    if (!this.lease) fail("DIRECT_TELEOP_LEASE_INVALID", "Control plane did not return a simulator lease.");
    if (granted.signedLease) await this.edgeRequest("/edge/v1/signed-leases", { signedLease: granted.signedLease });
    else await this.edgeRequest("/edge/v1/leases", { lease: this.lease });
    this.session = requireSession(await this.controlRequest(`/control/v1/sessions/${sessionId}/connecting`, {
      expectedRevision: this.session.revision,
    }));
    this.edgeState = requireEdgeState(await this.edgeRequest("/edge/v1/ownership/request", {
      sessionId,
      actuatorGroup: "BASE",
    }));
    this.edgeState = await this.waitForEdgeState((candidate) => candidate.ownership.status === "OWNED", 10_000);
    this.session = await this.activateSession(this.session, 5_000);
    this.edgeState = await this.enableBaseSafety(5_000);
    this.sequence = 1;
    return this.snapshot(true);
  }

  private async cleanupAbandonedDirectSessions(): Promise<void> {
    const response = await this.controlRequest("/control/v1/sessions");
    const sessions = response.sessions ?? [];
    const terminal = new Set(["RELEASED", "REVOKED", "EXPIRED", "FAULTED"]);
    for (const candidate of sessions) {
      if (!candidate.sessionId.startsWith("b2w-direct-console-") || terminal.has(candidate.status)
        || candidate.robotId !== this.robotId || candidate.operatorId !== this.operatorId) continue;
      try {
        await this.edgeRequest(`/edge/v1/leases/${encodeURIComponent(candidate.sessionId)}/revoke`, {
          reason: "Superseded by a new local direct-console session.",
        });
      } catch {
        // The edge deliberately forgets leases on restart.
      }
      await this.controlRequest(`/control/v1/sessions/${encodeURIComponent(candidate.sessionId)}/revoke`, {
        expectedRevision: candidate.revision,
        reason: "Superseded by a new local direct-console session.",
      });
    }
  }

  private async requireActiveSession(): Promise<void> {
    if (!this.session || this.session.status !== "ACTIVE" || !this.lease) {
      fail("DIRECT_TELEOP_NOT_CONNECTED", "The direct B2W simulator session is not active.");
    }
    if (Date.now() >= this.lease.expiresAtUnixMs) {
      fail("DIRECT_TELEOP_LEASE_EXPIRED", "The direct B2W simulator lease expired; reconnect.");
    }
  }

  private async activateSession(current: Session, timeoutMs: number): Promise<Session> {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        return requireSession(await this.controlRequest(`/control/v1/sessions/${current.sessionId}/activate`, {
          expectedRevision: current.revision,
        }));
      } catch (error) {
        lastError = error;
        await delay(100);
      }
    }
    throw lastError ?? new Error("Timed out waiting for robot readiness.");
  }

  private async enableBaseSafety(timeoutMs: number): Promise<EdgeState> {
    const deadline = Date.now() + timeoutMs;
    let latest: EdgeState | undefined;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        latest = requireEdgeState(await this.edgeRequest("/edge/v1/state"));
        if (latest.ownership.status !== "OWNED") fail("DIRECT_TELEOP_OWNERSHIP_LOST", `Robot ownership is ${latest.ownership.status}.`);
        if (latest.baseSafety.status !== "READY" && latest.baseSafety.status !== "ENABLED") {
          latest = requireEdgeState(await this.edgeRequest("/edge/v1/safety/prepare", {
            expectedRevision: latest.baseSafety.revision,
          }));
        }
        if (latest.baseSafety.status === "READY") {
          latest = requireEdgeState(await this.edgeRequest("/edge/v1/safety/enable", {
            expectedRevision: latest.baseSafety.revision,
          }));
        }
        if (latest.baseSafety.status === "ENABLED") return latest;
      } catch (error) {
        lastError = error;
      }
      await delay(100);
    }
    throw lastError ?? new Error("Timed out waiting for simulator safety.");
  }

  private async holdInternal(reason: string): Promise<EdgeState> {
    let latest = requireEdgeState(await this.edgeRequest("/edge/v1/state"));
    if (latest.baseSafety.status === "ENABLED") {
      latest = requireEdgeState(await this.edgeRequest("/edge/v1/safety/hold", {
        expectedRevision: latest.baseSafety.revision,
        reason,
      }));
    }
    return latest;
  }

  private async releaseSession(current: Session, timeoutMs: number): Promise<Session> {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        return requireSession(await this.controlRequest(`/control/v1/sessions/${current.sessionId}/release`, {
          expectedRevision: current.revision,
          reason: "Direct console received stopped robot evidence.",
        }));
      } catch (error) {
        lastError = error;
        await delay(100);
      }
    }
    throw lastError ?? new Error("Timed out releasing the simulator session.");
  }

  private async waitForEdgeState(predicate: (state: EdgeState) => boolean, timeoutMs: number): Promise<EdgeState> {
    const deadline = Date.now() + timeoutMs;
    let latest: EdgeState | undefined;
    while (Date.now() < deadline) {
      latest = requireEdgeState(await this.edgeRequest("/edge/v1/state"));
      if (predicate(latest)) return latest;
      await delay(100);
    }
    fail("DIRECT_TELEOP_EDGE_TIMEOUT", `Timed out waiting for robot edge; ownership is ${latest?.ownership.status ?? "unknown"}.`);
  }

  private controlRequest(path: string, body?: unknown): Promise<ApiResponse> {
    return this.request(this.controlUrl, this.controlToken, path, body);
  }

  private edgeRequest(path: string, body?: unknown): Promise<ApiResponse> {
    return this.request(this.edgeUrl, this.edgeToken, path, body);
  }

  private async request(baseUrl: string, token: string, path: string, body?: unknown): Promise<ApiResponse> {
    const response = await this.fetchWithTimeout(`${baseUrl}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
    }, baseUrl);
    const advertised = Number(response.headers.get("content-length"));
    if (Number.isFinite(advertised) && advertised > 256 * 1024) fail("DIRECT_TELEOP_RESPONSE_TOO_LARGE", "Simulator service response is oversized.");
    const text = await response.text();
    if (Buffer.byteLength(text) > 256 * 1024) fail("DIRECT_TELEOP_RESPONSE_TOO_LARGE", "Simulator service response is oversized.");
    let decoded: ApiResponse;
    try {
      decoded = JSON.parse(text) as ApiResponse;
    } catch {
      fail("DIRECT_TELEOP_RESPONSE_INVALID", "Simulator service returned invalid JSON.");
    }
    if (!response.ok) fail(decoded.code ?? "DIRECT_TELEOP_UPSTREAM_ERROR", decoded.message ?? `Simulator service returned HTTP ${response.status}.`);
    return decoded;
  }

  private async fetchWithTimeout(url: string, init: RequestInit, label: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } catch (error) {
      fail("DIRECT_TELEOP_UNAVAILABLE", `${label} is unavailable: ${error instanceof Error ? error.message : "request failed"}.`);
    } finally {
      clearTimeout(timer);
    }
  }

  private snapshot(connected: boolean): DirectTeleopState {
    const output = this.edgeState?.baseSafety.output;
    return {
      connected,
      robotId: this.robotId,
      ...(this.session ? { sessionId: this.session.sessionId, sessionStatus: this.session.status } : {}),
      ...(this.lease ? { leaseExpiresAtUnixMs: this.lease.expiresAtUnixMs } : {}),
      ownership: this.edgeState?.ownership.status ?? "NO_OWNER",
      safety: this.edgeState?.baseSafety.status ?? "DISCONNECTED",
      ...(this.edgeState?.baseSafety.reason ? { safetyReason: this.edgeState.baseSafety.reason } : {}),
      acceptedLinearXMetersPerSecond: output?.linearXMetersPerSecond ?? 0,
      acceptedAngularZRadiansPerSecond: output?.angularZRadiansPerSecond ?? 0,
    };
  }

  private serializeMotion<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.motionQueue.then(operation, operation);
    this.motionQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}

function validateCommandInput(input: { linear: number; yaw: number; speedScale: number; deadman: boolean }): void {
  if (!Number.isFinite(input.linear) || input.linear < -1 || input.linear > 1
    || !Number.isFinite(input.yaw) || input.yaw < -1 || input.yaw > 1
    || !Number.isFinite(input.speedScale) || input.speedScale < 0.1 || input.speedScale > 1
    || typeof input.deadman !== "boolean") {
    fail("DIRECT_TELEOP_COMMAND_INVALID", "Direct command values are outside their normalized bounds.");
  }
  if (Math.abs(input.linear) > 0 && Math.abs(input.yaw) > 0) {
    const magnitude = Math.hypot(input.linear, input.yaw);
    if (magnitude > Math.SQRT2 + Number.EPSILON) fail("DIRECT_TELEOP_COMMAND_INVALID", "Direct command magnitude is invalid.");
  }
}

function requireSession(response: ApiResponse): Session {
  if (!response.session) fail("DIRECT_TELEOP_RESPONSE_INVALID", "Control response did not include a session.");
  return response.session;
}

function requireEdgeState(response: ApiResponse): EdgeState {
  if (!response.state) fail("DIRECT_TELEOP_RESPONSE_INVALID", "Edge response did not include state.");
  return response.state;
}

async function failFromResponse(response: Response, fallbackCode: string): Promise<never> {
  let body: ApiResponse = {};
  try {
    const text = await response.text();
    if (Buffer.byteLength(text) <= 64 * 1024) body = JSON.parse(text) as ApiResponse;
  } catch {
    // Use the bounded fallback below.
  }
  fail(body.code ?? fallbackCode, body.message ?? `Media gateway returned HTTP ${response.status}.`);
}

function normalizedLoopbackUrl(value: string, label: string): string {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(hostname)
    || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error(`Direct simulator ${label} URL must be an exact HTTP loopback origin.`);
  }
  return url.origin;
}

function requiredSecret(value: string, label: string): string {
  if (value.trim().length < 16) throw new Error(`Direct simulator ${label} must contain at least 16 characters.`);
  return value.trim();
}

function requiredIdentity(value: string, label: string): string {
  if (!value.trim()) throw new Error(`Direct simulator ${label} is required.`);
  return value.trim();
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
