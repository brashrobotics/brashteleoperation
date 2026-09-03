import { createServer, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fail } from "../../../packages/contracts/src/index.ts";
import {
  listenHttp,
  readJsonObject,
  requiredBoolean,
  requiredNumber,
  sendError,
  sendJson,
  type RunningHttpServer,
} from "../../../packages/http-runtime/src/index.ts";
import { DirectTeleopRuntime } from "./runtime.ts";

export interface DirectTeleopServerOptions {
  runtime: DirectTeleopRuntime;
  host?: string;
  port?: number;
}

/** Tokenless, loopback-only HTTP surface for the dedicated Gazebo console. */
export async function startDirectTeleopServer(options: DirectTeleopServerOptions): Promise<RunningHttpServer> {
  const host = options.host ?? "127.0.0.1";
  if (!isLoopback(host)) throw new Error("The tokenless direct simulator must bind to loopback.");
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://direct-teleop.local");
      if (request.method === "GET" && url.pathname === "/health") {
        return sendJson(response, 200, { ok: true, service: "brash-direct-teleop-simulator", simulationOnly: true });
      }
      if (request.method === "GET" && ["/", "/index.html", "/app.js", "/styles.css"].includes(url.pathname)) {
        return sendAsset(url.pathname, response);
      }
      if (request.method === "GET" && url.pathname === "/api/state") {
        return sendJson(response, 200, { state: await options.runtime.state() });
      }
      if (request.method === "GET" && url.pathname === "/api/camera") {
        return sendCamera(response, await options.runtime.cameraFrame());
      }
      if (request.method !== "POST") fail("HTTP_ROUTE_NOT_FOUND", `${request.method} ${url.pathname} was not found.`);
      const body = await readJsonObject(request, 8 * 1024);
      if (url.pathname === "/api/connect") {
        return sendJson(response, 200, { state: await options.runtime.connect() });
      }
      if (url.pathname === "/api/command") {
        return sendJson(response, 200, { state: await options.runtime.command({
          linear: requiredNumber(body.linear, "linear"),
          yaw: requiredNumber(body.yaw, "yaw"),
          speedScale: requiredNumber(body.speedScale, "speedScale"),
          deadman: requiredBoolean(body.deadman, "deadman"),
        }) });
      }
      if (url.pathname === "/api/hold") {
        return sendJson(response, 200, { state: await options.runtime.hold() });
      }
      if (url.pathname === "/api/release") {
        return sendJson(response, 200, { state: await options.runtime.release() });
      }
      fail("HTTP_ROUTE_NOT_FOUND", `POST ${url.pathname} was not found.`);
    } catch (error) {
      sendError(response, error);
    }
  });
  return listenHttp(server, host, options.port ?? 0);
}

async function sendAsset(pathname: string, response: ServerResponse): Promise<void> {
  const asset = pathname === "/" || pathname === "/index.html" ? "index.html"
    : pathname === "/app.js" ? "app.js"
      : pathname === "/styles.css" ? "styles.css"
        : undefined;
  if (!asset) fail("HTTP_ROUTE_NOT_FOUND", `GET ${pathname} was not found.`);
  const body = await readFile(new URL(`../public/${asset}`, import.meta.url));
  response.writeHead(200, {
    "content-type": asset.endsWith(".html") ? "text/html; charset=utf-8"
      : asset.endsWith(".js") ? "text/javascript; charset=utf-8"
        : "text/css; charset=utf-8",
    "content-length": body.byteLength,
    "cache-control": "no-store",
    "content-security-policy": "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  response.end(body);
}

function sendCamera(response: ServerResponse, frame: Awaited<ReturnType<DirectTeleopRuntime["cameraFrame"]>>): void {
  response.writeHead(200, {
    "content-type": frame.mediaType,
    "content-length": frame.bytes.byteLength,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-brash-camera-id": frame.cameraId,
    "x-brash-sensor-frame-id": frame.sensorFrameId,
    "x-brash-frame-sequence": String(frame.sequence),
    "x-brash-source-timestamp-unix-ms": String(frame.sourceTimestampUnixMs),
  });
  response.end(Buffer.from(frame.bytes));
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}
