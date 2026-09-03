# Unitree B2W + Z1 Adapter

## Purpose

Maps canonical teleoperation, manipulation, capability, and safety contracts to
the existing BRASH B2W quadruped and Unitree Z1 ROS 2 integration.

## Existing foundations to reuse

- `../../../../brashquadrupedcontroller` owns B2W/Z1 bringup, namespaced ROS 2
  topics, sensor integration, transforms, localization, and equipment-specific
  compatibility.
- The B2W hardware command topic is already remapped behind a freshness,
  heartbeat, finite-value, and per-axis velocity guard.
- Z1 is exposed through namespaced `ros2_control`; its motion controller is
  deliberately opt-in.
- Front/rear B2 cameras and D435i RGB-D streams are available through the
  controller launch profiles.

Repository-relative integration links are documented from the workspace root:

- `brashquadrupedcontroller/README.md`
- `brashquadrupedcontroller/docs/ARCHITECTURE.md`
- `brashquadrupedcontroller/src/brash_quadruped_driver/`

## Responsibilities

- Advertise supported base, arm, gripper, camera, telemetry, and safety
  capabilities for the exact hardware/firmware profile.
- Map canonical base intent to the guarded B2W velocity path.
- Map canonical Z1 motion to a robot-local joint/Cartesian servo and
  `ros2_control` command path.
- Map gripper intent and report observed gripper state.
- Normalize odometry, joints, battery, IMU, controller state, stop state, and
  diagnostic feedback.
- Supply validated frame names, mount transforms, joint ordering/signs, limits,
  payload constraints, safe-response behavior, and controller rates.
- Acknowledge command acceptance and actual stopped/holding state.
- Isolate Unitree SDK, DDS-domain, Z1 UDP/helper-process, and firmware variation.

## Initial safety profile

- Base motion only while the Z1 is stowed/disabled or satisfies an explicitly
  validated posture rule.
- Z1 control only while the base is stopped in a validated stance.
- Base and arm direct-control modes are mutually exclusive.
- Z1 joint trajectory/servo commands pass through an arm-specific freshness
  and limit guard.
- Loss of either vendor interface triggers the measured safe response and
  revokes ownership.
- Physical emergency-stop and vendor remote behavior are validated separately.

## Calibration and commissioning prerequisites

- Measured `base_link` to `z1_world` mount transform.
- Camera intrinsics and camera-to-base/tool extrinsics.
- B2W command axes, signs, deadband, acceleration, and stop behavior.
- Z1 joint order, zero offsets, limits, servo rate, halt/hold behavior, and
  gripper mapping.
- Payload, center-of-mass, arm-reach, collision, stance, and stability envelope.
- Timestamp and clock policy for every observation and state stream.
- Exact robot, firmware, SDK, ROS overlay, and configuration versions.

## Failure behavior

- Missing/mismatched capability or calibration prevents readiness.
- Vendor disconnection or stale state prevents new commands and reports a typed
  fault upstream.
- Adapter restart starts without ownership and with command output disabled.
- A base or Z1 command is never inferred from a Fleet mission or object label.

## Initial milestone

First pass the shared adapter suite against simulation. Then validate read-only
state on hardware, followed by base control at restricted limits, and finally
Z1 joint-jog before Cartesian manipulation. Each transition uses a documented
lab procedure and retained evidence.

## Implemented boundary

The dependency-free ROS boundary now fixes the exact BRASH namespace/topic
mapping, normalizes timestamped B2/Z1 telemetry, validates the six-joint Z1
shape, rejects stale/non-finite state, and prevents any topic profile from
targeting the guarded hardware velocity output. It can publish the validated
safety-supervisor output only with a simulation profile, explicit runtime
opt-in, exact safety revision, and matching active ownership. Simulation
mapping covers guarded base twist plus safety-limited Z1 joint jog, Cartesian
twist, and gripper commands. Physical publication is intentionally not
implemented and returns `PHYSICAL_COMMAND_PATH_DISABLED`.
