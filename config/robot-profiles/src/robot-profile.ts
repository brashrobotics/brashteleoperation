import { readFile, stat } from "node:fs/promises";
import { fail } from "../../../packages/contracts/src/index.ts";

export type RobotProfileLifecycle = "DRAFT" | "SIMULATION_VALIDATED" | "OBSERVE_ONLY_VALIDATED" | "RESTRICTED_LAB" | "PRODUCTION_APPROVED";

export interface RobotProfile {
  schemaVersion: 1;
  profileId: string;
  lifecycle: RobotProfileLifecycle;
  robot: { vendor: string; baseModel: string; armModel: string; identityPattern: string };
  simulation: boolean;
  commandOutputEnabled: boolean;
  capabilities: { base: boolean; manipulator: boolean; gripper: boolean; rgbd: boolean };
  baseSafety: {
    commandTimeoutMs: number | null;
    maximumLinearXMetersPerSecond: number | null;
    maximumLinearYMetersPerSecond: number | null;
    maximumAngularZRadiansPerSecond: number | null;
    maximumLinearAccelerationMetersPerSecondSquared: number | null;
    maximumAngularAccelerationRadiansPerSecondSquared: number | null;
  };
  manipulationSafety: {
    baseMustBeStopped: true;
    jointCount: number;
    commandTimeoutMs: number | null;
    maximumJointJogRadiansPerSecond: readonly number[] | null;
    maximumCartesianLinearMetersPerSecond: number | null;
    maximumCartesianAngularRadiansPerSecond: number | null;
    maximumReachMeters: number | null;
    maximumPositionStdDevMeters: number | null;
    payloadKilograms: number | null;
  };
  frames: Readonly<Record<string, string>>;
  calibrations: Readonly<Record<string, string | null>>;
  unresolvedPhysicalMeasurements: readonly string[];
  physicalCommandApprovalId?: string;
}

export async function loadRobotProfile(path: string, maximumBytes = 256 * 1024): Promise<RobotProfile> {
  const info = await stat(path);
  if (!info.isFile() || info.size > maximumBytes) throw new Error(`Robot profile ${path} is missing, not a file, or too large.`);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(`Robot profile ${path} is not valid JSON.`);
  }
  assertRobotProfile(value);
  return structuredClone(value);
}

export function assertRobotProfile(value: unknown): asserts value is RobotProfile {
  if (!isRecord(value) || value.schemaVersion !== 1) fail("ROBOT_PROFILE_INVALID", "Profile schemaVersion must be 1.");
  for (const field of ["profileId", "lifecycle"] as const) requireString(value[field], field);
  if (!["DRAFT", "SIMULATION_VALIDATED", "OBSERVE_ONLY_VALIDATED", "RESTRICTED_LAB", "PRODUCTION_APPROVED"].includes(value.lifecycle as string)) {
    fail("ROBOT_PROFILE_INVALID", `Unknown profile lifecycle ${String(value.lifecycle)}.`);
  }
  if (!isRecord(value.robot) || !isRecord(value.capabilities) || !isRecord(value.baseSafety)
    || !isRecord(value.manipulationSafety) || !isRecord(value.frames) || !isRecord(value.calibrations)) {
    fail("ROBOT_PROFILE_INVALID", "Profile contains a missing or invalid section.");
  }
  if (typeof value.simulation !== "boolean" || typeof value.commandOutputEnabled !== "boolean") {
    fail("ROBOT_PROFILE_INVALID", "simulation and commandOutputEnabled must be booleans.");
  }
  for (const field of ["vendor", "baseModel", "armModel", "identityPattern"]) requireString(value.robot[field], `robot.${field}`);
  for (const field of ["base", "manipulator", "gripper", "rgbd"]) {
    if (typeof value.capabilities[field] !== "boolean") fail("ROBOT_PROFILE_INVALID", `capabilities.${field} must be boolean.`);
  }
  if (value.manipulationSafety.baseMustBeStopped !== true) fail("ROBOT_PROFILE_SAFETY_INVALID", "baseMustBeStopped cannot be disabled.");
  const numeric = [
    ...Object.entries(value.baseSafety),
    ...Object.entries(value.manipulationSafety).filter(([field]) => !["baseMustBeStopped", "jointCount", "maximumJointJogRadiansPerSecond"].includes(field)),
  ];
  for (const [field, setting] of numeric) {
    if (setting !== null && (typeof setting !== "number" || !Number.isFinite(setting) || setting <= 0)) {
      fail("ROBOT_PROFILE_LIMIT_INVALID", `${field} must be null or a positive finite number.`);
    }
  }
  if (!Number.isSafeInteger(value.manipulationSafety.jointCount) || (value.manipulationSafety.jointCount as number) < 1) {
    fail("ROBOT_PROFILE_LIMIT_INVALID", "manipulationSafety.jointCount must be positive.");
  }
  const jointJog = value.manipulationSafety.maximumJointJogRadiansPerSecond;
  if (jointJog !== null && (!Array.isArray(jointJog) || jointJog.length !== value.manipulationSafety.jointCount
    || jointJog.some((setting) => typeof setting !== "number" || !Number.isFinite(setting) || setting <= 0))) {
    fail("ROBOT_PROFILE_LIMIT_INVALID", "Joint jog limits must match the positive joint count.");
  }
  if (!Array.isArray(value.unresolvedPhysicalMeasurements)
    || value.unresolvedPhysicalMeasurements.some((item) => typeof item !== "string" || !item.trim())) {
    fail("ROBOT_PROFILE_INVALID", "unresolvedPhysicalMeasurements must be a string array.");
  }
  if (Object.keys(value.frames).length === 0 || Object.values(value.frames).some((frame) => typeof frame !== "string" || !frame.trim())) {
    fail("ROBOT_PROFILE_INVALID", "frames must contain non-empty frame names.");
  }
  if (Object.keys(value.calibrations).length === 0
    || Object.values(value.calibrations).some((calibration) => calibration !== null && (typeof calibration !== "string" || !calibration.trim()))) {
    fail("ROBOT_PROFILE_INVALID", "calibrations must contain null or non-empty IDs.");
  }
  const hasMissingLimit = numeric.some(([, setting]) => setting === null) || jointJog === null
    || Object.values(value.calibrations).some((setting) => setting === null);
  if (value.simulation) {
    if (value.lifecycle !== "SIMULATION_VALIDATED" || hasMissingLimit || value.unresolvedPhysicalMeasurements.length > 0) {
      fail("ROBOT_PROFILE_SIMULATION_INVALID", "Simulation profile must be complete and SIMULATION_VALIDATED.");
    }
  } else if (value.commandOutputEnabled) {
    if (value.lifecycle !== "PRODUCTION_APPROVED" || hasMissingLimit || value.unresolvedPhysicalMeasurements.length > 0
      || typeof value.physicalCommandApprovalId !== "string" || !value.physicalCommandApprovalId.trim()) {
      fail("ROBOT_PROFILE_PHYSICAL_OUTPUT_LOCKED", "Physical output requires a complete PRODUCTION_APPROVED profile and approval ID.");
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string): void {
  if (typeof value !== "string" || !value.trim()) fail("ROBOT_PROFILE_INVALID", `${field} must be a non-empty string.`);
}
