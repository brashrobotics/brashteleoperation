import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EvidenceRecorder } from "../../edge/evidence-recorder/src/index.ts";
import { TeleoperationError } from "../../packages/contracts/src/index.ts";
import { ObjectRegistryRuntime, type CreateCandidateInput } from "../../services/object-registry/src/index.ts";

test("reviewed registry versions activate by scope and rollback without deleting history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "brash-registry-"));
  const stateFilePath = join(directory, "registry.json");
  let now = 1_000;
  let id = 0;
  try {
    const runtime = await ObjectRegistryRuntime.open({ stateFilePath, now: () => now, idGenerator: () => `id-${++id}` });
    let first = runtime.registry.createCandidate(candidate("version-1", "class-container", "request-1"));
    first = runtime.registry.submitForReview(first.versionId, first.revision);
    first = runtime.registry.recordReview(first.versionId, first.revision, {
      reviewerId: "reviewer-1", reviewedAtUnixMs: ++now, approved: true, notes: "Label and mask verified.",
    });
    first = runtime.registry.startValidation(first.versionId, first.revision);
    first = runtime.registry.recordValidation(first.versionId, first.revision, {
      evaluationId: "evaluation-1",
      artifactSha256: "a".repeat(64),
      evaluatedAtUnixMs: ++now,
      passed: true,
      sampleCount: 20,
      metrics: { precision: 0.96, recall: 0.94 },
      notes: "Passed held-out site evaluation.",
    });
    first = runtime.registry.activate({
      versionId: first.versionId,
      expectedRevision: first.revision,
      siteId: "site-1",
      robotCapability: "b2-z1",
      activatedBy: "release-manager",
    });
    assert.equal(runtime.registry.resolve("class-container", "site-1", "b2-z1")?.versionId, "version-1");

    let second = runtime.registry.createCandidate(candidate("version-2", "class-container", "request-2"));
    second = runtime.registry.submitForReview(second.versionId, second.revision);
    second = runtime.registry.recordReview(second.versionId, second.revision, {
      reviewerId: "reviewer-2", reviewedAtUnixMs: ++now, approved: true, notes: "Improved exemplars verified.",
    });
    second = runtime.registry.startValidation(second.versionId, second.revision);
    second = runtime.registry.recordValidation(second.versionId, second.revision, {
      evaluationId: "evaluation-2",
      artifactSha256: "b".repeat(64),
      evaluatedAtUnixMs: ++now,
      passed: true,
      sampleCount: 30,
      metrics: { precision: 0.97, recall: 0.96 },
      notes: "Passed regression suite.",
    });
    second = runtime.registry.activate({
      versionId: second.versionId,
      expectedRevision: second.revision,
      siteId: "site-1",
      robotCapability: "b2-z1",
      activatedBy: "release-manager",
    });
    assert.equal(runtime.registry.getVersion("version-1").status, "DEPRECATED");
    assert.equal(runtime.registry.resolve("class-container", "site-1", "b2-z1")?.versionId, "version-2");

    second = runtime.registry.rollback({
      versionId: second.versionId,
      expectedRevision: second.revision,
      siteId: "site-1",
      robotCapability: "b2-z1",
      rolledBackBy: "release-manager",
      reason: "Field regression detected.",
    });
    assert.equal(second.status, "ROLLED_BACK");
    assert.equal(runtime.registry.resolve("class-container", "site-1", "b2-z1")?.versionId, "version-1");
    assert.equal(runtime.registry.getVersion("version-1").status, "ACTIVE");
    await runtime.persist();

    const restored = await ObjectRegistryRuntime.open({ stateFilePath, now: () => now });
    assert.equal(restored.registry.resolve("class-container", "site-1", "b2-z1")?.versionId, "version-1");
    assert.equal(restored.registry.listVersions("class-container").length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("evidence recorder requires redaction and consent for learning retention", async () => {
  const directory = await mkdtemp(join(tmpdir(), "brash-evidence-"));
  try {
    const recorder = await EvidenceRecorder.open({
      rootDirectory: directory,
      maximumArtifactBytes: 128,
      maximumTotalBytes: 256,
      now: () => 2_000,
    });
    const input = {
      artifactId: "artifact-1",
      observationId: "observation-1",
      robotId: "robot-1",
      requestId: "request-1",
      mediaType: "image/png",
      capturedAtUnixMs: 1_900,
      retention: "LEARNING_CANDIDATE" as const,
      redacted: false,
      bytes: new Uint8Array([1, 2, 3, 4]),
    };
    await assert.rejects(
      recorder.record(input),
      (error) => error instanceof TeleoperationError && error.code === "EVIDENCE_LEARNING_CONSENT_REQUIRED",
    );
    const artifact = await recorder.record({ ...input, redacted: true, consentId: "consent-1" });
    assert.equal(artifact.byteLength, 4);
    assert.equal(await recorder.verify(artifact.artifactId), true);

    const restored = await EvidenceRecorder.open({
      rootDirectory: directory,
      maximumArtifactBytes: 128,
      maximumTotalBytes: 256,
    });
    assert.equal(restored.get("artifact-1").consentId, "consent-1");
    assert.equal(await restored.verify("artifact-1"), true);
    await assert.rejects(
      restored.record({ ...input, redacted: true, consentId: "consent-1", bytes: new Uint8Array([9]) }),
      (error) => error instanceof TeleoperationError && error.code === "EVIDENCE_ID_COLLISION",
    );
    await writeFile(join(directory, artifact.storageKey), new Uint8Array([9, 9, 9, 9]));
    await assert.rejects(
      restored.record({ ...input, artifactId: "artifact-2", redacted: true, consentId: "consent-1" }),
      (error) => error instanceof TeleoperationError && error.code === "EVIDENCE_BLOB_COLLISION",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function candidate(versionId: string, objectClassId: string, requestId: string): CreateCandidateInput {
  return {
    versionId,
    objectClassId,
    semanticLabel: "shipping container",
    aliases: ["container", "bin"],
    siteIds: ["site-1"],
    robotCapabilities: ["b2-z1"],
    supportedIntents: ["PICK"],
    source: {
      requestId,
      taskId: `task-${requestId}`,
      robotId: "robot-1",
      declarationId: `declaration-${requestId}`,
      groundedObjectId: `object-${requestId}`,
      outcomeId: `outcome-${requestId}`,
    },
    evidence: [{
      artifactId: `artifact-${requestId}`,
      observationId: `observation-${requestId}`,
      mediaType: "image/png",
      sha256: "a".repeat(64),
      byteLength: 100,
      capturedAtUnixMs: 900,
    }],
    createdBy: "operator-1",
  };
}
