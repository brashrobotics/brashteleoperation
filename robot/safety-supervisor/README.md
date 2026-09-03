# Safety Supervisor

## Purpose

Applies robot-local software interlocks, command freshness checks, motion
limits, state-dependent envelopes, and deterministic safe responses before a
selected command reaches the platform adapter.

This component supports operational safety but is not assumed to be
safety-rated. The physical emergency stop and vendor safety controller remain
independent and authoritative.

## Current implementation

`src/base-safety-supervisor.ts` implements the dependency-free base domain core:
versioned state transitions, required interlocks, ownership checks, local
arrival-time timeout, speed scaling, per-axis velocity clamps, acceleration
limiting, accepted-command feedback, explicit hold, protective stop, and
latched fault behavior. It has no hardware output and its example limits are
simulation-only.

## Responsibilities

- Require a live command-arbiter heartbeat and valid selected owner.
- Reject non-finite, malformed, stale, or out-of-mode commands.
- Apply velocity, acceleration, jerk, joint, workspace, and configured payload
  limits.
- Enforce base stop and validated stance before Z1 ownership.
- Enforce posture/payload-dependent base limits when later profiles allow them.
- Consume vendor protective-stop, emergency-stop, fault, battery, stability,
  localization, and controller-health state where available.
- Apply collision/tracking/reachability interlocks supplied through typed,
  freshness-checked safety inputs.
- Publish requested, limited, and accepted command plus intervention reason.
- Execute and measure the robot-profile safe response on any invalidation.
- Latch faults where automatic clearing would be unsafe.

## Safety-state model

Suggested states:

`BOOTING -> DISARMED -> READY -> ENABLED -> HOLDING`

Transitions from any state may enter `PROTECTIVE_STOP`, `FAULT`, or
`EMERGENCY_STOP_OBSERVED`. Returning to `READY` requires all interlocks to pass
and, for latched states, an authorized acknowledgement. Returning to `ENABLED`
requires a new ownership/deadman transition.

## Boundaries

- The supervisor does not authenticate users or allocate sessions.
- It does not generate autonomous paths or grasp plans.
- A remote “stop” is treated as a controlled-stop request, not a certified
  emergency-stop channel.
- Universal numerical limits are prohibited; each value belongs to a versioned
  robot profile with measurement evidence and units.
- Perception confidence alone cannot authorize motion.

## Failure behavior

- Missing or stale required input selects the conservative profile response.
- Process restart starts disarmed and outputs stop.
- Configuration/schema mismatch prevents readiness.
- Loss of downstream adapter acknowledgement becomes a fault and prevents new
  commands.
- Physical/vendor safety state always overrides software enable state.

## Next milestone

Implement a ROS 2 lifecycle wrapper and bridge its zero/limited output through
the existing B2W velocity guard. Add profile-file validation, downstream stop
acknowledgement, measured watchdog tests, and a separate Z1 safety core before
any physical arm command path is enabled.

## Manipulator implementation

The Z1 safety core now has an independent freshness timeout and hold output. It
requires controller/state health, a stopped base, stable stance, joint-limit
state, and collision state before enablement; accepts only the current
manipulator owner; validates six-value joint jog or Cartesian input; scales
commands to profile limits; and moves to hold or protective stop on timeout or
interlock loss. The local robot agent enables this path only when a manipulator
profile is explicitly configured. Physical arm publication remains absent.
