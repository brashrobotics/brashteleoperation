# Workers

## Purpose

Contains asynchronous, retryable work that is not part of live operator or
robot-control timing.

## Components

- [Learning pipeline](learning-pipeline/README.md)
- [Simulation assistance worker](simulation-assistance/README.md)

Workers consume immutable inputs and publish versioned outputs. Production
learning workers make no robot-command or activation decision. The development
assistance worker is separately constrained to `SimulatedRobotAdapter`; it
cannot load ROS, a vendor SDK, or a physical adapter.
