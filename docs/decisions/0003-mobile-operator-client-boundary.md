# ADR 0003: Share operator contracts while keeping mobile lifecycle fail-closed

- **Status:** Accepted
- **Date:** 2026-09-03

## Context

Operators will eventually assist and control robots from phones and tablets.
Those devices have lifecycle and connectivity behaviors that do not exist in a
fixed workstation: the OS can background or suspend an app, lock the screen,
interrupt it with a call, move between radios, throttle it, or terminate it.
Creating a second robot API for mobile would duplicate authority and safety
behavior while relying on mobile background execution would make stop timing
unreliable.

## Decision

Desktop, web, and native mobile clients share canonical leases, assistance
contracts, command envelopes, media metadata, and the same authenticated edge
data plane. A transport-neutral operator client core gates normalized input and
requires foreground, unlocked screen, live real-time connection, acknowledged
ownership, robot safety enablement, deadman, and—when manipulating—a clutch.

Any lifecycle or readiness loss clears local input and closes the command
channel. Recovery returns to hold and requires a fresh deadman edge. The client
does not attempt to guarantee a final stop packet; the edge and robot-local
watchdogs remain authoritative.

The PWA supports low-rate assistance and supervision first. Direct motion on
mobile is reserved for a native shell after lifecycle, network, ergonomics, and
physical stop behavior are qualified.

## Consequences

- Mobile can be added without changing robot adapters or actuator APIs.
- Assistance features can ship before direct mobile motion.
- A shared core reduces behavioral drift, but platform shells still require
  native lifecycle and input integration tests.
- Returning from background or reconnecting costs an explicit re-arm step.
- Robot stop behavior does not depend on OS scheduling or reliable packet
  delivery from a disappearing mobile connection.

## Alternatives considered

- Use REST calls for mobile motion: rejected because HTTP request/response is
  not the authenticated high-rate command channel and encourages stale input.
- Continue sending in the background: rejected because mobile operating systems
  do not provide reliable timing or execution guarantees.
- Treat the responsive website as the final direct-control product: rejected
  for the initial hardware release because native lifecycle, secure storage,
  input, media, and device-policy integrations need explicit qualification.
- Build separate mobile command schemas: rejected because it would duplicate
  validation and produce inconsistent robot behavior across clients.
