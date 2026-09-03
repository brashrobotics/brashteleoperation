# ADR 0006: Robot edge reports command readiness

- **Status:** Accepted
- **Date:** 2026-09-03

## Context

A control-plane request previously accepted operator-provided booleans claiming
that robot ownership was granted or cleared. Those claims were checked by the
session state machine but did not prove that the robot-local arbiter had
performed its stopped handoff. A compromised or buggy operator client could
therefore mark the control-plane session active or released prematurely.

## Decision

Only the authenticated robot principal bound to the session robot ID may
publish `RobotSessionReadinessReport`. Each report binds the session, robot,
operator, lease revision, robot-local ownership revision and status, actuator
group, and robot timestamp.

For commanding sessions, the control API derives activation from a fresh
`OWNED` report and stopped release from a fresh `NO_OWNER` report. Operator
boolean claims are not consulted. Reports have bounded clock skew and age;
ownership revisions cannot move backward or identify different states; and a
lease renewal invalidates readiness until the edge installs and reports the new
lease revision.

The report does not grant physical authority. Robot-local lease validation,
command arbitration, safety supervision, watchdogs, and the physical emergency
stop remain authoritative.

## Consequences

- Operator and mobile clients cannot self-attest robot readiness.
- Robot and human identities need distinct authenticated principals.
- Activation requires one additional low-rate robot-to-control-plane message.
- Temporary control-plane unavailability cannot make the robot accept motion.
- Revoke and expiry leave Fleet conservatively held until a later robot-cleared
  reconciliation; durable retry belongs in the planned transactional outbox.

## Alternatives considered

- Trust the operator boolean: rejected because the claimant is outside the
  robot safety and ownership boundary.
- Query robot state synchronously during every transition: rejected because it
  couples request latency and availability while still requiring authenticated,
  revisioned state.
- Treat WebRTC connection as readiness: rejected because connectivity does not
  prove lease installation, stopped handoff, or actuator ownership.
