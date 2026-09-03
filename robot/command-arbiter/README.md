# Command Arbiter

## Purpose

Owns the single authoritative selection of which source may command each
actuator group: base, arm, and gripper.

## Current implementation

`src/command-arbiter.ts` implements one robot-local arbiter core with optimistic
revision checks. Every acquisition, release, replacement, or force-stop enters
`HANDOFF`; commands remain blocked until a stopped acknowledgement grants the
pending owner or clears ownership. Direct teleoperation requires a session and
selected commands must match source, session, robot, and actuator group.

## Responsibilities

- Track registered command sources and their health.
- Validate that a source has the required session or autonomous-task authority.
- Enforce at most one owner per actuator group.
- Implement explicit request, stopped handoff, grant, hold, revoke, and release
  transitions.
- Enforce profile rules such as base/arm mutual exclusion.
- Publish selected commands and a complete `CommandOwnershipState`.
- Publish typed rejection and revocation reasons.
- Clear ownership when source heartbeat, lease, mode precondition, or safety
  permission becomes invalid.
- Persist/audit ownership transitions through a non-blocking event sink.

## Initial ownership policy

Sources are classified as:

- Physical/vendor safety override.
- Robot-local safety or protective stop.
- Authorized local service/commissioning control.
- Direct teleoperation.
- Autonomous navigation or manipulation executor.

Higher priority does not cause live command switching. A different source can
be granted only after the old source is revoked, selected output is stopped,
the safety supervisor acknowledges the stop, and mode preconditions pass.

## Boundaries

- The arbiter does not decide kinematic or environmental safety.
- It cannot weaken a safety-supervisor stop or vendor safety state.
- It never merges commands from two sources.
- It does not remember and replay a source's last command after a handoff.
- Session authorization is necessary for remote sources but is not sufficient
  until robot-local ownership is granted.

## Failure behavior

- Process startup and restart select no owner and output stop.
- Ambiguous, conflicting, stale, or unhealthy sources result in no owner.
- Loss of the arbiter heartbeat causes the downstream safety supervisor to
  apply the robot-profile safe response.
- Audit-sink failure does not delay a safety transition; events are buffered
  within strict bounds and loss is surfaced as a fault.

## Next milestone

Expose the arbiter as a ROS 2 lifecycle node, add registered-source heartbeats
and base/manipulator mutual-exclusion profile rules, and test autonomous-to-
operator handoff against the integrated simulator.
