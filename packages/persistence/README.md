# Persistence

`AtomicJsonFileStore` is the initial single-node durability adapter. It writes a
checksummed snapshot to a uniquely created temporary file, flushes it, renames
it atomically, and flushes the containing directory. Files are private to the
service account by default and reads are size bounded.

This adapter is intended for an edge appliance or one control-plane replica.
It is not a distributed transaction log. A PostgreSQL event-store adapter can
implement the same control-plane state boundary when the service is replicated.
