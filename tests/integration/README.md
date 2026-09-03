# Integration Tests

## Purpose

Exercises component boundaries with real transports and persistence while
replacing physical actuators with deterministic fakes.

## Coverage

- Fleet pause/reservation/session/release reconciliation and bounded HTTP
  adapter failures.
- Session install, renewal, expiry, revocation, and stopped acknowledgement.
- Fresh robot-owned readiness, stale/replay rejection, and lease-renewal
  invalidation.
- Bounded edge readiness publishing, acknowledgement provenance, latest-state
  retry, and stale-state dropping.
- Assistance request through declaration, grounding, plan approval, outcome,
  and task resumption.
- Immutable observation and plan revision enforcement.
- Object enrollment candidate, review, artifact promotion, resolution, and
  rollback.
- Operator/edge real-time handshake, command feedback, and media metadata.
- Shared mobile command envelopes entering the normal edge/safety path, with
  robot-local timeout after a client lifecycle interruption.
- WebRTC signaling offer/answer/ICE sequencing, idempotency, expiry, identity
  binding, bounded payloads, and restart-time negotiation scrubbing.
- Restart and idempotent recovery for every durable service.
- Fleet reservation and release-retry restoration across a control-plane
  process restart.

## Initial milestone

Run the complete unknown-object workflow against a deterministic robot adapter
and persistent services, then prove that duplicate events and component restarts
do not duplicate execution or bypass approval.
