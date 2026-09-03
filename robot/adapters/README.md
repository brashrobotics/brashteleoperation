# Robot Adapters

## Purpose

Contains platform-specific implementations of the canonical robot adapter
contract.

## Components

- [Unitree B2W + Z1](unitree-b2-z1/README.md)

## Adapter rules

- Vendor messages, services, SDK objects, and firmware differences stay inside
  the adapter.
- Capabilities are declared explicitly; missing capabilities fail closed.
- Every command path reports acceptance/rejection and observed robot state.
- Every adapter passes the shared conformance and failure suites.
- A robot profile supplies measured limits and safe responses separately from
  adapter code.
