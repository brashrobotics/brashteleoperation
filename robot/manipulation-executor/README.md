# Manipulation Executor

## Purpose

Plans, executes, and verifies autonomous manipulation for a grounded target
while obtaining command ownership and obeying all robot-local safety controls.

## Responsibilities

- Validate grounded-object freshness, tracking state, pose frame, uncertainty,
  and task compatibility.
- Generate grasp or other manipulation candidates from geometry, affordances,
  learned artifacts, and optional operator hints.
- Check reachability, inverse kinematics, joint limits, singularities, collision,
  payload, base stance, approach, retreat, and destination constraints.
- Rank candidates and publish a revisioned `ManipulationPlanPreview`.
- Bind approval to the exact plan, scene, object, and robot-state revisions.
- Request arm/gripper ownership through the command arbiter.
- Execute locally through the canonical adapter interface.
- Monitor object tracking and robot feedback throughout execution.
- Verify the result using configured evidence such as gripper state, current,
  force, object tracking, and post-action observation.
- Produce a typed outcome with evidence, retryability, and assistance need.

## Execution policy

- The initial B2W/Z1 profile requires the base to be stopped and in a validated
  stance before arm ownership is requested.
- Large plans are decomposed into bounded local phases such as approach, grasp,
  lift, transfer, place, and retreat.
- Each phase has explicit preconditions, timeout, abort response, and
  verification.
- Changes to the target pose, collision scene, plan, or robot configuration
  invalidate earlier approval according to configured tolerances.

## Boundaries

- The executor cannot command hardware except through the arbiter, safety
  supervisor, and adapter.
- Operator hints may rank or constrain candidates but cannot waive safety
  checks.
- A planner success is not an execution success; physical outcome verification
  is mandatory.
- Direct teleoperation is a separate source and requires a stopped ownership
  handoff.

## Failure behavior

- Loss of target tracking or a safety input pauses/aborts according to the
  validated phase policy.
- Ownership loss stops issuing commands and records the incomplete phase.
- Retry is allowed only from a reconciled robot/object state, never by replaying
  the last command stream.
- Uncertain results produce a new assistance request rather than reporting
  success.

## Initial milestone

Generate collision-checked grasp previews for a simulated grounded object,
require approval of the exact revision, execute through the simulated adapter,
verify the grasp, and cover target movement, ownership loss, rejected plans,
failed grasps, and process restart.

## Implemented

The first executor is deliberately simulation-only and rejects any adapter that
does not advertise `simulation: true`. It checks target revision, freshness,
uncertainty and reach; binds execution to an exact approval; requires an empty
ownership arbiter and a stopped base; runs bounded approach, grasp, lift and
verification phases through the canonical simulator adapter; and always
attempts adapter disablement and stopped ownership release. Fault injection and
target-revision changes produce typed failed outcomes instead of success.
