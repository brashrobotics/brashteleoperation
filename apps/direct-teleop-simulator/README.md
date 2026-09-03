# Direct B2W Teleoperation Simulator

## Purpose

Provides a focused, tokenless browser console for driving only the Gazebo B2W.
It contains no assistance inbox, perception workflow, object declaration,
registry, or manipulation controls.

Open `http://127.0.0.1:4313/` after starting the simulation Compose profile.
The page automatically requests a short-lived simulation lease, waits for
measured stopped ownership and robot readiness, and enables the same
robot-local safety supervisor used by the full operator station. No credential
is sent to or stored by the browser: the loopback server keeps the development
control, edge, and media credentials in its process environment.

## Controls

- Hold W/A/S/D directly on the keyboard; Space is not required.
- On touch or mouse, press and hold a direction button.
- Releasing every key/button, losing pointer capture, hiding the page, or losing
  focus requests hold. The independent edge watchdog also zeros a missing
  command stream.
- **STOP** requests immediate robot-local hold.
- **End direct session** releases ownership only after stopped evidence.

A click that is released immediately intentionally produces only a very short
command. Hold the input long enough to see motion and the accepted-speed value
ramp under the acceleration limiter.

## Boundary

This console is deliberately unauthenticated and therefore binds only to
loopback. Its server can connect only to loopback development services. The
configured edge refuses non-simulation robot profiles, and the ROS bridge
publishes only to Gazebo controller topics. Do not expose port 4313 on a network
or reuse this route for physical hardware.
