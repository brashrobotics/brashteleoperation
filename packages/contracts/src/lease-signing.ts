import { sign as cryptoSign, verify as cryptoVerify, type KeyLike } from "node:crypto";
import { decodeTeleopSessionLease } from "./decoders.ts";
import { clone, type TeleopSessionLease } from "./index.ts";
import { fail } from "./errors.ts";

export interface SignedTeleopSessionLease {
  algorithm: "Ed25519";
  keyId: string;
  lease: TeleopSessionLease;
  signature: string;
}

export interface LeaseSignatureVerifier {
  verify(envelope: unknown): TeleopSessionLease;
}

export interface LeaseSignatureSigner {
  sign(lease: TeleopSessionLease): SignedTeleopSessionLease;
}

export class Ed25519LeaseSigner implements LeaseSignatureSigner {
  private readonly keyId: string;
  private readonly privateKey: KeyLike;

  constructor(keyId: string, privateKey: KeyLike) {
    if (!keyId.trim()) throw new Error("Lease signing keyId is required.");
    this.keyId = keyId;
    this.privateKey = privateKey;
  }

  sign(lease: TeleopSessionLease): SignedTeleopSessionLease {
    const decoded = decodeTeleopSessionLease(lease);
    const signature = cryptoSign(null, canonicalLeaseBytes(decoded), this.privateKey).toString("base64url");
    return { algorithm: "Ed25519", keyId: this.keyId, lease: decoded, signature };
  }
}

export class Ed25519LeaseVerifier implements LeaseSignatureVerifier {
  private readonly publicKeys: ReadonlyMap<string, KeyLike>;

  constructor(publicKeys: ReadonlyMap<string, KeyLike>) {
    if (publicKeys.size === 0) throw new Error("At least one lease verification key is required.");
    this.publicKeys = new Map(publicKeys);
  }

  verify(untrusted: unknown): TeleopSessionLease {
    if (!isRecord(untrusted) || untrusted.algorithm !== "Ed25519"
      || typeof untrusted.keyId !== "string" || !untrusted.keyId.trim()
      || typeof untrusted.signature !== "string" || !untrusted.signature.trim()) {
      fail("SESSION_LEASE_SIGNATURE_INVALID", "Signed lease envelope is malformed.");
    }
    const publicKey = this.publicKeys.get(untrusted.keyId);
    if (!publicKey) fail("SESSION_LEASE_SIGNING_KEY_UNKNOWN", `Lease signing key ${untrusted.keyId} is not trusted.`);
    const lease = decodeTeleopSessionLease(untrusted.lease);
    let signature: Buffer;
    try {
      signature = Buffer.from(untrusted.signature, "base64url");
    } catch {
      fail("SESSION_LEASE_SIGNATURE_INVALID", "Lease signature is not valid base64url.");
    }
    if (signature.byteLength !== 64 || !cryptoVerify(null, canonicalLeaseBytes(lease), publicKey, signature)) {
      fail("SESSION_LEASE_SIGNATURE_INVALID", "Lease signature verification failed.");
    }
    return clone(lease);
  }
}

function canonicalLeaseBytes(lease: TeleopSessionLease): Buffer {
  return Buffer.from(JSON.stringify({
    contractVersion: { major: lease.contractVersion.major, minor: lease.contractVersion.minor },
    sessionId: lease.sessionId,
    robotId: lease.robotId,
    operatorId: lease.operatorId,
    scopes: [...lease.scopes],
    revision: lease.revision,
    issuedAtUnixMs: lease.issuedAtUnixMs,
    expiresAtUnixMs: lease.expiresAtUnixMs,
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
