# Canonical Contracts

## Purpose

Defines versioned, vendor-neutral schemas and state machines used across trust,
process, language, and transport boundaries.

## Current implementation

`src/index.ts` contains the initial version 1 types and runtime validators for
session leases, robot readiness reports, base/arm/gripper intent, ownership, assistance requests,
immutable observations, object declarations, grounded objects, manipulation
plans/approvals, and outcomes. `src/errors.ts` provides stable typed domain
errors. `src/decoders.ts` converts untrusted JSON into canonical session,
command, signaling, assistance, observation, declaration, grounding, plan,
approval, and outcome contracts. The implementation is transport-neutral and
has no external runtime dependency.

`src/lease-signing.ts` adds Ed25519 lease envelopes with key IDs, canonical
serialization, public-key verification, unknown-key rejection, and tamper
detection. Development can still exercise unsigned leases explicitly; a robot
agent configured with `requireSignedLeases` rejects them.

`schemas/canonical-contracts.schema.json` contains Draft 2020-12 definitions
for every external version-1 message implemented here, including signed lease,
robot readiness, base, arm, gripper, signaling, declaration, grounding, plan,
approval, and outcome variants. Golden JSON fixtures cover each workflow
boundary and round-trip through the strict decoders in the contract suite.

## Contract groups

### Capability and identity

- `RobotCapabilities`
- `RobotProfileReference`
- `OperatorIdentity`
- `RobotIdentity`

### Session and command

- `TeleopSessionLease`
- `SignedTeleopSessionLease`
- `RobotSessionReadinessReport`
- `CommandOwnershipRequest`
- `CommandOwnershipState`
- `TeleopCommandEnvelope`
- `RealtimeSignalingMessage` for bounded offer, answer, ICE, connected, and
  close exchange; signaling never grants command authority
- `BaseMotionIntent`
- `ArmMotionIntent`
- `GripperIntent`
- `AcceptedCommandState`
- `SafetyState`

### Human assistance

- `AssistanceRequest`
- `AssistanceResolution`
- `ObservationBundleReference`
- `ObjectDeclaration`
- `GroundedObject`
- `ManipulationPlanPreview`
- `ManipulationApproval`
- `ManipulationOutcome`

### Learning and registry

- `ObjectEnrollmentCandidate`
- `ObjectArtifactVersion`
- `EvaluationReportReference`
- `PromotionDecision`

## Envelope requirements

Every command includes:

- Contract major/minor version.
- Session, robot, operator/source, and actuator-group identifiers.
- Monotonic sequence number within the session/source stream.
- Source production time and explicit expiry/deadline.
- Requested mode and deadman/clutch state where applicable.
- Idempotency or deduplication identity where the transport can retry.

Every perception artifact includes:

- Observation, declaration, scene, and artifact revision IDs.
- Sensor frame and acquisition timestamp.
- Calibration, robot-profile, and algorithm/model versions.
- Uncertainty/confidence representation and validity horizon.
- Provenance and typed invalidation reason.

## Compatibility policy

- Additive optional fields are allowed within a major version.
- A receiver ignores unknown optional fields but rejects an unknown required
  capability or semantic.
- Units and coordinate frames are explicit; implicit vendor defaults are
  forbidden.
- Breaking semantic or state-machine changes require a new major version.
- Schemas generate language bindings where practical; handwritten duplicate
  wire models are prohibited.
- Recorded sessions retain the exact contract version used at runtime.

## Validation expectations

- Serialization round-trip and golden-vector tests in every supported language.
- Property tests for command expiry, sequence, units, and finite numeric values.
- State-machine transition tests.
- Backward/forward compatibility fixtures.
- Fuzzing for untrusted edge/control-plane decoders.
- Contract examples for every rejection and terminal state.

## Next milestone

Generate ROS 2 and additional-language bindings from the machine-readable
schemas, add property/fuzz testing at ingress boundaries, and publish a formal
compatibility release process.
