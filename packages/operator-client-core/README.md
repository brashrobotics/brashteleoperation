# Operator Client Core

## Purpose

Provides a transport- and UI-neutral command-input gate that can be shared by a
future native iOS/Android controller and desktop operator clients. It produces
canonical, short-lived command envelopes from normalized user input.

This package is not a safety authority. The edge command validator, robot-local
arbiter, base/Z1 safety supervisors, vendor controller, and physical E-stop
remain authoritative.

## Mobile lifecycle behavior

`MobileCommandController` requires all of these signals before accepting a
fresh deadman press:

- application is in the foreground;
- screen is unlocked;
- real-time channel is connected;
- robot-local ownership is acknowledged; and
- the corresponding robot safety path is enabled.

Any missing signal, deadman release, app interruption, or lease expiry clears
deadman and clutch and puts the client in `HOLDING`. If deadman was held,
restoring connectivity or foreground state does not resume command generation;
the operator must release and press deadman again. Controller creation and
restart always begin in `OBSERVE_ONLY`.

The shell should call `interrupt()` and close its real-time command channel for
backgrounding, screen lock, call/notification interruption, route change,
controller disconnection, and operating-system termination. It should not rely
on sending a final zero command because a mobile network can disappear before
that packet arrives. The robot-local watchdog owns the stop.

## Security boundary

The core accepts only the scoped, short-lived teleoperation lease. It has no
API for an OIDC refresh token or long-lived bearer token, and its snapshot
contains only non-secret session metadata. Native shells must keep identity
credentials in platform secure storage and exchange them for short-lived
control-plane and edge credentials.

## Inputs and outputs

Inputs are a teleoperation lease, robot-profile client limits, readiness
signals, deadman/clutch state, and normalized controls. Outputs are
`TeleopCommandEnvelope` values for base, Z1 joint jog, Cartesian twist, or
gripper commands. Inputs are bounded here for predictable UX and bounded again
by the robot-local safety profile.
