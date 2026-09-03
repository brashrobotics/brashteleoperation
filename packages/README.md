# Shared Packages

## Purpose

Contains transport-neutral domain contracts, scene semantics, and adapter
interfaces shared by applications, services, edge processes, robot components,
and tests.

## Components

- [Contracts](contracts/README.md)
- [JSON HTTP runtime](http-runtime/README.md)
- [Atomic persistence](persistence/README.md)
- [Observability](observability/README.md)
- [Identity and authorization](identity/README.md)
- [Operator client core](operator-client-core/README.md)
- [Scene model](scene-model/README.md)
- [Robot adapter SDK](robot-adapter-sdk/README.md)

Shared packages contain no deployment startup, database connection, ROS node,
vendor SDK, or UI composition code.
