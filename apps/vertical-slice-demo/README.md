# Vertical-Slice Demo

## Purpose

Runs the dependency-free domain implementation as one deterministic process
before network, persistence, ROS 2, media, perception-model, or UI adapters are
added.

The demo proves two paths:

1. A direct-base session is granted, installed, given robot-local ownership,
   validated, selected, stopped, and released.
2. An unknown-object request is assigned, declared against an immutable RGB-D
   observation, grounded in the runtime scene, planned, approved, executed,
   verified, and resolved.

## Run

From `brashteleoperation`:

```bash
npm run demo
```

The command prints the final session, ownership, assistance, object, and command
states as JSON. All timestamps and adapters are deterministic demonstration
fixtures; this application does not command hardware.

## Boundaries

- No authentication, networking, database, ROS 2, or perception model is
  implemented here.
- Synthetic grounding and execution results exercise provenance/state rules;
  they do not demonstrate manipulation quality.
- This app is a development executable, not a deployable control component.
