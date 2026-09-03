# Evidence Recorder

## Purpose

Creates a correlated, bounded robot-local record of assistance and direct-control
sessions so behavior can be reconstructed, tested, audited, and—after review—
used as learning evidence.

## Responsibilities

- Record session/lease revisions, ownership, requested/accepted/rejected
  commands, safety transitions, and robot/controller state.
- Record assistance requests, immutable observation references, declarations,
  grounded-object revisions, plans, approvals, execution phases, and outcomes.
- Record network statistics and source/arrival timestamps needed to measure
  command and media age.
- Optionally record policy-approved raw sensor/video segments or references to
  separately stored media.
- Correlate ROS-local, edge, operator, assistance, Fleet, and registry events
  without relying on a single wall clock.
- Spool evidence locally during disconnection and export it asynchronously with
  integrity digests and idempotency keys.
- Enforce storage quotas, retention, redaction, and access policy.
- Produce replay manifests that pin contract, robot-profile, calibration,
  software, firmware, model, and artifact versions.

## Boundaries

- Recording and export are never in the final command or stop timing path.
- Recorder failure cannot grant motion, delay a stop, or block a safety-state
  transition.
- A recording is evidence of observed software state, not proof of physical
  safety or physical outcome by itself.
- Learning consumes only explicitly reviewed/exported evidence, not arbitrary
  live buffers.
- Privacy-sensitive audio/video recording is disabled unless policy enables it.

## Failure behavior

- When storage approaches its quota, preserve critical state/command/safety
  events and shed optional high-bandwidth media first.
- Export outage leaves a bounded local spool and surfaces health; it never grows
  without limit.
- Process restart opens a new recording segment linked to the active session but
  never restores command ownership.
- Corrupt or incomplete segments are quarantined and never silently promoted to
  training data.

## Initial milestone

Record and replay the complete simulated unknown-object workflow and direct-base
session, including process/network failure cases, with deterministic correlation
and proof that recorder loss does not affect stop latency.

## Implemented

The file-backed recorder stores content-addressed blobs with private file
permissions and a checksummed atomic manifest. It enforces per-artifact and
total quotas, a media-type allowlist, immutable IDs, and hash verification.
Artifacts retained for learning must be marked redacted and carry an explicit
consent identifier. The recorder returns provenance-rich references rather
than placing raw evidence in control-plane state.
