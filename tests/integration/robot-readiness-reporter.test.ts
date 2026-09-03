import assert from "node:assert/strict";
import test from "node:test";
import {
  HttpRobotReadinessPublisher,
  RobotReadinessReporter,
  type RobotReadinessPublisher,
} from "../../edge/robot-agent/src/index.ts";
import { CONTRACT_VERSION, TeleoperationError, type RobotSessionReadinessReport } from "../../packages/contracts/src/index.ts";

test("HTTP readiness publisher sends only the canonical report to the bound session endpoint", async () => {
  const report = readiness({ readinessId: "readiness-1", ownershipRevision: 3, ownershipStatus: "OWNED", actuatorGroup: "BASE" });
  let requestSeen = false;
  const publisher = new HttpRobotReadinessPublisher({
    controlPlaneUrl: "http://127.0.0.1:4310/",
    bearerToken: "robot-control-token-long",
    fetchImplementation: async (input, init) => {
      requestSeen = true;
      assert.equal(String(input), "http://127.0.0.1:4310/control/v1/sessions/session-1/robot-readiness");
      assert.equal(init?.method, "POST");
      assert.equal((init?.headers as Record<string, string>).authorization, "Bearer robot-control-token-long");
      assert.deepEqual(JSON.parse(init?.body as string), { report });
      return new Response(JSON.stringify({
        readiness: { sessionId: report.sessionId, robotId: report.robotId, revision: 1, receivedAtUnixMs: 1_000, report },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  await publisher.publish(report);
  assert.equal(requestSeen, true);
  assert.throws(
    () => new HttpRobotReadinessPublisher({ controlPlaneUrl: "http://control.example.test", bearerToken: "robot-control-token-long" }),
    /HTTPS/,
  );
});

test("HTTP readiness publisher bounds time and validates acknowledgement provenance", async () => {
  const report = readiness();
  const timeoutPublisher = new HttpRobotReadinessPublisher({
    controlPlaneUrl: "http://127.0.0.1:4310/",
    bearerToken: "robot-control-token-long",
    requestTimeoutMs: 25,
    fetchImplementation: (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
  });
  await assert.rejects(
    () => timeoutPublisher.publish(report),
    (error) => error instanceof TeleoperationError && error.code === "ROBOT_READINESS_PUBLISH_TIMEOUT",
  );

  const mismatchPublisher = new HttpRobotReadinessPublisher({
    controlPlaneUrl: "http://127.0.0.1:4310/",
    bearerToken: "robot-control-token-long",
    fetchImplementation: async () => new Response(JSON.stringify({
      readiness: { report: { ...report, ownershipRevision: report.ownershipRevision + 1 } },
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  await assert.rejects(
    () => mismatchPublisher.publish(report),
    (error) => error instanceof TeleoperationError && error.code === "ROBOT_READINESS_PUBLISH_RESPONSE_INVALID",
  );
});

test("readiness reporter retains only latest state, retries failures, and drops stale reports", async () => {
  let now = 1_000;
  const publisher = new RecordingPublisher();
  const reporter = new RobotReadinessReporter({ publisher, now: () => now, automaticDelivery: false });
  reporter.enqueue(readiness({ readinessId: "readiness-1", ownershipRevision: 2, reportedAtUnixMs: now }));
  reporter.enqueue(readiness({ readinessId: "readiness-2", ownershipRevision: 3, reportedAtUnixMs: now }));
  publisher.failuresRemaining = 1;
  let snapshot = await reporter.flushNow();
  assert.equal(snapshot.queuedSessions, 1);
  assert.equal(snapshot.failedAttempts, 1);

  now += 100;
  snapshot = await reporter.flushNow();
  assert.equal(snapshot.queuedSessions, 0);
  assert.equal(snapshot.deliveredReports, 1);
  assert.deepEqual(publisher.reports.map((item) => item.readinessId), ["readiness-2"]);

  reporter.enqueue(readiness({ readinessId: "readiness-3", ownershipRevision: 4, reportedAtUnixMs: now }));
  now += 1_501;
  snapshot = await reporter.flushNow();
  assert.equal(snapshot.queuedSessions, 0);
  assert.equal(snapshot.droppedStaleReports, 1);
  assert.equal(reporter.close().closed, true);
});

test("readiness queued during an in-flight publication is delivered automatically", async () => {
  let releaseFirst!: () => void;
  const firstPublication = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const delivered: string[] = [];
  const reporter = new RobotReadinessReporter({
    now: () => 1_000,
    publisher: {
      async publish(report) {
        delivered.push(report.readinessId);
        if (report.readinessId === "readiness-owned") await firstPublication;
      },
    },
  });

  reporter.enqueue(readiness({
    readinessId: "readiness-owned",
    ownershipRevision: 3,
    ownershipStatus: "OWNED",
    actuatorGroup: "BASE",
  }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  reporter.enqueue(readiness({
    readinessId: "readiness-cleared",
    ownershipRevision: 4,
    ownershipStatus: "NO_OWNER",
    actuatorGroup: undefined,
  }));
  releaseFirst();

  const deadline = Date.now() + 1_000;
  while (delivered.length < 2 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(delivered, ["readiness-owned", "readiness-cleared"]);
  assert.equal(reporter.snapshot().queuedSessions, 0);
  reporter.close();
});

class RecordingPublisher implements RobotReadinessPublisher {
  failuresRemaining = 0;
  readonly reports: RobotSessionReadinessReport[] = [];

  async publish(report: RobotSessionReadinessReport): Promise<void> {
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error("injected outage");
    }
    this.reports.push(structuredClone(report));
  }
}

function readiness(overrides: Partial<RobotSessionReadinessReport> = {}): RobotSessionReadinessReport {
  return {
    contractVersion: CONTRACT_VERSION,
    readinessId: "readiness-default",
    sessionId: "session-1",
    robotId: "robot-1",
    operatorId: "operator-1",
    leaseRevision: 1,
    ownershipRevision: 1,
    ownershipStatus: "NO_OWNER",
    reportedAtUnixMs: 1_000,
    ...overrides,
  };
}
