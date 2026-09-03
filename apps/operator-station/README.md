# Operator Station

## Implemented local console

The control-plane API now serves a responsive, keyboard-accessible console at
`/operator`. It keeps the development token in session storage, lists durable
sessions and assistance requests, displays immutable observation provenance,
loads a bounded and hash-verified frozen RGB preview from an optional media API,
supports pointer/touch box declarations in source-image coordinates, binds
approval to the exact active plan revision, escalates to direct teleoperation,
creates short-lived direct-base leases, drives the loopback-only B2W Gazebo
adapter with held touch or keyboard controls, and shows a read-only registry of
reviewed object knowledge. A one-second, low-rate state refresh makes robot-side
grounding, planning, and simulated completion visible without disturbing an
unchanged declaration form or active pointer selection.

It includes a web-app manifest, mobile safe-area layout, lifecycle notices, and
a network-only service worker, so it can be installed as a low-rate assistance
PWA. The worker clears prior BRASH caches and never creates an offline cache:
assistance, approval, lease, and safety state must not be presented from stale
storage. The development B2W controls connect only to an exact HTTP loopback
edge origin, keep the edge credential in memory, emit 150 ms commands while a
direction/deadman is held, and request robot-local hold on release, background,
or pointer loss. Physical direct mobile motion remains disabled pending the
native real-time client described in the
[mobile application boundary](../operator-mobile/README.md).

The simulation browser path installs its lease at the development edge and
waits for the ROS bridge to report measured stopped state and controller health
before enabling. Its downstream adapter publishes only to Gazebo controller
topics. The Unitree SDK and physical command topics remain absent. Production
browser control still requires the real-time channel described by the
architecture.

The optional media API URL must be HTTPS, except for loopback development. The
client requests a short-lived observation grant, keeps it only in memory,
bounds the response to 8 MiB, verifies observation and sensor-frame headers,
recomputes SHA-256 before display, and never substitutes a live frame when the
frozen preview is unavailable. Its exact origin must also be configured in the
control server's `BRASH_TELEOP_OPERATOR_CONNECT_ORIGINS`; the Content Security
Policy does not grant wildcard network access.

## Purpose

Provides one interface for direct motion teleoperation and interactive-autonomy
assistance. It helps an operator understand why a robot requested assistance,
declare the intended object or action, review the robot's interpretation, and
control motion directly only when necessary.

## Responsibilities

- Authenticate the operator and request a scoped session.
- Display current command owner, session expiry, robot mode, safety state, and
  network/observation age.
- Present raw timestamped camera views beside optional perception overlays.
- Allow click, box, lasso, and mask-correction object selection.
- Capture semantic label, task intent, grasp hints, forbidden regions,
  persistence scope, and operator notes.
- Display grounded 3D pose, uncertainty, tracking status, reachability, and
  manipulation-plan previews.
- Require approval of the exact plan revision when policy demands it.
- Map supported human-input devices to canonical base, arm, gripper, deadman,
  clutch, and speed-scale intent.
- Present requested versus accepted commands so safety intervention is visible.
- Stop emitting commands on deadman release, device loss, focus loss, session
  loss, or explicit release.

## Primary views

1. **Assistance inbox:** assigned requests, reason, age, robot, and task context.
2. **Object declaration:** synchronized RGB/depth views, selection tools, mask
   preview, semantics, affordances, and current-scene versus enrollment scope.
3. **Plan review:** 3D target, approach, grasp, retreat, collisions, constraints,
   expected outcome, confidence, and approval revision.
4. **Direct control:** base or arm mode, live video, accepted-command feedback,
   deadman, speed scale, and stop reason.
5. **Outcome review:** execution evidence, verification result, retry, correct,
   enroll, or escalate-to-direct-control action.

## Boundaries

- The interface never decides whether motion is safe.
- Browser or workstation focus is not considered a safety signal by itself;
  focus loss only causes input to cease and the robot watchdog to stop motion.
- Rendering an overlay does not alter the underlying raw observation.
- A displayed controlled-stop action is not a physical emergency stop.
- The interface cannot promote an enrollment candidate directly to production.

## Inputs and outputs

Inputs:

- Assistance and session state from control-plane services.
- Video, telemetry, scene metadata, accepted-command state, and safety state
  from the edge connection.
- Gamepad, SpaceMouse, keyboard, or later haptic input through input adapters.

Outputs:

- Session requests and release/hold actions.
- `ObjectDeclaration` and mask corrections.
- `ManipulationApproval` for a specific plan revision.
- Expiring canonical motion intent while direct control is active.
- Outcome review and optional enrollment-candidate request.

## Failure behavior

- Loss of the real-time channel freezes controls, clears deadman locally, and
  shows that the robot-side watchdog owns the stop.
- Stale video or scene metadata is prominently marked and cannot be used for a
  new declaration without an explicit refresh.
- Device disconnection clears the active input mode.
- Reconnection returns to observe/hold; motion does not resume automatically.

## B2W simulator controls

Start the teleoperation Compose stack, then launch the embodied controller with
`teleop_bridge:=true`. In the Direct control tab enter the loopback edge origin
and the development edge token. Touch controls use a held direction as their
deadman. Keyboard controls require holding Space plus W/A/S/D. Every release
requests hold and the edge watchdog independently zeros stale commands.

## Next milestone

Add depth-aligned overlays, lasso/mask correction, live-but-clearly-distinct
context video, and production WebRTC accepted-command feedback. Physical browser
motion remains disabled. Browser UI automation also remains pending; current
network tests validate the backing APIs, robot worker, and revision rules.
