# ADR 0001: Separate control, real-time, autonomy, and safety planes

- **Status:** Proposed
- **Date:** 2026-09-02

## Context

Human assistance requires durable authorization, low-latency media and command
transport, robot-local perception/manipulation, and failure-independent safety.
Combining these concerns in Fleet Control or one edge process would couple
mission availability to control timing and create unclear safety authority.

## Decision

Separate the system into:

1. A control plane for identity, leases, assistance workflow, Fleet handoff,
   approval, and audit.
2. A real-time data plane directly between operator station and robot edge.
3. A robot-local perception and autonomous-manipulation plane.
4. A robot-local command arbitration and safety plane that remains authoritative
   under failures of every other plane.

Fleet Control integrates through semantic reservation and lifecycle events. It
does not transport joint, velocity, media, or vendor messages.

## Consequences

- Robot motion can stop safely without cloud availability.
- Real-time transport can evolve without changing mission APIs.
- More explicit contracts and integration tests are required.
- Edge deployment contains multiple independently supervised processes.
- No single user-interface or media process can grant actuator authority.

## Alternatives considered

- Route commands through Fleet Control: rejected because mission APIs are not a
  real-time or robot-safety boundary.
- Expose ROS 2/DDS remotely: rejected because it leaks vendor/local topics and
  does not provide the required session, internet, or trust boundary.
- Put all edge behavior in one process: rejected because failures and authority
  would be difficult to isolate and test.
