import { createHash, randomUUID } from "node:crypto";
import { open, mkdir, readFile, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

interface StoredEnvelope<T> {
  schemaVersion: 1;
  writtenAtUnixMs: number;
  payload: T;
  payloadSha256: string;
}

export interface AtomicJsonFileStoreOptions {
  maximumBytes?: number;
  now?: () => number;
}

export class AtomicJsonFileStore<T> {
  readonly filePath: string;
  private readonly maximumBytes: number;
  private readonly now: () => number;

  constructor(filePath: string, options: AtomicJsonFileStoreOptions = {}) {
    if (!filePath.trim()) throw new Error("Persistence filePath is required.");
    this.filePath = filePath;
    this.maximumBytes = options.maximumBytes ?? 16 * 1024 * 1024;
    this.now = options.now ?? Date.now;
    if (!Number.isSafeInteger(this.maximumBytes) || this.maximumBytes < 1_024) {
      throw new Error("maximumBytes must be at least 1024.");
    }
  }

  async load(): Promise<T | undefined> {
    let info;
    try {
      info = await stat(this.filePath);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return undefined;
      throw error;
    }
    if (!info.isFile()) throw new Error(`Persistence path ${this.filePath} is not a regular file.`);
    if (info.size > this.maximumBytes) throw new Error(`Persistence file exceeds ${this.maximumBytes} bytes.`);
    const raw = await readFile(this.filePath, "utf8");
    let envelope: StoredEnvelope<T>;
    try {
      envelope = JSON.parse(raw) as StoredEnvelope<T>;
    } catch {
      throw new Error(`Persistence file ${this.filePath} is not valid JSON.`);
    }
    if (envelope?.schemaVersion !== 1 || typeof envelope.payloadSha256 !== "string") {
      throw new Error("Persistence envelope version is invalid or unsupported.");
    }
    const actualHash = digest(envelope.payload);
    if (actualHash !== envelope.payloadSha256) throw new Error("Persistence payload checksum mismatch.");
    return structuredClone(envelope.payload);
  }

  async save(payload: T): Promise<void> {
    const parent = dirname(this.filePath);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const envelope: StoredEnvelope<T> = {
      schemaVersion: 1,
      writtenAtUnixMs: this.now(),
      payload: structuredClone(payload),
      payloadSha256: digest(payload),
    };
    const serialized = `${JSON.stringify(envelope)}\n`;
    if (Buffer.byteLength(serialized) > this.maximumBytes) {
      throw new Error(`Persistence snapshot exceeds ${this.maximumBytes} bytes.`);
    }
    const temporaryPath = join(parent, `.${basename(this.filePath)}.${process.pid}.${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, this.filePath);
      const directory = await open(parent, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }
}

function digest(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}
