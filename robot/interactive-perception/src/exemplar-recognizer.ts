import {
  clone,
  fail,
  assertGroundedObject,
  type AssistanceReason,
  type GroundedObject,
} from "../../../packages/contracts/src/index.ts";
import type { ObjectRegistryVersion } from "../../../services/object-registry/src/index.ts";
import type { ExemplarArtifact } from "../../../workers/learning-pipeline/src/index.ts";

export interface RecognitionCandidate {
  candidateId: string;
  object: GroundedObject;
  featureVector: readonly number[];
}

export type RecognitionResult =
  | {
      status: "RECOGNIZED";
      candidateId: string;
      object: GroundedObject;
      objectClassId: string;
      semanticLabel: string;
      artifactId: string;
      score: number;
    }
  | {
      status: "ASSISTANCE_REQUIRED";
      reason: AssistanceReason;
      message: string;
      bestScore?: number;
    };

interface InstalledExemplar {
  artifact: ExemplarArtifact;
  registryVersion: number;
  siteId: string;
  robotCapability: string;
  installedAtUnixMs: number;
}

export class RuntimeExemplarRecognizer {
  private readonly installed = new Map<string, InstalledExemplar>();
  private readonly now: () => number;
  private readonly ambiguityMargin: number;

  constructor(options: { now?: () => number; ambiguityMargin?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.ambiguityMargin = options.ambiguityMargin ?? 0.03;
    if (!Number.isFinite(this.ambiguityMargin) || this.ambiguityMargin < 0 || this.ambiguityMargin > 1) {
      throw new Error("Recognition ambiguityMargin must be between zero and one.");
    }
  }

  install(input: {
    artifact: ExemplarArtifact;
    activeVersion: ObjectRegistryVersion;
    siteId: string;
    robotCapability: string;
  }): void {
    if (input.activeVersion.status !== "ACTIVE"
      || input.artifact.registryVersionId !== input.activeVersion.versionId
      || input.artifact.objectClassId !== input.activeVersion.objectClassId
      || input.artifact.sha256 !== input.activeVersion.validation?.artifactSha256) {
      fail("RECOGNITION_ARTIFACT_NOT_ACTIVE", "Artifact does not belong to the active reviewed registry version.");
    }
    if (!input.activeVersion.siteIds.includes(input.siteId)
      || !input.activeVersion.robotCapabilities.includes(input.robotCapability)
      || !input.artifact.siteIds.includes(input.siteId)
      || !input.artifact.robotCapabilities.includes(input.robotCapability)) {
      fail("RECOGNITION_ARTIFACT_SCOPE_INVALID", "Artifact is not approved for this site and robot capability.");
    }
    if (!input.artifact.artifactId.trim() || !/^[a-f0-9]{64}$/i.test(input.artifact.sha256)
      || input.artifact.centroid.length === 0 || input.artifact.centroid.some((value) => !Number.isFinite(value))
      || !Number.isFinite(input.artifact.similarityThreshold)
      || input.artifact.similarityThreshold < 0 || input.artifact.similarityThreshold > 1) {
      fail("RECOGNITION_ARTIFACT_INVALID", "Artifact centroid is invalid.");
    }
    const key = installationKey(input.activeVersion.objectClassId, input.siteId, input.robotCapability);
    this.installed.set(key, {
      artifact: clone(input.artifact),
      registryVersion: input.activeVersion.version,
      siteId: input.siteId,
      robotCapability: input.robotCapability,
      installedAtUnixMs: this.now(),
    });
  }

  recognize(input: {
    siteId: string;
    robotCapability: string;
    candidates: readonly RecognitionCandidate[];
  }): RecognitionResult {
    if (input.candidates.length === 0) {
      return { status: "ASSISTANCE_REQUIRED", reason: "OBJECT_NOT_RECOGNIZED", message: "No object candidates were proposed." };
    }
    const exemplars = [...this.installed.values()].filter((item) =>
      item.siteId === input.siteId && item.robotCapability === input.robotCapability);
    if (exemplars.length === 0) {
      return { status: "ASSISTANCE_REQUIRED", reason: "OBJECT_NOT_RECOGNIZED", message: "No reviewed exemplar is installed for this scope." };
    }
    const scores: Array<{ candidate: RecognitionCandidate; exemplar: InstalledExemplar; score: number }> = [];
    for (const candidate of input.candidates) {
      if (!candidate.candidateId.trim()) fail("RECOGNITION_CANDIDATE_INVALID", "candidateId is required.");
      assertGroundedObject(candidate.object);
      if (candidate.object.status !== "GROUNDED" && candidate.object.status !== "TRACKED") {
        fail("RECOGNITION_CANDIDATE_UNUSABLE", `Candidate object is ${candidate.object.status}.`);
      }
      for (const exemplar of exemplars) {
        if (candidate.featureVector.length !== exemplar.artifact.centroid.length
          || candidate.featureVector.some((value) => !Number.isFinite(value))) {
          fail("RECOGNITION_FEATURE_INVALID", "Candidate feature dimension or values are invalid.");
        }
        scores.push({ candidate, exemplar, score: cosine(normalize(candidate.featureVector), normalize(exemplar.artifact.centroid)) });
      }
    }
    scores.sort((left, right) => right.score - left.score);
    const best = scores[0]!;
    if (best.score < best.exemplar.artifact.similarityThreshold) {
      return {
        status: "ASSISTANCE_REQUIRED",
        reason: "OBJECT_NOT_RECOGNIZED",
        message: "No candidate met its reviewed exemplar threshold.",
        bestScore: best.score,
      };
    }
    const secondDistinct = scores.find((item) => item.candidate.candidateId !== best.candidate.candidateId
      || item.exemplar.artifact.objectClassId !== best.exemplar.artifact.objectClassId);
    if (secondDistinct && secondDistinct.score >= secondDistinct.exemplar.artifact.similarityThreshold
      && best.score - secondDistinct.score < this.ambiguityMargin) {
      return {
        status: "ASSISTANCE_REQUIRED",
        reason: "MULTIPLE_OBJECTS_AMBIGUOUS",
        message: "Multiple object candidates have indistinguishable reviewed-exemplar scores.",
        bestScore: best.score,
      };
    }
    return {
      status: "RECOGNIZED",
      candidateId: best.candidate.candidateId,
      object: clone(best.candidate.object),
      objectClassId: best.exemplar.artifact.objectClassId,
      semanticLabel: best.exemplar.artifact.semanticLabel,
      artifactId: best.exemplar.artifact.artifactId,
      score: best.score,
    };
  }

  installedCount(): number {
    return this.installed.size;
  }
}

function installationKey(objectClassId: string, siteId: string, robotCapability: string): string {
  return `${objectClassId}\u0000${siteId}\u0000${robotCapability}`;
}

function normalize(vector: readonly number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((total, value) => total + (value ** 2), 0));
  if (magnitude === 0) fail("RECOGNITION_FEATURE_ZERO_VECTOR", "Feature vector cannot have zero magnitude.");
  return vector.map((value) => value / magnitude);
}

function cosine(left: readonly number[], right: readonly number[]): number {
  return left.reduce((total, value, index) => total + value * right[index]!, 0);
}
