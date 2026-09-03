import { createServer } from "node:http";
import {
  decodeTeleopCommandEnvelope,
  decodeTeleopSessionLease,
  fail,
  type ActuatorGroup,
  type RobotSessionReadinessReport,
} from "../../../packages/contracts/src/index.ts";
import {
  listenHttp,
  readJsonObject,
  requiredBoolean,
  requiredInteger,
  requiredObject,
  requiredString,
  requireBearer,
  sendError,
  sendJson,
  sendText,
  type RunningHttpServer,
} from "../../../packages/http-runtime/src/index.ts";
import { LocalRobotAgent } from "./local-robot-agent.ts";
import { MetricRegistry } from "../../../packages/observability/src/index.ts";

export interface RobotAgentTestServerOptions {
  agent: LocalRobotAgent;
  bearerToken: string;
  host?: string;
  port?: number;
  metrics?: MetricRegistry;
  watchdogIntervalMs?: number;
  onReadinessReport?: (report: RobotSessionReadinessReport) => void;
  operatorOrigin?: string;
}

export async function startRobotAgentTestServer(options: RobotAgentTestServerOptions): Promise<RunningHttpServer> {
  const host = options.host ?? "127.0.0.1";
  if (!isLoopback(host)) throw new Error("The robot-agent HTTP test transport is restricted to loopback.");
  if (options.bearerToken.length < 16) throw new Error("Robot-agent bearer token must contain at least 16 characters.");
  const operatorOrigin = options.operatorOrigin === undefined
    ? undefined
    : validatedLoopbackOrigin(options.operatorOrigin);
  const metrics = options.metrics ?? new MetricRegistry();
  const emitReadiness = (sessionId: string): void => {
    if (!options.onReadinessReport) return;
    try {
      options.onReadinessReport(options.agent.createReadinessReport(sessionId));
    } catch {
      // Readiness delivery cannot roll back or block a robot-local transition.
      metrics.increment("brash_teleoperation_edge_readiness_enqueue_errors_total", "Robot readiness enqueue failures.");
    }
  };
  const watchdogIntervalMs = options.watchdogIntervalMs ?? 25;
  if (!Number.isSafeInteger(watchdogIntervalMs) || watchdogIntervalMs < 5) throw new Error("Edge watchdog interval must be at least 5 ms.");
  const server = createServer(async (request, response) => {
    const requestOrigin = request.headers.origin;
    if (operatorOrigin !== undefined && requestOrigin === operatorOrigin) {
      response.setHeader("access-control-allow-origin", operatorOrigin);
      response.setHeader("access-control-allow-headers", "authorization, content-type");
      response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
      response.setHeader("access-control-max-age", "600");
      response.setHeader("vary", "Origin");
    }
    const route = normalizedEdgeRoute(request.url ?? "/");
    response.once("finish", () => {
      metrics.increment("brash_teleoperation_edge_http_requests_total", "Completed edge HTTP test requests.", {
        method: request.method ?? "UNKNOWN", route, status: String(response.statusCode),
      });
    });
    try {
      const url = new URL(request.url ?? "/", "http://robot-agent.local");
      if (request.method === "OPTIONS") {
        if (operatorOrigin === undefined || requestOrigin !== operatorOrigin) {
          fail("EDGE_OPERATOR_ORIGIN_DENIED", "Browser origin is not allowed by the simulation edge.");
        }
        response.statusCode = 204;
        response.end();
        return;
      }
      if (request.method === "GET" && url.pathname === "/health") {
        return sendJson(response, 200, { ok: true, service: "brash-robot-agent-test-transport", commandTransport: "http-test-only" });
      }
      requireBearer(request, options.bearerToken);
      if (request.method === "GET" && url.pathname === "/metrics") {
        const state = options.agent.state();
        const baseOutputActive = Math.abs(state.baseSafety.output.linearXMetersPerSecond) > 0
          || Math.abs(state.baseSafety.output.linearYMetersPerSecond) > 0
          || Math.abs(state.baseSafety.output.angularZRadiansPerSecond) > 0;
        const manipulatorOutputActive = state.manipulatorSafety !== undefined && state.manipulatorSafety.output.kind !== "HOLD";
        metrics.setGauge("brash_teleoperation_edge_installed_leases", "Currently installed edge leases.", {}, state.installedLeases.length);
        metrics.setGauge("brash_teleoperation_edge_safety_enabled", "Whether actuator-group safety output is enabled.", { actuator_group: "base" }, state.baseSafety.status === "ENABLED" ? 1 : 0);
        metrics.setGauge("brash_teleoperation_edge_safety_enabled", "Whether actuator-group safety output is enabled.", { actuator_group: "manipulator" }, state.manipulatorSafety?.status === "ENABLED" ? 1 : 0);
        metrics.setGauge("brash_teleoperation_edge_output_active", "Whether an actuator-group output requests motion.", { actuator_group: "base" }, baseOutputActive ? 1 : 0);
        metrics.setGauge("brash_teleoperation_edge_output_active", "Whether an actuator-group output requests motion.", { actuator_group: "manipulator" }, manipulatorOutputActive ? 1 : 0);
        metrics.setGauge("brash_teleoperation_edge_output_linear_x_meters_per_second", "Current accepted base X output.", {}, state.baseSafety.output.linearXMetersPerSecond);
        return sendText(response, 200, metrics.renderPrometheus(), "text/plain; version=0.0.4; charset=utf-8");
      }
      if (request.method === "GET" && url.pathname === "/edge/v1/state") {
        return sendJson(response, 200, { state: options.agent.state() });
      }
      if (request.method !== "POST") fail("HTTP_ROUTE_NOT_FOUND", `${request.method} ${url.pathname} was not found.`);
      const body = await readJsonObject(request);
      if (url.pathname === "/edge/v1/leases") {
        const lease = decodeTeleopSessionLease(body.lease);
        const state = options.agent.installLease(lease);
        emitReadiness(lease.sessionId);
        return sendJson(response, 200, { state });
      }
      if (url.pathname === "/edge/v1/signed-leases") {
        const state = options.agent.installSignedLease(body.signedLease);
        for (const lease of state.installedLeases) emitReadiness(lease.sessionId);
        return sendJson(response, 200, { state });
      }
      const leaseRevocation = url.pathname.match(/^\/edge\/v1\/leases\/([^/]+)\/revoke$/);
      if (leaseRevocation) {
        return sendJson(response, 200, { state: options.agent.revokeLease(decodeURIComponent(leaseRevocation[1]!), requiredString(body.reason, "reason")) });
      }
      if (url.pathname === "/edge/v1/ownership/request") {
        const actuatorGroup = requiredString(body.actuatorGroup, "actuatorGroup");
        if (actuatorGroup !== "BASE" && actuatorGroup !== "MANIPULATOR") fail("OWNERSHIP_ACTUATOR_INVALID", "actuatorGroup is invalid.");
        const sessionId = requiredString(body.sessionId, "sessionId");
        const state = options.agent.requestOwnership(sessionId, actuatorGroup as ActuatorGroup);
        emitReadiness(sessionId);
        return sendJson(response, 200, { state });
      }
      if (url.pathname === "/edge/v1/ownership/stopped-ack") {
        const evidence = requiredObject(body.evidence, "evidence");
        const ownership = options.agent.state().ownership;
        const sessionId = ownership.pendingOwner?.sessionId ?? ownership.owner?.sessionId;
        const state = options.agent.acknowledgeStopped(
          requiredInteger(body.expectedRevision, "expectedRevision", 1),
          {
            observedAtUnixMs: requiredInteger(evidence.observedAtUnixMs, "evidence.observedAtUnixMs"),
            controllerStateFresh: requiredBoolean(evidence.controllerStateFresh, "evidence.controllerStateFresh"),
            baseStopped: requiredBoolean(evidence.baseStopped, "evidence.baseStopped"),
            manipulatorHolding: requiredBoolean(evidence.manipulatorHolding, "evidence.manipulatorHolding"),
          },
        );
        if (sessionId) emitReadiness(sessionId);
        return sendJson(response, 200, { state });
      }
      if (url.pathname === "/edge/v1/ownership/release") {
        const sessionId = options.agent.state().ownership.owner?.sessionId;
        const state = options.agent.releaseOwnership(
          requiredInteger(body.expectedRevision, "expectedRevision", 1),
          requiredString(body.reason, "reason"),
        );
        if (sessionId) emitReadiness(sessionId);
        return sendJson(response, 200, { state });
      }
      if (url.pathname === "/edge/v1/safety/interlocks") {
        const interlocks = requiredObject(body.interlocks, "interlocks");
        return sendJson(response, 200, {
          state: options.agent.updateBaseInterlocks({
            vendorSafetyOk: requiredBoolean(interlocks.vendorSafetyOk, "interlocks.vendorSafetyOk"),
            controllerHealthy: requiredBoolean(interlocks.controllerHealthy, "interlocks.controllerHealthy"),
            robotStateFresh: requiredBoolean(interlocks.robotStateFresh, "interlocks.robotStateFresh"),
          }),
        });
      }
      if (url.pathname === "/edge/v1/safety/prepare") {
        return sendJson(response, 200, { state: options.agent.prepareBaseSafety(requiredInteger(body.expectedRevision, "expectedRevision", 1)) });
      }
      if (url.pathname === "/edge/v1/safety/enable") {
        return sendJson(response, 200, { state: options.agent.enableBaseSafety(requiredInteger(body.expectedRevision, "expectedRevision", 1)) });
      }
      if (url.pathname === "/edge/v1/safety/hold") {
        return sendJson(response, 200, {
          state: options.agent.holdBaseSafety(
            requiredInteger(body.expectedRevision, "expectedRevision", 1),
            requiredString(body.reason, "reason"),
          ),
        });
      }
      if (url.pathname === "/edge/v1/manipulator-safety/interlocks") {
        const interlocks = requiredObject(body.interlocks, "interlocks");
        return sendJson(response, 200, { state: options.agent.updateManipulatorInterlocks({
          vendorSafetyOk: requiredBoolean(interlocks.vendorSafetyOk, "interlocks.vendorSafetyOk"),
          controllerHealthy: requiredBoolean(interlocks.controllerHealthy, "interlocks.controllerHealthy"),
          robotStateFresh: requiredBoolean(interlocks.robotStateFresh, "interlocks.robotStateFresh"),
          baseStopped: requiredBoolean(interlocks.baseStopped, "interlocks.baseStopped"),
          stableStance: requiredBoolean(interlocks.stableStance, "interlocks.stableStance"),
          withinJointLimits: requiredBoolean(interlocks.withinJointLimits, "interlocks.withinJointLimits"),
          collisionFree: requiredBoolean(interlocks.collisionFree, "interlocks.collisionFree"),
        }) });
      }
      if (url.pathname === "/edge/v1/manipulator-safety/prepare") {
        return sendJson(response, 200, { state: options.agent.prepareManipulatorSafety(requiredInteger(body.expectedRevision, "expectedRevision", 1)) });
      }
      if (url.pathname === "/edge/v1/manipulator-safety/enable") {
        return sendJson(response, 200, { state: options.agent.enableManipulatorSafety(requiredInteger(body.expectedRevision, "expectedRevision", 1)) });
      }
      if (url.pathname === "/edge/v1/manipulator-safety/hold") {
        return sendJson(response, 200, { state: options.agent.holdManipulatorSafety(
          requiredInteger(body.expectedRevision, "expectedRevision", 1),
          requiredString(body.reason, "reason"),
        ) });
      }
      if (url.pathname === "/edge/v1/commands") {
        return sendJson(response, 200, { state: options.agent.acceptCommand(decodeTeleopCommandEnvelope(body.command)) });
      }
      if (url.pathname === "/edge/v1/tick") return sendJson(response, 200, { state: options.agent.tick() });
      fail("HTTP_ROUTE_NOT_FOUND", `POST ${url.pathname} was not found.`);
    } catch (error) {
      sendError(response, error);
    }
  });
  const watchdog = setInterval(() => {
    try {
      options.agent.tick();
    } catch {
      metrics.increment("brash_teleoperation_edge_watchdog_errors_total", "Robot-agent watchdog execution failures.");
    }
  }, watchdogIntervalMs);
  watchdog.unref();
  let running: RunningHttpServer;
  try {
    running = await listenHttp(server, host, options.port ?? 0);
  } catch (error) {
    clearInterval(watchdog);
    throw error;
  }
  return {
    ...running,
    close: async () => {
      clearInterval(watchdog);
      await running.close();
    },
  };
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "[::1]" || host === "localhost";
}

function validatedLoopbackOrigin(value: string): string {
  const url = new URL(value);
  if ((url.protocol !== "http:" && url.protocol !== "https:")
    || !isLoopback(url.hostname)
    || url.username !== ""
    || url.password !== ""
    || url.pathname !== "/"
    || url.search !== ""
    || url.hash !== "") {
    throw new Error("Robot-agent operatorOrigin must be an exact loopback HTTP(S) origin.");
  }
  return url.origin;
}

function normalizedEdgeRoute(rawUrl: string): string {
  const pathname = new URL(rawUrl, "http://robot-agent.local").pathname;
  if (/^\/edge\/v1\/leases\/[^/]+\/revoke$/.test(pathname)) return "/edge/v1/leases/:sessionId/revoke";
  return pathname;
}
