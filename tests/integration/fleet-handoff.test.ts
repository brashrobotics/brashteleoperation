import assert from "node:assert/strict";
import test from "node:test";
import { TeleoperationError } from "../../packages/contracts/src/index.ts";
import {
  type FleetHold,
  FleetCommandLeaseCoordinator,
  FleetReservationCoordinator,
  type FleetTeleoperationPort,
  InMemoryFleetTeleoperationPort,
  InMemorySessionControl,
} from "../../services/session-control/src/index.ts";

test("commanding lease admission waits for Fleet and robot-stopped confirmation", async () => {
  let now = 1_000;
  const fleet = new InMemoryFleetTeleoperationPort();
  const coordinator = new FleetReservationCoordinator({ fleet, now: () => now });
  let reservation = await coordinator.request({
    reservationId: "reservation-1",
    robotId: "robot-1",
    missionId: "mission-1",
    reason: "Unknown object requires operator assistance.",
  });
  assert.equal(reservation.status, "WAITING_FOR_ROBOT_STOP");
  assert.throws(
    () => coordinator.requireAdmission(reservation.reservationId, "robot-1"),
    (error) => error instanceof TeleoperationError && error.code === "FLEET_RESERVATION_NOT_READY",
  );

  fleet.confirmRobotStopped(reservation.fleetHoldId);
  now += 10;
  reservation = await coordinator.reconcile(reservation.reservationId, reservation.revision);
  assert.equal(reservation.status, "RESERVED");
  coordinator.requireAdmission(reservation.reservationId, "robot-1");

  const sessions = new InMemorySessionControl({ now: () => now });
  let session = sessions.requestSession({
    sessionId: "session-1",
    robotId: "robot-1",
    operatorId: "operator-1",
    scopes: ["CONTROL_BASE"],
  });
  session = sessions.grantSession(session.sessionId, session.revision, 5_000);
  assert.equal(session.status, "GRANTED");

  reservation = await coordinator.release(reservation.reservationId, reservation.revision, "Teleoperation session ended and robot is stopped.");
  assert.equal(reservation.status, "RELEASED");
});

test("Fleet rejection fails closed", async () => {
  const fleet = new InMemoryFleetTeleoperationPort();
  const coordinator = new FleetReservationCoordinator({ fleet });
  let reservation = await coordinator.request({ reservationId: "reservation-2", robotId: "robot-2", reason: "Direct control request." });
  fleet.reject(reservation.fleetHoldId, "Mission cannot be paused safely.");
  reservation = await coordinator.reconcile(reservation.reservationId, reservation.revision);
  assert.equal(reservation.status, "FAILED");
  assert.throws(() => coordinator.requireAdmission(reservation.reservationId, "robot-2"));
});

test("Fleet release remains retryable when the first acknowledgement is incomplete", async () => {
  const fleet = new RetryReleaseFleet();
  const coordinator = new FleetReservationCoordinator({ fleet, now: () => 1_000 });
  let reservation = await coordinator.request({ reservationId: "reservation-retry", robotId: "robot-3", reason: "Direct control." });
  assert.equal(reservation.status, "RESERVED");
  await assert.rejects(
    () => coordinator.release(reservation.reservationId, reservation.revision, "Robot stopped."),
    (error) => error instanceof TeleoperationError && error.code === "FLEET_RELEASE_NOT_CONFIRMED",
  );
  reservation = coordinator.get(reservation.reservationId);
  assert.equal(reservation.status, "RELEASING");
  reservation = await coordinator.release(reservation.reservationId, reservation.revision, "Robot stopped.");
  assert.equal(reservation.status, "RELEASED");
  assert.equal((await coordinator.release(reservation.reservationId, 1, "Duplicate delivery.")).status, "RELEASED");
});

test("concurrent Fleet release deliveries report exactly one durable state change", async () => {
  const fleet = new ConcurrentReleaseFleet();
  const coordinator = new FleetCommandLeaseCoordinator({ fleet, now: () => 1_000 });
  assert.equal((await coordinator.authorize({ sessionId: "session-concurrent", robotId: "robot-4" })).status, "RESERVED");

  const [first, second] = await Promise.all([
    coordinator.releaseTrackedWithResult("session-concurrent"),
    coordinator.releaseTrackedWithResult("session-concurrent"),
  ]);
  assert.deepEqual([first.changed, second.changed].sort(), [false, true]);
  assert.equal(first.reservation?.status, "RELEASED");
  assert.equal(second.reservation?.status, "RELEASED");
  assert.equal(fleet.releaseCalls, 1);
});

class RetryReleaseFleet implements FleetTeleoperationPort {
  private releaseAttempts = 0;
  private hold: FleetHold = { holdId: "reservation-retry", robotId: "robot-3", state: "ROBOT_STOPPED", revision: 1 };

  async requestHold(): Promise<FleetHold> { return structuredClone(this.hold); }
  async inspectHold(): Promise<FleetHold> { return structuredClone(this.hold); }
  async releaseHold(): Promise<FleetHold> {
    this.releaseAttempts += 1;
    if (this.releaseAttempts > 1) this.hold = { ...this.hold, state: "RELEASED", revision: this.hold.revision + 1 };
    return structuredClone(this.hold);
  }
}

class ConcurrentReleaseFleet implements FleetTeleoperationPort {
  releaseCalls = 0;
  private hold: FleetHold = { holdId: "session-concurrent", robotId: "robot-4", state: "ROBOT_STOPPED", revision: 1 };

  async requestHold(): Promise<FleetHold> { return structuredClone(this.hold); }
  async inspectHold(): Promise<FleetHold> { return structuredClone(this.hold); }
  async releaseHold(): Promise<FleetHold> {
    this.releaseCalls += 1;
    this.hold = { ...this.hold, state: "RELEASED", revision: this.hold.revision + 1 };
    return structuredClone(this.hold);
  }
}
