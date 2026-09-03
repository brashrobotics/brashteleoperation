import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { TeleoperationError, fail } from "../../contracts/src/index.ts";

export async function readJsonObject(request: IncomingMessage, maximumBytes = 64 * 1024): Promise<Record<string, unknown>> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") fail("HTTP_CONTENT_TYPE_INVALID", "content-type must be application/json.");
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > maximumBytes) fail("HTTP_BODY_TOO_LARGE", `JSON body exceeds ${maximumBytes} bytes.`);
    chunks.push(buffer);
  }
  if (chunks.length === 0) fail("HTTP_BODY_REQUIRED", "A JSON request body is required.");
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    fail("HTTP_JSON_INVALID", "Request body is not valid JSON.");
  }
  return requiredObject(value, "body");
}

export function requiredObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("HTTP_FIELD_INVALID", `${field} must be an object.`, { field });
  }
  return value as Record<string, unknown>;
}

export function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) fail("HTTP_FIELD_INVALID", `${field} must be a non-empty string.`, { field });
  return value;
}

export function requiredInteger(value: unknown, field: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    fail("HTTP_FIELD_INVALID", `${field} must be a safe integer greater than or equal to ${minimum}.`, { field });
  }
  return value;
}

export function requiredNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail("HTTP_FIELD_INVALID", `${field} must be finite.`, { field });
  return value;
}

export function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") fail("HTTP_FIELD_INVALID", `${field} must be boolean.`, { field });
  return value;
}

export function requiredStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) fail("HTTP_FIELD_INVALID", `${field} must be an array.`, { field });
  return value.map((item, index) => requiredString(item, `${field}[${index}]`));
}

export function optionalString(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : requiredString(value, field);
}

export function requireBearer(request: IncomingMessage, expectedToken: string): void {
  const header = request.headers.authorization;
  const prefix = "Bearer ";
  if (!header?.startsWith(prefix) || !secureEqual(header.slice(prefix.length), expectedToken)) {
    fail("UNAUTHORIZED", "A valid bearer token is required.");
  }
}

export function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

export function sendText(response: ServerResponse, statusCode: number, body: string, contentType = "text/plain; charset=utf-8"): void {
  response.writeHead(statusCode, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

export function sendError(response: ServerResponse, error: unknown): void {
  if (error instanceof TeleoperationError) {
    sendJson(response, statusForCode(error.code), { code: error.code, message: error.message, details: error.details });
    return;
  }
  sendJson(response, 500, { code: "INTERNAL_ERROR", message: "An unexpected error occurred." });
}

export interface RunningHttpServer {
  url: string;
  close(): Promise<void>;
}

export async function listenHttp(server: Server, host = "127.0.0.1", port = 0): Promise<RunningHttpServer> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address() as AddressInfo | null;
  if (!address) throw new Error("HTTP server did not publish an address.");
  return {
    url: `http://${address.address.includes(":") ? `[${address.address}]` : address.address}:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function secureEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.byteLength === rightBuffer.byteLength && timingSafeEqual(leftBuffer, rightBuffer);
}

function statusForCode(code: string): number {
  if (code === "UNAUTHORIZED") return 401;
  if (code === "FORBIDDEN" || code === "ACTOR_IDENTITY_MISMATCH"
    || code === "ROBOT_IDENTITY_MISMATCH" || code === "SIGNALING_IDENTITY_MISMATCH"
    || code === "ROBOT_READINESS_IDENTITY_MISMATCH" || code === "MEDIA_ORIGIN_DENIED"
    || code === "MEDIA_ACCESS_DENIED" || code === "MEDIA_OBSERVATION_ACCESS_DENIED") return 403;
  if (code === "MEDIA_ACCESS_INVALID" || code === "MEDIA_ACCESS_EXPIRED") return 401;
  if (code.endsWith("_NOT_FOUND")) return 404;
  if (code.includes("REVISION") || code.includes("CONFLICT") || code.includes("COLLISION") || code.includes("TRANSITION")) return 409;
  if (code === "HTTP_BODY_TOO_LARGE") return 413;
  if (code === "HTTP_CONTENT_TYPE_INVALID") return 415;
  return 400;
}
