# Mobile Operator Application

## Status

The mobile product boundary and shared command-input core are implemented; the
native iOS/Android shell is a future application. The current operator console
is installable as a responsive PWA for assistance, supervision, and lease
setup. It intentionally has no direct actuator path.

The native app should begin with observe-and-assist workflows, then add direct
base control, and only later add Z1 control after device-specific usability,
network, and stop-behavior qualification.

The shared responsive console now exercises the mobile assistance path with a
short-lived media grant, bounded/hash-verified immutable image retrieval, and
pointer/touch box selection. This web implementation informs the native shell;
it does not qualify direct mobile motion.

## Architecture

The mobile app is another operator client, not a new robot interface. It uses:

- control-plane HTTPS APIs for identity, assistance, declaration, approval,
  session leases, and audit;
- the media gateway for live video and timestamped perception metadata;
- the authenticated real-time edge channel for expiring command envelopes and
  accepted-command feedback; and
- [operator client core](../../packages/operator-client-core/README.md) for
  normalized controls, sequencing, expiry, deadman/clutch gating, and lifecycle
  interruption behavior.

No REST endpoint, push-notification handler, background task, or cloud service
may issue motion commands. Mobile and desktop clients share the same canonical
contracts, edge validation, ownership handoff, and robot-local safety path.

## Mobile lifecycle requirements

The native shell must clear input state and close the command channel when any
of these occurs:

- app backgrounding, screen lock, process suspension, or process termination;
- phone call, system dialog, audio route, or other operating-system
  interruption that obscures or disables the active controls;
- Wi-Fi/cellular handoff, connection loss, excessive latency, or stale video;
- Bluetooth/gamepad disconnection;
- thermal pressure, low-power policy, or frame-rate degradation below the
  qualified operating envelope; or
- navigation away from the direct-control screen.

The app must not depend on background execution or a final zero packet. The
robot-local timeout is the stop mechanism. Returning to the foreground always
returns to observe/hold and requires fresh ownership confirmation plus an
observed deadman release followed by a new physical press.

## Interaction rules

- A direct-control screen shows live media age, command round-trip age, lease
  expiry, ownership, safety state, and requested versus accepted motion.
- A touch deadman requires continuous contact and must not latch. Haptics and
  audio are supplementary feedback, not safety mechanisms.
- Arm Cartesian or joint-jog control requires both deadman and a separate
  clutch gesture/control. Base and arm control are mutually exclusive for the
  first B2W/Z1 profile.
- Orientation changes and reachable display bounds must not synthesize input.
  Controls are cleared before remapping the layout.
- An on-screen stop requests a controlled stop; it is never labeled as or
  treated as a physical emergency stop.
- External gamepads are optional input adapters. Pairing or reconnection cannot
  re-arm control.

## Security and privacy

- Use platform OIDC flows and keep refresh credentials in Keychain/Keystore.
- Exchange long-lived identity for short-lived, robot- and scope-bound session
  credentials. Do not expose refresh tokens to the shared command core.
- Enforce device integrity and minimum OS policy where deployment risk requires
  it; treat attestation as an access signal, not a robot safety signal.
- Pin trust to the managed deployment PKI where operationally supportable and
  preserve certificate rotation/recovery procedures.
- Make recording and evidence state visible, apply site consent/redaction
  policy, and never cache protected video for offline use.

## Delivery phases

1. Installable PWA and native read-only shell: sign-in, fleet status, assistance
   inbox, object declaration, plan approval, telemetry, and notifications.
2. Native media and assistance tools: low-latency video, calibrated selection,
   mask correction, and interruption/network-quality telemetry.
3. Restricted base teleoperation: real-time edge channel, continuous deadman,
   accepted-command feedback, and device/lifecycle failure tests.
4. Restricted Z1 joint jog and gripper, followed by Cartesian control only after
   ergonomics and stop behavior are qualified.
5. Store distribution, mobile device management, staged rollout, and retained
   commissioning evidence.

Every direct-control phase requires physical-device testing across supported OS
versions, device classes, radios, orientation changes, incoming calls, screen
locks, thermal throttling, and network handoffs.
