# Control-Plane Services

## Purpose

Contains durable, relatively low-rate coordination services. These services may
run at a site or in a cloud environment and are never part of a motor-control
timing loop.

## Components

- [Session control](session-control/README.md)
- [Real-time signaling](realtime-signaling/README.md)
- [Assistance orchestrator](assistance-orchestrator/README.md)
- [Object registry](object-registry/README.md)
- [Control-plane runtime](control-plane-runtime/README.md)

## Boundaries

Services depend on canonical contracts and persistence ports. They do not
import ROS, Unitree, camera-driver, or controller types and cannot directly
publish actuator commands.
