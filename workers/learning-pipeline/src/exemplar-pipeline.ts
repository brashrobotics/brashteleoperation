import { createHash } from "node:crypto";
import { clone, fail } from "../../../packages/contracts/src/index.ts";
import type { ObjectRegistryVersion } from "../../../services/object-registry/src/index.ts";

export interface FeatureSample {
  sampleId: string;
  observationId: string;
  semanticLabel: string;
  vector: readonly number[];
}

export interface ExemplarJobConfig {
  featureExtractorName: string;
  featureExtractorVersion: string;
  similarityThreshold: number;
  minimumPrecision: number;
  minimumRecall: number;
  randomSeed: number;
}

export interface ExemplarArtifact {
  artifactId: string;
  sha256: string;
  objectClassId: string;
  registryVersionId: string;
  semanticLabel: string;
  aliases: readonly string[];
  siteIds: readonly string[];
  robotCapabilities: readonly string[];
  featureExtractor: { name: string; version: string };
  centroid: readonly number[];
  similarityThreshold: number;
  trainingObservationIds: readonly string[];
}

export interface ExemplarEvaluationReport {
  evaluationId: string;
  jobDigest: string;
  artifactSha256: string;
  passed: boolean;
  sampleCount: number;
  truePositive: number;
  falsePositive: number;
  trueNegative: number;
  falseNegative: number;
  precision: number;
  recall: number;
  evaluatedObservationIds: readonly string[];
  config: ExemplarJobConfig;
}

export interface ExemplarPipelineResult {
  artifact: ExemplarArtifact;
  evaluation: ExemplarEvaluationReport;
  reused: boolean;
}

export class ExemplarLearningPipeline {
  private readonly completed = new Map<string, Omit<ExemplarPipelineResult, "reused">>();

  run(input: {
    candidate: ObjectRegistryVersion;
    training: readonly FeatureSample[];
    evaluation: readonly FeatureSample[];
    config: ExemplarJobConfig;
  }): ExemplarPipelineResult {
    validateJob(input.candidate, input.training, input.evaluation, input.config);
    const jobDigest = digest({
      registryVersionId: input.candidate.versionId,
      evidence: input.candidate.evidence.map((item) => item.sha256).sort(),
      training: canonicalSamples(input.training),
      evaluation: canonicalSamples(input.evaluation),
      config: input.config,
    });
    const existing = this.completed.get(jobDigest);
    if (existing) return { ...clone(existing), reused: true };

    const positiveTraining = input.training.filter((sample) => labelMatches(sample.semanticLabel, input.candidate));
    if (positiveTraining.length === 0) fail("LEARNING_POSITIVE_SAMPLE_REQUIRED", "Training requires at least one candidate-label sample.");
    const dimension = positiveTraining[0]!.vector.length;
    const centroid = normalize(Array.from({ length: dimension }, (_, index) =>
      positiveTraining.reduce((total, sample) => total + normalize(sample.vector)[index]!, 0) / positiveTraining.length));
    const artifactBase = {
      objectClassId: input.candidate.objectClassId,
      registryVersionId: input.candidate.versionId,
      semanticLabel: input.candidate.semanticLabel,
      aliases: input.candidate.aliases,
      siteIds: input.candidate.siteIds,
      robotCapabilities: input.candidate.robotCapabilities,
      featureExtractor: { name: input.config.featureExtractorName, version: input.config.featureExtractorVersion },
      centroid,
      similarityThreshold: input.config.similarityThreshold,
      trainingObservationIds: [...new Set(input.training.map((sample) => sample.observationId))].sort(),
    };
    const artifactSha256 = digest(artifactBase);
    const artifact: ExemplarArtifact = {
      artifactId: `exemplar-${artifactSha256.slice(0, 20)}`,
      sha256: artifactSha256,
      ...artifactBase,
    };

    let truePositive = 0;
    let falsePositive = 0;
    let trueNegative = 0;
    let falseNegative = 0;
    for (const sample of input.evaluation) {
      const predicted = cosine(centroid, normalize(sample.vector)) >= input.config.similarityThreshold;
      const actual = labelMatches(sample.semanticLabel, input.candidate);
      if (predicted && actual) truePositive += 1;
      else if (predicted) falsePositive += 1;
      else if (actual) falseNegative += 1;
      else trueNegative += 1;
    }
    const precision = divide(truePositive, truePositive + falsePositive);
    const recall = divide(truePositive, truePositive + falseNegative);
    const evaluation: ExemplarEvaluationReport = {
      evaluationId: `evaluation-${jobDigest.slice(0, 20)}`,
      jobDigest,
      artifactSha256,
      passed: precision >= input.config.minimumPrecision && recall >= input.config.minimumRecall,
      sampleCount: input.evaluation.length,
      truePositive,
      falsePositive,
      trueNegative,
      falseNegative,
      precision,
      recall,
      evaluatedObservationIds: [...new Set(input.evaluation.map((sample) => sample.observationId))].sort(),
      config: clone(input.config),
    };
    const completed = { artifact, evaluation };
    this.completed.set(jobDigest, clone(completed));
    return { ...completed, reused: false };
  }
}

function validateJob(
  candidate: ObjectRegistryVersion,
  training: readonly FeatureSample[],
  evaluation: readonly FeatureSample[],
  config: ExemplarJobConfig,
): void {
  if (candidate.status !== "VALIDATING") fail("LEARNING_CANDIDATE_NOT_VALIDATING", "Learning requires a reviewed candidate in VALIDATING state.");
  if (training.length === 0 || evaluation.length === 0) fail("LEARNING_DATASET_EMPTY", "Training and evaluation datasets are required.");
  const evidenceObservations = new Set(candidate.evidence.map((item) => item.observationId));
  if (training.some((sample) => !evidenceObservations.has(sample.observationId))) {
    fail("LEARNING_TRAINING_PROVENANCE_INVALID", "Every training observation must be referenced by reviewed candidate evidence.");
  }
  const trainingObservations = new Set(training.map((sample) => sample.observationId));
  if (evaluation.some((sample) => trainingObservations.has(sample.observationId))) {
    fail("LEARNING_EVALUATION_LEAKAGE", "Evaluation observations must be disjoint from training observations.");
  }
  const samples = [...training, ...evaluation];
  const dimension = samples[0]?.vector.length ?? 0;
  if (dimension < 1 || samples.some((sample) => !sample.sampleId.trim() || !sample.observationId.trim()
    || !sample.semanticLabel.trim() || sample.vector.length !== dimension
    || sample.vector.some((value) => !Number.isFinite(value)))) {
    fail("LEARNING_FEATURE_INVALID", "Feature samples require identities and equal-length finite vectors.");
  }
  if (!config.featureExtractorName.trim() || !config.featureExtractorVersion.trim()
    || !Number.isSafeInteger(config.randomSeed)
    || !inUnitInterval(config.similarityThreshold) || !inUnitInterval(config.minimumPrecision) || !inUnitInterval(config.minimumRecall)) {
    fail("LEARNING_CONFIG_INVALID", "Learning configuration is incomplete or outside valid ranges.");
  }
}

function canonicalSamples(samples: readonly FeatureSample[]): FeatureSample[] {
  return clone([...samples].sort((left, right) => left.sampleId.localeCompare(right.sampleId)));
}

function labelMatches(label: string, candidate: ObjectRegistryVersion): boolean {
  const normalized = label.trim().toLocaleLowerCase("en-US");
  return normalized === candidate.semanticLabel.toLocaleLowerCase("en-US")
    || candidate.aliases.some((alias) => alias.toLocaleLowerCase("en-US") === normalized);
}

function normalize(vector: readonly number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((total, value) => total + (value ** 2), 0));
  if (magnitude === 0) fail("LEARNING_FEATURE_ZERO_VECTOR", "Feature vectors cannot have zero magnitude.");
  return vector.map((value) => value / magnitude);
}

function cosine(left: readonly number[], right: readonly number[]): number {
  return left.reduce((total, value, index) => total + value * right[index]!, 0);
}

function divide(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function inUnitInterval(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
