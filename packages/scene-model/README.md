# Runtime Scene Model

## Purpose

Provides immutable, revisioned representations of robot observations, grounded
objects, transforms, collision geometry, tracking state, and provenance during
an assistance interaction.

## Current implementation

`src/index.ts` implements an in-memory runtime scene model that registers
immutable observation bundles, enforces robot/scene provenance when publishing
grounded objects, requires exact object revisions, rejects expired/unusable
targets, and records explicit invalidation revisions.

## Responsibilities

- Represent synchronized observation bundles without copying transport details
  into domain code.
- Represent 2D selections, masks, point-cloud/mesh/bounding geometry, object
  pose, uncertainty, and coordinate frame.
- Track revisions of the world, robot configuration, calibration, declaration,
  grounded object, and manipulation target.
- Determine whether a target/plan reference is current, stale, lost, ambiguous,
  or invalidated.
- Preserve links from derived artifacts back to raw observations and algorithms.
- Provide deterministic comparison/digest utilities for approval binding and
  replay.

## Core concepts

- `ObservationBundle`: immutable synchronized sensor references.
- `SceneRevision`: one consistent world/robot/calibration snapshot.
- `ObjectSelection`: point, box, lasso, mask, or 3D selection.
- `GroundedObject`: a current physical instance, not a durable class.
- `TrackingState`: current pose history and validity.
- `CollisionSceneReference`: geometry used by a specific plan revision.
- `ArtifactProvenance`: source inputs, algorithm/version, and derivation chain.

## Boundaries

- The scene model stores facts and references; it runs no segmentation, tracking,
  planning, or persistence workflow.
- It does not treat recognition confidence as safety authorization.
- Registry object classes and runtime grounded instances remain different types.
- Mutable “latest” aliases are not allowed in approvals or execution requests.

## Next milestone

Add collision-scene and transform revisions, immutable artifact storage ports,
and ROS 2 conversion at the robot edge while retaining deterministic replay.
