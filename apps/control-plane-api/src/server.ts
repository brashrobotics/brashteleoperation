import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import {
  decodeAssistanceRequest,
  decodeGroundedObject,
  decodeManipulationApproval,
  decodeManipulationOutcome,
  decodeManipulationPlanPreview,
  decodeObjectDeclaration,
  decodeRealtimeSignalingMessage,
  fail,
  type SessionScope,
  type LeaseSignatureSigner,
  type SignedTeleopSessionLease,
} from "../../../packages/contracts/src/index.ts";
import {
  listenHttp,
  optionalString,
  readJsonObject,
  requiredBoolean,
  requiredInteger,
  requiredNumber,
  requiredString,
  requiredStringArray,
  requiredObject,
  requireBearer,
  sendError,
  sendJson,
  sendText,
  type RunningHttpServer,
} from "../../../packages/http-runtime/src/index.ts";
import {
  InMemoryRobotReadiness,
  InMemorySessionControl,
  type SessionSnapshot,
} from "../../../services/session-control/src/index.ts";
import { InMemoryRealtimeSignaling } from "../../../services/realtime-signaling/src/index.ts";
import { InMemoryAssistanceOrchestrator } from "../../../services/assistance-orchestrator/src/index.ts";
import { MetricRegistry } from "../../../packages/observability/src/index.ts";
import {
  InMemoryObjectRegistry,
  type CreateCandidateInput,
  type EvidenceArtifactReference,
} from "../../../services/object-registry/src/index.ts";
import type { ManipulationIntent } from "../../../packages/contracts/src/index.ts";
import {
  DEVELOPMENT_ADMIN_PRINCIPAL,
  requireActorBinding,
  requirePermission,
  requireRobotBinding,
  requireSignalingExchangeBinding,
  requireSignalingPeerBinding,
  type OperatorPrincipal,
  type RequestIdentityProvider,
} from "../../../packages/identity/src/index.ts";

const allowedScopes = new Set<SessionScope>([
  "OBSERVE",
  "DECLARE_OBJECT",
  "APPROVE_PLAN",
  "CONTROL_BASE",
  "CONTROL_MANIPULATOR",
  "SUPERVISE",
]);

export interface ControlPlaneApiOptions {
  bearerToken?: string;
  identityProvider?: RequestIdentityProvider;
  host?: string;
  port?: number;
  sessions?: InMemorySessionControl;
  assistance?: InMemoryAssistanceOrchestrator;
  persistenceLabel?: string;
  afterMutation?: () => void | Promise<void>;
  authorizeCommandLease?: (session: SessionSnapshot) => void | Promise<void>;
  releaseCommandReservation?: (session: SessionSnapshot) => boolean | void | Promise<boolean | void>;
  allowUncoordinatedCommandLeases?: boolean;
  metrics?: MetricRegistry;
  registry?: InMemoryObjectRegistry;
  signaling?: InMemoryRealtimeSignaling;
  robotReadiness?: InMemoryRobotReadiness;
  leaseSigner?: LeaseSignatureSigner;
  reconciliationIntervalMs?: number;
  principal?: OperatorPrincipal;
  operatorConnectOrigins?: readonly string[];
}

export interface RunningControlPlaneApi extends RunningHttpServer {
  sessions: InMemorySessionControl;
  assistance: InMemoryAssistanceOrchestrator;
  metrics: MetricRegistry;
  registry: InMemoryObjectRegistry;
  signaling: InMemoryRealtimeSignaling;
  robotReadiness: InMemoryRobotReadiness;
}

export async function startControlPlaneApi(options: ControlPlaneApiOptions): Promise<RunningControlPlaneApi> {
  const host = options.host ?? "127.0.0.1";
  if (!isLoopback(host)) throw new Error("The initial control-plane API is restricted to loopback.");
  if (options.identityProvider && (options.bearerToken !== undefined || options.principal !== undefined)) {
    throw new Error("Configure either identityProvider or a fixed bearerToken/principal, not both.");
  }
  if (!options.identityProvider && (!options.bearerToken || options.bearerToken.length < 16)) {
    throw new Error("Control-plane bearer token must contain at least 16 characters.");
  }
  const sessions = options.sessions ?? new InMemorySessionControl();
  const assistance = options.assistance ?? new InMemoryAssistanceOrchestrator();
  const metrics = options.metrics ?? new MetricRegistry();
  const registry = options.registry ?? new InMemoryObjectRegistry();
  const signaling = options.signaling ?? new InMemoryRealtimeSignaling();
  const robotReadiness = options.robotReadiness ?? new InMemoryRobotReadiness();
  const fixedPrincipal = options.principal ?? DEVELOPMENT_ADMIN_PRINCIPAL;
  const enforceActorBinding = options.identityProvider !== undefined || options.principal !== undefined;
  const reconciliationIntervalMs = options.reconciliationIntervalMs ?? 250;
  if (!Number.isSafeInteger(reconciliationIntervalMs) || reconciliationIntervalMs < 25) {
    throw new Error("Control-plane reconciliation interval must be at least 25 ms.");
  }
  const operatorConnectOrigins = (options.operatorConnectOrigins ?? []).map(validateOperatorConnectOrigin);
  const fleetReleaseRetryAt = new Map<string, number>();
  const fleetReleaseAttempts = new Map<string, number>();

  const server = createServer(async (request, response) => {
    const startedAt = performance.now();
    const route = normalizedControlRoute(request.url ?? "/");
    let authenticated = false;
    response.once("finish", () => {
      metrics.increment(
        "brash_teleoperation_http_requests_total",
        "Completed control-plane HTTP requests.",
        { method: request.method ?? "UNKNOWN", route, status: String(response.statusCode) },
      );
      metrics.setGauge(
        "brash_teleoperation_http_last_duration_seconds",
        "Duration of the latest control-plane HTTP request.",
        { method: request.method ?? "UNKNOWN", route },
        (performance.now() - startedAt) / 1_000,
      );
    });
    try {
      const url = new URL(request.url ?? "/", "http://control-plane.local");
      if (request.method === "GET" && url.pathname === "/health") {
        return sendJson(response, 200, {
          ok: true,
          service: "brash-teleoperation-control-plane",
          persistence: options.persistenceLabel ?? "memory",
        });
      }
      if (request.method === "GET" && (url.pathname === "/operator" || url.pathname.startsWith("/operator/"))) {
        return await sendOperatorAsset(url.pathname, response, operatorConnectOrigins);
      }
      const requestPrincipal = options.identityProvider
        ? options.identityProvider.authenticateBearer(request.headers.authorization)
        : (requireBearer(request, options.bearerToken!), fixedPrincipal);
      authenticated = true;
      if (request.method === "GET" && url.pathname === "/metrics") {
        requirePermission(requestPrincipal, "observability:read");
        metrics.setGauge("brash_teleoperation_sessions", "Sessions by status.", { status: "active" }, sessions.listSessions().filter((item) => item.status === "ACTIVE").length);
        metrics.setGauge("brash_teleoperation_assistance_requests", "Assistance requests by terminal class.", { terminal: "false" }, assistance.listRequests().filter((item) => !["RESOLVED", "CANCELLED", "EXPIRED", "FAILED", "DIRECT_TELEOP_REQUIRED"].includes(item.status)).length);
        return sendText(response, 200, metrics.renderPrometheus(), "text/plain; version=0.0.4; charset=utf-8");
      }
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts[0] === "control" && parts[1] === "v1" && parts[2] === "sessions") {
        return await handleSessions(
          request.method ?? "GET",
          parts.slice(3),
          request,
          response,
          sessions,
          robotReadiness,
          options.leaseSigner,
          options.afterMutation,
          options.authorizeCommandLease,
          options.releaseCommandReservation,
          options.allowUncoordinatedCommandLeases ?? false,
          requestPrincipal,
          enforceActorBinding,
        );
      }
      if (parts[0] === "assistance" && parts[1] === "v1" && parts[2] === "requests") {
        return await handleAssistance(request.method ?? "GET", parts.slice(3), request, response, assistance, options.afterMutation, requestPrincipal, enforceActorBinding);
      }
      if (parts[0] === "registry" && parts[1] === "v1" && parts[2] === "versions") {
        return await handleRegistry(request.method ?? "GET", parts.slice(3), url.searchParams, request, response, registry, options.afterMutation, requestPrincipal, enforceActorBinding);
      }
      if (parts[0] === "signaling" && parts[1] === "v1" && parts[2] === "exchanges") {
        return await handleSignaling(request.method ?? "GET", parts.slice(3), request, response, signaling, sessions, options.afterMutation, requestPrincipal);
      }
      fail("HTTP_ROUTE_NOT_FOUND", `${request.method} ${url.pathname} was not found.`);
    } catch (error) {
      if (authenticated && options.afterMutation) {
        try {
          // Some expiry checks intentionally record a terminal event before
          // returning their typed error. Preserve that conservative state.
          await options.afterMutation();
        } catch (persistenceError) {
          metrics.increment("brash_teleoperation_persistence_errors_total", "Control-plane persistence failures.");
          sendError(response, persistenceError);
          return;
        }
      }
      sendError(response, error);
    }
  });
  let reconciling = false;
  const reconciliation = setInterval(async () => {
    if (reconciling) return;
    reconciling = true;
    try {
      const changes = sessions.expireDue().length + assistance.expireDue().length + signaling.expireDue().length;
      if (changes > 0) await options.afterMutation?.();
      if (options.releaseCommandReservation) {
        const now = Date.now();
        for (const session of sessions.listSessions()) {
          if (session.status !== "RELEASED" || !hasCommandScope(session)
            || (fleetReleaseRetryAt.get(session.sessionId) ?? 0) > now) continue;
          try {
            const changed = await options.releaseCommandReservation(session);
            fleetReleaseRetryAt.delete(session.sessionId);
            fleetReleaseAttempts.delete(session.sessionId);
            if (changed) await options.afterMutation?.();
          } catch {
            // A release attempt can durably enter RELEASING before the Fleet
            // acknowledgement fails. Persist that conservative intermediate
            // state before scheduling another delivery.
            try {
              await options.afterMutation?.();
            } catch {
              metrics.increment("brash_teleoperation_persistence_errors_total", "Control-plane persistence failures.");
            }
            const attempts = (fleetReleaseAttempts.get(session.sessionId) ?? 0) + 1;
            fleetReleaseAttempts.set(session.sessionId, attempts);
            fleetReleaseRetryAt.set(session.sessionId, now + Math.min(30_000, 1_000 * 2 ** Math.min(attempts - 1, 5)));
            metrics.increment("brash_teleoperation_fleet_release_errors_total", "Fleet reservation release reconciliation failures.");
          }
        }
      }
    } catch {
      metrics.increment("brash_teleoperation_reconciliation_errors_total", "Control-plane reconciliation failures.");
    } finally {
      reconciling = false;
    }
  }, reconciliationIntervalMs);
  reconciliation.unref();
  let running: RunningHttpServer;
  try {
    running = await listenHttp(server, host, options.port ?? 0);
  } catch (error) {
    clearInterval(reconciliation);
    throw error;
  }
  return {
    ...running,
    sessions,
    assistance,
    metrics,
    registry,
    signaling,
    robotReadiness,
    close: async () => {
      clearInterval(reconciliation);
      await running.close();
    },
  };
}

async function handleSignaling(
  method: string,
  parts: string[],
  request: Parameters<typeof readJsonObject>[0],
  response: Parameters<typeof sendJson>[0],
  signaling: InMemoryRealtimeSignaling,
  sessions: InMemorySessionControl,
  afterMutation: (() => void | Promise<void>) | undefined,
  principal: OperatorPrincipal,
): Promise<void> {
  if (method === "POST" && parts.length === 0) {
    requirePermission(principal, "signaling:create");
    const body = await readJsonObject(request);
    const session = sessions.getSession(requiredString(body.sessionId, "sessionId"));
    requireActorBinding(principal, session.operatorId);
    requireSignalingSession(session);
    return sendMutation(response, 201, {
      exchange: signaling.createExchange({
        signalingId: optionalString(body.signalingId, "signalingId"),
        sessionId: session.sessionId,
        robotId: session.robotId,
        operatorId: session.operatorId,
        leaseExpiresAtUnixMs: session.lease!.expiresAtUnixMs,
      }),
    }, afterMutation);
  }
  const signalingId = parts[0];
  if (!signalingId) fail("HTTP_ROUTE_NOT_FOUND", "Signaling route was not found.");
  const exchange = signaling.getExchange(signalingId);
  if (method === "GET" && parts.length === 1) {
    requirePermission(principal, "signaling:read");
    requireSignalingExchangeBinding(principal, exchange);
    return sendJson(response, 200, { exchange });
  }
  if (method === "GET" && parts.length === 2 && parts[1] === "events") {
    requirePermission(principal, "signaling:read");
    requireSignalingExchangeBinding(principal, exchange);
    return sendJson(response, 200, { events: signaling.getEvents(signalingId) });
  }
  if (method !== "POST" || parts.length !== 2 || parts[1] !== "messages") {
    fail("HTTP_ROUTE_NOT_FOUND", "Signaling message route was not found.");
  }
  requirePermission(principal, "signaling:write");
  const body = await readJsonObject(request);
  const message = decodeRealtimeSignalingMessage(body.message);
  requireSignalingPeerBinding(principal, message.from, exchange);
  const session = sessions.getSession(exchange.sessionId);
  if (message.payload.kind !== "CLOSE") requireSignalingSession(session);
  return sendMutation(response, 200, {
    exchange: signaling.submitMessage(
      signalingId,
      requiredInteger(body.expectedRevision, "expectedRevision", 1),
      message,
    ),
  }, afterMutation);
}

function requireSignalingSession(session: SessionSnapshot): void {
  if (!session.lease || !["GRANTED", "CONNECTING", "ACTIVE", "HOLDING"].includes(session.status)) {
    fail("SIGNALING_SESSION_INVALID", `Session ${session.sessionId} cannot signal from ${session.status}.`);
  }
}

async function handleRegistry(
  method: string,
  parts: string[],
  searchParams: URLSearchParams,
  request: Parameters<typeof readJsonObject>[0],
  response: Parameters<typeof sendJson>[0],
  registry: InMemoryObjectRegistry,
  afterMutation?: () => void | Promise<void>,
  principal?: OperatorPrincipal,
  enforceActorBinding = false,
): Promise<void> {
  const actor = principal ?? DEVELOPMENT_ADMIN_PRINCIPAL;
  if (method === "GET" && parts.length === 0) {
    requirePermission(actor, "registry:read");
    return sendJson(response, 200, { versions: registry.listVersions(searchParams.get("objectClassId") ?? undefined) });
  }
  if (method === "POST" && parts.length === 0) {
    requirePermission(actor, "registry:candidate");
    const body = await readJsonObject(request);
    const candidate = decodeCandidate(body);
    if (enforceActorBinding) requireActorBinding(actor, candidate.createdBy);
    return sendMutation(response, 201, { version: registry.createCandidate(candidate) }, afterMutation);
  }
  const versionId = parts[0];
  if (!versionId) fail("HTTP_ROUTE_NOT_FOUND", "Registry route was not found.");
  if (method === "GET" && parts.length === 1) {
    requirePermission(actor, "registry:read");
    return sendJson(response, 200, { version: registry.getVersion(versionId) });
  }
  if (method === "GET" && parts.length === 2 && parts[1] === "events") {
    requirePermission(actor, "registry:read");
    return sendJson(response, 200, { events: registry.getEvents(versionId) });
  }
  if (method !== "POST" || parts.length !== 2) fail("HTTP_ROUTE_NOT_FOUND", "Registry action route was not found.");
  const body = await readJsonObject(request);
  const expectedRevision = requiredInteger(body.expectedRevision, "expectedRevision", 1);
  const action = parts[1];
  if (action === "submit-review") {
    requirePermission(actor, "registry:candidate");
    return sendMutation(response, 200, { version: registry.submitForReview(versionId, expectedRevision) }, afterMutation);
  }
  if (action === "reviews") {
    requirePermission(actor, "registry:review");
    const reviewerId = requiredString(body.reviewerId, "reviewerId");
    if (enforceActorBinding) requireActorBinding(actor, reviewerId);
    return sendMutation(response, 200, { version: registry.recordReview(versionId, expectedRevision, {
      reviewerId,
      reviewedAtUnixMs: requiredInteger(body.reviewedAtUnixMs, "reviewedAtUnixMs"),
      approved: requiredBoolean(body.approved, "approved"),
      notes: requiredString(body.notes, "notes"),
    }) }, afterMutation);
  }
  if (action === "start-validation") {
    requirePermission(actor, "registry:review");
    return sendMutation(response, 200, { version: registry.startValidation(versionId, expectedRevision) }, afterMutation);
  }
  if (action === "validations") {
    requirePermission(actor, "registry:review");
    const rawMetrics = requiredObject(body.metrics, "metrics");
    const metrics = Object.fromEntries(Object.entries(rawMetrics).map(([key, value]) => [key, requiredNumber(value, `metrics.${key}`)]));
    return sendMutation(response, 200, { version: registry.recordValidation(versionId, expectedRevision, {
      evaluationId: requiredString(body.evaluationId, "evaluationId"),
      artifactSha256: requiredString(body.artifactSha256, "artifactSha256"),
      evaluatedAtUnixMs: requiredInteger(body.evaluatedAtUnixMs, "evaluatedAtUnixMs"),
      passed: requiredBoolean(body.passed, "passed"),
      sampleCount: requiredInteger(body.sampleCount, "sampleCount", 1),
      metrics,
      notes: requiredString(body.notes, "notes"),
    }) }, afterMutation);
  }
  if (action === "activate") {
    requirePermission(actor, "registry:activate");
    const activatedBy = requiredString(body.activatedBy, "activatedBy");
    if (enforceActorBinding) requireActorBinding(actor, activatedBy);
    return sendMutation(response, 200, { version: registry.activate({
      versionId,
      expectedRevision,
      siteId: requiredString(body.siteId, "siteId"),
      robotCapability: requiredString(body.robotCapability, "robotCapability"),
      activatedBy,
    }) }, afterMutation);
  }
  if (action === "rollback") {
    requirePermission(actor, "registry:activate");
    const rolledBackBy = requiredString(body.rolledBackBy, "rolledBackBy");
    if (enforceActorBinding) requireActorBinding(actor, rolledBackBy);
    return sendMutation(response, 200, { version: registry.rollback({
      versionId,
      expectedRevision,
      siteId: requiredString(body.siteId, "siteId"),
      robotCapability: requiredString(body.robotCapability, "robotCapability"),
      rolledBackBy,
      reason: requiredString(body.reason, "reason"),
    }) }, afterMutation);
  }
  fail("HTTP_ROUTE_NOT_FOUND", `Unknown registry action ${action}.`);
}

async function handleSessions(
  method: string,
  parts: string[],
  request: Parameters<typeof readJsonObject>[0],
  response: Parameters<typeof sendJson>[0],
  sessions: InMemorySessionControl,
  robotReadiness: InMemoryRobotReadiness,
  leaseSigner?: LeaseSignatureSigner,
  afterMutation?: () => void | Promise<void>,
  authorizeCommandLease?: (session: SessionSnapshot) => void | Promise<void>,
  releaseCommandReservation?: (session: SessionSnapshot) => boolean | void | Promise<boolean | void>,
  allowUncoordinatedCommandLeases = false,
  principal: OperatorPrincipal = DEVELOPMENT_ADMIN_PRINCIPAL,
  enforceActorBinding = false,
): Promise<void> {
  if (method === "GET" && parts.length === 0) {
    requirePermission(principal, "session:read");
    return sendJson(response, 200, { sessions: sessions.listSessions() });
  }
  if (method === "POST" && parts.length === 0) {
    requirePermission(principal, "session:request");
    const body = await readJsonObject(request);
    const scopes = requiredStringArray(body.scopes, "scopes").map((scope) => {
      if (!allowedScopes.has(scope as SessionScope)) fail("SESSION_SCOPE_INVALID", `Unknown session scope ${scope}.`);
      return scope as SessionScope;
    });
    const operatorId = requiredString(body.operatorId, "operatorId");
    if (enforceActorBinding) requireActorBinding(principal, operatorId);
    const session = sessions.requestSession({
      sessionId: optionalString(body.sessionId, "sessionId"),
      robotId: requiredString(body.robotId, "robotId"),
      operatorId,
      scopes,
    });
    return sendMutation(response, 201, { session }, afterMutation);
  }
  const sessionId = parts[0];
  if (!sessionId) fail("HTTP_ROUTE_NOT_FOUND", "Session route was not found.");
  if (method === "GET" && parts.length === 1) {
    requirePermission(principal, "session:read");
    return sendJson(response, 200, { session: sessions.getSession(sessionId) });
  }
  if (method === "GET" && parts.length === 2 && parts[1] === "events") {
    requirePermission(principal, "session:read");
    return sendJson(response, 200, { events: sessions.getEvents(sessionId) });
  }
  if (method === "GET" && parts.length === 2 && parts[1] === "signed-lease") {
    requirePermission(principal, "session:read");
    sessions.expireDue();
    const session = sessions.getSession(sessionId);
    if (enforceActorBinding) requireActorBinding(principal, session.operatorId);
    return sendJson(response, 200, { signedLease: signCurrentLease(session, leaseSigner) });
  }
  if (parts.length === 2 && parts[1] === "robot-readiness") {
    const session = sessions.getSession(sessionId);
    if (method === "GET") {
      requirePermission(principal, "session:read");
      return sendJson(response, 200, { readiness: robotReadiness.get(sessionId) });
    }
    if (method === "POST") {
      requirePermission(principal, "session:robot-report");
      requireRobotBinding(principal, session.robotId);
      const body = await readJsonObject(request);
      return sendMutation(response, 200, { readiness: robotReadiness.record(session, body.report) }, afterMutation);
    }
  }
  if (method !== "POST" || parts.length !== 2) fail("HTTP_ROUTE_NOT_FOUND", "Session action route was not found.");
  const action = parts[1];
  const body = await readJsonObject(request);
  const expectedRevision = requiredInteger(body.expectedRevision, "expectedRevision", 1);
  if (action === "grant") {
    requirePermission(principal, "session:grant");
    const leaseDurationMs = requiredInteger(body.leaseDurationMs, "leaseDurationMs", 1);
    sessions.validateGrant(sessionId, expectedRevision, leaseDurationMs);
    const requested = sessions.getSession(sessionId);
    if (requested.scopes.some((scope) => scope === "CONTROL_BASE" || scope === "CONTROL_MANIPULATOR")) {
      if (authorizeCommandLease) await authorizeCommandLease(requested);
      else if (!allowUncoordinatedCommandLeases) {
        fail("FLEET_RESERVATION_REQUIRED", "Commanding lease grant requires an admitted Fleet reservation.");
      }
    }
    const session = sessions.grantSession(sessionId, expectedRevision, leaseDurationMs);
    const signedLease = leaseSigner ? leaseSigner.sign(session.lease!) : undefined;
    return sendMutation(response, 200, { session, ...(signedLease ? { signedLease } : {}) }, afterMutation);
  }
  requirePermission(principal, "session:control");
  if (action === "connecting") return sendMutation(response, 200, { session: sessions.markConnecting(sessionId, expectedRevision) }, afterMutation);
  if (action === "activate") {
    const session = sessions.getSession(sessionId);
    const ownershipGranted = hasCommandScope(session)
      ? Boolean(robotReadiness.requireOwnershipGranted(session))
      : false;
    return sendMutation(response, 200, { session: sessions.activate(sessionId, expectedRevision, ownershipGranted) }, afterMutation);
  }
  if (action === "renew") {
    const session = sessions.renewSession(sessionId, expectedRevision, requiredInteger(body.leaseDurationMs, "leaseDurationMs", 1));
    const signedLease = leaseSigner ? leaseSigner.sign(session.lease!) : undefined;
    return sendMutation(response, 200, { session, ...(signedLease ? { signedLease } : {}) }, afterMutation);
  }
  if (action === "hold") {
    return sendMutation(response, 200, { session: sessions.hold(sessionId, expectedRevision, requiredString(body.reason, "reason")) }, afterMutation);
  }
  if (action === "release") {
    const current = sessions.getSession(sessionId);
    const robotStopped = hasCommandScope(current)
      ? Boolean(robotReadiness.requireOwnershipCleared(current))
      : true;
    const session = sessions.release(
      sessionId,
      expectedRevision,
      robotStopped,
      optionalString(body.reason, "reason"),
    );
    await afterMutation?.();
    if (hasCommandScope(session) && releaseCommandReservation) {
      const fleetStateChanged = await releaseCommandReservation(session);
      if (fleetStateChanged) await afterMutation?.();
    }
    return sendJson(response, 200, { session });
  }
  if (action === "revoke") {
    const session = sessions.revoke(sessionId, expectedRevision, requiredString(body.reason, "reason"));
    return sendMutation(response, 200, { session }, afterMutation);
  }
  fail("HTTP_ROUTE_NOT_FOUND", `Unknown session action ${action}.`);
}

async function handleAssistance(
  method: string,
  parts: string[],
  request: Parameters<typeof readJsonObject>[0],
  response: Parameters<typeof sendJson>[0],
  assistance: InMemoryAssistanceOrchestrator,
  afterMutation?: () => void | Promise<void>,
  principal?: OperatorPrincipal,
  enforceActorBinding = false,
): Promise<void> {
  const actor = principal ?? DEVELOPMENT_ADMIN_PRINCIPAL;
  if (method === "GET" && parts.length === 0) {
    requirePermission(actor, "assistance:read");
    const requests = assistance.listRequests();
    return sendJson(response, 200, {
      requests: actor.roles.includes("ROBOT")
        ? requests.filter((item) => item.request.robotId === actor.robotId)
        : requests,
    });
  }
  if (method === "POST" && parts.length === 0) {
    requirePermission(actor, "assistance:open");
    const body = await readJsonObject(request);
    const assistanceRequest = decodeAssistanceRequest(body);
    if (actor.roles.includes("ROBOT")) requireRobotBinding(actor, assistanceRequest.robotId);
    return sendMutation(response, 201, { assistance: assistance.open(assistanceRequest) }, afterMutation);
  }
  const requestId = parts[0];
  if (!requestId) fail("HTTP_ROUTE_NOT_FOUND", "Assistance route was not found.");
  if (method === "GET" && parts.length === 1) {
    requirePermission(actor, "assistance:read");
    const snapshot = assistance.get(requestId);
    if (actor.roles.includes("ROBOT")) requireRobotBinding(actor, snapshot.request.robotId);
    return sendJson(response, 200, { assistance: snapshot });
  }
  if (method === "GET" && parts.length === 2 && parts[1] === "events") {
    requirePermission(actor, "assistance:read");
    requireAssistanceRobotBinding(actor, assistance, requestId);
    return sendJson(response, 200, { events: assistance.getEvents(requestId) });
  }
  if (method !== "POST" || parts.length !== 2) fail("HTTP_ROUTE_NOT_FOUND", "Assistance action route was not found.");
  const action = parts[1];
  const body = await readJsonObject(request);
  const expectedRevision = requiredInteger(body.expectedRevision, "expectedRevision", 1);
  if (action === "assign") {
    requirePermission(actor, "assistance:act");
    const operatorId = requiredString(body.operatorId, "operatorId");
    if (enforceActorBinding) requireActorBinding(actor, operatorId);
    return sendMutation(response, 200, { assistance: assistance.assign(requestId, expectedRevision, operatorId) }, afterMutation);
  }
  if (action === "declarations") {
    requirePermission(actor, "assistance:act");
    const declaration = decodeObjectDeclaration(body.declaration);
    if (enforceActorBinding) requireActorBinding(actor, declaration.declaredBy);
    return sendMutation(response, 200, { assistance: assistance.submitDeclaration(requestId, expectedRevision, declaration) }, afterMutation);
  }
  if (action === "groundings") {
    requirePermission(actor, "assistance:machine");
    requireAssistanceMachineRobotBinding(actor, assistance, requestId);
    return sendMutation(response, 200, { assistance: assistance.recordGrounding(requestId, expectedRevision, decodeGroundedObject(body.groundedObject)) }, afterMutation);
  }
  if (action === "declaration-correction") {
    requirePermission(actor, "assistance:machine");
    requireAssistanceMachineRobotBinding(actor, assistance, requestId);
    return sendMutation(response, 200, {
      assistance: assistance.requestDeclarationCorrection(requestId, expectedRevision, requiredString(body.reason, "reason")),
    }, afterMutation);
  }
  if (action === "plans") {
    requirePermission(actor, "assistance:machine");
    requireAssistanceMachineRobotBinding(actor, assistance, requestId);
    return sendMutation(response, 200, { assistance: assistance.recordPlan(requestId, expectedRevision, decodeManipulationPlanPreview(body.plan)) }, afterMutation);
  }
  if (action === "approvals") {
    requirePermission(actor, "assistance:act");
    const approval = decodeManipulationApproval(body.approval);
    if (enforceActorBinding) requireActorBinding(actor, approval.approvedBy);
    return sendMutation(response, 200, { assistance: assistance.approve(requestId, expectedRevision, approval) }, afterMutation);
  }
  if (action === "outcomes") {
    requirePermission(actor, "assistance:machine");
    requireAssistanceMachineRobotBinding(actor, assistance, requestId);
    return sendMutation(response, 200, { assistance: assistance.recordOutcome(requestId, expectedRevision, decodeManipulationOutcome(body.outcome)) }, afterMutation);
  }
  if (action === "verification") {
    requirePermission(actor, "assistance:machine");
    requireAssistanceMachineRobotBinding(actor, assistance, requestId);
    return sendMutation(response, 200, {
      assistance: assistance.completeVerification(
        requestId,
        expectedRevision,
        requiredBoolean(body.verified, "verified"),
        requiredString(body.reason, "reason"),
      ),
    }, afterMutation);
  }
  if (action === "direct-teleop") {
    requirePermission(actor, "assistance:act");
    return sendMutation(response, 200, { assistance: assistance.requireDirectTeleop(requestId, expectedRevision, requiredString(body.reason, "reason")) }, afterMutation);
  }
  fail("HTTP_ROUTE_NOT_FOUND", `Unknown assistance action ${action}.`);
}

function requireAssistanceRobotBinding(
  principal: OperatorPrincipal,
  assistance: InMemoryAssistanceOrchestrator,
  requestId: string,
): void {
  if (principal.roles.includes("ROBOT")) {
    requireRobotBinding(principal, assistance.get(requestId).request.robotId);
  }
}

function requireAssistanceMachineRobotBinding(
  principal: OperatorPrincipal,
  assistance: InMemoryAssistanceOrchestrator,
  requestId: string,
): void {
  requireRobotBinding(principal, assistance.get(requestId).request.robotId);
}

async function sendMutation(
  response: Parameters<typeof sendJson>[0],
  statusCode: number,
  value: unknown,
  afterMutation?: () => void | Promise<void>,
): Promise<void> {
  await afterMutation?.();
  sendJson(response, statusCode, value);
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function hasCommandScope(session: SessionSnapshot): boolean {
  return session.scopes.some((scope) => scope === "CONTROL_BASE" || scope === "CONTROL_MANIPULATOR");
}

function signCurrentLease(session: SessionSnapshot, leaseSigner: LeaseSignatureSigner | undefined): SignedTeleopSessionLease {
  if (!leaseSigner) fail("SESSION_LEASE_SIGNER_NOT_CONFIGURED", "Control plane has no lease signing key configured.");
  if (!session.lease || !["GRANTED", "CONNECTING", "ACTIVE", "HOLDING"].includes(session.status)) {
    fail("SESSION_LEASE_NOT_SIGNABLE", `Session ${session.sessionId} has no live signable lease in ${session.status}.`);
  }
  return leaseSigner.sign(session.lease);
}

async function sendOperatorAsset(
  pathname: string,
  response: Parameters<typeof sendJson>[0],
  connectOrigins: readonly string[],
): Promise<void> {
  const asset = pathname === "/operator" || pathname === "/operator/" ? "index.html"
    : pathname === "/operator/app.js" ? "app.js"
      : pathname === "/operator/styles.css" ? "styles.css"
        : pathname === "/operator/manifest.webmanifest" ? "manifest.webmanifest"
          : pathname === "/operator/icon.svg" ? "icon.svg"
            : pathname === "/operator/sw.js" ? "sw.js"
              : undefined;
  if (!asset) fail("HTTP_ROUTE_NOT_FOUND", `GET ${pathname} was not found.`);
  const body = await readFile(new URL(`../../operator-station/public/${asset}`, import.meta.url));
  response.writeHead(200, {
    "content-type": asset.endsWith(".html") ? "text/html; charset=utf-8"
      : asset.endsWith(".js") ? "text/javascript; charset=utf-8"
        : asset.endsWith(".css") ? "text/css; charset=utf-8"
          : asset.endsWith(".webmanifest") ? "application/manifest+json; charset=utf-8"
            : "image/svg+xml; charset=utf-8",
    "content-length": body.byteLength,
    "cache-control": "no-store",
    "content-security-policy": `default-src 'self'; connect-src 'self'${connectOrigins.map((origin) => ` ${origin}`).join("")}; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "service-worker-allowed": "/operator/",
  });
  response.end(body);
}

function validateOperatorConnectOrigin(value: string): string {
  const origin = value.trim();
  const url = new URL(origin);
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const loopback = hostname === "localhost" || hostname === "::1" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
  if (!origin || url.origin !== origin || url.username || url.password
    || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) {
    throw new Error("Operator connect origins must be exact HTTPS origins, except for loopback development.");
  }
  return url.origin;
}

function normalizedControlRoute(rawUrl: string): string {
  const pathname = new URL(rawUrl, "http://control-plane.local").pathname;
  if (/^\/control\/v1\/sessions\/[^/]+\/[^/]+$/.test(pathname)) return "/control/v1/sessions/:sessionId/:action";
  if (/^\/control\/v1\/sessions\/[^/]+$/.test(pathname)) return "/control/v1/sessions/:sessionId";
  if (/^\/assistance\/v1\/requests\/[^/]+\/[^/]+$/.test(pathname)) return "/assistance/v1/requests/:requestId/:action";
  if (/^\/assistance\/v1\/requests\/[^/]+$/.test(pathname)) return "/assistance/v1/requests/:requestId";
  if (/^\/registry\/v1\/versions\/[^/]+\/[^/]+$/.test(pathname)) return "/registry/v1/versions/:versionId/:action";
  if (/^\/registry\/v1\/versions\/[^/]+$/.test(pathname)) return "/registry/v1/versions/:versionId";
  if (/^\/signaling\/v1\/exchanges\/[^/]+\/[^/]+$/.test(pathname)) return "/signaling/v1/exchanges/:signalingId/:action";
  if (/^\/signaling\/v1\/exchanges\/[^/]+$/.test(pathname)) return "/signaling/v1/exchanges/:signalingId";
  if (pathname.startsWith("/operator/")) return "/operator/:asset";
  return pathname;
}

function decodeCandidate(body: Record<string, unknown>): CreateCandidateInput {
  const source = requiredObject(body.source, "source");
  if (!Array.isArray(body.evidence)) fail("HTTP_FIELD_INVALID", "evidence must be an array.");
  const evidence: EvidenceArtifactReference[] = body.evidence.map((item, index) => {
    const value = requiredObject(item, `evidence[${index}]`);
    return {
      artifactId: requiredString(value.artifactId, `evidence[${index}].artifactId`),
      observationId: requiredString(value.observationId, `evidence[${index}].observationId`),
      mediaType: requiredString(value.mediaType, `evidence[${index}].mediaType`),
      sha256: requiredString(value.sha256, `evidence[${index}].sha256`),
      byteLength: requiredInteger(value.byteLength, `evidence[${index}].byteLength`, 1),
      capturedAtUnixMs: requiredInteger(value.capturedAtUnixMs, `evidence[${index}].capturedAtUnixMs`),
    };
  });
  const supportedIntents = requiredStringArray(body.supportedIntents, "supportedIntents").map((intent) => {
    if (!["PICK", "PLACE", "PUSH", "TURN", "INSPECT"].includes(intent)) fail("HTTP_FIELD_INVALID", `Unknown manipulation intent ${intent}.`);
    return intent as ManipulationIntent;
  });
  return {
    objectClassId: optionalString(body.objectClassId, "objectClassId"),
    versionId: optionalString(body.versionId, "versionId"),
    semanticLabel: requiredString(body.semanticLabel, "semanticLabel"),
    aliases: body.aliases === undefined ? [] : requiredStringArray(body.aliases, "aliases"),
    siteIds: requiredStringArray(body.siteIds, "siteIds"),
    robotCapabilities: requiredStringArray(body.robotCapabilities, "robotCapabilities"),
    supportedIntents,
    source: {
      requestId: requiredString(source.requestId, "source.requestId"),
      taskId: requiredString(source.taskId, "source.taskId"),
      robotId: requiredString(source.robotId, "source.robotId"),
      declarationId: requiredString(source.declarationId, "source.declarationId"),
      groundedObjectId: requiredString(source.groundedObjectId, "source.groundedObjectId"),
      outcomeId: requiredString(source.outcomeId, "source.outcomeId"),
    },
    evidence,
    createdBy: requiredString(body.createdBy, "createdBy"),
  };
}
