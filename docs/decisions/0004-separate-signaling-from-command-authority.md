# ADR 0004: Separate WebRTC signaling from command authority

- **Status:** Accepted
- **Date:** 2026-09-03

## Context

Operator and robot-edge peers need to exchange WebRTC session descriptions and
ICE candidates before media and data channels exist. Signaling payloads can
contain temporary credentials and network addresses. Treating successful
negotiation as permission to move, routing motor commands through signaling, or
retaining raw negotiation payloads as audit records would join unrelated trust
and lifecycle boundaries.

## Decision

Use a short-lived control-plane signaling exchange bound to an already granted
teleoperation session, its operator identity, and its robot-edge identity. Only
the operator may offer and only the bound robot may answer. Messages use
optimistic revisions and message-ID digests so exact retries are idempotent and
altered replays fail.

Bound SDP size, candidate size/count, message count, message age, clock skew,
and exchange duration. Scrub SDP and ICE material on close, expiry, or process
restart. Retain payload-free transition events for audit.

Signaling `CONNECTED` is informational. Session activation still requires the
normal lease installation, real-time channel, stopped ownership handoff, and
robot-local safety acknowledgement. Motion commands never use the signaling
API.

## Consequences

- Signaling availability or compromise cannot directly grant actuator access.
- A control-plane restart requires fresh negotiation instead of restoring stale
  temporary credentials.
- Operators and robot edges need distinct authenticated principals.
- Production deployment needs an encrypted TTL store and a scalable delivery
  transport such as authenticated WebSocket or server-sent polling; the domain
  transitions remain the same.
- TURN credentials need their own short-lived provisioning policy and must not
  be retained in audit logs.

## Alternatives considered

- Activate teleoperation when WebRTC connects: rejected because transport
  connectivity is not authorization, ownership, or safety readiness.
- Send high-rate commands through the signaling API: rejected because it is a
  low-rate coordination path without robot-local timing guarantees.
- Persist raw SDP/ICE indefinitely for debugging: rejected because it retains
  network details and temporary credentials beyond their operational purpose.
- Restore in-progress signaling after restart: rejected because peer state and
  ephemeral credentials may no longer match.
