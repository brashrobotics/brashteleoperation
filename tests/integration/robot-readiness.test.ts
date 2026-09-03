import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTRACT_VERSION,
  TeleoperationError,
  type RobotSessionReadinessReport,
} from "../../packages/contracts/src/index.ts";
import { InMemoryRobotReadiness, InMemorySessionControl } from "../../services/session-control/src/index.ts";

test("robot readiness gates activation and stopped release with exact lease and ownership revisions", () => {
  let now = 1_000;
  const sessions = new InMemorySessionControl({ now: () => now });
  const readiness = new InMemoryRobotReadiness({ now: () => now });
  let session = sessions.requestSession({
    sessionId: "session-1",
    robotId: "robot-1",
    operatorId: "operator-1",
    scopes: ["CONTROL_BASE"],
  });
  session = sessions.grantSession(session.sessionId, session.revision, 10_000);
  session = sessions.markConnecting(session.sessionId, session.revision);

  assert.throws(
    () => readiness.requireOwnershipGranted(session),
    (error) => error instanceof TeleoperationError && error.code === "ROBOT_READINESS_NOT_FOUND",
  );
  const owned = report({ readinessId: "readiness-1", ownershipRevision: 3, ownershipStatus: "OWNED", actuatorGroup: "BASE", reportedAtUnixMs: now });
  const record = readiness.record(session, owned);
  assert.equal(readiness.record(session, owned).revision, record.revision);
  readiness.requireOwnershipGranted(session);

  assert.throws(
    () => readiness.record(session, { ...owned, robotId: "robot-2" }),
    (error) => error instanceof TeleoperationError && error.code === "ROBOT_READINESS_IDENTITY_MISMATCH",
  );
  assert.throws(
    () => readiness.record(session, { ...owned, ownershipRevision: 4 }),
    (error) => error instanceof TeleoperationError && error.code === "ROBOT_READINESS_ID_COLLISION",
  );

  session = sessions.activate(session.sessionId, session.revision, true);
  now += 100;
  readiness.record(session, report({
    readinessId: "readiness-2",
    ownershipRevision: 5,
    ownershipStatus: "NO_OWNER",
    reportedAtUnixMs: now,
  }));
  readiness.requireOwnershipCleared(session);
  session = sessions.release(session.sessionId, session.revision, true);
  assert.equal(session.status, "RELEASED");
});

test("robot readiness becomes stale and renewal requires a report for the new lease revision", () => {
  let now = 1_000;
  const sessions = new InMemorySessionControl({ now: () => now });
  const readiness = new InMemoryRobotReadiness({ now: () => now, maximumReportAgeMs: 100 });
  let session = sessions.requestSession({ sessionId: "session-1", robotId: "robot-1", operatorId: "operator-1", scopes: ["CONTROL_BASE"] });
  session = sessions.grantSession(session.sessionId, session.revision, 10_000);
  session = sessions.markConnecting(session.sessionId, session.revision);
  readiness.record(session, report({ readinessId: "readiness-1", ownershipRevision: 3, ownershipStatus: "OWNED", actuatorGroup: "BASE", reportedAtUnixMs: now }));
  now += 101;
  assert.throws(
    () => readiness.requireOwnershipGranted(session),
    (error) => error instanceof TeleoperationError && error.code === "ROBOT_READINESS_STALE",
  );

  session = sessions.activate(session.sessionId, session.revision, true);
  session = sessions.hold(session.sessionId, session.revision, "Renewing edge lease.");
  session = sessions.renewSession(session.sessionId, session.revision, 10_000);
  assert.throws(
    () => readiness.requireOwnershipGranted(session),
    (error) => error instanceof TeleoperationError && error.code === "ROBOT_READINESS_LEASE_REVISION_MISMATCH",
  );
});

function report(overrides: Partial<RobotSessionReadinessReport> = {}): RobotSessionReadinessReport {
  return { ...baseReport(), ...overrides };
}

function baseReport(): RobotSessionReadinessReport {
  return {
    contractVersion: CONTRACT_VERSION,
    readinessId: "readiness-base",
    sessionId: "session-1",
    robotId: "robot-1",
    operatorId: "operator-1",
    leaseRevision: 1,
    ownershipRevision: 1,
    ownershipStatus: "NO_OWNER",
    reportedAtUnixMs: 1_000,
  };
}
