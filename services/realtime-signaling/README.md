# Real-Time Signaling

## Purpose

Coordinates short-lived WebRTC offer, answer, ICE candidate, and connected/close
messages between one bound operator and one robot edge. This service establishes
transport metadata only. It cannot grant a session, acquire actuator ownership,
activate safety, or carry motion commands.

## Implemented behavior

- One active signaling exchange per teleoperation session.
- Operator-only offer and robot-edge-only answer transitions.
- Canonical versioned messages with exchange/session binding.
- Optimistic revisions plus message-ID/digest idempotency.
- Bounded SDP, candidate, message count, clock skew, and message age.
- Explicit connected acknowledgement from both peers.
- Expiry capped by both the session lease and a short signaling lifetime.
- SDP and ICE material scrubbed on close, expiry, and control-plane restart.
- Payload-free audit events retain peer, message ID, revision, time, and reason.

The current implementation is an in-process domain core with serializable
state. Production should place active negotiation data in an encrypted,
TTL-enforced store and retain only payload-free audit events after termination.

## Failure behavior

Restart invalidates every non-terminal exchange instead of trying to restore a
possibly stale peer connection. Reconnection requires a new exchange. Signaling
expiry does not itself stop or authorize a robot; the session lease, real-time
heartbeat, edge validator, command arbiter, and safety watchdog remain separate
authorities.
