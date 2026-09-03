const sensitiveKey = /(authorization|token|secret|password|signature|private.?key)/i;

export interface LogRecord {
  timestamp: string;
  level: "DEBUG" | "INFO" | "WARN" | "ERROR";
  message: string;
  service: string;
  correlationId?: string;
  fields?: Readonly<Record<string, unknown>>;
}

export class JsonLogger {
  private readonly service: string;
  private readonly sink: (line: string) => void;
  private readonly now: () => Date;

  constructor(service: string, options: { sink?: (line: string) => void; now?: () => Date } = {}) {
    if (!service.trim()) throw new Error("Logger service is required.");
    this.service = service;
    this.sink = options.sink ?? ((line) => console.log(line));
    this.now = options.now ?? (() => new Date());
  }

  info(message: string, fields?: Readonly<Record<string, unknown>>, correlationId?: string): void {
    this.write("INFO", message, fields, correlationId);
  }

  warn(message: string, fields?: Readonly<Record<string, unknown>>, correlationId?: string): void {
    this.write("WARN", message, fields, correlationId);
  }

  error(message: string, error: unknown, fields?: Readonly<Record<string, unknown>>, correlationId?: string): void {
    const normalizedError = error instanceof Error ? { name: error.name, message: error.message } : { name: "UnknownError", message: String(error) };
    this.write("ERROR", message, { ...fields, error: normalizedError }, correlationId);
  }

  private write(
    level: LogRecord["level"],
    message: string,
    fields?: Readonly<Record<string, unknown>>,
    correlationId?: string,
  ): void {
    const record: LogRecord = {
      timestamp: this.now().toISOString(),
      level,
      message,
      service: this.service,
      correlationId,
      fields: fields ? redact(fields) as Readonly<Record<string, unknown>> : undefined,
    };
    this.sink(JSON.stringify(record));
  }
}

function redact(value: unknown, key = ""): unknown {
  if (sensitiveKey.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [entryKey, redact(entryValue, entryKey)]));
  }
  return value;
}
