# Deployment

## Purpose

Defines repeatable packaging and operations for the control plane and robot
edge while preserving their different availability and safety properties.

## Components

- [Control-plane deployment](control-plane/README.md)
- [Robot-edge deployment](edge/README.md)

## Rules

- Development, simulation, laboratory, and production profiles are distinct.
- Images and packages are versioned and immutable.
- Startup dependency order does not imply actuator enablement.
- Deployment tooling never embeds secrets in images or source configuration.
- Rollback must leave the robot command path disabled until compatibility and
  readiness are re-established.

## Local simulation

Copy `.env.example` to a private environment file, replace the three bearer
values and media signing secret, and run:

```sh
docker compose --env-file .env -f deployment/compose.simulation.yaml up --build
```

The Linux Compose profile uses host networking solely to preserve the
loopback-only API invariant. It enables uncoordinated commanding leases only
for the explicit simulation profile. The edge process does not link ROS 2 or a
physical Unitree SDK. Open `http://127.0.0.1:4310/operator` for the local
console.

For B2W driving, start the Gazebo launch from `../brashquadrupedcontroller`
with `teleop_bridge:=true` and the same `BRASH_TELEOP_EDGE_TOKEN` used here.
The Direct control tab connects to `http://127.0.0.1:4311`; the credential is
kept in browser memory only. The ROS bridge supplies controller health and
measured stopped acknowledgement, then maps accepted X/yaw output only to the
Gazebo wheel controller. Held input release and the independent edge watchdog
both command zero.

The media simulator creates a new unknown-object assistance request with a
frozen synthetic RGB-D observation on startup. Enter
`http://127.0.0.1:4312` in the console's optional **Media API** field to load
the hash-verified frame and draw the declaration box by mouse or touch. After
submission, the robot-authenticated simulation worker grounds the selected
pixels, creates a plan, and stops at **Approval pending**. Approving that exact
plan lets the worker execute only through `SimulatedRobotAdapter`, record its
outcome, verify it, and resolve the request. The console polls this low-rate
state automatically.

This process combines an immutable-image test adapter and a simulation-only
workflow worker for convenience. It is not a live-video implementation, has no
ROS or vendor SDK dependency, and cannot publish physical commands.
