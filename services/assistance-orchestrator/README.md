# Assistance Orchestrator

## Purpose

Owns the durable human-assistance workflow from an autonomy failure through
operator declaration, robot-local grounding, plan approval, execution,
verification, and task resumption or escalation.

## Current implementation

`src/assistance-orchestrator.ts` implements the complete in-memory workflow,
optimistic revision checks, immutable observation binding, grounding provenance,
plan/object/scene approval binding, typed outcomes, expiry, escalation, and an
append-only event view. External task adapters and durable repositories remain
to be implemented.

## Responsibilities

- Accept structured assistance requests from autonomous tasks.
- Deduplicate requests and preserve task/mission correlation.
- Classify the requested human input: target selection, disambiguation, grasp
  hint, destination selection, plan approval, or direct-control escalation.
- Assign requests to an authorized operator or queue.
- Pin declarations to immutable observation bundles.
- Coordinate grounding and plan-generation operations on the selected robot.
- Track declaration, grounded-object, plan, approval, and execution revisions.
- Resume or fail the originating task through an idempotent result contract.
- Record complete decision and outcome provenance.
- Optionally create an enrollment candidate after reviewed success/failure.

## Workflow states

`OPEN -> ASSIGNED -> DECLARATION_PENDING -> GROUNDING -> PLAN_PENDING ->
APPROVAL_PENDING -> EXECUTING -> VERIFYING -> RESOLVED`

Any non-terminal state may transition to `CANCELLED`, `EXPIRED`, `FAILED`, or
`DIRECT_TELEOP_REQUIRED` with an explicit reason.

## Boundaries

- The orchestrator never generates actuator commands.
- It does not accept a class label as evidence of a valid 3D pose or grasp.
- It cannot approve on behalf of an operator when policy requires human review.
- It cannot bypass robot-local collision, tracking, safety, or ownership checks.
- Task resumption is semantic and idempotent; it is not a continuation of a
  previously interrupted command stream.

## Inputs and outputs

Inputs:

- `AssistanceRequest` and task context.
- Operator declarations and corrections.
- Grounding result, plan preview, robot-local acceptance, and outcome evidence.
- Session availability and operator authorization.

Outputs:

- Assigned assistance work.
- Grounding and plan-generation requests referencing immutable versions.
- Plan-approval requests.
- Resolved assistance result or typed escalation for the originating task.
- Enrollment-candidate request with full provenance.

## Failure behavior

- Timed-out or disconnected operators return the request to a queue while the
  robot remains held.
- A changed scene invalidates the grounding and returns to declaration.
- A changed plan invalidates any earlier approval.
- Duplicate robot outcomes are handled idempotently.
- Service recovery reconstructs workflow state from durable events and queries
  current robot state before continuing.

## Next milestone

Add repository/outbox ports and an API, connect the workflow to a robot-edge
grounding/manipulation adapter, and make originating task resumption idempotent
across process restart.
