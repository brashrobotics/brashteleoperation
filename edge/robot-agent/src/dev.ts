import { LocalRobotAgent } from "./local-robot-agent.ts";
import { startRobotAgentTestServer } from "./server.ts";
import { fileURLToPath } from "node:url";
import { createPublicKey } from "node:crypto";
import { readFile } from "node:fs/promises";
import { loadRobotProfile } from "../../../config/robot-profiles/src/index.ts";
import {
  HttpRobotReadinessPublisher,
  RobotReadinessReporter,
} from "./readiness-reporter.ts";
import { Ed25519LeaseVerifier } from "../../../packages/contracts/src/index.ts";

const bearerToken = process.env.BRASH_TELEOP_EDGE_TOKEN?.trim();
if (!bearerToken) throw new Error("BRASH_TELEOP_EDGE_TOKEN is required.");
const robotId = process.env.BRASH_TELEOP_ROBOT_ID?.trim() || "b2-unit-001";
const leaseSigningKeyId = process.env.BRASH_TELEOP_LEASE_SIGNING_KEY_ID?.trim();
const leaseSigningPublicKeyFile = process.env.BRASH_TELEOP_LEASE_SIGNING_PUBLIC_KEY_FILE?.trim();
if (Boolean(leaseSigningKeyId) !== Boolean(leaseSigningPublicKeyFile)) {
  throw new Error("BRASH_TELEOP_LEASE_SIGNING_KEY_ID and BRASH_TELEOP_LEASE_SIGNING_PUBLIC_KEY_FILE must be configured together.");
}
const leaseVerifier = leaseSigningKeyId && leaseSigningPublicKeyFile
  ? new Ed25519LeaseVerifier(new Map([[
      leaseSigningKeyId,
      createPublicKey(await readFile(leaseSigningPublicKeyFile)),
    ]]))
  : undefined;
const controlPlaneUrl = process.env.BRASH_TELEOP_CONTROL_URL?.trim();
const robotControlToken = process.env.BRASH_TELEOP_ROBOT_CONTROL_TOKEN?.trim();
if (Boolean(controlPlaneUrl) !== Boolean(robotControlToken)) {
  throw new Error("BRASH_TELEOP_CONTROL_URL and BRASH_TELEOP_ROBOT_CONTROL_TOKEN must be configured together.");
}
const profilePath = process.env.BRASH_TELEOP_ROBOT_PROFILE?.trim()
  || fileURLToPath(new URL("../../../config/robot-profiles/b2-z1.simulation.json", import.meta.url));
const profile = await loadRobotProfile(profilePath);
if (!profile.simulation || !profile.commandOutputEnabled) {
  throw new Error("The HTTP edge development transport accepts only an output-enabled simulation profile.");
}
const base = profile.baseSafety;
if (Object.values(base).some((value) => value === null)) throw new Error("Simulation base-safety limits must be complete.");

const agent = new LocalRobotAgent({
  robotId,
  leaseVerifier,
  requireSignedLeases: Boolean(leaseVerifier),
  baseSafetyProfile: {
    robotId,
    commandTimeoutMs: base.commandTimeoutMs!,
    maximumLinearXMetersPerSecond: base.maximumLinearXMetersPerSecond!,
    maximumLinearYMetersPerSecond: base.maximumLinearYMetersPerSecond!,
    maximumAngularZRadiansPerSecond: base.maximumAngularZRadiansPerSecond!,
    maximumLinearAccelerationMetersPerSecondSquared: base.maximumLinearAccelerationMetersPerSecondSquared!,
    maximumAngularAccelerationRadiansPerSecondSquared: base.maximumAngularAccelerationRadiansPerSecondSquared!,
  },
  manipulatorSafetyProfile: {
    robotId,
    commandTimeoutMs: profile.manipulationSafety.commandTimeoutMs!,
    jointCount: profile.manipulationSafety.jointCount,
    maximumJointJogRadiansPerSecond: profile.manipulationSafety.maximumJointJogRadiansPerSecond!,
    maximumCartesianLinearMetersPerSecond: profile.manipulationSafety.maximumCartesianLinearMetersPerSecond!,
    maximumCartesianAngularRadiansPerSecond: profile.manipulationSafety.maximumCartesianAngularRadiansPerSecond!,
  },
});
const readinessReporter = controlPlaneUrl && robotControlToken
  ? new RobotReadinessReporter({
      publisher: new HttpRobotReadinessPublisher({
        controlPlaneUrl,
        bearerToken: robotControlToken,
        requestTimeoutMs: optionalPositiveInteger(process.env.BRASH_TELEOP_CONTROL_TIMEOUT_MS, 2_000),
      }),
    })
  : undefined;
const running = await startRobotAgentTestServer({
  agent,
  bearerToken,
  host: process.env.BRASH_TELEOP_EDGE_HOST?.trim() || "127.0.0.1",
  port: Number.parseInt(process.env.BRASH_TELEOP_EDGE_PORT || "4311", 10),
  operatorOrigin: process.env.BRASH_TELEOP_OPERATOR_ORIGIN?.trim(),
  onReadinessReport: readinessReporter ? (report) => { readinessReporter.enqueue(report); } : undefined,
});

console.log(`BRASH robot-agent HTTP test transport ready at ${running.url}`);
console.log(`Simulation profile ${profile.profileId} loaded. Physical hardware output remains disabled.`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    readinessReporter?.close();
    await running.close();
    process.exit(0);
  });
}

function optionalPositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error("BRASH_TELEOP_CONTROL_TIMEOUT_MS must be a positive integer.");
  return parsed;
}
