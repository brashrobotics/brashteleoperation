import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startControlPlaneApi } from "../../apps/control-plane-api/src/server.ts";
import { CONTRACT_VERSION } from "../../packages/contracts/src/index.ts";
import { ControlPlaneRuntime } from "../../services/control-plane-runtime/src/index.ts";

const token = "control-boundary-test-token";
const principal = { subject: "test:admin", operatorId: "admin-1", roles: ["ADMIN"] as const };

test("commanding leases fail closed without Fleet admission while observe-only leases remain available", async () => {
  const control = await startControlPlaneApi({ bearerToken: token, principal });
  try {
    let response = await post(`${control.url}/control/v1/sessions`, {
      sessionId: "command-session",
      robotId: "robot-1",
      operatorId: "admin-1",
      scopes: ["OBSERVE", "CONTROL_BASE"],
    });
    assert.equal(response.status, 201);
    const commandSession = response.body.session as { revision: number };
    response = await post(`${control.url}/control/v1/sessions/command-session/grant`, {
      expectedRevision: commandSession.revision,
      leaseDurationMs: 10_000,
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.code, "FLEET_RESERVATION_REQUIRED");

    response = await post(`${control.url}/control/v1/sessions`, {
      sessionId: "observe-session",
      robotId: "robot-1",
      operatorId: "admin-1",
      scopes: ["OBSERVE"],
    });
    const observeSession = response.body.session as { revision: number };
    response = await post(`${control.url}/control/v1/sessions/observe-session/grant`, {
      expectedRevision: observeSession.revision,
      leaseDurationMs: 10_000,
    });
    assert.equal(response.status, 200);
    assert.equal((response.body.session as { status: string }).status, "GRANTED");
  } finally {
    await control.close();
  }
});

test("registry HTTP lifecycle requires exact revisions and records a scoped active version", async () => {
  let nowUnixMs = 1_000;
  const control = await startControlPlaneApi({ bearerToken: token, principal });
  try {
    let response = await post(`${control.url}/registry/v1/versions`, {
      versionId: "registry-version-1",
      objectClassId: "class-bin",
      semanticLabel: "blue parts bin",
      aliases: ["parts bin"],
      siteIds: ["site-1"],
      robotCapabilities: ["unitree-b2-z1"],
      supportedIntents: ["PICK"],
      source: {
        requestId: "assistance-1",
        taskId: "task-1",
        robotId: "robot-1",
        declarationId: "declaration-1",
        groundedObjectId: "object-1",
        outcomeId: "outcome-1",
      },
      evidence: [{
        artifactId: "evidence-1",
        observationId: "observation-1",
        mediaType: "application/json",
        sha256: "a".repeat(64),
        byteLength: 16,
        capturedAtUnixMs: nowUnixMs,
      }],
      createdBy: "admin-1",
    });
    assert.equal(response.status, 201);
    let version = response.body.version as RegistryVersion;

    response = await post(`${control.url}/registry/v1/versions/${version.versionId}/submit-review`, {
      expectedRevision: version.revision,
    });
    version = response.body.version as RegistryVersion;
    const stale = await post(`${control.url}/registry/v1/versions/${version.versionId}/reviews`, {
      expectedRevision: version.revision - 1,
      reviewerId: "admin-1",
      reviewedAtUnixMs: ++nowUnixMs,
      approved: true,
      notes: "Reviewed.",
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, "REGISTRY_REVISION_MISMATCH");

    response = await post(`${control.url}/registry/v1/versions/${version.versionId}/reviews`, {
      expectedRevision: version.revision,
      reviewerId: "admin-1",
      reviewedAtUnixMs: ++nowUnixMs,
      approved: true,
      notes: "Evidence and label reviewed.",
    });
    version = response.body.version as RegistryVersion;
    response = await post(`${control.url}/registry/v1/versions/${version.versionId}/start-validation`, {
      expectedRevision: version.revision,
    });
    version = response.body.version as RegistryVersion;
    response = await post(`${control.url}/registry/v1/versions/${version.versionId}/validations`, {
      expectedRevision: version.revision,
      evaluationId: "evaluation-1",
      artifactSha256: "b".repeat(64),
      evaluatedAtUnixMs: ++nowUnixMs,
      passed: true,
      sampleCount: 20,
      metrics: { precision: 0.98, recall: 0.96 },
      notes: "Held-out evaluation passed.",
    });
    version = response.body.version as RegistryVersion;
    response = await post(`${control.url}/registry/v1/versions/${version.versionId}/activate`, {
      expectedRevision: version.revision,
      siteId: "site-1",
      robotCapability: "unitree-b2-z1",
      activatedBy: "admin-1",
    });
    assert.equal(response.status, 200);
    version = response.body.version as RegistryVersion;
    assert.equal(version.status, "ACTIVE");

    const events = await get(`${control.url}/registry/v1/versions/${version.versionId}/events`);
    assert.equal(events.status, 200);
    assert.deepEqual(
      (events.body.events as Array<{ status: string }>).map((event) => event.status),
      ["CANDIDATE", "IN_REVIEW", "APPROVED", "VALIDATING", "VALIDATING", "ACTIVE"],
    );
  } finally {
    await control.close();
  }
});

test("terminal expiry recorded while returning an error is durably persisted", async () => {
  const directory = await mkdtemp(join(tmpdir(), "brash-expiry-api-"));
  const stateFilePath = join(directory, "control.json");
  let now = 1_000;
  let control: Awaited<ReturnType<typeof startControlPlaneApi>> | undefined;
  try {
    const runtime = await ControlPlaneRuntime.open({ stateFilePath, now: () => now });
    control = await startControlPlaneApi({
      bearerToken: token,
      principal,
      assistance: runtime.assistance,
      sessions: runtime.sessions,
      registry: runtime.registry,
      afterMutation: () => runtime.persist(),
      reconciliationIntervalMs: 10_000,
    });
    let response = await post(`${control.url}/assistance/v1/requests`, {
      contractVersion: CONTRACT_VERSION,
      requestId: "expiring-request",
      robotId: "robot-1",
      taskId: "task-1",
      reason: "OBJECT_NOT_RECOGNIZED",
      requestedInput: "SELECT_TARGET",
      observations: [{ observationId: "observation-1", robotId: "robot-1", capturedAtUnixMs: 900, sceneRevision: "scene-1", calibrationVersion: "cal-1", frameIds: ["camera"] }],
      createdAtUnixMs: now,
      expiresAtUnixMs: 2_000,
    });
    const workflow = response.body.assistance as { revision: number };
    now = 2_000;
    response = await post(`${control.url}/assistance/v1/requests/expiring-request/assign`, {
      expectedRevision: workflow.revision,
      operatorId: "admin-1",
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.code, "ASSISTANCE_EXPIRED");
    await control.close();
    control = undefined;
    const restored = await ControlPlaneRuntime.open({ stateFilePath, now: () => now });
    assert.equal(restored.assistance.get("expiring-request").status, "EXPIRED");
  } finally {
    await control?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("operator assistance console exposes an installable mobile manifest without authentication", async () => {
  const control = await startControlPlaneApi({
    bearerToken: token,
    principal,
    operatorConnectOrigins: ["http://127.0.0.1:4312"],
  });
  try {
    let response = await fetch(`${control.url}/operator/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/html/);
    const csp = response.headers.get("content-security-policy") ?? "";
    assert.match(csp, /connect-src 'self' http:\/\/127\.0\.0\.1:4312/);
    assert.match(csp, /img-src 'self' data: blob:/);
    assert.doesNotMatch(csp, /connect-src[^;]*\*/);
    const html = await response.text();
    assert.match(html, /rel="manifest" href="\/operator\/manifest\.webmanifest"/);
    assert.match(html, /Direct touch-to-motion remains disabled/);

    response = await fetch(`${control.url}/operator/manifest.webmanifest`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^application\/manifest\+json/);
    const manifest = await response.json() as { start_url: string; display: string; icons: unknown[] };
    assert.equal(manifest.start_url, "/operator/");
    assert.equal(manifest.display, "standalone");
    assert.ok(manifest.icons.length > 0);

    response = await fetch(`${control.url}/operator/icon.svg`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^image\/svg\+xml/);

    response = await fetch(`${control.url}/operator/sw.js`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/javascript/);
    assert.match(await response.text(), /Network-only by design/);
  } finally {
    await control.close();
  }
});

test("signaling API binds offer to the session operator and rejects forged robot answers", async () => {
  const control = await startControlPlaneApi({ bearerToken: token, principal });
  try {
    let response = await post(`${control.url}/control/v1/sessions`, {
      sessionId: "signaling-session",
      robotId: "robot-1",
      operatorId: "admin-1",
      scopes: ["OBSERVE"],
    });
    let session = response.body.session as { revision: number };
    response = await post(`${control.url}/control/v1/sessions/signaling-session/grant`, {
      expectedRevision: session.revision,
      leaseDurationMs: 10_000,
    });
    session = response.body.session as { revision: number };

    response = await post(`${control.url}/signaling/v1/exchanges`, {
      signalingId: "signaling-api-1",
      sessionId: "signaling-session",
    });
    assert.equal(response.status, 201);
    let exchange = response.body.exchange as { revision: number; status: string };
    response = await post(`${control.url}/signaling/v1/exchanges/signaling-api-1/messages`, {
      expectedRevision: exchange.revision,
      message: {
        contractVersion: CONTRACT_VERSION,
        messageId: "offer-api-1",
        signalingId: "signaling-api-1",
        sessionId: "signaling-session",
        from: "OPERATOR",
        sentAtUnixMs: Date.now(),
        payload: { kind: "OFFER", description: { type: "offer", sdp: "v=0\r\ns=API test\r\n" } },
      },
    });
    assert.equal(response.status, 200);
    exchange = response.body.exchange as { revision: number; status: string };
    assert.equal(exchange.status, "AWAITING_ANSWER");

    response = await post(`${control.url}/signaling/v1/exchanges/signaling-api-1/messages`, {
      expectedRevision: exchange.revision,
      message: {
        contractVersion: CONTRACT_VERSION,
        messageId: "forged-answer-api-1",
        signalingId: "signaling-api-1",
        sessionId: "signaling-session",
        from: "ROBOT_EDGE",
        sentAtUnixMs: Date.now(),
        payload: { kind: "ANSWER", description: { type: "answer", sdp: "v=0\r\ns=forged\r\n" } },
      },
    });
    assert.equal(response.status, 403);
    assert.equal(response.body.code, "ROBOT_IDENTITY_MISMATCH");

    const events = await get(`${control.url}/signaling/v1/exchanges/signaling-api-1/events`);
    assert.equal(events.status, 200);
    assert.deepEqual(
      (events.body.events as Array<{ type: string }>).map((event) => event.type),
      ["SIGNALING_CREATED", "SIGNALING_OFFER"],
    );
  } finally {
    await control.close();
  }
});

interface RegistryVersion {
  versionId: string;
  revision: number;
  status: string;
}

async function post(url: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function get(url: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}
