# Object Registry

## Purpose

Stores reviewed, versioned knowledge for recognizing and manipulating recurring
objects without confusing durable learning with a runtime target declaration.

## Responsibilities

- Store semantic object classes, instance exemplars, aliases, site scope, and
  lifecycle state.
- Store references to reviewed RGB/depth observations, masks, point clouds,
  geometry, feature artifacts, and calibration versions.
- Store manipulation affordances, allowed/forbidden grasp regions, payload
  properties, successful strategies, and failure evidence.
- Preserve provenance: operator, robot, site, task, algorithm versions, review,
  and promotion decision.
- Version artifacts and support rollback.
- Resolve which artifact versions are active for a site and robot capability.
- Supply immutable training/evaluation manifests to the learning pipeline.

## Lifecycle

`CANDIDATE -> IN_REVIEW -> APPROVED -> VALIDATING -> ACTIVE`

Any non-terminal state may become `REJECTED`; an active version may be
`DEPRECATED` or `ROLLED_BACK`. Activation is scoped and never overwrites prior
versions.

## Boundaries

- The registry is not a live scene graph or target tracker.
- Runtime manipulation cannot depend on registry availability after a target
  and artifact version have been resolved locally.
- A successful grasp is useful evidence but is not automatic proof that a
  semantic label or grasp policy generalizes.
- The registry cannot directly deploy or activate a model without a recorded
  evaluation and promotion decision.

## Initial milestone

Persist an enrollment candidate from a completed assistance interaction,
support human review, activate one site-scoped exemplar version, resolve that
version on a later task, and roll it back without deleting history.

## Implemented

The registry core enforces the documented review and validation lifecycle,
immutable provenance/evidence references, monotonically versioned object
classes, site-and-capability activation bindings, supersession, and rollback.
A passing validation is bound to the exact SHA-256 digest of the evaluated
artifact; a robot-local recognizer refuses a different artifact even when its
class and version IDs match.
A checksummed file runtime persists versions, bindings, and audit events for
single-node development. Enrollment from an assistance workflow is accepted
only after verified success and only when the operator explicitly selected
`SITE_ENROLLMENT_CANDIDATE` with a semantic label.
