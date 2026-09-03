# Contract Tests

## Purpose

Proves that every implementation agrees on canonical schemas, state machines,
adapter behavior, compatibility, and rejection semantics.

## Coverage

- Golden serialization vectors across supported languages/transports.
- Required/optional-field and major/minor-version compatibility.
- Units, coordinate frames, finite values, ranges, timestamp, expiry, and
  sequence validation.
- Session, ownership, assistance, object, plan, approval, and artifact lifecycle
  transition matrices.
- Robot adapter conformance including observe-only behavior and restart state.
- Fuzzing of untrusted operator/edge/control-plane decoders.
- Idempotency and duplicate delivery.
- Mobile foreground, screen-lock, connectivity, deadman/clutch, lease-expiry,
  and non-resuming restart behavior.

## Initial milestone

Run one shared suite against the simulator and B2W/Z1 adapter boundary, plus
language-level fixtures for the operator/control-plane and ROS/edge bindings.
