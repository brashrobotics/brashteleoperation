# Robot Edge

## Purpose

Contains processes deployed on the robot companion computer that terminate
remote transports and translate them into robot-local contracts.

## Components

- [Robot agent](robot-agent/README.md)
- [Media gateway](media-gateway/README.md)
- [Evidence recorder](evidence-recorder/README.md)

## Boundaries

The edge authenticates and validates remote traffic but is not the final safety
authority. It cannot bypass the robot-local command arbiter or safety
supervisor, and it does not expose ROS 2/DDS directly to remote clients.
