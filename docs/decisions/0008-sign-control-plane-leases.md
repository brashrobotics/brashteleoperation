# ADR 0008: Sign control-plane session leases

- **Status:** Accepted
- **Date:** 2026-09-03

## Context

The robot edge must distinguish a lease issued by Session Control from raw JSON
created or modified by an operator, mobile application, signaling peer, or
intermediary. Transport authentication alone does not make a copied lease
tamper-evident after it crosses process and real-time channel boundaries.

## Decision

Session Control optionally signs the canonical lease bytes with Ed25519 on
grant and renewal and exposes an operator-bound recovery endpoint for the
current live lease. The envelope carries an explicit algorithm and key ID. A
configured robot edge rejects unsigned leases, unknown key IDs, invalid
signatures, identity changes, scope changes, stale revisions, and expiry.

Private signing keys are loaded only by the control-plane process from a file;
robot edge receives only public verification keys. Key material is never put in
domain state, audit events, API logs, or environment variable values. Physical
deployment must require signed leases; unsigned mode remains only for the
simulation compatibility path.

## Consequences

- Mobile and desktop clients can relay a lease but cannot expand its scope,
  robot, operator, revision, or validity without invalidating the signature.
- A signing failure cannot grant robot authority; the signed-lease recovery
  endpoint can recover a session already persisted as granted.
- Rotation needs overlapping trusted public keys and an auditable retirement
  procedure.
- Signature validity does not replace Fleet admission, current session state,
  robot readiness, ownership handoff, command expiry, or local safety.

## Alternatives considered

- Trust raw lease JSON over TLS: rejected because leases cross more than one
  transport and can be modified or replayed by a client.
- Symmetric MAC shared with every operator: rejected because any holder could
  mint robot-authorizing leases.
- Embed long-lived identity tokens in the real-time command stream: rejected
  because it expands secret exposure and couples identity lifetime to control.
