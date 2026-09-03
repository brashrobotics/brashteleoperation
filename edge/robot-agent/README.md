# Robot Agent

## Purpose

Terminates the authenticated real-time operator connection, installs
short-lived session leases, validates remote messages, and bridges canonical
contracts to robot-local interfaces.

## Current implementation

`src/command-validator.ts` implements the edge command trust-boundary core. It
checks contract version, lease identity and scope, command/lease expiry,
bounded lifetime, future clock skew, deadman/clutch, actuator-intent agreement,
finite/ranged values, and monotonically increasing per-session sequence.

`src/local-robot-agent.ts` composes lease installation/revocation, stopped
ownership handoff, validation, independent base/Z1 safety, and forced hold on
lease expiry. Handoff acknowledgement requires fresh stopped/holding evidence.
It also derives a canonical readiness report from the installed lease and the
actual robot-local arbiter revision for authenticated publication to Session
Control.

`HttpRobotReadinessPublisher` rejects redirects, insecure non-loopback URLs,
timeouts, oversized responses, authentication failures, and mismatched
acknowledgement provenance. `RobotReadinessReporter` keeps only the newest
report per session, retries with bounded backoff while it remains fresh, and
drops stale state. Publisher failure never rolls back or blocks a robot-local
ownership or safety transition.

The agent can require Ed25519-signed lease envelopes. Set
`BRASH_TELEOP_LEASE_SIGNING_KEY_ID` and
`BRASH_TELEOP_LEASE_SIGNING_PUBLIC_KEY_FILE` together in the development entry
point to enable strict verification. Raw leases, unknown key IDs, altered lease
fields, invalid signatures, and expired authority are then rejected. Only the
public key belongs at the edge.

`src/server.ts` exposes this composition through an authenticated,
loopback-only HTTP test transport and runs the local watchdog independently of
inbound requests. An optional exact loopback `operatorOrigin` enables CORS for
the B2W Gazebo console; no wildcard or non-loopback browser origin is accepted.

`src/realtime-command-channel.ts` supplies the transport-independent core for a
future WebRTC data channel or WebSocket adapter: heartbeat timeout, bounded
audit events, per-command acknowledgement/rejection, disconnect hold, and
lease revocation. It contains no network negotiation code and cannot restore a
command stream after restart. The Unitree ROS boundary is separate and
simulation-only.

## Responsibilities

- Authenticate the robot to the session-control service.
- Install, renew, revoke, and expire signed/scoped session leases.
- Establish the real-time command and telemetry channel using negotiated
  signaling information.
- Validate session ID, capability scope, mode, sequence, schema version,
  command expiry, deadman, and payload limits.
- Restamp arrival with a robot-local monotonic clock.
- Reject duplicate, reordered, late, unauthorized, and unknown commands.
- Translate valid canonical intent to robot-local command-arbiter requests.
- Return accepted-command state, rejections, safety state, robot state, and
  measured channel quality.
- Forward assistance operations between the orchestrator and robot-local
  perception/manipulation services.
- Expose liveness, readiness, current lease, and transport diagnostics.

## Boundaries

- Installing a lease does not grant actuator ownership.
- The agent performs no kinematics, collision checking, or vendor control.
- The agent cannot convert a Fleet mission directly into open-loop motion.
- The agent cannot continue sending the last remote command after expiry.
- Media transport and operator observation rights do not imply command rights.

## Robot-local interfaces

Expected interactions:

- Request/release `CommandOwnership` from the command arbiter.
- Publish validated `BaseMotionIntent`, `ArmMotionIntent`, or `GripperIntent`.
- Subscribe to `AcceptedCommandState`, `SafetyState`, capability state, and
  robot telemetry.
- Submit immutable observation references and object declarations to
  interactive perception.
- Request plans and receive outcomes from the manipulation executor.

These interfaces should use canonical ROS 2 messages or a narrow local RPC
schema. Vendor types remain inside the platform adapter.

## Failure behavior

- Connection loss, lease expiry, process shutdown, schema error, or heartbeat
  failure immediately clears the agent's ownership request and stops publishing
  live intent.
- On restart, the agent starts without a lease or ownership.
- Readiness delivery is also empty after restart; the edge must publish current
  state after installing a fresh lease.
- A recovered remote peer must establish a new or still-valid lease and complete
  a stopped handoff before commands can be accepted.
- Invalid traffic increments bounded metrics and audit events without flooding
  robot logs or starving valid local work.

## Next milestone

Bind the transport-independent channel to authenticated WebRTC or a comparably
bounded data channel, expose accepted-command telemetry, and package the tested
composition as a compiled ROS 2 node. Keep physical output disabled until the
profile commissioning gates are satisfied.
