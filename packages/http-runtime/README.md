# JSON HTTP Runtime

## Purpose

Provides the small dependency-free HTTP utilities shared by the loopback
control-plane API and robot-edge test transport.

## Current implementation

`src/index.ts` provides bounded JSON-body parsing, strict object/field readers,
constant-time bearer-token comparison, consistent domain-error responses,
JSON response helpers, and ephemeral loopback server startup/shutdown.

## Boundaries

- This package is transport plumbing, not authentication policy or business
  logic.
- The edge HTTP command endpoint is a test transport and is not the planned
  real-time production transport.
- Non-loopback binding and TLS termination are outside the first implementation.
- Request limits are defensive defaults, not a substitute for an ingress proxy.

## Next milestone

Add request IDs, structured access logs, rate limits, production TLS/ingress
integration, and generated API documentation once endpoint contracts stabilize.
