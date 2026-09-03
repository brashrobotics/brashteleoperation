import { randomUUID } from "node:crypto";

const controlUrl = normalizedLoopbackUrl(process.env.BRASH_TELEOP_CONTROL_URL || "http://127.0.0.1:4310", "control");
const edgeUrl = normalizedLoopbackUrl(process.env.BRASH_TELEOP_EDGE_URL || "http://127.0.0.1:4311", "edge");
const controlToken = requiredSecret("BRASH_TELEOP_CONTROL_TOKEN");
const edgeToken = requiredSecret("BRASH_TELEOP_EDGE_TOKEN");
const operatorId = process.env.BRASH_TELEOP_OPERATOR_ID?.trim() || "operator-001";
const robotId = process.env.BRASH_TELEOP_ROBOT_ID?.trim() || "b2-unit-001";
const durationMs = boundedInteger(process.env.BRASH_B2W_DEMO_DURATION_MS, 1_500, 250, 10_000);
const sessionId = `b2w-demo-${randomUUID()}`;

interface Lease {
  sessionId: string;
  robotId: string;
  operatorId: string;
  revision: number;
  expiresAtUnixMs: number;
}

interface Session {
  sessionId: string;
  revision: number;
  status: string;
  lease?: Lease;
}

interface Ownership {
  revision: number;
  status: string;
}

interface BaseOutput {
  linearXMetersPerSecond?: number;
  angularZRadiansPerSecond?: number;
}

interface BaseSafety {
  revision: number;
  status: string;
  output?: BaseOutput;
}

interface EdgeState {
  ownership: Ownership;
  baseSafety: BaseSafety;
}

interface JsonResponse {
  session?: Session;
  signedLease?: unknown;
  state?: EdgeState;
}

let session: Session | undefined;
let lease: Lease | undefined;
let edgeState: EdgeState | undefined;
let maximumAcceptedSpeed = 0;
let acceptedCommands = 0;

console.log("BRASH B2W Gazebo teleoperation smoke demo");
console.log(`Session: ${sessionId}`);
console.log(`Command: forward for ${durationMs} ms (simulation only)`);

try {
  session = requireSession(await controlRequest("/control/v1/sessions", {
    sessionId,
    robotId,
    operatorId,
    scopes: ["OBSERVE", "CONTROL_BASE"],
  }));

  const granted = await controlRequest(`/control/v1/sessions/${sessionId}/grant`, {
    expectedRevision: session.revision,
    leaseDurationMs: 30_000,
  });
  session = requireSession(granted);
  lease = session.lease;
  if (!lease) throw new Error("Control plane granted a session without a lease.");

  if (granted.signedLease) await edgeRequest("/edge/v1/signed-leases", { signedLease: granted.signedLease });
  else await edgeRequest("/edge/v1/leases", { lease });

  session = requireSession(await controlRequest(`/control/v1/sessions/${sessionId}/connecting`, {
    expectedRevision: session.revision,
  }));
  edgeState = requireEdgeState(await edgeRequest("/edge/v1/ownership/request", {
    sessionId,
    actuatorGroup: "BASE",
  }));
  edgeState = await waitForEdgeState((state) => state.ownership.status === "OWNED", 10_000);
  session = await activateSession(session, 5_000);
  edgeState = await enableBaseSafety(edgeState, 5_000);

  console.log("Ownership: OWNED; base safety: ENABLED");
  const commandDeadline = Date.now() + durationMs;
  let sequence = 1;
  while (Date.now() < commandDeadline) {
    const now = Date.now();
    edgeState = requireEdgeState(await edgeRequest("/edge/v1/commands", {
      command: {
        contractVersion: { major: 1, minor: 0 },
        commandId: randomUUID(),
        sessionId: lease.sessionId,
        robotId: lease.robotId,
        sourceId: lease.operatorId,
        actuatorGroup: "BASE",
        sequence: sequence++,
        producedAtUnixMs: now,
        expiresAtUnixMs: Math.min(now + 150, lease.expiresAtUnixMs),
        deadman: true,
        intent: {
          kind: "BASE_MOTION",
          frameId: "base_link",
          linearXMetersPerSecond: 0.35,
          linearYMetersPerSecond: 0,
          angularZRadiansPerSecond: 0,
          speedScale: 0.5,
        },
      },
    }));
    maximumAcceptedSpeed = Math.max(maximumAcceptedSpeed, Math.abs(edgeState.baseSafety.output?.linearXMetersPerSecond || 0));
    acceptedCommands += 1;
    await delay(50);
  }

  edgeState = await holdBase(edgeState, "B2W Gazebo smoke-demo deadman released.");
  await delay(400);
  console.log(`Motion accepted: ${acceptedCommands} commands; peak safe output ${maximumAcceptedSpeed.toFixed(3)} m/s`);
  console.log("Deadman released: commanded output is zero");
  await releaseAll();
  console.log("Stopped acknowledgement received; ownership and lease released");
  console.log("B2W Gazebo teleoperation demo passed");
} catch (error) {
  await bestEffortCleanup();
  console.error(`B2W Gazebo teleoperation demo failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

async function activateSession(current: Session, timeoutMs: number): Promise<Session> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return requireSession(await controlRequest(`/control/v1/sessions/${sessionId}/activate`, {
        expectedRevision: current.revision,
      }));
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }
  throw lastError || new Error("Timed out waiting for robot readiness at the control plane.");
}

async function enableBaseSafety(current: EdgeState, timeoutMs: number): Promise<EdgeState> {
  const deadline = Date.now() + timeoutMs;
  let latest = current;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      latest = await getEdgeState();
      if (latest.ownership.status !== "OWNED") throw new Error(`Ownership is ${latest.ownership.status}.`);
      if (latest.baseSafety.status !== "READY" && latest.baseSafety.status !== "ENABLED") {
        latest = requireEdgeState(await edgeRequest("/edge/v1/safety/prepare", {
          expectedRevision: latest.baseSafety.revision,
        }));
      }
      if (latest.baseSafety.status === "READY") {
        latest = requireEdgeState(await edgeRequest("/edge/v1/safety/enable", {
          expectedRevision: latest.baseSafety.revision,
        }));
      }
      if (latest.baseSafety.status === "ENABLED") return latest;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw lastError || new Error("Timed out waiting for simulator safety interlocks.");
}

async function holdBase(current: EdgeState, reason: string): Promise<EdgeState> {
  if (current.baseSafety.status !== "ENABLED") return current;
  return requireEdgeState(await edgeRequest("/edge/v1/safety/hold", {
    expectedRevision: current.baseSafety.revision,
    reason,
  }));
}

async function releaseAll(): Promise<void> {
  edgeState = await getEdgeState();
  edgeState = await holdBase(edgeState, "B2W Gazebo demo completed.");
  if (edgeState.ownership.status === "OWNED") {
    edgeState = requireEdgeState(await edgeRequest("/edge/v1/ownership/release", {
      expectedRevision: edgeState.ownership.revision,
      reason: "B2W Gazebo demo completed.",
    }));
  }
  if (edgeState.ownership.status !== "NO_OWNER") {
    edgeState = await waitForEdgeState((state) => state.ownership.status === "NO_OWNER", 5_000);
  }
  if (session && session.status !== "RELEASED") {
    session = await releaseSession(session, 5_000);
  }
  if (lease) await edgeRequest(`/edge/v1/leases/${encodeURIComponent(lease.sessionId)}/revoke`, {
    reason: "B2W Gazebo demo completed.",
  });
}

async function releaseSession(current: Session, timeoutMs: number): Promise<Session> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return requireSession(await controlRequest(`/control/v1/sessions/${sessionId}/release`, {
        expectedRevision: current.revision,
        reason: "Simulator reported stopped ownership.",
      }));
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }
  throw lastError || new Error("Timed out waiting for stopped readiness at the control plane.");
}

async function bestEffortCleanup(): Promise<void> {
  try {
    await releaseAll();
  } catch (cleanupError) {
    console.error(`Cleanup warning: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
  }
}

async function waitForEdgeState(predicate: (state: EdgeState) => boolean, timeoutMs: number): Promise<EdgeState> {
  const deadline = Date.now() + timeoutMs;
  let latest: EdgeState | undefined;
  while (Date.now() < deadline) {
    latest = await getEdgeState();
    if (predicate(latest)) return latest;
    await delay(100);
  }
  throw new Error(`Timed out waiting for edge state; ownership is ${latest?.ownership.status || "unknown"}.`);
}

async function getEdgeState(): Promise<EdgeState> {
  return requireEdgeState(await edgeRequest("/edge/v1/state"));
}

async function controlRequest(path: string, body?: unknown): Promise<JsonResponse> {
  return request(controlUrl, controlToken, path, body);
}

async function edgeRequest(path: string, body?: unknown): Promise<JsonResponse> {
  return request(edgeUrl, edgeToken, path, body);
}

async function request(baseUrl: string, token: string, path: string, body?: unknown): Promise<JsonResponse> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json() as JsonResponse & { code?: string; message?: string };
  if (!response.ok) throw new Error(`${result.code || `HTTP_${response.status}`}: ${result.message || response.statusText}`);
  return result;
}

function requireSession(response: JsonResponse): Session {
  if (!response.session) throw new Error("Control-plane response did not contain a session.");
  return response.session;
}

function requireEdgeState(response: JsonResponse): EdgeState {
  if (!response.state) throw new Error("Edge response did not contain state.");
  return response.state;
}

function requiredSecret(name: string): string {
  const value = process.env[name]?.trim();
  if (!value || value.length < 16) throw new Error(`${name} must contain at least 16 characters.`);
  return value;
}

function normalizedLoopbackUrl(value: string, label: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error(`The ${label} URL must be a loopback HTTP address.`);
  }
  return url.href.replace(/\/$/, "");
}

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Duration must be an integer between ${minimum} and ${maximum} milliseconds.`);
  }
  return parsed;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
