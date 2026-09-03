# Robot-Edge Deployment

## Purpose

Packages and supervises the real-time edge, robot-local autonomy, safety, and
adapter components on the robot companion computer.

## Responsibilities

- Pin compatible robot profile, adapter, ROS overlay, vendor SDK, model, and
  calibration versions.
- Start observe-only dependencies before readiness and keep actuator ownership
  empty through startup.
- Supervise robot agent, media, evidence recorder, perception, manipulation,
  arbiter, safety, and adapter processes independently.
- Configure CPU/GPU, real-time priorities where justified, network interfaces,
  time synchronization, storage quotas, and bounded logs.
- Expose local health/diagnostics without making cloud connectivity a safety
  dependency.
- Support an atomic update/rollback process that returns to disabled state.

## Boundaries

- Container/process restart never restores a lease or command owner implicitly.
- Vendor/DDS interfaces bind only to approved robot/site networks.
- Model and calibration updates cannot become active during an execution phase.
- Physical E-stop wiring and vendor safety are commissioned outside this
  deployment package and verified by the lab procedure.

## Initial milestone

Deploy all simulated edge components under one supervisor, inject individual
process failures, verify deterministic stop/hold behavior, and export correlated
health, command-age, frame-age, ownership, and safety metrics.

## Implemented simulation deployment

The Compose edge process loads the versioned simulation profile and refuses the
physical candidate, runs unprivileged with a read-only filesystem, and exposes
only the loopback HTTP test transport. Prometheus metrics report installed
leases, enabled safety state, accepted output, and normalized request results;
alerts detect any nonzero output while safety is disabled. ROS 2 and physical
Unitree interfaces are not mounted into the container.

The simulation Compose profile gives the edge a distinct robot-control bearer
and a loopback control-plane URL. Lease installation and ownership transitions
enqueue current readiness for bounded asynchronous delivery; control-plane
failure cannot delay the local transition or watchdog.
