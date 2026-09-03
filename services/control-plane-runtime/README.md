# Control-plane Runtime

Composes session control, authenticated robot readiness, assistance
orchestration, object registry, and real-time signaling with a durable snapshot boundary. Startup restores state,
verifies the snapshot checksum and internal event provenance, expires overdue
leases and requests, and invalidates/scrubs any in-flight signaling negotiation
instead of attempting to restore a peer connection.

When the Fleet adapter is configured, session-keyed reservation and in-progress
release state is restored as well. A released command session is periodically
reconciled until the tracked Fleet hold reaches `RELEASED`, with bounded
in-memory retry backoff. The reservation transition is persisted after remote
confirmation.

Every successful API mutation is persisted before its response is sent. This
is a single-process durability milestone; clustered deployments will replace
the file adapter with a transactional database-backed implementation and
outbox so retry schedules also survive failover.
