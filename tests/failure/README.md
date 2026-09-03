# Failure and Resilience Tests

## Purpose

Demonstrates deterministic, conservative behavior when dependencies, processes,
networks, sensors, state, or operators fail.

## Failure matrix

- Operator application crash, focus loss, and input-device disconnect.
- Real-time command channel loss, delay, duplication, reordering, and replay.
- Media-only loss and stale/repeated video.
- Session-control outage, lease expiry, revocation, and conflicting grants.
- Fleet handoff timeout or inconsistent reservation state.
- Robot-agent, arbiter, safety-supervisor, perception, manipulation, and adapter
  crash/restart independently.
- Camera/depth loss, calibration mismatch, localization degradation, tracking
  loss, and scene change.
- Vendor command/state disconnect and missing stop acknowledgement.
- Persistence, object-registry, artifact-store, audit-sink, and learning-worker
  outage.

## Assertions

- The final actuator command reaches the robot-profile safe response within its
  measured deadline whenever required.
- No reconnection or restart resumes motion automatically.
- No stale command, object pose, plan, or approval is accepted.
- Durable workflows recover idempotently without duplicate execution.
- Partial media or learning failure cannot grant command authority.
- Every stop/rejection has a bounded, observable reason.

## Initial milestone

Automate the complete failure matrix against simulation, retain timelines for
command age and stop acknowledgement, and block laboratory promotion on any
unexplained or non-deterministic result.
