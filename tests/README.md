# Tests

## Purpose

Defines evidence that components, contracts, end-to-end workflows, and failure
responses behave as designed before simulation, laboratory, or production
promotion.

## Suites

- [Contract](contract/README.md)
- [End-to-end API](e2e/README.md)
- [Integration](integration/README.md)
- [Simulation](simulation/README.md)
- [Failure and resilience](failure/README.md)

## Evidence policy

- Every safety invariant has at least one automated test where feasible and a
  linked commissioning test where physical behavior is involved.
- Tests identify the exact contract, robot profile, code, model, calibration,
  firmware, and environment versions.
- Passing simulation does not imply physical safety approval.
- Expected failures and rejected commands are first-class outcomes.

## Current implementation

The dependency-free runtime test set covers schemas and signed leases, identity,
durable recovery/tamper rejection, Fleet admission, synchronized media and
bounded immutable preview retrieval,
evidence and learning provenance, registration/rollback, recognition-triggered
assistance, future recognition, command replay/expiry, stopped handoffs,
independent base/Z1 interlocks and watchdogs, simulation ROS mapping,
perception/manipulation failures, authenticated loopback APIs, process restart,
mobile lifecycle interruption and non-resumption, bounded WebRTC signaling and
restart scrubbing, two-service Fleet stop-confirmation/release ordering, the
robot-authenticated assistance worker's approval pause and simulated terminal
resolution, and the full declare-once/recognize-later loop. Run `npm run verify`
from the project root.
