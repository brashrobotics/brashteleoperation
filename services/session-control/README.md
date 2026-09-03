# Session Control Service

## Purpose

Owns operator authorization, exclusive control leases, real-time connection
signaling, and the safe handoff between Fleet autonomy and human assistance.

## Current implementation

`src/session-control.ts` implements the session state machine in memory,
including revision checks, bounded leases, renewal, expiry, idempotent release,
exclusive commanding-session enforcement, stopped acknowledgement on release,
and an append-only event view. `src/fleet-coordination.ts` supplies the Fleet
reservation state machine, a bounded HTTP client, and command-session admission
coordination. Production identity and durable cross-service retry remain
adapter work.

`src/robot-readiness.ts` accepts only identity-bound, revisioned reports from
the robot API principal. Commanding activation requires a fresh `OWNED` report;
stopped release requires a fresh `NO_OWNER` report. A lease renewal makes the
previous report unusable.

## Responsibilities

- Authenticate operator and robot identities.
- Authorize observe, declare, approve, base-control, arm-control, gripper, and
  supervisor capabilities independently.
- Ensure at most one active command lease exists for an actuator group.
- Create short-lived, robot-scoped, operator-scoped, capability-scoped leases.
- Coordinate pause/reservation/release with BRASH Fleet Control.
- Exchange signaling information without relaying motion semantics.
- Renew, revoke, expire, and audit sessions.
- Expose session state to the assistance orchestrator and operator station.
- Reject conflicting sessions and stale/replayed lifecycle requests.

## Session rules

- A lease authorizes a request for robot-local ownership; it does not itself
  enable an actuator.
- Observe-only participants may never transmit accepted motion commands.
- Base and arm command leases are mutually exclusive in the first B2W/Z1
  profile.
- Lease renewal requires the operator, robot, and Fleet reservation to remain
  valid.
- Release is complete only after robot-local acknowledgement that ownership is
  cleared and the robot is stopped.
- Operator or mobile request fields cannot assert ownership or stopped state.

## Interfaces

Expected operations:

- `requestSession`
- `grantSession`
- `renewSession`
- `holdSession`
- `releaseSession`
- `revokeSession`
- `getSession`
- `publishRobotSessionState`
- `createRealtimeOffer` / `answerRealtimeOffer`

Durable session events include causation ID, correlation ID, operator identity,
robot identity, lease revision, reason, timestamps, and Fleet reservation ID.

## Failure behavior

- Service unavailability prevents new sessions and renewal.
- An edge agent treats an unrenewed lease as expired using its locally installed
  expiry and transitions to stop/hold.
- Recovery reconciles durable state with robot-reported ownership before a new
  grant can be issued.
- No recovered record automatically resumes a previous command stream.

## Next milestone

Add the counterpart hold endpoints to Fleet Control, persist reservation state
and release retries through a transactional outbox, and integrate robot-edge
lease installation acknowledgements.

## Fleet integration boundary

`FleetReservationCoordinator` defines a semantic hold port and fails closed
until Fleet and its robot adapter report the robot stopped. Only a `RESERVED`
record may be used to admit a commanding lease; release likewise waits for
Fleet confirmation. `HttpFleetTeleoperationPort` enforces authenticated,
bounded, revisioned calls without redirects, and
`FleetCommandLeaseCoordinator` serializes retries by session ID.

The expected server contract is
[`docs/api/fleet-teleoperation-openapi.yaml`](../../docs/api/fleet-teleoperation-openapi.yaml).
The existing Fleet Core does not expose these endpoints yet. Its cancellation
and quarantine operations are intentionally not treated as substitutes.
