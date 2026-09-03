import {
  TeleoperationError,
  assertRobotSessionReadinessReport,
  clone,
  decodeRobotSessionReadinessReport,
  fail,
  type RobotSessionReadinessReport,
} from "../../../packages/contracts/src/index.ts";

export interface RobotReadinessPublisher {
  publish(report: RobotSessionReadinessReport): Promise<void>;
}

export interface HttpRobotReadinessPublisherOptions {
  controlPlaneUrl: string;
  bearerToken: string;
  requestTimeoutMs?: number;
  maximumResponseBytes?: number;
  fetchImplementation?: typeof fetch;
}

export class HttpRobotReadinessPublisher implements RobotReadinessPublisher {
  private readonly controlPlaneUrl: URL;
  private readonly bearerToken: string;
  private readonly requestTimeoutMs: number;
  private readonly maximumResponseBytes: number;
  private readonly fetchImplementation: typeof fetch;

  constructor(options: HttpRobotReadinessPublisherOptions) {
    this.controlPlaneUrl = validatedBaseUrl(options.controlPlaneUrl);
    this.bearerToken = boundedText(options.bearerToken, "bearerToken", 4_096);
    if (this.bearerToken !== options.bearerToken) throw new Error("Robot control-plane bearer token cannot contain surrounding whitespace.");
    this.requestTimeoutMs = options.requestTimeoutMs ?? 2_000;
    this.maximumResponseBytes = options.maximumResponseBytes ?? 32 * 1_024;
    if (!Number.isSafeInteger(this.requestTimeoutMs) || this.requestTimeoutMs < 25 || this.requestTimeoutMs > 30_000) {
      throw new Error("Robot readiness request timeout must be between 25 and 30000 milliseconds.");
    }
    if (!Number.isSafeInteger(this.maximumResponseBytes) || this.maximumResponseBytes < 256 || this.maximumResponseBytes > 256 * 1_024) {
      throw new Error("Robot readiness response bound must be between 256 and 262144 bytes.");
    }
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  async publish(untrustedReport: RobotSessionReadinessReport): Promise<void> {
    const report = decodeRobotSessionReadinessReport(untrustedReport);
    assertRobotSessionReadinessReport(report);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    let response: Response;
    try {
      response = await this.fetchImplementation(
        new URL(`control/v1/sessions/${encodeURIComponent(report.sessionId)}/robot-readiness`, this.controlPlaneUrl),
        {
          method: "POST",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${this.bearerToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ report }),
          redirect: "error",
          signal: controller.signal,
        },
      );
    } catch (error) {
      clearTimeout(timeout);
      if (controller.signal.aborted) fail("ROBOT_READINESS_PUBLISH_TIMEOUT", "Control plane did not accept readiness before the request timeout.");
      fail("ROBOT_READINESS_PUBLISH_UNAVAILABLE", "Control-plane readiness endpoint is unavailable.", {
        cause: error instanceof Error ? error.name : "unknown",
      });
    }
    let bytes: Buffer;
    try {
      bytes = await readBounded(response, this.maximumResponseBytes);
    } catch (error) {
      if (controller.signal.aborted) fail("ROBOT_READINESS_PUBLISH_TIMEOUT", "Control plane did not complete the readiness response before timeout.");
      if (error instanceof TeleoperationError) throw error;
      fail("ROBOT_READINESS_PUBLISH_UNAVAILABLE", "Control-plane readiness response could not be read.");
    } finally {
      clearTimeout(timeout);
    }
    if (response.status === 401 || response.status === 403) {
      fail("ROBOT_READINESS_PUBLISH_AUTHENTICATION_FAILED", "Control plane rejected the robot service identity.", { status: response.status });
    }
    if (!response.ok) {
      fail("ROBOT_READINESS_PUBLISH_REJECTED", "Control plane rejected the robot readiness report.", { status: response.status });
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") {
      fail("ROBOT_READINESS_PUBLISH_RESPONSE_INVALID", "Control-plane readiness response must use application/json.");
    }
    let body: unknown;
    try {
      body = JSON.parse(bytes.toString("utf8"));
    } catch {
      fail("ROBOT_READINESS_PUBLISH_RESPONSE_INVALID", "Control-plane readiness response is not valid JSON.");
    }
    const readiness = requiredRecord(requiredRecord(body).readiness);
    const echoed = decodeRobotSessionReadinessReport(readiness.report);
    if (echoed.readinessId !== report.readinessId || echoed.sessionId !== report.sessionId
      || echoed.robotId !== report.robotId || echoed.leaseRevision !== report.leaseRevision
      || echoed.ownershipRevision !== report.ownershipRevision || echoed.ownershipStatus !== report.ownershipStatus) {
      fail("ROBOT_READINESS_PUBLISH_RESPONSE_INVALID", "Control plane acknowledged different readiness provenance.");
    }
  }
}

export interface RobotReadinessReporterOptions {
  publisher: RobotReadinessPublisher;
  now?: () => number;
  maximumQueuedSessions?: number;
  maximumReportAgeMs?: number;
  initialRetryDelayMs?: number;
  maximumRetryDelayMs?: number;
  automaticDelivery?: boolean;
}

export interface RobotReadinessReporterSnapshot {
  queuedSessions: number;
  deliveredReports: number;
  failedAttempts: number;
  droppedStaleReports: number;
  closed: boolean;
}

interface PendingReport {
  report: RobotSessionReadinessReport;
  attempts: number;
  nextAttemptAtUnixMs: number;
}

/**
 * Latest-state, bounded retry queue. Reporting can never block or roll back a
 * robot-local ownership/safety transition; stale state is dropped, not sent.
 */
export class RobotReadinessReporter {
  private readonly publisher: RobotReadinessPublisher;
  private readonly now: () => number;
  private readonly maximumQueuedSessions: number;
  private readonly maximumReportAgeMs: number;
  private readonly initialRetryDelayMs: number;
  private readonly maximumRetryDelayMs: number;
  private readonly automaticDelivery: boolean;
  private readonly pending = new Map<string, PendingReport>();
  private timer?: NodeJS.Timeout;
  private draining?: Promise<void>;
  private deliveredReports = 0;
  private failedAttempts = 0;
  private droppedStaleReports = 0;
  private closed = false;

  constructor(options: RobotReadinessReporterOptions) {
    this.publisher = options.publisher;
    this.now = options.now ?? Date.now;
    this.maximumQueuedSessions = options.maximumQueuedSessions ?? 32;
    this.maximumReportAgeMs = options.maximumReportAgeMs ?? 1_500;
    this.initialRetryDelayMs = options.initialRetryDelayMs ?? 100;
    this.maximumRetryDelayMs = options.maximumRetryDelayMs ?? 1_000;
    for (const [field, value] of Object.entries({
      maximumQueuedSessions: this.maximumQueuedSessions,
      maximumReportAgeMs: this.maximumReportAgeMs,
      initialRetryDelayMs: this.initialRetryDelayMs,
      maximumRetryDelayMs: this.maximumRetryDelayMs,
    })) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} must be a positive safe integer.`);
    }
    if (this.maximumRetryDelayMs < this.initialRetryDelayMs || this.maximumReportAgeMs <= this.initialRetryDelayMs) {
      throw new Error("Robot readiness retry and freshness bounds are inconsistent.");
    }
    this.automaticDelivery = options.automaticDelivery ?? true;
  }

  enqueue(untrustedReport: RobotSessionReadinessReport): RobotReadinessReporterSnapshot {
    if (this.closed) fail("ROBOT_READINESS_REPORTER_CLOSED", "Robot readiness reporter is closed.");
    const report = decodeRobotSessionReadinessReport(untrustedReport);
    assertRobotSessionReadinessReport(report);
    const now = this.checkedNow();
    if (report.reportedAtUnixMs > now + 500) fail("ROBOT_READINESS_FROM_FUTURE", "Queued readiness is too far in the future.");
    if (now - report.reportedAtUnixMs > this.maximumReportAgeMs) fail("ROBOT_READINESS_STALE", "Cannot queue stale robot readiness.");
    if (!this.pending.has(report.sessionId) && this.pending.size >= this.maximumQueuedSessions) {
      fail("ROBOT_READINESS_QUEUE_FULL", "Robot readiness queue is full.");
    }
    const existing = this.pending.get(report.sessionId);
    if (existing && report.ownershipRevision < existing.report.ownershipRevision) {
      fail("ROBOT_READINESS_REVISION_STALE", "Queued readiness ownership revision moved backwards.");
    }
    if (existing && report.ownershipRevision === existing.report.ownershipRevision
      && (report.leaseRevision !== existing.report.leaseRevision
        || report.ownershipStatus !== existing.report.ownershipStatus
        || report.actuatorGroup !== existing.report.actuatorGroup)) {
      fail("ROBOT_READINESS_REVISION_COLLISION", "One ownership revision cannot identify different queued readiness state.");
    }
    this.pending.set(report.sessionId, {
      report: clone(report),
      attempts: 0,
      nextAttemptAtUnixMs: now,
    });
    if (this.automaticDelivery) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
      this.schedule(0);
    }
    return this.snapshot();
  }

  async flushNow(): Promise<RobotReadinessReporterSnapshot> {
    if (this.closed) return this.snapshot();
    if (this.draining) {
      await this.draining;
      return this.snapshot();
    }
    this.draining = this.drain();
    try {
      await this.draining;
    } finally {
      this.draining = undefined;
    }
    return this.snapshot();
  }

  close(): RobotReadinessReporterSnapshot {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending.clear();
    return this.snapshot();
  }

  snapshot(): RobotReadinessReporterSnapshot {
    return {
      queuedSessions: this.pending.size,
      deliveredReports: this.deliveredReports,
      failedAttempts: this.failedAttempts,
      droppedStaleReports: this.droppedStaleReports,
      closed: this.closed,
    };
  }

  private async drain(): Promise<void> {
    const now = this.checkedNow();
    let nextAttemptAt: number | undefined;
    for (const [sessionId, pending] of [...this.pending]) {
      const current = this.pending.get(sessionId);
      if (current !== pending) continue;
      if (now - pending.report.reportedAtUnixMs > this.maximumReportAgeMs) {
        this.pending.delete(sessionId);
        this.droppedStaleReports += 1;
        continue;
      }
      if (pending.nextAttemptAtUnixMs > now) {
        nextAttemptAt = Math.min(nextAttemptAt ?? pending.nextAttemptAtUnixMs, pending.nextAttemptAtUnixMs);
        continue;
      }
      try {
        await this.publisher.publish(pending.report);
        if (this.pending.get(sessionId) === pending) this.pending.delete(sessionId);
        this.deliveredReports += 1;
      } catch {
        this.failedAttempts += 1;
        if (this.pending.get(sessionId) !== pending) continue;
        const attempts = pending.attempts + 1;
        const delay = Math.min(this.maximumRetryDelayMs, this.initialRetryDelayMs * 2 ** Math.min(attempts - 1, 10));
        const retryAt = this.checkedNow() + delay;
        this.pending.set(sessionId, { ...pending, attempts, nextAttemptAtUnixMs: retryAt });
        nextAttemptAt = Math.min(nextAttemptAt ?? retryAt, retryAt);
      }
    }
    if (this.automaticDelivery && nextAttemptAt !== undefined && !this.closed) {
      this.schedule(Math.max(0, nextAttemptAt - this.checkedNow()));
    }
  }

  private schedule(delayMs: number): void {
    if (this.closed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flushNow().catch(() => undefined);
    }, delayMs);
    this.timer.unref();
  }

  private checkedNow(): number {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("Robot readiness reporter clock must return non-negative Unix milliseconds.");
    return now;
  }
}

async function readBounded(response: Response, maximumBytes: number): Promise<Buffer> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > maximumBytes) {
    await response.body?.cancel();
    fail("ROBOT_READINESS_PUBLISH_RESPONSE_TOO_LARGE", `Control-plane response exceeds ${maximumBytes} bytes.`);
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        fail("ROBOT_READINESS_PUBLISH_RESPONSE_TOO_LARGE", `Control-plane response exceeds ${maximumBytes} bytes.`);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function validatedBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Control-plane URL is invalid.");
  }
  if (url.username || url.password || url.search || url.hash) throw new Error("Control-plane URL cannot contain credentials, query, or fragment.");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const loopback = host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Control-plane URL must use HTTPS except on loopback.");
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

function boundedText(value: string, field: string, maximumLength: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required.`);
  if (value.length > maximumLength) throw new Error(`${field} exceeds ${maximumLength} characters.`);
  return value;
}

function requiredRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("ROBOT_READINESS_PUBLISH_RESPONSE_INVALID", "Control-plane readiness response must be an object.");
  }
  return value as Record<string, unknown>;
}
