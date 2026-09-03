import assert from "node:assert/strict";
import test from "node:test";
import { runVerticalSlice } from "../../apps/vertical-slice-demo/src/main.ts";

test("simulated direct-control and unknown-object flows finish in safe terminal states", () => {
  const result = runVerticalSlice();
  assert.equal(result.directSessionStatus, "RELEASED");
  assert.equal(result.ownershipStatus, "NO_OWNER");
  assert.equal(result.acceptedCommandId, "command-base-001");
  assert.equal(result.acceptedLinearXMetersPerSecond, 0.055);
  assert.equal(result.safetyStatus, "HOLDING");
  assert.equal(result.assistanceStatus, "RESOLVED");
  assert.equal(result.groundedObjectStatus, "TRACKED");
  assert.deepEqual(result.assistanceEventTypes, [
    "ASSISTANCE_OPEN",
    "ASSISTANCE_ASSIGNED",
    "ASSISTANCE_DECLARATION_PENDING",
    "ASSISTANCE_GROUNDING",
    "ASSISTANCE_PLAN_PENDING",
    "ASSISTANCE_APPROVAL_PENDING",
    "ASSISTANCE_EXECUTING",
    "ASSISTANCE_VERIFYING",
    "ASSISTANCE_RESOLVED",
  ]);
});
