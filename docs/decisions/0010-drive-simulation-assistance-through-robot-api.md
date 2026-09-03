# ADR 0010: Drive simulation assistance through the robot API boundary

- **Status:** Accepted
- **Date:** 2026-09-03

## Context

The operator console could submit a declaration and approval, but the runnable
Compose profile previously stopped at robot-owned workflow states. Advancing
those states inside the browser or with an administrator credential would hide
the intended trust boundary and produce an unrealistic integration path.

Executing a manipulation twice after an ambiguous network response is also
materially different from retrying an idempotent grounding or planning write.

## Decision

The local simulation profile runs a low-rate assistance worker authenticated as
the exact robot. It reads only that robot's request and submits grounding,
declaration-correction, plan, outcome, and verification transitions through the
same bounded, revisioned HTTP API used by other callers. It remains idle during
operator-owned assignment, declaration, and exact approval states.

The worker composes the deterministic RGB-D grounder, scene model, and
simulation manipulation executor. The executor rejects non-simulation adapters.
An in-memory receipt prevents repeated execution of one plan revision after an
ambiguous response during the lifetime of the process.

This worker is development infrastructure. A physical implementation requires
a durable robot-local operation journal and reconciliation protocol before an
execution retry can be considered safe. HTTP workflow state never grants or
bypasses robot-local command ownership and safety.

## Consequences

- The browser exercise now demonstrates the complete declaration, approval,
  simulated execution, and verification lifecycle.
- Robot credentials cannot read or mutate another robot's assistance request.
- Operator credentials cannot perform robot-owned machine transitions.
- A worker restart can safely resume non-execution states, but the in-memory
  receipt is explicitly insufficient for physical exactly-once execution.
- The Compose worker has no ROS, Unitree SDK, or physical adapter dependency.

## Alternatives considered

- Advance robot states from the browser: rejected because it collapses the
  operator and robot trust boundaries.
- Call the orchestrator directly from the simulator: rejected because it would
  bypass authentication, response bounds, and deployed API behavior.
- Treat HTTP retry as physical exactly-once execution: rejected because a
  control-plane revision cannot prove what an actuator completed.
