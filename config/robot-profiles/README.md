# Robot Profiles

## Purpose

Defines versioned, measured capabilities, limits, frames, safe responses, and
commissioning evidence for each deployable robot configuration.

## Required profile sections

- Robot/vendor/model/serial or fleet identity matching rules.
- Firmware, SDK, ROS, adapter, URDF, and calibration compatibility ranges.
- Base axes, frames, maximum velocity/acceleration/jerk, deadbands, and stop
  response.
- Arm joint ordering, signs, limits, servo/controller rate, workspace, and
  halt/hold response.
- Gripper range, force/current limits, and success evidence.
- Base-to-arm, camera, depth, LiDAR, and tool transforms with calibration IDs.
- Payload, center-of-mass, stance, stability, reach, and collision envelopes.
- Required sensors, controller states, freshness limits, and degraded behavior.
- Watchdog deadlines and measured response evidence.
- Allowed direct-control and interactive-autonomy capabilities.

## Lifecycle

Profiles progress from `DRAFT` through `SIMULATION_VALIDATED`,
`OBSERVE_ONLY_VALIDATED`, `RESTRICTED_LAB`, and `PRODUCTION_APPROVED` according to
the organization's safety process. Architecture documents do not confer these
states; retained test and review evidence does.

## Boundaries

- No universal default is assumed safe for an unknown robot.
- Simulation profiles are never accepted as physical profiles.
- A profile mismatch prevents readiness rather than falling back to broad
  limits.
- Secrets and network credentials are external runtime configuration.

## Initial milestone

Create separate simulated and physical-candidate B2W/Z1 schemas. Populate the
simulation profile and leave every unmeasured physical value explicitly
unresolved so the real adapter remains observe-only.

## Implemented

`schema.json` defines the portable profile shape. `b2-z1.simulation.json`
contains the deterministic test envelope, while
`b2-z1.physical-candidate.json` keeps command output disabled and lists every
commissioning measurement still unresolved. The runtime loader rejects
malformed limits and will not accept physical command output unless the profile
is complete, `PRODUCTION_APPROVED`, and contains an explicit approval ID.
