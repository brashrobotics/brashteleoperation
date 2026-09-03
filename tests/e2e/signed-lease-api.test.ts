import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { startControlPlaneApi } from "../../apps/control-plane-api/src/server.ts";
import { LocalRobotAgent } from "../../edge/robot-agent/src/index.ts";
import {
  Ed25519LeaseSigner,
  Ed25519LeaseVerifier,
  TeleoperationError,
  type SignedTeleopSessionLease,
} from "../../packages/contracts/src/index.ts";

const token = "signed-lease-control-token-long";

test("control API signs grant and renewal while the edge rejects raw or tampered leases", async (context) => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const signer = new Ed25519LeaseSigner("control-key-1", privateKey);
  const verifier = new Ed25519LeaseVerifier(new Map([["control-key-1", publicKey]]));
  const control = await startControlPlaneApi({
    bearerToken: token,
    leaseSigner: signer,
    allowUncoordinatedCommandLeases: true,
    principal: { subject: "oidc:operator-1", operatorId: "operator-1", roles: ["ADMIN"] },
  });
  context.after(() => control.close());
  const agent = new LocalRobotAgent({
    robotId: "robot-1",
    leaseVerifier: verifier,
    requireSignedLeases: true,
    baseSafetyProfile: {
      robotId: "robot-1",
      commandTimeoutMs: 250,
      maximumLinearXMetersPerSecond: 0.5,
      maximumLinearYMetersPerSecond: 0.3,
      maximumAngularZRadiansPerSecond: 0.5,
      maximumLinearAccelerationMetersPerSecondSquared: 0.5,
      maximumAngularAccelerationRadiansPerSecondSquared: 0.5,
    },
  });

  let response = await post(control.url, "/control/v1/sessions", {
    sessionId: "session-1",
    robotId: "robot-1",
    operatorId: "operator-1",
    scopes: ["CONTROL_BASE"],
  });
  let session = response.body.session as SessionView;
  response = await post(control.url, "/control/v1/sessions/session-1/grant", {
    expectedRevision: session.revision,
    leaseDurationMs: 10_000,
  });
  assert.equal(response.status, 200);
  session = response.body.session as SessionView;
  const firstSigned = response.body.signedLease as unknown as SignedTeleopSessionLease;
  assert.equal(firstSigned.keyId, "control-key-1");
  assert.throws(
    () => agent.installLease(session.lease),
    (error) => error instanceof TeleoperationError && error.code === "SESSION_LEASE_SIGNATURE_REQUIRED",
  );
  assert.equal(agent.installSignedLease(firstSigned).installedLeases[0]?.revision, 1);

  response = await get(control.url, "/control/v1/sessions/session-1/signed-lease");
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.signedLease, firstSigned);

  response = await post(control.url, "/control/v1/sessions/session-1/renew", {
    expectedRevision: session.revision,
    leaseDurationMs: 10_000,
  });
  assert.equal(response.status, 200);
  session = response.body.session as SessionView;
  const renewed = response.body.signedLease as unknown as SignedTeleopSessionLease;
  assert.equal(renewed.lease.revision, 2);
  assert.equal(agent.installSignedLease(renewed).installedLeases[0]?.revision, 2);
  assert.throws(
    () => agent.installSignedLease({ ...renewed, lease: { ...renewed.lease, robotId: "robot-2" } }),
    (error) => error instanceof TeleoperationError && error.code === "SESSION_LEASE_SIGNATURE_INVALID",
  );
});

interface SessionView {
  revision: number;
  lease: SignedTeleopSessionLease["lease"];
}

async function post(baseUrl: string, path: string, body: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function get(baseUrl: string, path: string) {
  const response = await fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}
