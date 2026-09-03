export class TeleoperationError extends Error {
  readonly code: string;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "TeleoperationError";
    this.code = code;
    this.details = details ? Object.freeze({ ...details }) : undefined;
  }
}

export function fail(code: string, message: string, details?: Record<string, unknown>): never {
  throw new TeleoperationError(code, message, details);
}
