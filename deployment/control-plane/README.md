# Control-Plane Deployment

## Purpose

Packages session control, assistance orchestration, object registry, persistence,
and asynchronous learning services for a site or cloud environment.

## Responsibilities

- Supply service discovery, ingress, authenticated signaling, persistence,
  queues, object storage, and artifact storage.
- Configure identity provider, role mappings, robot identities, and audit sinks.
- Run database migrations and reversible artifact/catalog promotions.
- Expose liveness/readiness while distinguishing partial dependencies.
- Monitor lease issuance, assistance backlog, workflow age, registry changes,
  and learning/promotion activity.
- Back up and restore durable assistance, audit, registry, and artifact metadata.

## Boundaries

- Control-plane health is not a robot motion-enable signal.
- Loss of the control plane must result in lease expiry/hold at the edge; it
  must not require a remotely delivered stop command.
- Media relay infrastructure carries encrypted media but cannot authorize
  commands.

## Initial milestone

Provide a local compose-style environment for simulation with identity stub,
session control, assistance orchestrator, persistence, object registry, and
artifact storage; demonstrate restart and durable workflow recovery.

## Implemented simulation deployment

`../compose.simulation.yaml` runs the durable control plane and robot-edge test
transport as separate unprivileged, read-only containers on Linux host
networking, while both applications remain bound to loopback. Tokens must be
provided at runtime, the control snapshot is on a named volume, health checks
are explicit, and simulation is the only profile allowed. Alert rules cover
assistance backlog and API failures. This is not a production ingress or
identity configuration.
