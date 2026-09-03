import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { clone, fail } from "../../../packages/contracts/src/index.ts";
import { AtomicJsonFileStore } from "../../../packages/persistence/src/index.ts";
import type { EvidenceArtifactReference } from "../../../services/object-registry/src/index.ts";

export type EvidenceRetention = "TASK_ONLY" | "LEARNING_CANDIDATE";

export interface EvidenceArtifact extends EvidenceArtifactReference {
  robotId: string;
  requestId: string;
  storageKey: string;
  retention: EvidenceRetention;
  redacted: boolean;
  consentId?: string;
  recordedAtUnixMs: number;
}

export interface EvidenceRecorderState {
  schemaVersion: 1;
  artifacts: readonly EvidenceArtifact[];
}

export interface RecordEvidenceInput {
  artifactId?: string;
  observationId: string;
  robotId: string;
  requestId: string;
  mediaType: string;
  capturedAtUnixMs: number;
  retention: EvidenceRetention;
  redacted: boolean;
  consentId?: string;
  bytes: Uint8Array;
}

export interface EvidenceRecorderOptions {
  rootDirectory: string;
  maximumArtifactBytes?: number;
  maximumTotalBytes?: number;
  allowedMediaTypes?: readonly string[];
  now?: () => number;
  idGenerator?: () => string;
}

export class EvidenceRecorder {
  private readonly artifacts = new Map<string, EvidenceArtifact>();
  private readonly rootDirectory: string;
  private readonly blobDirectory: string;
  private readonly stateStore: AtomicJsonFileStore<EvidenceRecorderState>;
  private readonly maximumArtifactBytes: number;
  private readonly maximumTotalBytes: number;
  private readonly allowedMediaTypes: Set<string>;
  private readonly now: () => number;
  private readonly idGenerator: () => string;
  private persistenceTail: Promise<void> = Promise.resolve();

  private constructor(options: EvidenceRecorderOptions) {
    this.rootDirectory = options.rootDirectory;
    this.blobDirectory = join(options.rootDirectory, "blobs");
    this.stateStore = new AtomicJsonFileStore(join(options.rootDirectory, "evidence-state.json"));
    this.maximumArtifactBytes = options.maximumArtifactBytes ?? 32 * 1024 * 1024;
    this.maximumTotalBytes = options.maximumTotalBytes ?? 2 * 1024 * 1024 * 1024;
    this.allowedMediaTypes = new Set(options.allowedMediaTypes ?? [
      "image/jpeg",
      "image/png",
      "application/x-point-cloud",
      "application/x-brash-mask",
      "application/json",
    ]);
    this.now = options.now ?? Date.now;
    this.idGenerator = options.idGenerator ?? randomUUID;
    if (!options.rootDirectory.trim()) throw new Error("Evidence rootDirectory is required.");
    if (this.maximumArtifactBytes < 1 || this.maximumTotalBytes < this.maximumArtifactBytes) {
      throw new Error("Evidence quota configuration is invalid.");
    }
  }

  static async open(options: EvidenceRecorderOptions): Promise<EvidenceRecorder> {
    const recorder = new EvidenceRecorder(options);
    const state = await recorder.stateStore.load();
    if (state) recorder.restore(state);
    return recorder;
  }

  async record(input: RecordEvidenceInput): Promise<EvidenceArtifact> {
    validateInput(input, this.allowedMediaTypes, this.maximumArtifactBytes);
    const artifactId = input.artifactId?.trim() || this.idGenerator();
    const digest = createHash("sha256").update(input.bytes).digest("hex");
    const existing = this.artifacts.get(artifactId);
    if (existing) {
      if (existing.sha256 !== digest || existing.requestId !== input.requestId) {
        fail("EVIDENCE_ID_COLLISION", `Evidence artifact ${artifactId} identifies different bytes or provenance.`);
      }
      return clone(existing);
    }
    const usedBytes = [...this.artifacts.values()].reduce((total, artifact) => total + artifact.byteLength, 0);
    if (usedBytes + input.bytes.byteLength > this.maximumTotalBytes) {
      fail("EVIDENCE_QUOTA_EXCEEDED", "Recording this artifact would exceed the evidence quota.");
    }
    await mkdir(this.blobDirectory, { recursive: true, mode: 0o700 });
    const storageKey = `blobs/${digest}`;
    await writeBlobOnce(join(this.rootDirectory, storageKey), input.bytes, digest);
    const artifact: EvidenceArtifact = {
      artifactId,
      observationId: input.observationId,
      robotId: input.robotId,
      requestId: input.requestId,
      mediaType: input.mediaType,
      sha256: digest,
      byteLength: input.bytes.byteLength,
      capturedAtUnixMs: input.capturedAtUnixMs,
      storageKey,
      retention: input.retention,
      redacted: input.redacted,
      consentId: input.consentId,
      recordedAtUnixMs: this.now(),
    };
    this.artifacts.set(artifactId, artifact);
    try {
      await this.persist();
    } catch (error) {
      this.artifacts.delete(artifactId);
      throw error;
    }
    return clone(artifact);
  }

  get(artifactId: string): EvidenceArtifact {
    const artifact = this.artifacts.get(artifactId);
    if (!artifact) fail("EVIDENCE_NOT_FOUND", `Evidence artifact ${artifactId} was not found.`);
    return clone(artifact);
  }

  list(requestId?: string): readonly EvidenceArtifact[] {
    return clone([...this.artifacts.values()]
      .filter((artifact) => requestId === undefined || artifact.requestId === requestId)
      .sort((left, right) => right.recordedAtUnixMs - left.recordedAtUnixMs));
  }

  reference(artifactId: string): EvidenceArtifactReference {
    const artifact = this.get(artifactId);
    return {
      artifactId: artifact.artifactId,
      observationId: artifact.observationId,
      mediaType: artifact.mediaType,
      sha256: artifact.sha256,
      byteLength: artifact.byteLength,
      capturedAtUnixMs: artifact.capturedAtUnixMs,
    };
  }

  async verify(artifactId: string): Promise<boolean> {
    const artifact = this.get(artifactId);
    const bytes = await readFile(join(this.rootDirectory, artifact.storageKey));
    return bytes.byteLength === artifact.byteLength
      && createHash("sha256").update(bytes).digest("hex") === artifact.sha256;
  }

  private async persist(): Promise<void> {
    const state: EvidenceRecorderState = { schemaVersion: 1, artifacts: [...this.artifacts.values()] };
    const operation = this.persistenceTail.then(() => this.stateStore.save(state));
    this.persistenceTail = operation.catch(() => undefined);
    await operation;
  }

  private restore(state: EvidenceRecorderState): void {
    if (state.schemaVersion !== 1 || !Array.isArray(state.artifacts)) {
      throw new Error("Evidence state is invalid or unsupported.");
    }
    for (const artifact of state.artifacts) {
      if (!artifact.artifactId?.trim() || !/^[a-f0-9]{64}$/i.test(artifact.sha256)
        || !artifact.storageKey.startsWith("blobs/") || this.artifacts.has(artifact.artifactId)) {
        throw new Error("Evidence state contains a malformed or duplicated artifact.");
      }
      this.artifacts.set(artifact.artifactId, clone(artifact));
    }
  }
}

async function writeBlobOnce(filePath: string, bytes: Uint8Array, expectedDigest: string): Promise<void> {
  let handle;
  try {
    handle = await open(filePath, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST")) throw error;
    const existing = await readFile(filePath);
    if (existing.byteLength !== bytes.byteLength
      || createHash("sha256").update(existing).digest("hex") !== expectedDigest) {
      fail("EVIDENCE_BLOB_COLLISION", "An existing content-addressed evidence blob failed integrity verification.");
    }
  } finally {
    if (handle) await handle.close();
  }
}

function validateInput(input: RecordEvidenceInput, allowedMediaTypes: Set<string>, maximumArtifactBytes: number): void {
  for (const [field, value] of Object.entries({
    observationId: input.observationId,
    robotId: input.robotId,
    requestId: input.requestId,
    mediaType: input.mediaType,
  })) {
    if (!value?.trim()) fail("EVIDENCE_FIELD_REQUIRED", `${field} is required.`, { field });
  }
  if (!allowedMediaTypes.has(input.mediaType)) fail("EVIDENCE_MEDIA_TYPE_DENIED", `Media type ${input.mediaType} is not allowed.`);
  if (!Number.isSafeInteger(input.capturedAtUnixMs) || input.capturedAtUnixMs < 0) {
    fail("EVIDENCE_TIME_INVALID", "capturedAtUnixMs must be a non-negative Unix time.");
  }
  if (input.bytes.byteLength < 1 || input.bytes.byteLength > maximumArtifactBytes) {
    fail("EVIDENCE_SIZE_INVALID", `Evidence bytes must be between 1 and ${maximumArtifactBytes}.`);
  }
  if (input.retention === "LEARNING_CANDIDATE" && (!input.redacted || !input.consentId?.trim())) {
    fail("EVIDENCE_LEARNING_CONSENT_REQUIRED", "Learning evidence must be redacted and reference explicit consent.");
  }
}
