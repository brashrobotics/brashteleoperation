# End-to-End API Tests

## Purpose

Exercises the control-plane and robot-edge development APIs over real loopback
HTTP sockets while keeping all robot behavior simulated and in process.

## Current coverage

- Bearer-token rejection.
- Session request, grant, lease installation, connection, ownership handoff,
  activation, command, hold, stopped release, and control-plane release.
- Canonical JSON decoding and duplicate command rejection.
- Unknown-object request, assignment, declaration, grounding, plan, stale
  approval rejection, correct approval, outcome, verification, and event query.
- Final zero-output, no-owner, released-session state.
- Role/actor binding and fail-closed Fleet admission for commanding leases.
- Separate authenticated Fleet/control-plane HTTP services with stop-gated
  lease admission and persist-before-Fleet-release ordering.
- Separate operator and robot principals proving that operator readiness claims
  cannot activate or release commanding sessions.
- Control-plane Ed25519 signing on grant and renewal, operator-bound signed
  lease recovery, edge rejection of raw and tampered authority, and successful
  installation of an authentic envelope.
- Assigned immutable-observation media access, strict CORS, expiring scoped
  grants, provenance headers, exact retained bytes, and unauthorized rejection.
- Registry review, validation, scoped activation, and stale-revision rejection.
- Separate-process durable workflow recovery and edge restart with no restored
  lease, owner, or output.

## Boundaries

The HTTP edge command endpoint exists only to test trust and process boundaries.
It is not representative of the future low-latency production transport and
does not connect to ROS 2 or hardware.

## Next milestone

Repeat the same behavior against PostgreSQL, the Fleet Control server-side hold
implementation, the production real-time transport, and a ROS 2 simulation
graph in CI.
