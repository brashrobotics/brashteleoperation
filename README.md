# BRASH Teleoperation and Interactive Autonomy

Executable foundation for human-assisted control of BRASH robots. The first
robot profile is the Unitree B2W quadruped with a Z1 arm and gripper, but the
contracts and operator workflows are intentionally vendor-neutral.

The system supports two complementary recovery paths:

1. **Interactive autonomy** is preferred. When autonomy cannot identify or
   manipulate an object, an operator declares the target in the interface. The
   robot grounds that declaration in 3D, proposes a safe manipulation plan, and
   resumes autonomous execution after the required approval.
2. **Direct teleoperation** is the fallback. An authorized operator directly
   commands base or arm motion through an exclusive, expiring session while all
   robot-local safety constraints remain active.

This directory contains a dependency-light TypeScript implementation of the
control, assistance, simulation, evidence, enrollment, and operator-console
boundaries. It is deployable for local simulation only. It is not a
safety-rated system and contains no enabled physical Unitree command path.

## Implementation status

Implemented:

- Version 1 canonical contract types and runtime validation.
- Strict unknown-JSON decoders for every implemented external contract.
- Immutable observation and revisioned runtime scene model.
- Durable single-node session, assistance, registry, and audit snapshots with
  checksums, atomic replacement, and restart-time expiry reconciliation.
- Unknown-object assistance with assignment, declaration correction, exact
  revision binding, plan approval, execution outcome, and verification.
- Edge command validation for scope, identity, expiry, deadman, sequence, and
  intent shape.
- Robot-local stopped-handoff command arbiter.
- Base and Z1 safety supervisors with independent interlocks, local timeouts,
  stopped-handshake evidence, limiting, hold, and fault states.
- Authenticated, role-authorized loopback API for sessions, assistance, object
  registry, observability, and the operator console.
- Authenticated loopback robot-edge test transport composing lease installation,
  validation, ownership, and base safety.
- Signed Ed25519 lease envelopes and a transport-independent real-time command
  channel with heartbeat, sequence, expiry, and bounded audit behavior. The
  control API signs grants and renewals and exposes an operator-bound recovery
  endpoint; a configured edge rejects unsigned or tampered authority.
- Expiring, revisioned WebRTC signaling for operator offers, robot-edge answers,
  bounded ICE exchange, peer acknowledgement, idempotency, identity binding,
  payload-free audit, and restart-time negotiation scrubbing.
- Bounded synchronized media metadata and frozen RGB-D retention, scoped
  immutable-preview grants, client-side preview hash verification,
  content-addressed evidence recording, consent/redaction checks, reviewed
  registry versions, held-out exemplar evaluation, scoped recognition, and
  rollback.
- Deterministic RGB-D point/box/mask grounding and a simulation-only
  manipulation executor with exact plan/scene/object approval binding.
- Robot-authenticated simulation assistance worker that advances grounding and
  planning, pauses for exact operator approval, then simulates execution,
  verification, and terminal resolution through the revisioned HTTP API.
- Fleet reservation/stopped-handoff boundary and a simulation-only B2W/Z1 ROS
  mapper. Physical publication is rejected by construction.
- Bounded authenticated Fleet hold HTTP adapter, versioned endpoint contract,
  durable single-node reservation/release retry, command-session admission
  wiring, and conservative release ordering.
- Authenticated robot readiness reports bound to session, robot, operator,
  lease revision, ownership revision, actuator group, and a short freshness
  window; operator readiness booleans cannot activate or release command scope.
- Per-request principal resolution with distinct, least-privilege loopback
  credentials for operator and robot callers on one control API listener.
- Edge readiness publisher with bounded HTTP responses, latest-state queuing,
  freshness expiry, retry backoff, and non-blocking ownership hooks.
- Responsive local operator console for assistance, declaration, plan approval,
  escalation, lease setup, audit visibility, pointer/touch box selection on the
  exact retained observation image, and held-deadman B2W Gazebo driving through
  the loopback-only simulation edge, with a fresh authenticated Gazebo front
  camera view beside the drive controls.
- Installable mobile-assistance PWA plus a transport-neutral mobile command core
  that fails closed on backgrounding, screen lock, connection loss, lease
  expiry, deadman release, and process restart.
- Process-restart, network, contract, integration, failure, and simulation tests,
  including the full declare-once/recognize-later loop.

Not implemented yet:

- Production OIDC/mTLS identity, PostgreSQL/outbox storage, distributed locking,
  and the Fleet Control server-side teleoperation hold endpoints.
- Production WebRTC peer/media adapters, TURN/STUN credential provisioning,
  codecs, production camera transport, segmentation and feature models, and a
  collision-aware MoveIt 2 planning backend. Local simulation currently uses
  a bounded low-rate HTTP camera adapter instead of WebRTC.
- Native iOS/Android shells, platform identity/secure storage, native media and
  input adapters, device-policy integration, and physical-device qualification
  for direct mobile control.
- Production ROS 2 nodes, vendor SDK command integration, measured physical
  limits, hazard analysis, commissioning evidence, and any physical B2W/Z1
  command enablement. A compiled simulation-only B2W Gazebo bridge now lives in
  `../brashquadrupedcontroller`.

## Run the first slice

Requires Node.js 22.18 or newer.

```bash
npm install
npm run verify
npm run demo
npm run demo:autonomy
npm run demo:b2w
```

`demo` exercises direct control and one assisted manipulation workflow.
`demo:autonomy` additionally records reviewed evidence, evaluates and activates
a site-scoped exemplar, then recognizes and manipulates a future instance
without a second assistance request.
`demo:b2w` exercises the live loopback control-plane/edge/ROS/Gazebo path and
performs a short simulation-only forward motion with stopped-handoff cleanup.

After the ROS workspace has been built and `.env` configured, the complete
B2W stack can also be started from this repository with one command:

```bash
./scripts/run-b2w-simulation.sh
```

The command starts the three healthy Compose services and then keeps Gazebo in
the foreground. Open `http://127.0.0.1:4310/operator/`; Ctrl-C stops Gazebo but
leaves the restart-safe Compose services running.

`docker compose --env-file .env -f deployment/compose.simulation.yaml up
--build` starts a frozen-media simulator and seeds an unknown-object request
for mouse/touch declaration in the installable operator console. Its
robot-authenticated worker grounds and plans the declaration, waits for the
operator's exact approval, and then completes simulated execution and
verification. It cannot publish physical commands.

## System principles

- Robot-local safety is authoritative and does not depend on cloud reachability.
- The physical emergency stop and vendor safety controller remain independent.
- Fleet Control reserves and hands off robots, but does not carry high-rate
  motion commands or media.
- Raw observations remain available beside perception overlays.
- Operator declarations ground a current object instance; they do not silently
  retrain the production perception model.
- Every command and perception artifact is scoped, timestamped, traceable, and
  rejectable when stale.
- Teleoperation and autonomy never command the same actuator concurrently.
- Robot differences are isolated behind capability declarations and adapters.

## Component map

| Area | Component | Responsibility |
| --- | --- | --- |
| Operator | [Operator station](apps/operator-station/README.md) | Direct controls, object declaration, plan review, and session status |
| Operator | [Mobile operator application](apps/operator-mobile/README.md) | Mobile lifecycle, native-client roadmap, and installable assistance boundary |
| Control plane | [Control-plane API](apps/control-plane-api/README.md) | Loopback authenticated session and assistance HTTP API |
| Development | [Vertical-slice demo](apps/vertical-slice-demo/README.md) | Executable direct-control and unknown-object domain walkthrough |
| Development | [Interactive-autonomy demo](apps/interactive-autonomy-demo/README.md) | Declare once, review/evaluate, then recognize and act autonomously |
| Development | [B2W Gazebo teleoperation demo](apps/b2w-gazebo-demo/README.md) | End-to-end lease, safety, motion, stopped-handoff, and release smoke run |
| Control plane | [Session control](services/session-control/README.md) | Exclusive lease lifecycle and Fleet handoff |
| Control plane | [Real-time signaling](services/realtime-signaling/README.md) | Expiring, identity-bound WebRTC offer/answer/ICE coordination |
| Control plane | [Assistance orchestrator](services/assistance-orchestrator/README.md) | Human-assistance workflow and task resumption |
| Knowledge | [Object registry](services/object-registry/README.md) | Reviewed, versioned object exemplars and manipulation knowledge |
| Learning | [Learning pipeline](workers/learning-pipeline/README.md) | Offline evaluation and promotion of reviewed observations |
| Development | [Simulation assistance worker](workers/simulation-assistance/README.md) | Robot-authenticated grounding, plan, approval wait, and simulated completion |
| Robot edge | [Robot agent](edge/robot-agent/README.md) | Real-time authenticated endpoint and ROS/vendor translation |
| Robot edge | [Media gateway](edge/media-gateway/README.md) | Low-latency raw video and timestamped metadata transport |
| Robot edge | [Evidence recorder](edge/evidence-recorder/README.md) | Bounded local recording, correlation, and asynchronous evidence export |
| Robot runtime | [Command arbiter](robot/command-arbiter/README.md) | Exclusive actuator ownership and command-source selection |
| Robot runtime | [Safety supervisor](robot/safety-supervisor/README.md) | Local command validity, limits, interlocks, and safe response |
| Robot runtime | [Interactive perception](robot/interactive-perception/README.md) | Prompted segmentation, 3D grounding, tracking, and uncertainty |
| Robot runtime | [Manipulation executor](robot/manipulation-executor/README.md) | Plan, execute, and verify autonomous manipulation |
| Robot integration | [B2W + Z1 adapter](robot/adapters/unitree-b2-z1/README.md) | Unitree/ROS-specific base, arm, gripper, and telemetry mapping |
| Shared | [Contracts](packages/contracts/README.md) | Versioned messages and state definitions |
| Shared | [Operator client core](packages/operator-client-core/README.md) | Mobile-safe readiness, deadman/clutch gating, and canonical command generation |
| Shared | [JSON HTTP runtime](packages/http-runtime/README.md) | Bounded parsing, authentication, errors, and loopback server utilities |
| Shared | [Scene model](packages/scene-model/README.md) | Runtime objects, observations, transforms, and provenance |
| Shared | [Robot adapter SDK](packages/robot-adapter-sdk/README.md) | Capability and conformance contract for future robots |

The complete data flows, state machines, safety invariants, and deployment
boundaries are in the [system architecture](docs/architecture/README.md).

Supporting areas:

- [Documentation](docs/README.md)
- [Robot profiles and configuration](config/README.md)
- [Deployment](deployment/README.md)
- [Verification suites](tests/README.md)

## Relationship to existing BRASH projects

- `../brashquadrupedcontroller` remains the ROS 2 equipment integration and
  supplies B2W/Z1 drivers, transforms, sensors, and the existing velocity guard.
- `../brashfleetcontrol` remains mission-, dispatch-, and traffic-oriented. It
  integrates only with session lifecycle, robot reservation, and audit events.
- This project owns human assistance, low-latency operator communication,
  interactive object grounding, and direct teleoperation.

## Delivery sequence

Completed in this simulation foundation: canonical contracts, direct base and
Z1 control safety paths, unknown-object assistance, RGB-D grounding, simulated
manipulation, reviewed enrollment, future recognition, durable state, local
operator UI, installable mobile-assistance shell, shared mobile command gating,
and failure/restart tests.

Remaining release gates, in order:

1. Integrate production identity, database/outbox, Fleet RPC, WebRTC/media, and
   compiled ROS 2 nodes while retaining the tested domain boundaries.
2. Add production perception and MoveIt 2 planning backends in simulation.
3. Validate read-only hardware telemetry and all frame/calibration contracts.
4. Measure stop behavior and establish a restricted laboratory robot profile.
5. Qualify restricted B2W control, then Z1 joint jog, then manipulation.
6. Approve a production profile only after hazard analysis and retained
   commissioning evidence.

Each physical-robot phase requires its own hazard analysis, laboratory test
procedure, measured stop behavior, and explicit approval.
