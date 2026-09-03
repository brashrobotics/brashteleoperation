import assert from "node:assert/strict";
import test from "node:test";
import { CONTRACT_VERSION, TeleoperationError, type GroundedObject } from "../../packages/contracts/src/index.ts";
import { RuntimeExemplarRecognizer } from "../../robot/interactive-perception/src/index.ts";
import { InMemoryObjectRegistry } from "../../services/object-registry/src/index.ts";
import type { ExemplarArtifact } from "../../workers/learning-pipeline/src/index.ts";

test("a reviewed active exemplar autonomously recognizes a future grounded proposal", () => {
  let now = 1_000;
  const registry = new InMemoryObjectRegistry({ now: () => now });
  let version = registry.createCandidate({
    versionId: "version-1", objectClassId: "class-tote", semanticLabel: "blue tote", aliases: ["tote"],
    siteIds: ["site-1"], robotCapabilities: ["b2-z1"], supportedIntents: ["PICK"],
    source: { requestId: "request-1", taskId: "task-1", robotId: "robot-1", declarationId: "declaration-1", groundedObjectId: "object-source", outcomeId: "outcome-1" },
    evidence: [{ artifactId: "evidence-1", observationId: "observation-source", mediaType: "application/json", sha256: "a".repeat(64), byteLength: 10, capturedAtUnixMs: 900 }],
    createdBy: "operator-1",
  });
  version = registry.submitForReview(version.versionId, version.revision);
  version = registry.recordReview(version.versionId, version.revision, { reviewerId: "reviewer-1", reviewedAtUnixMs: ++now, approved: true, notes: "Verified." });
  version = registry.startValidation(version.versionId, version.revision);
  version = registry.recordValidation(version.versionId, version.revision, { evaluationId: "evaluation-1", artifactSha256: "b".repeat(64), evaluatedAtUnixMs: ++now, passed: true, sampleCount: 20, metrics: { precision: 1, recall: 1 }, notes: "Passed." });
  version = registry.activate({ versionId: version.versionId, expectedRevision: version.revision, siteId: "site-1", robotCapability: "b2-z1", activatedBy: "release-manager" });

  const artifact: ExemplarArtifact = {
    artifactId: "exemplar-1", sha256: "b".repeat(64), objectClassId: "class-tote", registryVersionId: "version-1",
    semanticLabel: "blue tote", aliases: ["tote"], siteIds: ["site-1"], robotCapabilities: ["b2-z1"],
    featureExtractor: { name: "test", version: "1" }, centroid: [1, 0], similarityThreshold: 0.9,
    trainingObservationIds: ["observation-source"],
  };
  const recognizer = new RuntimeExemplarRecognizer({ ambiguityMargin: 0.03 });
  assert.throws(
    () => new RuntimeExemplarRecognizer().install({ artifact: { ...artifact, sha256: "d".repeat(64) }, activeVersion: version, siteId: "site-1", robotCapability: "b2-z1" }),
    (error) => error instanceof TeleoperationError && error.code === "RECOGNITION_ARTIFACT_NOT_ACTIVE",
  );
  recognizer.install({ artifact, activeVersion: version, siteId: "site-1", robotCapability: "b2-z1" });
  const result = recognizer.recognize({
    siteId: "site-1",
    robotCapability: "b2-z1",
    candidates: [
      { candidateId: "candidate-tote", object: object("object-future-1"), featureVector: [0.99, 0.01] },
      { candidateId: "candidate-other", object: object("object-future-2"), featureVector: [0, 1] },
    ],
  });
  assert.equal(result.status, "RECOGNIZED");
  if (result.status === "RECOGNIZED") {
    assert.equal(result.candidateId, "candidate-tote");
    assert.equal(result.semanticLabel, "blue tote");
    assert.equal(result.artifactId, "exemplar-1");
  }

  recognizer.install({
    artifact: {
      ...artifact,
      artifactId: "exemplar-alternative",
      sha256: "c".repeat(64),
      objectClassId: "class-alternative",
      registryVersionId: "version-alternative",
      semanticLabel: "alternative class",
      centroid: [2, 0],
    },
    activeVersion: {
      ...version,
      versionId: "version-alternative",
      objectClassId: "class-alternative",
      semanticLabel: "alternative class",
      validation: { ...version.validation!, artifactSha256: "c".repeat(64) },
    },
    siteId: "site-1",
    robotCapability: "b2-z1",
  });
  const classAmbiguous = recognizer.recognize({
    siteId: "site-1",
    robotCapability: "b2-z1",
    candidates: [{ candidateId: "candidate-one", object: object("object-one"), featureVector: [1, 0] }],
  });
  assert.equal(classAmbiguous.status, "ASSISTANCE_REQUIRED");
  if (classAmbiguous.status === "ASSISTANCE_REQUIRED") assert.equal(classAmbiguous.reason, "MULTIPLE_OBJECTS_AMBIGUOUS");

  const ambiguous = recognizer.recognize({
    siteId: "site-1",
    robotCapability: "b2-z1",
    candidates: [
      { candidateId: "candidate-a", object: object("object-a"), featureVector: [1, 0] },
      { candidateId: "candidate-b", object: object("object-b"), featureVector: [0.999, 0.01] },
    ],
  });
  assert.equal(ambiguous.status, "ASSISTANCE_REQUIRED");
  if (ambiguous.status === "ASSISTANCE_REQUIRED") assert.equal(ambiguous.reason, "MULTIPLE_OBJECTS_AMBIGUOUS");

  const coldRobot = new RuntimeExemplarRecognizer();
  assert.equal(coldRobot.recognize({ siteId: "site-1", robotCapability: "b2-z1", candidates: [{ candidateId: "c", object: object("object-c"), featureVector: [1, 0] }] }).status, "ASSISTANCE_REQUIRED");
});

function object(objectId: string): GroundedObject {
  return {
    contractVersion: CONTRACT_VERSION,
    objectId,
    requestId: "future-request",
    declarationId: "proposal",
    declarationRevision: 1,
    observationId: `observation-${objectId}`,
    robotId: "robot-1",
    sceneRevision: "future-scene",
    revision: 1,
    status: "TRACKED",
    pose: { frameId: "base_link", positionMeters: [0.5, 0, 0.3], orientationXyzw: [0, 0, 0, 1] },
    dimensionsMeters: [0.1, 0.1, 0.2],
    positionStdDevMeters: [0.01, 0.01, 0.01],
    groundedAtUnixMs: 2_000,
    validUntilUnixMs: 3_000,
    algorithm: { name: "proposal", version: "1" },
  };
}
