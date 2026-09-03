import { createHash, timingSafeEqual } from "node:crypto";
import { clone, fail } from "../../contracts/src/index.ts";

export type OperatorRole = "ROBOT" | "OPERATOR" | "SUPERVISOR" | "REVIEWER" | "RELEASE_MANAGER" | "ADMIN";

export type TeleoperationPermission =
  | "session:read" | "session:request" | "session:grant" | "session:control" | "session:robot-report"
  | "assistance:read" | "assistance:open" | "assistance:act" | "assistance:machine"
  | "registry:read" | "registry:candidate" | "registry:review" | "registry:activate"
  | "signaling:read" | "signaling:create" | "signaling:write"
  | "media:read"
  | "observability:read";

export interface OperatorPrincipal {
  subject: string;
  operatorId: string;
  robotId?: string;
  roles: readonly OperatorRole[];
}

export interface RequestIdentityProvider {
  authenticateBearer(authorizationHeader: string | undefined): OperatorPrincipal;
}

export interface StaticBearerCredential {
  token: string;
  principal: OperatorPrincipal;
}

/** Development/test identity provider. Raw bearer tokens are never retained in
 * exported state and comparisons use fixed-size SHA-256 digests. */
export class StaticBearerIdentityProvider implements RequestIdentityProvider {
  private readonly credentials: ReadonlyArray<{ digest: Buffer; principal: OperatorPrincipal }>;

  constructor(credentials: readonly StaticBearerCredential[]) {
    if (credentials.length === 0 || credentials.length > 64) {
      throw new Error("Static bearer identity provider requires between 1 and 64 credentials.");
    }
    const seen = new Set<string>();
    this.credentials = credentials.map(({ token, principal }) => {
      if (token.length < 16 || token.length > 4_096 || token.trim() !== token) {
        throw new Error("Static bearer tokens must contain 16 to 4096 characters without surrounding whitespace.");
      }
      validatePrincipal(principal);
      const hexDigest = createHash("sha256").update(token).digest("hex");
      if (seen.has(hexDigest)) throw new Error("Static bearer tokens must be unique.");
      seen.add(hexDigest);
      return { digest: Buffer.from(hexDigest, "hex"), principal: clone(principal) };
    });
  }

  authenticateBearer(authorizationHeader: string | undefined): OperatorPrincipal {
    if (!authorizationHeader?.startsWith("Bearer ") || authorizationHeader.length <= "Bearer ".length) {
      fail("UNAUTHORIZED", "A valid bearer token is required.");
    }
    const candidate = createHash("sha256").update(authorizationHeader.slice("Bearer ".length)).digest();
    let matched: OperatorPrincipal | undefined;
    for (const credential of this.credentials) {
      if (timingSafeEqual(candidate, credential.digest)) matched = credential.principal;
    }
    if (!matched) fail("UNAUTHORIZED", "A valid bearer token is required.");
    return clone(matched);
  }
}

const permissions: Readonly<Record<OperatorRole, readonly TeleoperationPermission[]>> = {
  ROBOT: ["session:robot-report", "assistance:read", "assistance:open", "assistance:machine", "signaling:read", "signaling:write"],
  OPERATOR: ["session:read", "session:request", "assistance:read", "assistance:act", "registry:read", "registry:candidate", "signaling:read", "signaling:create", "signaling:write", "media:read"],
  SUPERVISOR: ["session:read", "session:request", "session:grant", "session:control", "assistance:read", "assistance:open", "assistance:act", "registry:read", "registry:candidate", "signaling:read", "signaling:create", "signaling:write", "media:read", "observability:read"],
  REVIEWER: ["assistance:read", "registry:read", "registry:review", "observability:read"],
  RELEASE_MANAGER: ["registry:read", "registry:activate", "observability:read"],
  ADMIN: ["session:read", "session:request", "session:grant", "session:control", "assistance:read", "assistance:open", "assistance:act", "registry:read", "registry:candidate", "registry:review", "registry:activate", "signaling:read", "signaling:create", "signaling:write", "media:read", "observability:read"],
};

export function requirePermission(principal: OperatorPrincipal, permission: TeleoperationPermission): void {
  validatePrincipal(principal);
  if (!principal.roles.some((role) => permissions[role]?.includes(permission))) {
    fail("FORBIDDEN", `Principal lacks ${permission}.`);
  }
}

export function validatePrincipal(principal: OperatorPrincipal): void {
  if (!principal.subject?.trim() || !principal.operatorId?.trim() || !Array.isArray(principal.roles) || principal.roles.length === 0) {
    fail("IDENTITY_INVALID", "Authenticated principal is incomplete.");
  }
  if (new Set(principal.roles).size !== principal.roles.length
    || principal.roles.some((role) => !(role in permissions))
    || (principal.roles.includes("ROBOT") && principal.roles.length !== 1)) {
    fail("IDENTITY_INVALID", "Robot and human roles must be valid, unique, and cannot be combined in one principal.");
  }
  if (principal.roles.includes("ROBOT") !== Boolean(principal.robotId?.trim())) {
    fail("IDENTITY_INVALID", "Exactly robot principals must carry a robot ID.");
  }
}

export function requireActorBinding(principal: OperatorPrincipal, claimedOperatorId: string): void {
  if (principal.operatorId !== claimedOperatorId) {
    fail("ACTOR_IDENTITY_MISMATCH", "Request actor does not match the authenticated operator identity.");
  }
}

export function requireRobotBinding(principal: OperatorPrincipal, claimedRobotId: string): void {
  if (!principal.roles.includes("ROBOT") || !principal.robotId?.trim() || principal.robotId !== claimedRobotId) {
    fail("ROBOT_IDENTITY_MISMATCH", "Request actor does not match the robot identity.");
  }
}

export function requireSignalingPeerBinding(
  principal: OperatorPrincipal,
  peer: "OPERATOR" | "ROBOT_EDGE",
  binding: { operatorId: string; robotId: string },
): void {
  if (peer === "OPERATOR") {
    if (!principal.roles.some((role) => role === "OPERATOR" || role === "SUPERVISOR" || role === "ADMIN")) {
      fail("ACTOR_IDENTITY_MISMATCH", "A robot principal cannot act as the signaling operator.");
    }
    requireActorBinding(principal, binding.operatorId);
    return;
  }
  if (!principal.roles.includes("ROBOT") || !principal.robotId?.trim() || principal.robotId !== binding.robotId) {
    fail("ROBOT_IDENTITY_MISMATCH", "Request actor does not match the bound robot-edge identity.");
  }
}

export function requireSignalingExchangeBinding(
  principal: OperatorPrincipal,
  binding: { operatorId: string; robotId: string },
): "OPERATOR" | "ROBOT_EDGE" {
  if (principal.roles.includes("ROBOT")) {
    if (principal.robotId === binding.robotId) return "ROBOT_EDGE";
    fail("SIGNALING_IDENTITY_MISMATCH", "Robot principal is not bound to this signaling exchange.");
  }
  if (principal.operatorId === binding.operatorId) return "OPERATOR";
  fail("SIGNALING_IDENTITY_MISMATCH", "Principal is not a peer in this signaling exchange.");
}

export const DEVELOPMENT_ADMIN_PRINCIPAL: OperatorPrincipal = Object.freeze({
  subject: "development-static-bearer",
  operatorId: "development-admin",
  roles: ["ADMIN"] as const,
});
