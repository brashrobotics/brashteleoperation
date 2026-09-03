# Robot Adapter SDK

## Purpose

Defines the capability, command, state, lifecycle, and conformance interfaces
that isolate platform-specific drivers from the rest of the system.

## Responsibilities

- Define adapter lifecycle: configure, validate, start observe-only, ready,
  enable command path, disable, and stop.
- Define capability discovery for base, arm, gripper, cameras, sensors, and
  reported safety states.
- Define canonical base/arm/gripper command and acknowledgement ports.
- Define normalized robot, controller, diagnostic, and safety-state streams.
- Define calibration/profile validation and version reporting.
- Provide simulator/fake adapters and a reusable conformance harness.
- Provide typed error and rejection semantics independent of vendor wording.

## Adapter contract rules

- Starting an adapter never enables actuator output automatically.
- Commands are rejected unless readiness, ownership, freshness, mode, and
  profile requirements are satisfied upstream and locally.
- Every accepted command is observable; silence is not acceptance.
- Adapter state contains source timestamp and observed-at timestamp.
- Vendor types do not escape the adapter module.
- Optional capabilities are absent, not silently emulated.
- Shutdown attempts the configured safe response and reports its acknowledgement.

## Conformance expectations

- Capability declaration and profile-schema validation.
- Command units, axes, frame, range, expiry, and acknowledgement.
- Observe-only mode cannot command.
- Startup/restart begins disabled.
- Stop on upstream timeout and downstream disconnect.
- Idempotent enable/disable and no command replay.
- Deterministic simulation fixtures for every supported actuator group.

## Initial milestone

Define the minimum base, arm, gripper, camera, robot-state, and stop-state ports;
implement a simulator adapter; and run the same suite against the B2W/Z1
adapter before physical command tests.

## Implemented

The transport-neutral lifecycle, capability, state, command, and acknowledgement
interfaces are implemented with a deterministic simulator adapter. It starts
disabled, requires the exact profile version and explicit command-output opt-in,
checks actuator capabilities and expiry, prevents arm enablement while the base
is moving, and supports deterministic fault injection. No Unitree hardware
output is connected.
