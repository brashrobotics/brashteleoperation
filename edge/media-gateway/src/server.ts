import { createServer, type ServerResponse } from "node:http";
import {
  listenHttp,
  readJsonObject,
  requiredInteger,
  sendError,
  sendJson,
  type RunningHttpServer,
} from "../../../packages/http-runtime/src/index.ts";
import {
  requirePermission,
  type OperatorPrincipal,
  type RequestIdentityProvider,
} from "../../../packages/identity/src/index.ts";
import { fail } from "../../../packages/contracts/src/index.ts";
import { MediaGateway, type ImmutableObservationBundle, type ImmutableObservationFrame } from "./media-gateway.ts";

export interface MediaGatewayTestServerOptions {
  gateway: MediaGateway;
  identityProvider: RequestIdentityProvider;
  authorizeObservationAccess: (
    principal: OperatorPrincipal,
    observation: ImmutableObservationBundle,
  ) => void | Promise<void>;
  host?: string;
  port?: number;
  allowedOrigins?: readonly string[];
  maximumGrantLifetimeMs?: number;
}

/**
 * Bounded loopback adapter for immutable observation previews.
 *
 * This is deliberately not a production video transport. It provides a real
 * integration boundary for the low-rate, frozen image used during object
 * declaration without exposing live media or actuator control.
 */
export async function startMediaGatewayTestServer(options: MediaGatewayTestServerOptions): Promise<RunningHttpServer> {
  const host = options.host ?? "127.0.0.1";
  if (!isLoopback(host)) throw new Error("The media-gateway HTTP test transport is restricted to loopback.");
  if (typeof options.authorizeObservationAccess !== "function") {
    throw new Error("An observation access authorizer is required.");
  }
  const maximumGrantLifetimeMs = options.maximumGrantLifetimeMs ?? 60_000;
  if (!Number.isSafeInteger(maximumGrantLifetimeMs) || maximumGrantLifetimeMs < 1_000 || maximumGrantLifetimeMs > 5 * 60_000) {
    throw new Error("Media access grant maximum lifetime must be between 1 second and 5 minutes.");
  }
  const allowedOrigins = new Set((options.allowedOrigins ?? []).map(normalizeOrigin));

  const server = createServer(async (request, response) => {
    try {
      applyCors(request.headers.origin, allowedOrigins, response);
      const url = new URL(request.url ?? "/", "http://media-gateway.local");
      if (request.method === "OPTIONS") return sendPreflight(response);
      if (request.method === "GET" && url.pathname === "/health") {
        return sendJson(response, 200, {
          ok: true,
          service: "brash-media-gateway-test-transport",
          mediaTransport: "immutable-http-test-only",
        });
      }

      const accessMatch = url.pathname.match(/^\/media\/v1\/observations\/([^/]+)\/access$/);
      if (request.method === "POST" && accessMatch) {
        const principal = options.identityProvider.authenticateBearer(request.headers.authorization);
        requirePermission(principal, "media:read");
        const observationId = decodeURIComponent(accessMatch[1]!);
        const observation = options.gateway.getObservation(observationId);
        await options.authorizeObservationAccess(principal, observation);
        const body = await readJsonObject(request, 4 * 1024);
        const lifetimeMs = requiredInteger(body.lifetimeMs, "lifetimeMs", 1_000);
        if (lifetimeMs > maximumGrantLifetimeMs) {
          fail("MEDIA_ACCESS_LIFETIME_INVALID", `Media access lifetime cannot exceed ${maximumGrantLifetimeMs} ms.`);
        }
        const accessToken = options.gateway.issueObservationAccess({
          operatorId: principal.operatorId,
          observationId,
          lifetimeMs,
        });
        return sendJson(response, 201, {
          accessToken,
          grant: options.gateway.verifyAccess(accessToken),
        });
      }

      const previewMatch = url.pathname.match(/^\/media\/v1\/observations\/([^/]+)\/preview$/);
      if (request.method === "GET" && previewMatch) {
        const token = bearerValue(request.headers.authorization);
        const frame = options.gateway.observationPreview(decodeURIComponent(previewMatch[1]!), token);
        return sendFrame(response, frame);
      }

      const frameMatch = url.pathname.match(/^\/media\/v1\/observations\/([^/]+)\/frames\/([^/]+)$/);
      if (request.method === "GET" && frameMatch) {
        const token = bearerValue(request.headers.authorization);
        const frame = options.gateway.observationFrame(
          decodeURIComponent(frameMatch[1]!),
          decodeURIComponent(frameMatch[2]!),
          token,
        );
        return sendFrame(response, frame);
      }
      fail("HTTP_ROUTE_NOT_FOUND", `${request.method} ${url.pathname} was not found.`);
    } catch (error) {
      sendError(response, error);
    }
  });
  return listenHttp(server, host, options.port ?? 0);
}

const SAFE_PREVIEW_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/avif"]);

function sendFrame(response: ServerResponse, frame: ImmutableObservationFrame): void {
  if (!SAFE_PREVIEW_TYPES.has(frame.reference.mediaType)) {
    fail("MEDIA_PREVIEW_TYPE_INVALID", `Media type ${frame.reference.mediaType} is not allowed for an image preview.`);
  }
  response.writeHead(200, {
    "content-type": frame.reference.mediaType,
    "content-length": frame.bytes.byteLength,
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; sandbox",
    "x-content-type-options": "nosniff",
    "x-brash-observation-id": frame.observationId,
    "x-brash-frame-id": frame.reference.frameId,
    "x-brash-sensor-frame-id": frame.reference.sensorFrameId,
    "x-brash-frame-sha256": frame.reference.sha256,
    "x-brash-source-timestamp-unix-ms": String(frame.reference.sourceTimestampUnixMs),
  });
  response.end(Buffer.from(frame.bytes));
}

function bearerValue(header: string | undefined): string {
  if (!header?.startsWith("Bearer ") || header.length <= "Bearer ".length || header.length > 8_192) {
    fail("UNAUTHORIZED", "A valid media access grant is required.");
  }
  return header.slice("Bearer ".length);
}

function normalizeOrigin(origin: string): string {
  const parsed = new URL(origin);
  if (parsed.origin !== origin || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
    throw new Error(`Invalid allowed operator origin ${origin}.`);
  }
  return parsed.origin;
}

function applyCors(origin: string | undefined, allowedOrigins: ReadonlySet<string>, response: ServerResponse): void {
  if (!origin) return;
  if (!allowedOrigins.has(origin)) fail("MEDIA_ORIGIN_DENIED", "Operator origin is not allowed to access media.");
  response.setHeader("access-control-allow-origin", origin);
  response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  response.setHeader("access-control-allow-headers", "authorization, content-type");
  response.setHeader("access-control-expose-headers", "x-brash-observation-id, x-brash-frame-id, x-brash-sensor-frame-id, x-brash-frame-sha256, x-brash-source-timestamp-unix-ms");
  response.setHeader("vary", "origin");
}

function sendPreflight(response: ServerResponse): void {
  response.writeHead(204, { "content-length": "0", "cache-control": "no-store" });
  response.end();
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}
