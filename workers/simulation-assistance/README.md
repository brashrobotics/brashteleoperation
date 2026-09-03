# Simulation Assistance Worker

## Purpose

Completes the browser-based unknown-object exercise through the same
authenticated, revisioned interfaces intended for robot-local perception and
manipulation. It is simulation infrastructure and cannot connect to ROS,
Unitree hardware, or a physical command adapter.

## Current implementation

- Polls one robot-bound assistance request through a bounded HTTPS-or-loopback
  client.
- Waits without acting during operator assignment, declaration, and exact plan
  approval states.
- Uses the deterministic RGB-D grounder and runtime scene model.
- Creates a simulation manipulation plan, waits for its exact approval, runs
  the simulation-only adapter, records the outcome, and verifies completion.
- Uses optimistic revisions for every transition, bounded retry backoff, and an
  in-memory execution receipt to avoid repeating a simulated plan after an
  ambiguous response in the same process.
- Stops polling on every terminal assistance state.

## Boundaries

The execution receipt is not durable across process restart and is not suitable
for physical action exactly-once guarantees. Production requires a durable
robot-local operation journal, collision-aware planning, live tracking, and a
commissioned hardware adapter. A control-plane success response never bypasses
robot-local ownership or safety.
