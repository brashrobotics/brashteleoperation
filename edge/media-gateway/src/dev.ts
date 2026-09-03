import { randomUUID } from "node:crypto";
import { StaticBearerIdentityProvider } from "../../../packages/identity/src/index.ts";
import { fail } from "../../../packages/contracts/src/index.ts";
import type { DepthObservation } from "../../../robot/interactive-perception/src/index.ts";
import {
  HttpRobotAssistancePort,
  RobotAssistanceWorker,
  SimulationAssistanceBackend,
} from "../../../workers/simulation-assistance/src/index.ts";
import { MediaGateway } from "./media-gateway.ts";
import { startMediaGatewayTestServer } from "./server.ts";
import { createSimulationObservationPng } from "./simulation-fixture.ts";

const operatorToken = process.env.BRASH_TELEOP_CONTROL_TOKEN;
const robotControlToken = process.env.BRASH_TELEOP_ROBOT_CONTROL_TOKEN;
const signingSecret = process.env.BRASH_TELEOP_MEDIA_SIGNING_SECRET;
if (!operatorToken || !robotControlToken || !signingSecret) {
  throw new Error("BRASH_TELEOP_CONTROL_TOKEN, BRASH_TELEOP_ROBOT_CONTROL_TOKEN, and BRASH_TELEOP_MEDIA_SIGNING_SECRET are required.");
}
const operatorId = process.env.BRASH_TELEOP_OPERATOR_ID?.trim() || "operator-001";
const robotId = process.env.BRASH_TELEOP_ROBOT_ID?.trim() || "b2-unit-001";
const controlPlaneUrl = validatedControlUrl(process.env.BRASH_TELEOP_CONTROL_URL?.trim() || "http://127.0.0.1:4310/");
const operatorOrigin = new URL(process.env.BRASH_TELEOP_OPERATOR_ORIGIN?.trim() || "http://127.0.0.1:4310").origin;
const now = Date.now();
const observationId = randomUUID();
const requestId = randomUUID();
const imageWidth = 640;
const imageHeight = 360;
const depthMeters = Array.from(
  { length: imageWidth * imageHeight },
  (_, index) => 0.55 + ((index % 7) * 0.0002),
);
const gateway = new MediaGateway({ robotId, signingSecret });
gateway.registerCamera({ cameraId: "simulation-rgb", robotId, frameId: "simulation_color_optical_frame", calibrationVersion: "simulation-calibration-v1", kind: "RGB" });
gateway.registerCamera({ cameraId: "simulation-depth", robotId, frameId: "simulation_depth_optical_frame", calibrationVersion: "simulation-calibration-v1", kind: "DEPTH" });
gateway.ingest({
  frameId: `rgb-${observationId}`,
  cameraId: "simulation-rgb",
  robotId,
  sequence: 1,
  sourceTimestampUnixMs: now,
  receivedAtUnixMs: now,
  mediaType: "image/png",
  bytes: createSimulationObservationPng(),
});
gateway.ingest({
  frameId: `depth-${observationId}`,
  cameraId: "simulation-depth",
  robotId,
  sequence: 1,
  sourceTimestampUnixMs: now,
  receivedAtUnixMs: now,
  mediaType: "application/x-depth-f32",
  bytes: new Uint8Array(Float32Array.from(depthMeters).buffer),
});
const observation = gateway.createObservation({
  rgbCameraId: "simulation-rgb",
  depthCameraId: "simulation-depth",
  sceneRevision: `simulation-scene-${observationId}`,
  observationId,
});
const depthObservation: DepthObservation = {
  reference: observation.reference,
  imageFrameId: "simulation_color_optical_frame",
  poseFrameId: "base_link",
  intrinsics: {
    width: imageWidth,
    height: imageHeight,
    fx: 2_000,
    fy: 2_000,
    cx: imageWidth / 2,
    cy: imageHeight / 2,
  },
  depthMeters,
  cameraOriginInPoseFrameMeters: [0.45, 0, 0],
};

const identityProvider = new StaticBearerIdentityProvider([{
  token: operatorToken,
  principal: { subject: "development:operator", operatorId, roles: ["SUPERVISOR"] },
}]);
const running = await startMediaGatewayTestServer({
  gateway,
  identityProvider,
  host: process.env.BRASH_TELEOP_MEDIA_HOST?.trim() || "127.0.0.1",
  port: positiveInteger(process.env.BRASH_TELEOP_MEDIA_PORT, 4_312, "BRASH_TELEOP_MEDIA_PORT"),
  allowedOrigins: [operatorOrigin],
  authorizeObservationAccess: (principal, candidate) => {
    if (principal.operatorId !== operatorId || candidate.reference.observationId !== observationId) {
      fail("MEDIA_OBSERVATION_ACCESS_DENIED", "Operator is not authorized for this simulation observation.");
    }
  },
});

try {
  await seedAssistanceRequest(controlPlaneUrl, robotControlToken, requestId, observation.reference, now);
} catch (error) {
  await running.close();
  throw error;
}
const worker = new RobotAssistanceWorker({
  requestId,
  port: new HttpRobotAssistancePort({
    controlPlaneUrl: controlPlaneUrl.href,
    bearerToken: robotControlToken,
  }),
  backend: new SimulationAssistanceBackend({
    robotId,
    observations: new Map([[observationId, depthObservation]]),
  }),
});

console.log(`BRASH immutable media simulator ready at ${running.url}`);
console.log(`Seeded unknown-object request ${requestId} with observation ${observationId}. Configure the operator console media API as ${running.url}.`);
console.log("A robot-authenticated simulation worker will ground, plan, simulate execution, verify, and resolve after operator declaration and exact approval.");
console.log("This process serves frozen simulation imagery and drives only SimulatedRobotAdapter; it has no physical actuator path.");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    worker.close();
    await running.close();
    process.exit(0);
  });
}

async function seedAssistanceRequest(
  baseUrl: URL,
  token: string,
  requestId: string,
  reference: typeof observation.reference,
  createdAtUnixMs: number,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2_000);
  let response: Response;
  try {
    response = await fetch(new URL("assistance/v1/requests", baseUrl), {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        contractVersion: { major: 1, minor: 0 },
        requestId,
        robotId,
        taskId: `simulation-pick-${observationId}`,
        reason: "OBJECT_NOT_RECOGNIZED",
        requestedInput: "SELECT_TARGET",
        observations: [reference],
        createdAtUnixMs,
        expiresAtUnixMs: createdAtUnixMs + 10 * 60_000,
      }),
    });
  } catch (error) {
    throw new Error(`Cannot seed simulation assistance request: ${error instanceof Error ? error.message : "request failed"}.`);
  } finally {
    clearTimeout(timer);
  }
  const advertised = Number(response.headers.get("content-length"));
  if (Number.isFinite(advertised) && advertised > 64 * 1024) throw new Error("Control-plane seed response is oversized.");
  const body = await response.text();
  if (Buffer.byteLength(body) > 64 * 1024) throw new Error("Control-plane seed response is oversized.");
  if (!response.ok) throw new Error(`Control plane rejected simulation assistance seed (${response.status}): ${body.slice(0, 512)}`);
}

function validatedControlUrl(value: string): URL {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const loopback = hostname === "localhost" || hostname === "::1" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
  if (url.username || url.password || url.search || url.hash
    || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) {
    throw new Error("BRASH_TELEOP_CONTROL_URL must use HTTPS, except for loopback development.");
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) throw new Error(`${name} must be a valid port.`);
  return parsed;
}
