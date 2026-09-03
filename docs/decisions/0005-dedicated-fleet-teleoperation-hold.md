# ADR 0005: Use a dedicated Fleet teleoperation-hold contract

- **Status:** Accepted
- **Date:** 2026-09-03

## Context

A commanding teleoperation lease must not overlap Fleet mission authority.
The current BRASH Fleet Control API exposes mission cancellation, recovery,
traffic, and robot quarantine, but does not expose the stopped handoff needed
for teleoperation. Reusing cancellation would discard mission intent; reusing
quarantine would misrepresent a planned temporary handoff as a fault.

## Decision

Define a versioned, low-rate hold contract with three operations: request an
idempotent hold, inspect its state, and release it with an expected revision.
Fleet must not report `ROBOT_STOPPED` until its robot adapter has confirmed the
mission command source is stopped. Session Control may grant a commanding
lease only from that state.

The teleoperation client uses authenticated HTTPS, except for explicit
loopback development; rejects redirects; bounds time and response bytes; and
validates version, identity, state, and revision. Session termination is
persisted before asking Fleet to release its hold. Fleet never receives
real-time commands, video, SDP, ICE, object masks, or vendor packets.

The client and conformance contract live in this repository. The corresponding
server endpoints must be added to Fleet Control in a separately reviewed
change because that repository currently has unrelated hardware-integration
work in progress.

## Consequences

- Fleet and teleoperation retain separate command and safety responsibilities.
- A Fleet outage prevents a new commanding lease; it cannot bypass admission.
- A release failure leaves Fleet held, which favors safety over availability.
- Idempotency keys and optimistic revisions make retries deterministic.
- Durable cross-service release retry still requires the planned database and
  outbox implementation.

## Alternatives considered

- Cancel the active mission: rejected because cancellation is destructive task
  semantics rather than a reversible ownership handoff.
- Quarantine the robot: rejected because quarantine represents a fault and can
  trigger unrelated operational policy.
- Send Fleet-specific motion stop commands from Session Control: rejected
  because the robot-local arbiter and Fleet robot adapter own stop confirmation.
