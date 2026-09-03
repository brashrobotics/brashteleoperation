# Media Gateway

## Purpose

Publishes low-latency robot video and synchronized perception metadata while
preserving raw observations and their timing/provenance.

## Responsibilities

- Discover cameras declared by the active robot capability profile.
- Encode raw feeds using available hardware acceleration.
- Negotiate direct or relayed encrypted media sessions.
- Adapt bitrate, resolution, frame rate, and selected camera to network quality.
- Preserve source timestamp, frame ID, calibration version, and sequence.
- Carry depth/perception metadata separately from raw video where practical.
- Publish frame age, encoder delay, packet loss, jitter, and estimated
  glass-to-glass latency.
- Produce immutable observation-bundle references for assistance requests.
- Enforce camera-level observation permissions.

## Boundaries

- The gateway cannot grant or infer actuator command authority.
- Perception overlays do not overwrite stored or streamed raw frames.
- Reconstructed, stabilized, predicted, or generated views are clearly labeled
  and remain supplementary.
- Media timestamps are not trusted as command-watchdog time.
- Recording is policy-controlled and separate from the live transport buffer.

## Failure behavior

- Loss of one camera does not crash other streams.
- Stale frames are dropped or marked; they are never silently repeated as live.
- The operator station receives explicit source-loss and timestamp status.
- When network quality falls, adaptation preserves freshness ahead of visual
  quality and never affects robot-local safety behavior.

## Initial milestone

Stream one raw RGB feed plus timestamped depth/segmentation metadata from
simulation, create a stable immutable observation reference, degrade cleanly
under injected bandwidth/loss, and expose measurable frame age to the operator.

## Implemented core

The dependency-free core registers calibrated RGB/depth cameras, maintains a
strictly sequenced bounded frame ring, drops stale or reordered frames, issues
short-lived HMAC-signed observation grants, and freezes synchronized RGB-D
metadata and bytes into immutable checksummed observation bundles. Frozen bytes
are retained under explicit observation-count and total-byte budgets and their
hash is rechecked at retrieval. Quality selection prioritizes freshness and
explicitly pauses stale media.

`src/server.ts` is a loopback-only test adapter for low-rate immutable image
previews. It requires per-request operator identity, `media:read` permission,
an application authorization callback, exact CORS origins, and a short-lived
observation/camera grant. It exposes provenance headers and safe image media
types with no-store responses. It is not a production live-video transport.
Encoding and encrypted WebRTC transport remain deployment adapters; neither
can grant command authority.

For an interactive local exercise, start the control API and then run
`npm run dev:media`. The simulator creates a synthetic RGB-D observation,
opens an `OBJECT_NOT_RECOGNIZED` request through the robot-authenticated control
API, serves its frozen preview on port 4312, and starts the
[simulation assistance worker](../../workers/simulation-assistance/README.md).
After declaration it grounds and plans, waits for exact approval, and completes
only simulated execution and verification. It never connects to ROS or
hardware.
