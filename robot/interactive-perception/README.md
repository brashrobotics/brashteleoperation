# Interactive Perception

## Purpose

Converts an operator declaration made against an immutable observation into a
tracked, uncertainty-aware 3D object that autonomous manipulation can consume.

## Responsibilities

- Load the exact synchronized observation bundle referenced by a declaration.
- Accept point, box, lasso, mask, semantic, and manipulation-affordance prompts.
- Propose a segmentation mask and support operator correction revisions.
- Project the selected pixels into calibrated depth/point-cloud geometry.
- Estimate object pose, collision geometry, dimensions, and uncertainty.
- Track the grounded object across new frames and robot/camera motion.
- Detect loss, ambiguity, calibration mismatch, scene change, and staleness.
- Publish immutable `GroundedObject` revisions into the runtime scene model.
- Request active perception or additional operator views when observability is
  insufficient, subject to normal planning and safety approval.
- Package reviewed observations and outcomes as enrollment candidates without
  modifying a production model.

## Required provenance

Every result includes:

- Declaration and observation IDs.
- Source sensor frames and timestamps.
- Camera/depth calibration and robot-description versions.
- Mask/selection revision.
- Pose frame, covariance or equivalent uncertainty, and geometry method.
- Algorithm/model name and version.
- Tracking state, last-confirmed time, and invalidation reason.

## Boundaries

- The component publishes scene facts, not actuator commands.
- A semantic label does not imply a valid target pose or grasp.
- It cannot silently replace raw observations with generated imagery.
- It cannot promote enrollment artifacts.
- A stale/lost target must be invalidated rather than extrapolated indefinitely.

## Failure behavior

- Missing depth, invalid calibration, high uncertainty, or conflicting views
  return a typed result requiring correction, another view, or direct control.
- Process restart invalidates transient tracking sessions unless the current
  scene is explicitly re-observed and reconciled.
- If the object moves outside validated tracking bounds during planning or
  execution, its scene-model revision becomes invalid for new commands.

## Initial milestone

In integrated B2W/Z1 simulation, accept an operator box/mask over synchronized
RGB-D, create a 3D object crop and pose with visible uncertainty, track it while
the camera moves, and invalidate it deterministically on scene or calibration
change.

## Implemented

The deterministic RGB-D grounder validates immutable observation provenance,
camera shape and calibration, projects point/box/mask selections into 3D,
estimates geometry and uncertainty, and publishes revisioned scene objects. It
returns explicit requests for more operator input on missing depth, frame
mismatch, empty masks, or excessive uncertainty. Tracking publishes a new
revision and invalidates the object if calibration changes.

Reviewed exemplar artifacts can now be installed into a robot-local runtime
recognizer only when their exact registry version is active for the site and
robot capability. Recognition selects a grounded proposal above its reviewed
threshold, requests human help when no match exists, and reports ambiguity when
two candidates are too close. Installed artifacts remain usable during a
registry outage; their pinned version is never replaced mid-attempt.

The recognition-assistance coordinator converts a miss or ambiguity into a
revisioned assistance request over the same immutable observation references.
A reviewed match returns directly to autonomy and does not open a request.
