# B2W Gazebo Teleoperation Demo

This executable smoke demo proves the real local control path from the BRASH
control plane and robot-edge safety service into the simulation-only B2W ROS 2
bridge. It requests an expiring base-control lease, waits for measured stopped
handoff and robot readiness, enables the base safety supervisor, streams a
short held-deadman forward command, returns the output to zero, and releases
ownership only after Gazebo reports that the wheels have stopped.

It accepts loopback HTTP endpoints only and has no physical Unitree output.

With the teleoperation Docker stack and the B2W Gazebo launch running:

```bash
set -a
source .env
set +a
npm run demo:b2w
```

Set `BRASH_B2W_DEMO_DURATION_MS` to 250–10000 to alter the short motion window.
The default is 1500 ms. Keep the Gazebo world clear before running the demo.
