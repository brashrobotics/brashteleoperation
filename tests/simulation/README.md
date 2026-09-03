# Simulation Tests

## Purpose

Validates robot motion, perception grounding, manipulation, and operator flows
in an integrated B2W/Z1 environment before any command reaches hardware.

## Required simulation capabilities

- B2W base, Z1 arm, gripper, joint/controller state, and collision geometry.
- RGB, depth, front/rear, and eventual wrist-camera observations with calibrated
  frames.
- Movable known, unknown, ambiguous, reflective, occluded, and unreachable
  objects.
- Deterministic task and perception-failure scenarios.
- Sensor noise, pose uncertainty, calibration mismatch, object movement, and
  tracking loss.
- Network latency, jitter, loss, duplication, reordering, disconnection, and
  bandwidth constraints.
- Process crash/restart and vendor-interface failure injection.

## Acceptance scenarios

- Direct base control with deadman and exclusive ownership.
- Arm/base mutual exclusion and stopped handoff.
- Unknown-object selection, mask correction, 3D grounding, tracking, plan
  preview, exact-revision approval, execution, and verification.
- Stale image, stale object, changed scene, changed plan, and lost-target
  rejection.
- Failed grasp leading to a structured assistance request rather than false
  completion.

## Initial milestone

Extend the existing base-only B2W simulation to include Z1, gripper, RGB-D,
object/collision scenes, and deterministic assistance scenarios, then run the
first end-to-end acceptance slice documented in the architecture.
