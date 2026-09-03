import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CONTRACT_VERSION } from "../../packages/contracts/src/index.ts";

const controlToken = "process-control-token-long";
const edgeToken = "process-edge-token-long-value";

test("control process restores durable workflow and edge restart restores no authority", async () => {
  const directory = await mkdtemp(join(tmpdir(), "brash-process-restart-"));
  const stateFile = join(directory, "control-state.json");
  let control: RunningProcess | undefined;
  let edge: RunningProcess | undefined;
  try {
    control = await startProcess("apps/control-plane-api/src/dev.ts", {
      BRASH_TELEOP_CONTROL_TOKEN: controlToken,
      BRASH_TELEOP_CONTROL_PORT: "0",
      BRASH_TELEOP_STATE_FILE: stateFile,
    }, /ready at (http:\/\/[^\s]+)/);
    let response = await postJson(`${control.url}/assistance/v1/requests`, controlToken, {
      contractVersion: CONTRACT_VERSION,
      requestId: "process-request-1",
      robotId: "robot-1",
      taskId: "task-1",
      reason: "OBJECT_NOT_RECOGNIZED",
      requestedInput: "SELECT_TARGET",
      observations: [{ observationId: "observation-1", robotId: "robot-1", capturedAtUnixMs: Date.now(), sceneRevision: "scene-1", calibrationVersion: "cal-1", frameIds: ["camera"] }],
      createdAtUnixMs: Date.now(),
      expiresAtUnixMs: Date.now() + 60_000,
    });
    assert.equal(response.status, 201);
    await control.stop(); control = undefined;

    control = await startProcess("apps/control-plane-api/src/dev.ts", {
      BRASH_TELEOP_CONTROL_TOKEN: controlToken,
      BRASH_TELEOP_CONTROL_PORT: "0",
      BRASH_TELEOP_STATE_FILE: stateFile,
    }, /ready at (http:\/\/[^\s]+)/);
    response = await getJson(`${control.url}/assistance/v1/requests/process-request-1`, controlToken);
    assert.equal(response.status, 200);
    assert.equal((response.body.assistance as Record<string, unknown>).status, "OPEN");

    edge = await startProcess("edge/robot-agent/src/dev.ts", {
      BRASH_TELEOP_EDGE_TOKEN: edgeToken,
      BRASH_TELEOP_EDGE_PORT: "0",
      BRASH_TELEOP_ROBOT_ID: "robot-1",
    }, /ready at (http:\/\/[^\s]+)/);
    const now = Date.now();
    response = await postJson(`${edge.url}/edge/v1/leases`, edgeToken, {
      lease: { contractVersion: CONTRACT_VERSION, sessionId: "session-1", robotId: "robot-1", operatorId: "operator-1", scopes: ["CONTROL_BASE"], revision: 1, issuedAtUnixMs: now, expiresAtUnixMs: now + 10_000 },
    });
    response = await postJson(`${edge.url}/edge/v1/ownership/request`, edgeToken, { sessionId: "session-1", actuatorGroup: "BASE" });
    let robot = response.body.state as RobotState;
    response = await postJson(`${edge.url}/edge/v1/ownership/stopped-ack`, edgeToken, {
      expectedRevision: robot.ownership.revision,
      evidence: { observedAtUnixMs: Date.now(), controllerStateFresh: true, baseStopped: true, manipulatorHolding: true },
    });
    robot = response.body.state as RobotState;
    response = await postJson(`${edge.url}/edge/v1/safety/interlocks`, edgeToken, { interlocks: { vendorSafetyOk: true, controllerHealthy: true, robotStateFresh: true } });
    robot = response.body.state as RobotState;
    response = await postJson(`${edge.url}/edge/v1/safety/prepare`, edgeToken, { expectedRevision: robot.baseSafety.revision });
    robot = response.body.state as RobotState;
    response = await postJson(`${edge.url}/edge/v1/safety/enable`, edgeToken, { expectedRevision: robot.baseSafety.revision });
    robot = response.body.state as RobotState;
    response = await postJson(`${edge.url}/edge/v1/commands`, edgeToken, {
      command: { contractVersion: CONTRACT_VERSION, commandId: "command-1", sessionId: "session-1", robotId: "robot-1", sourceId: "operator-1", actuatorGroup: "BASE", sequence: 1, producedAtUnixMs: Date.now(), expiresAtUnixMs: Date.now() + 200, deadman: true, intent: { kind: "BASE_MOTION", frameId: "base_link", linearXMetersPerSecond: 0.2, linearYMetersPerSecond: 0, angularZRadiansPerSecond: 0, speedScale: 1 } },
    });
    robot = response.body.state as RobotState;
    assert.ok(robot.baseSafety.output.linearXMetersPerSecond >= 0);
    await edge.stop(); edge = undefined;

    edge = await startProcess("edge/robot-agent/src/dev.ts", {
      BRASH_TELEOP_EDGE_TOKEN: edgeToken,
      BRASH_TELEOP_EDGE_PORT: "0",
      BRASH_TELEOP_ROBOT_ID: "robot-1",
    }, /ready at (http:\/\/[^\s]+)/);
    response = await getJson(`${edge.url}/edge/v1/state`, edgeToken);
    robot = response.body.state as RobotState;
    assert.equal(robot.installedLeases.length, 0);
    assert.equal(robot.ownership.status, "NO_OWNER");
    assert.equal(robot.baseSafety.output.linearXMetersPerSecond, 0);
    assert.equal(robot.baseSafety.output.linearYMetersPerSecond, 0);
    assert.equal(robot.baseSafety.output.angularZRadiansPerSecond, 0);
  } finally {
    await edge?.stop();
    await control?.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

interface RunningProcess { url: string; stop(): Promise<void> }
interface RobotState {
  installedLeases: unknown[];
  ownership: { status: string; revision: number };
  baseSafety: { revision: number; output: { linearXMetersPerSecond: number; linearYMetersPerSecond: number; angularZRadiansPerSecond: number } };
}

async function startProcess(script: string, environment: Record<string, string>, readyPattern: RegExp): Promise<RunningProcess> {
  const child = spawn(process.execPath, [script], {
    cwd: fileURLRoot(),
    env: { ...process.env, ...environment },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const url = await waitForUrl(child, readyPattern);
  return { url, stop: () => stopProcess(child) };
}

function waitForUrl(child: ChildProcessWithoutNullStreams, pattern: RegExp): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error(`Child process did not become ready: ${output}`)), 5_000);
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      const match = output.match(pattern);
      if (match?.[1]) { clearTimeout(timeout); resolve(match[1]); }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`Child exited before readiness with ${code}: ${output}`)); });
  });
}

async function stopProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 3_000);
    child.once("exit", () => { clearTimeout(timeout); resolve(); });
  });
}

function fileURLRoot(): string {
  return new URL("../../", import.meta.url).pathname;
}

async function postJson(url: string, token: string, value: unknown) {
  const response = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(value) });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function getJson(url: string, token: string) {
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}
