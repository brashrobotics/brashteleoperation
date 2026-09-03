import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CONTRACT_VERSION } from "../../packages/contracts/src/index.ts";
import { AtomicJsonFileStore } from "../../packages/persistence/src/index.ts";
import { ControlPlaneRuntime } from "../../services/control-plane-runtime/src/index.ts";
import { InMemoryFleetTeleoperationPort } from "../../services/session-control/src/index.ts";

test("control-plane state survives restart and overdue work expires during recovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "brash-control-recovery-"));
  const stateFilePath = join(directory, "state.json");
  let now = 10_000;
  try {
    const first = await ControlPlaneRuntime.open({ stateFilePath, now: () => now });
    let session = first.sessions.requestSession({
      sessionId: "session-1",
      robotId: "robot-1",
      operatorId: "operator-1",
      scopes: ["CONTROL_BASE"],
    });
    session = first.sessions.grantSession(session.sessionId, session.revision, 2_000);
    first.robotReadiness.record(session, {
      contractVersion: CONTRACT_VERSION,
      readinessId: "readiness-1",
      sessionId: session.sessionId,
      robotId: session.robotId,
      operatorId: session.operatorId,
      leaseRevision: session.lease!.revision,
      ownershipRevision: 1,
      ownershipStatus: "NO_OWNER",
      reportedAtUnixMs: now,
    });
    first.assistance.open({
      contractVersion: CONTRACT_VERSION,
      requestId: "request-1",
      robotId: "robot-1",
      taskId: "task-1",
      reason: "OBJECT_NOT_RECOGNIZED",
      requestedInput: "SELECT_TARGET",
      observations: [{
        observationId: "observation-1",
        robotId: "robot-1",
        capturedAtUnixMs: now,
        sceneRevision: "scene-1",
        calibrationVersion: "calibration-1",
        frameIds: ["camera"],
      }],
      createdAtUnixMs: now,
      expiresAtUnixMs: now + 3_000,
    });
    first.registry.createCandidate({
      versionId: "registry-version-1",
      objectClassId: "class-1",
      semanticLabel: "container",
      siteIds: ["site-1"],
      robotCapabilities: ["b2-z1"],
      supportedIntents: ["PICK"],
      source: { requestId: "request-1", taskId: "task-1", robotId: "robot-1", declarationId: "declaration-1", groundedObjectId: "object-1", outcomeId: "outcome-1" },
      evidence: [{ artifactId: "artifact-1", observationId: "observation-1", mediaType: "image/png", sha256: "a".repeat(64), byteLength: 10, capturedAtUnixMs: now }],
      createdBy: "operator-1",
    });
    await first.persist();

    now += 2_500;
    const second = await ControlPlaneRuntime.open({ stateFilePath, now: () => now });
    assert.equal(second.sessions.getSession(session.sessionId).status, "EXPIRED");
    assert.equal(second.assistance.get("request-1").status, "OPEN");
    assert.equal(second.sessions.getEvents(session.sessionId).at(-1)?.type, "SESSION_EXPIRED");
    assert.equal(second.registry.getVersion("registry-version-1").semanticLabel, "container");
    assert.equal(second.robotReadiness.get(session.sessionId).report.readinessId, "readiness-1");

    now += 600;
    const third = await ControlPlaneRuntime.open({ stateFilePath, now: () => now });
    assert.equal(third.assistance.get("request-1").status, "EXPIRED");
    assert.equal(third.assistance.getEvents("request-1").at(-1)?.type, "ASSISTANCE_EXPIRED");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("atomic JSON store rejects tampered snapshots", async () => {
  const directory = await mkdtemp(join(tmpdir(), "brash-checksum-"));
  const filePath = join(directory, "state.json");
  try {
    const store = new AtomicJsonFileStore<{ counter: number }>(filePath);
    await store.save({ counter: 1 });
    const raw = await readFile(filePath, "utf8");
    await writeFile(filePath, raw.replace('"counter":1', '"counter":2'), "utf8");
    await assert.rejects(store.load(), /checksum mismatch/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Fleet reservation and release-retry state survives control-plane restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "brash-fleet-recovery-"));
  const stateFilePath = join(directory, "state.json");
  const fleet = new InMemoryFleetTeleoperationPort();
  try {
    const first = await ControlPlaneRuntime.open({ stateFilePath, fleet, now: () => 1_000 });
    await assert.rejects(first.fleetSessions!.authorize({ sessionId: "session-1", robotId: "robot-1" }));
    fleet.confirmRobotStopped("session-1");
    const reserved = await first.fleetSessions!.authorize({ sessionId: "session-1", robotId: "robot-1" });
    assert.equal(reserved.status, "RESERVED");
    await first.persist();

    const second = await ControlPlaneRuntime.open({ stateFilePath, fleet, now: () => 1_100 });
    assert.equal(second.fleetSessions!.get("session-1")?.status, "RESERVED");
    assert.equal((await second.fleetSessions!.releaseTracked("session-1"))?.status, "RELEASED");
    await second.persist();

    const third = await ControlPlaneRuntime.open({ stateFilePath, fleet, now: () => 1_200 });
    assert.equal(third.fleetSessions!.get("session-1")?.status, "RELEASED");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
