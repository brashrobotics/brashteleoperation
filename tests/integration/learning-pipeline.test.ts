import assert from "node:assert/strict";
import test from "node:test";
import { TeleoperationError } from "../../packages/contracts/src/index.ts";
import { InMemoryObjectRegistry } from "../../services/object-registry/src/index.ts";
import { ExemplarLearningPipeline } from "../../workers/learning-pipeline/src/index.ts";

test("reviewed evidence builds an idempotent exemplar and gates registry activation", () => {
  let now = 1_000;
  const registry = new InMemoryObjectRegistry({ now: () => now });
  let candidate = registry.createCandidate({
    versionId: "version-1",
    objectClassId: "class-tote",
    semanticLabel: "blue tote",
    aliases: ["tote"],
    siteIds: ["site-1"],
    robotCapabilities: ["b2-z1"],
    supportedIntents: ["PICK"],
    source: {
      requestId: "request-1", taskId: "task-1", robotId: "robot-1", declarationId: "declaration-1",
      groundedObjectId: "object-1", outcomeId: "outcome-1",
    },
    evidence: ["train-1", "train-2"].map((observationId, index) => ({
      artifactId: `artifact-${index}`,
      observationId,
      mediaType: "application/json",
      sha256: String(index + 1).repeat(64),
      byteLength: 100,
      capturedAtUnixMs: 900 + index,
    })),
    createdBy: "operator-1",
  });
  candidate = registry.submitForReview(candidate.versionId, candidate.revision);
  candidate = registry.recordReview(candidate.versionId, candidate.revision, {
    reviewerId: "reviewer-1", reviewedAtUnixMs: ++now, approved: true, notes: "Evidence and label verified.",
  });
  candidate = registry.startValidation(candidate.versionId, candidate.revision);

  const pipeline = new ExemplarLearningPipeline();
  const input = {
    candidate,
    training: [
      { sampleId: "sample-1", observationId: "train-1", semanticLabel: "blue tote", vector: [1, 0] },
      { sampleId: "sample-2", observationId: "train-2", semanticLabel: "tote", vector: [0.95, 0.05] },
    ],
    evaluation: [
      { sampleId: "sample-3", observationId: "eval-positive", semanticLabel: "blue tote", vector: [0.9, 0.1] },
      { sampleId: "sample-4", observationId: "eval-negative", semanticLabel: "wood pallet", vector: [0, 1] },
    ],
    config: {
      featureExtractorName: "test-features",
      featureExtractorVersion: "1",
      similarityThreshold: 0.8,
      minimumPrecision: 0.9,
      minimumRecall: 0.9,
      randomSeed: 42,
    },
  };
  const first = pipeline.run(input);
  const second = pipeline.run(input);
  assert.equal(first.evaluation.passed, true);
  assert.equal(first.evaluation.precision, 1);
  assert.equal(first.evaluation.recall, 1);
  assert.equal(second.reused, true);
  assert.equal(second.artifact.sha256, first.artifact.sha256);

  candidate = registry.recordValidation(candidate.versionId, candidate.revision, {
    evaluationId: first.evaluation.evaluationId,
    artifactSha256: first.evaluation.artifactSha256,
    evaluatedAtUnixMs: ++now,
    passed: first.evaluation.passed,
    sampleCount: first.evaluation.sampleCount,
    metrics: { precision: first.evaluation.precision, recall: first.evaluation.recall },
    notes: "Automated held-out gates passed; awaiting explicit activation.",
  });
  assert.equal(candidate.status, "VALIDATING");
  assert.equal(registry.resolve("class-tote", "site-1", "b2-z1"), undefined);
  candidate = registry.activate({
    versionId: candidate.versionId,
    expectedRevision: candidate.revision,
    siteId: "site-1",
    robotCapability: "b2-z1",
    activatedBy: "release-manager",
  });
  assert.equal(candidate.status, "ACTIVE");
});

test("exemplar pipeline rejects evaluation leakage", () => {
  const registry = new InMemoryObjectRegistry();
  let candidate = registry.createCandidate({
    semanticLabel: "container", siteIds: ["site-1"], robotCapabilities: ["b2-z1"], supportedIntents: ["PICK"],
    source: { requestId: "r", taskId: "t", robotId: "robot", declarationId: "d", groundedObjectId: "g", outcomeId: "o" },
    evidence: [{ artifactId: "a", observationId: "same", mediaType: "application/json", sha256: "a".repeat(64), byteLength: 1, capturedAtUnixMs: 1 }],
    createdBy: "operator",
  });
  candidate = registry.submitForReview(candidate.versionId, candidate.revision);
  candidate = registry.recordReview(candidate.versionId, candidate.revision, { reviewerId: "reviewer", reviewedAtUnixMs: 2, approved: true, notes: "ok" });
  candidate = registry.startValidation(candidate.versionId, candidate.revision);
  const pipeline = new ExemplarLearningPipeline();
  assert.throws(
    () => pipeline.run({
      candidate,
      training: [{ sampleId: "train", observationId: "same", semanticLabel: "container", vector: [1] }],
      evaluation: [{ sampleId: "eval", observationId: "same", semanticLabel: "container", vector: [1] }],
      config: { featureExtractorName: "test", featureExtractorVersion: "1", similarityThreshold: 0.8, minimumPrecision: 0.8, minimumRecall: 0.8, randomSeed: 1 },
    }),
    (error) => error instanceof TeleoperationError && error.code === "LEARNING_EVALUATION_LEAKAGE",
  );
});
