import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runInteractiveAutonomyDemo } from "../../apps/interactive-autonomy-demo/src/main.ts";

test("an operator declaration becomes reviewed autonomy for the next encounter", async () => {
  const directory = await mkdtemp(join(tmpdir(), "brash-autonomy-loop-test-"));
  try {
    const result = await runInteractiveAutonomyDemo(directory);
    assert.deepEqual(result, {
      firstEncounter: {
        assistanceStatus: "RESOLVED",
        manipulationSucceeded: true,
        operatorDeclarationId: "declaration-blue-parts-bin",
      },
      enrollment: {
        registryVersionStatus: "ACTIVE",
        evaluationPassed: true,
        evidenceVerified: true,
        installedExemplarCount: 1,
      },
      futureEncounter: {
        recognitionStatus: "RECOGNIZED",
        semanticLabel: "blue parts bin",
        assistanceRequested: false,
        autonomousManipulationSucceeded: true,
      },
      physicalCommandOutputEnabled: false,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
