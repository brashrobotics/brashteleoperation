# Configuration

## Purpose

Contains schemas and non-secret configuration for system components and
versioned robot profiles.

## Components

- [Robot profiles](robot-profiles/README.md)

## Rules

- Every configuration file is schema-validated before a component becomes
  ready.
- Units, coordinate frames, version, robot identity/profile scope, and source
  evidence are explicit.
- Secrets, private keys, bearer tokens, and session credentials are never
  committed here.
- Environment overrides cannot weaken a production safety limit without an
  auditable profile revision and deployment approval.
