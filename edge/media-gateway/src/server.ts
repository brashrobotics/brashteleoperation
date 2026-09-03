import { createServer, type ServerResponse } from "node:http";
import {
  listenHttp,
  readJsonObject,
  requireBearer,
  requiredInteger,
  requiredString,
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
import {
  MediaGateway,
  type CameraDescriptor,
  type ImmutableObservationBundle,
  type ImmutableObservationFrame,
  type MediaFrame,
} from "./media-gateway.ts";

export interface MediaGatewayTestServerOptions {
  gateway: MediaGateway;
  identityProvider: RequestIdentityProvider;
  authorizeObservationAccess: (
    principal: OperatorPrincipal,
    observation: ImmutableObservationBundle,
  ) => void | Promise<void>;
  authorizeLiveCameraAccess?: (
    principal: OperatorPrincipal,
    camera: CameraDescriptor,
    sessionId: string,
  ) => void | Promise<void>;
  robotIngestBearerToken?: string;
  host?: string;
  port?: number;
  allowedOrigins?: readonly string[];
  maximumGrantLifetimeMs?: number;
}

/**
 * Bounded loopback adapter for immutable previews and simulation live frames.
 *
 * This is deliberately not a production video transport. It provides a real
 * integration boundary for low-rate images used during local development. It
 * never carries actuator commands and is not a production WebRTC transport.
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
          mediaTransport: "bounded-simulation-http",
        });
      }

      const ingestMatch = url.pathname.match(/^\/media\/v1\/cameras\/([^/]+)\/frames$/);
      if (request.method === "POST" && ingestMatch) {
        if (!options.robotIngestBearerToken) fail("HTTP_ROUTE_NOT_FOUND", `${request.method} ${url.pathname} was not found.`);
        requireBearer(request, options.robotIngestBearerToken);
        const cameraId = decodeURIComponent(ingestMatch[1]!);
        const camera = options.gateway.getCamera(cameraId);
        const body = await readJsonObject(request, 12 * 1024 * 1024);
        const mediaType = requiredString(body.mediaType, "mediaType");
        if (!SAFE_PREVIEW_TYPES.has(mediaType)) {
          fail("MEDIA_PREVIEW_TYPE_INVALID", `Media type ${mediaType} is not allowed for a live image.`);
        }
        const frame: MediaFrame = {
          frameId: requiredString(body.frameId, "frameId"),
          cameraId,
          robotId: requiredString(body.robotId, "robotId"),
          sequence: requiredInteger(body.sequence, "sequence", 1),
          sourceTimestampUnixMs: requiredInteger(body.sourceTimestampUnixMs, "sourceTimestampUnixMs", 1),
          receivedAtUnixMs: Date.now(),
          mediaType,
          bytes: decodeBase64(requiredString(body.bytesBase64, "bytesBase64")),
        };
        if (frame.robotId !== camera.robotId) fail("MEDIA_ROBOT_MISMATCH", "Frame belongs to another robot.");
        const result = options.gateway.ingest(frame);
        return sendJson(response, result.accepted ? 202 : 409, { result });
      }

      const liveAccessMatch = url.pathname.match(/^\/media\/v1\/cameras\/([^/]+)\/access$/);
      if (request.method === "POST" && liveAccessMatch) {
        if (!options.authorizeLiveCameraAccess) fail("HTTP_ROUTE_NOT_FOUND", `${request.method} ${url.pathname} was not found.`);
        const principal = options.identityProvider.authenticateBearer(request.headers.authorization);
        requirePermission(principal, "media:read");
        const cameraId = decodeURIComponent(liveAccessMatch[1]!);
        const camera = options.gateway.getCamera(cameraId);
        const body = await readJsonObject(request, 4 * 1024);
        const sessionId = requiredString(body.sessionId, "sessionId");
        const lifetimeMs = requiredInteger(body.lifetimeMs, "lifetimeMs", 1_000);
        if (lifetimeMs > maximumGrantLifetimeMs) {
          fail("MEDIA_ACCESS_LIFETIME_INVALID", `Media access lifetime cannot exceed ${maximumGrantLifetimeMs} ms.`);
        }
        await options.authorizeLiveCameraAccess(principal, camera, sessionId);
        const accessToken = options.gateway.issueAccess({
          operatorId: principal.operatorId,
          cameraIds: [cameraId],
          lifetimeMs,
        });
        return sendJson(response, 201, {
          accessToken,
          grant: options.gateway.verifyAccess(accessToken),
          camera,
        });
      }

      const liveMatch = url.pathname.match(/^\/media\/v1\/cameras\/([^/]+)\/live$/);
      if (request.method === "GET" && liveMatch) {
        const cameraId = decodeURIComponent(liveMatch[1]!);
        const token = bearerValue(request.headers.authorization);
        const frame = options.gateway.liveFrame(cameraId, token);
        return sendLiveFrame(response, frame, options.gateway.getCamera(cameraId));
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

function sendLiveFrame(response: ServerResponse, frame: MediaFrame, camera: CameraDescriptor): void {
  if (!SAFE_PREVIEW_TYPES.has(frame.mediaType)) {
    fail("MEDIA_PREVIEW_TYPE_INVALID", `Media type ${frame.mediaType} is not allowed for a live image.`);
  }
  response.writeHead(200, {
    "content-type": frame.mediaType,
    "content-length": frame.bytes.byteLength,
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; sandbox",
    "x-content-type-options": "nosniff",
    "x-brash-camera-id": frame.cameraId,
    "x-brash-frame-id": frame.frameId,
    "x-brash-sensor-frame-id": camera.frameId,
    "x-brash-frame-sequence": String(frame.sequence),
    "x-brash-source-timestamp-unix-ms": String(frame.sourceTimestampUnixMs),
  });
  response.end(Buffer.from(frame.bytes));
}

function decodeBase64(value: string): Uint8Array {
  if (value.length === 0 || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    fail("MEDIA_FRAME_INVALID", "bytesBase64 must be canonical base64.");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) fail("MEDIA_FRAME_INVALID", "bytesBase64 must be canonical base64.");
  return bytes;
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
  response.setHeader("access-control-expose-headers", "x-brash-observation-id, x-brash-camera-id, x-brash-frame-id, x-brash-sensor-frame-id, x-brash-frame-sequence, x-brash-frame-sha256, x-brash-source-timestamp-unix-ms");
  response.setHeader("vary", "origin");
}

function sendPreflight(response: ServerResponse): void {
  response.writeHead(204, { "content-length": "0", "cache-control": "no-store" });
  response.end();
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}
