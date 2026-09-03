# ADR 0007: Resolve the authenticated principal per request

- **Status:** Accepted
- **Date:** 2026-09-03

## Context

Operator, reviewer, release-manager, service, and robot-edge requests share the
low-rate control API but have different permissions and identity bindings. A
single process-wide principal cannot represent those callers safely, and
running one listener per identity is only a test convenience.

## Decision

The control API resolves one principal from an identity-provider abstraction
for every authenticated request, before authorization or actor binding. The
loopback development provider supports a bounded set of distinct static bearer
credentials, stores only SHA-256 token digests, compares all fixed-size digests
with constant-time equality, and never combines robot and human roles.

Fixed single-bearer mode remains for compatibility tests, but it cannot be
configured together with a dynamic provider. Production will implement the
same abstraction with verified OIDC access tokens for people and workload
identity or mTLS for robot and service principals.

## Consequences

- One API listener can safely distinguish the web/mobile operator from the
  robot reporting readiness and signaling state.
- Permission and actor-binding checks use the actual caller on every request.
- Development credentials are still not production authentication and the API
  remains loopback-only.
- Token rotation, revocation, issuer discovery, key refresh, and mTLS binding
  remain production adapter work.

## Alternatives considered

- One process-wide principal: rejected because every bearer inherits the same
  authority and robot/person separation cannot be enforced.
- One listener per identity: rejected as a deployment topology workaround, not
  an authentication model.
- Allow a caller to supply roles in request JSON: rejected because authorization
  claims must come from verified identity material, never request payloads.
