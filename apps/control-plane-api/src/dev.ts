import { startControlPlaneApi } from "./server.ts";
import { createPrivateKey } from "node:crypto";
import { readFile } from "node:fs/promises";
import { ControlPlaneRuntime } from "../../../services/control-plane-runtime/src/index.ts";
import {
  HttpFleetTeleoperationPort,
} from "../../../services/session-control/src/index.ts";
import { StaticBearerIdentityProvider } from "../../../packages/identity/src/index.ts";
import { Ed25519LeaseSigner } from "../../../packages/contracts/src/index.ts";

const bearerToken = process.env.BRASH_TELEOP_CONTROL_TOKEN?.trim();
if (!bearerToken) throw new Error("BRASH_TELEOP_CONTROL_TOKEN is required.");
const robotControlToken = process.env.BRASH_TELEOP_ROBOT_CONTROL_TOKEN?.trim();
const robotId = process.env.BRASH_TELEOP_ROBOT_ID?.trim();
if (Boolean(robotControlToken) !== Boolean(robotId)) {
  throw new Error("BRASH_TELEOP_ROBOT_CONTROL_TOKEN and BRASH_TELEOP_ROBOT_ID must be configured together.");
}
const identityProvider = new StaticBearerIdentityProvider([
  {
    token: bearerToken,
    principal: {
      subject: "development:operator",
      operatorId: process.env.BRASH_TELEOP_OPERATOR_ID?.trim() || "operator-001",
      roles: ["SUPERVISOR"],
    },
  },
  ...(robotControlToken && robotId ? [{
    token: robotControlToken,
    principal: {
      subject: `development:robot:${robotId}`,
      operatorId: "robot-edge-service",
      robotId,
      roles: ["ROBOT" as const],
    },
  }] : []),
]);
const leaseSigningKeyId = process.env.BRASH_TELEOP_LEASE_SIGNING_KEY_ID?.trim();
const leaseSigningPrivateKeyFile = process.env.BRASH_TELEOP_LEASE_SIGNING_PRIVATE_KEY_FILE?.trim();
if (Boolean(leaseSigningKeyId) !== Boolean(leaseSigningPrivateKeyFile)) {
  throw new Error("BRASH_TELEOP_LEASE_SIGNING_KEY_ID and BRASH_TELEOP_LEASE_SIGNING_PRIVATE_KEY_FILE must be configured together.");
}
const leaseSigner = leaseSigningKeyId && leaseSigningPrivateKeyFile
  ? new Ed25519LeaseSigner(leaseSigningKeyId, createPrivateKey(await readFile(leaseSigningPrivateKeyFile)))
  : undefined;

const fleetUrl = process.env.BRASH_TELEOP_FLEET_URL?.trim();
const fleetToken = process.env.BRASH_TELEOP_FLEET_TOKEN?.trim();
if (Boolean(fleetUrl) !== Boolean(fleetToken)) {
  throw new Error("BRASH_TELEOP_FLEET_URL and BRASH_TELEOP_FLEET_TOKEN must be configured together.");
}
const fleet = fleetUrl && fleetToken
  ? new HttpFleetTeleoperationPort({
      baseUrl: fleetUrl,
      bearerToken: fleetToken,
      requestTimeoutMs: optionalPositiveInteger(process.env.BRASH_TELEOP_FLEET_TIMEOUT_MS, 2_000),
    })
  : undefined;

const runtime = await ControlPlaneRuntime.open({
  stateFilePath: process.env.BRASH_TELEOP_STATE_FILE?.trim() || ".local/control-plane-state.json",
  fleet,
});
const fleetSessions = runtime.fleetSessions;

const running = await startControlPlaneApi({
  identityProvider,
  host: process.env.BRASH_TELEOP_CONTROL_HOST?.trim() || "127.0.0.1",
  port: Number.parseInt(process.env.BRASH_TELEOP_CONTROL_PORT || "4310", 10),
  sessions: runtime.sessions,
  assistance: runtime.assistance,
  registry: runtime.registry,
  signaling: runtime.signaling,
  robotReadiness: runtime.robotReadiness,
  leaseSigner,
  operatorConnectOrigins: parseOrigins(process.env.BRASH_TELEOP_OPERATOR_CONNECT_ORIGINS),
  persistenceLabel: "atomic-json-file",
  afterMutation: () => runtime.persist(),
  authorizeCommandLease: fleetSessions
    ? async (session) => { await fleetSessions.authorize({ sessionId: session.sessionId, robotId: session.robotId }); }
    : undefined,
  releaseCommandReservation: fleetSessions
    ? async (session) => {
        return (await fleetSessions.releaseTrackedWithResult(session.sessionId)).changed;
      }
    : undefined,
  allowUncoordinatedCommandLeases: process.env.BRASH_TELEOP_ALLOW_UNCOORDINATED_SIMULATION === "true",
});

console.log(`BRASH teleoperation control-plane API ready at ${running.url}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    await running.close();
    process.exit(0);
  });
}

function optionalPositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error("BRASH_TELEOP_FLEET_TIMEOUT_MS must be a positive integer.");
  return parsed;
}

function parseOrigins(value: string | undefined): string[] {
  if (value === undefined) return ["http://127.0.0.1:4312"];
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}
