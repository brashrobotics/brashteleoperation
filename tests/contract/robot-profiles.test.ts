import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { assertRobotProfile, loadRobotProfile } from "../../config/robot-profiles/src/index.ts";
import { TeleoperationError } from "../../packages/contracts/src/index.ts";

test("simulation profile is complete and physical candidate remains output locked", async () => {
  const directory = fileURLToPath(new URL("../../config/robot-profiles/", import.meta.url));
  const simulation = await loadRobotProfile(`${directory}/b2-z1.simulation.json`);
  const physical = await loadRobotProfile(`${directory}/b2-z1.physical-candidate.json`);
  assert.equal(simulation.simulation, true);
  assert.equal(simulation.commandOutputEnabled, true);
  assert.equal(physical.simulation, false);
  assert.equal(physical.commandOutputEnabled, false);
  assert.ok(physical.unresolvedPhysicalMeasurements.length > 0);

  assert.throws(
    () => assertRobotProfile({ ...physical, commandOutputEnabled: true }),
    (error) => error instanceof TeleoperationError && error.code === "ROBOT_PROFILE_PHYSICAL_OUTPUT_LOCKED",
  );
});
