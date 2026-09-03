import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { LocalRobotAgent } from "../../edge/robot-agent/src/index.ts";
import {
  CONTRACT_VERSION,
  Ed25519LeaseSigner,
  Ed25519LeaseVerifier,
  TeleoperationError,
  type TeleopSessionLease,
} from "../../packages/contracts/src/index.ts";

test("robot edge accepts trusted signed leases and rejects raw or tampered leases", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const signer = new Ed25519LeaseSigner("control-key-1", privateKey);
  const verifier = new Ed25519LeaseVerifier(new Map([["control-key-1", publicKey]]));
  const now = 10_000;
  const lease: TeleopSessionLease = {
    contractVersion: CONTRACT_VERSION,
    sessionId: "session-1",
    robotId: "robot-1",
    operatorId: "operator-1",
    scopes: ["CONTROL_BASE"],
    revision: 1,
    issuedAtUnixMs: now,
    expiresAtUnixMs: now + 5_000,
  };
  const agent = new LocalRobotAgent({
    robotId: "robot-1",
    nowUnixMs: () => now,
    leaseVerifier: verifier,
    requireSignedLeases: true,
    baseSafetyProfile: {
      robotId: "robot-1", commandTimeoutMs: 250, maximumLinearXMetersPerSecond: 1,
      maximumLinearYMetersPerSecond: 1, maximumAngularZRadiansPerSecond: 1,
      maximumLinearAccelerationMetersPerSecondSquared: 1, maximumAngularAccelerationRadiansPerSecondSquared: 1,
    },
  });
  assert.throws(
    () => agent.installLease(lease),
    (error) => error instanceof TeleoperationError && error.code === "SESSION_LEASE_SIGNATURE_REQUIRED",
  );
  const signed = signer.sign(lease);
  assert.equal(agent.installSignedLease(signed).installedLeases.length, 1);
  assert.throws(
    () => verifier.verify({ ...signed, lease: { ...signed.lease, operatorId: "attacker" } }),
    (error) => error instanceof TeleoperationError && error.code === "SESSION_LEASE_SIGNATURE_INVALID",
  );
  assert.throws(
    () => new Ed25519LeaseVerifier(new Map([["other-key", publicKey]])).verify(signed),
    (error) => error instanceof TeleoperationError && error.code === "SESSION_LEASE_SIGNING_KEY_UNKNOWN",
  );
});
