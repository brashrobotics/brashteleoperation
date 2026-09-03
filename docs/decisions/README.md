# Architecture Decision Records

## Purpose

Stores durable decisions that affect system safety, product boundaries,
compatibility, or long-term operability.

## Current decisions

- [ADR 0001: Separate control, real-time, autonomy, and safety planes](0001-separate-system-planes.md)
- [ADR 0002: Separate runtime object grounding from persistent learning](0002-separate-grounding-from-learning.md)
- [ADR 0003: Share operator contracts while keeping mobile lifecycle fail-closed](0003-mobile-operator-client-boundary.md)
- [ADR 0004: Separate WebRTC signaling from command authority](0004-separate-signaling-from-command-authority.md)
- [ADR 0005: Use a dedicated Fleet teleoperation-hold contract](0005-dedicated-fleet-teleoperation-hold.md)
- [ADR 0006: Robot edge reports command readiness](0006-robot-reports-command-readiness.md)
- [ADR 0007: Resolve the authenticated principal per request](0007-resolve-principal-per-request.md)
- [ADR 0008: Sign control-plane session leases](0008-sign-control-plane-leases.md)
- [ADR 0009: Bind declarations to retained observation media](0009-bind-declarations-to-retained-observation-media.md)
- [ADR 0010: Drive simulation assistance through the robot API boundary](0010-drive-simulation-assistance-through-robot-api.md)

## Rules

Each decision records context, decision, alternatives, consequences, status,
and date. Accepted decisions are not rewritten; a later decision supersedes
them explicitly.
