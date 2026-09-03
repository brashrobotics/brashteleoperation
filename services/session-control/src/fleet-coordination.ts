import { randomUUID } from "node:crypto";
import {
  CONTRACT_VERSION,
  TeleoperationError,
  assertContractVersion,
  clone,
  fail,
  type ContractVersion,
} from "../../../packages/contracts/src/index.ts";

export type FleetHoldState = "PAUSE_REQUESTED" | "ROBOT_STOPPED" | "REJECTED" | "RELEASED";

export interface FleetHold {
  holdId: string;
  robotId: string;
  missionId?: string;
  state: FleetHoldState;
  reason?: string;
  revision: number;
}

export interface FleetTeleoperationPort {
  requestHold(input: { requestId: string; robotId: string; missionId?: string; reason: string }): Promise<FleetHold>;
  inspectHold(holdId: string): Promise<FleetHold>;
  releaseHold(input: { holdId: string; expectedRevision: number; reason: string }): Promise<FleetHold>;
}

export interface HttpFleetTeleoperationPortOptions {
  baseUrl: string;
  bearerToken: string;
  requestTimeoutMs?: number;
  maximumResponseBytes?: number;
  fetchImplementation?: typeof fetch;
}

interface FleetHoldDocument {
  contractVersion: ContractVersion;
  hold: FleetHold;
}

const fleetHoldStates = new Set<FleetHoldState>(["PAUSE_REQUESTED", "ROBOT_STOPPED", "REJECTED", "RELEASED"]);
const DEFAULT_FLEET_TIMEOUT_MS = 2_000;
const DEFAULT_MAXIMUM_FLEET_RESPONSE_BYTES = 32 * 1024;
const MAXIMUM_FLEET_TIMEOUT_MS = 30_000;
const MAXIMUM_FLEET_RESPONSE_BYTES = 256 * 1024;

/**
 * Low-rate HTTP adapter for the dedicated Fleet teleoperation-hold API.
 * It deliberately has no operation capable of transporting motion or media.
 */
export class HttpFleetTeleoperationPort implements FleetTeleoperationPort {
  private readonly baseUrl: URL;
  private readonly bearerToken: string;
  private readonly requestTimeoutMs: number;
  private readonly maximumResponseBytes: number;
  private readonly fetchImplementation: typeof fetch;

  constructor(options: HttpFleetTeleoperationPortOptions) {
    this.baseUrl = validateFleetBaseUrl(options.baseUrl);
    this.bearerToken = requireBoundedText(options.bearerToken, "bearerToken", 4_096);
    if (this.bearerToken !== options.bearerToken) throw new Error("Fleet bearer token cannot contain surrounding whitespace.");
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_FLEET_TIMEOUT_MS;
    this.maximumResponseBytes = options.maximumResponseBytes ?? DEFAULT_MAXIMUM_FLEET_RESPONSE_BYTES;
    if (!Number.isSafeInteger(this.requestTimeoutMs) || this.requestTimeoutMs < 25 || this.requestTimeoutMs > MAXIMUM_FLEET_TIMEOUT_MS) {
      throw new Error(`Fleet request timeout must be between 25 and ${MAXIMUM_FLEET_TIMEOUT_MS} milliseconds.`);
    }
    if (!Number.isSafeInteger(this.maximumResponseBytes) || this.maximumResponseBytes < 256
      || this.maximumResponseBytes > MAXIMUM_FLEET_RESPONSE_BYTES) {
      throw new Error(`Fleet maximum response size must be between 256 and ${MAXIMUM_FLEET_RESPONSE_BYTES} bytes.`);
    }
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  async requestHold(input: { requestId: string; robotId: string; missionId?: string; reason: string }): Promise<FleetHold> {
    const requestId = requireBoundedText(input.requestId, "requestId", 128);
    const robotId = requireBoundedText(input.robotId, "robotId", 128);
    const reason = requireBoundedText(input.reason, "reason", 1_024);
    const missionId = input.missionId === undefined ? undefined : requireBoundedText(input.missionId, "missionId", 128);
    return this.request("POST", "api/v1/teleoperation/holds", {
      contractVersion: CONTRACT_VERSION,
      requestId,
      robotId,
      ...(missionId === undefined ? {} : { missionId }),
      reason,
    }, requestId);
  }

  async inspectHold(holdId: string): Promise<FleetHold> {
    const id = requireBoundedText(holdId, "holdId", 128);
    return this.request("GET", `api/v1/teleoperation/holds/${encodeURIComponent(id)}`);
  }

  async releaseHold(input: { holdId: string; expectedRevision: number; reason: string }): Promise<FleetHold> {
    const holdId = requireBoundedText(input.holdId, "holdId", 128);
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
      fail("FLEET_FIELD_INVALID", "expectedRevision must be a positive safe integer.");
    }
    const reason = requireBoundedText(input.reason, "reason", 1_024);
    return this.request("POST", `api/v1/teleoperation/holds/${encodeURIComponent(holdId)}/release`, {
      contractVersion: CONTRACT_VERSION,
      expectedRevision: input.expectedRevision,
      reason,
    }, `${holdId}:release:${input.expectedRevision}`);
  }

  private async request(method: "GET" | "POST", relativePath: string, body?: Record<string, unknown>, idempotencyKey?: string): Promise<FleetHold> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    let response: Response;
    try {
      response = await this.fetchImplementation(new URL(relativePath, this.baseUrl), {
        method,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.bearerToken}`,
          ...(body ? { "content-type": "application/json" } : {}),
          ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        redirect: "error",
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) fail("FLEET_REQUEST_TIMEOUT", `Fleet did not respond within ${this.requestTimeoutMs} milliseconds.`);
      fail("FLEET_UNAVAILABLE", "Fleet teleoperation coordination is unavailable.", {
        cause: error instanceof Error ? error.name : "unknown",
      });
    }

    let payload: Buffer;
    try {
      payload = await readBoundedResponse(response, this.maximumResponseBytes);
    } catch (error) {
      if (controller.signal.aborted) fail("FLEET_REQUEST_TIMEOUT", `Fleet did not complete its response within ${this.requestTimeoutMs} milliseconds.`);
      if (error instanceof TeleoperationError) throw error;
      fail("FLEET_UNAVAILABLE", "Fleet response could not be read.", {
        cause: error instanceof Error ? error.name : "unknown",
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) failFleetHttpStatus(response.status);
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") {
      fail("FLEET_RESPONSE_CONTENT_TYPE_INVALID", "Fleet response must use application/json.");
    }
    let document: unknown;
    try {
      document = JSON.parse(payload.toString("utf8"));
    } catch {
      fail("FLEET_RESPONSE_INVALID", "Fleet response is not valid JSON.");
    }
    return decodeFleetHoldDocument(document).hold;
  }
}

export type TeleoperationReservationStatus = "WAITING_FOR_ROBOT_STOP" | "RESERVED" | "RELEASING" | "RELEASED" | "FAILED";

export interface TeleoperationReservation {
  reservationId: string;
  robotId: string;
  missionId?: string;
  fleetHoldId: string;
  fleetHoldRevision: number;
  status: TeleoperationReservationStatus;
  revision: number;
  requestedAtUnixMs: number;
  changedAtUnixMs: number;
  reason?: string;
}

export interface FleetReservationCoordinatorOptions {
  fleet: FleetTeleoperationPort;
  now?: () => number;
  idGenerator?: () => string;
  initialState?: FleetReservationState;
}

export interface FleetReservationState {
  schemaVersion: 1;
  reservations: readonly TeleoperationReservation[];
}

export interface FleetCommandLeaseCoordinatorOptions extends FleetReservationCoordinatorOptions {
  holdReason?: string;
  releaseReason?: string;
}

export interface FleetReleaseResult {
  reservation?: TeleoperationReservation;
  changed: boolean;
}

/**
 * Binds a command-session ID to the idempotency key of its Fleet hold.
 * Calls for one session are serialized so concurrent grant retries cannot race
 * an inspection or release in this process.
 */
export class FleetCommandLeaseCoordinator {
  private readonly reservations: FleetReservationCoordinator;
  private readonly holdReason: string;
  private readonly releaseReason: string;
  private readonly tails = new Map<string, Promise<void>>();

  constructor(options: FleetCommandLeaseCoordinatorOptions) {
    this.reservations = new FleetReservationCoordinator(options);
    this.holdReason = options.holdReason ?? "Commanding teleoperation session requires Fleet mission hold.";
    this.releaseReason = options.releaseReason ?? "Teleoperation command session ended after robot-stopped acknowledgement.";
  }

  exportState(): FleetReservationState {
    return this.reservations.exportState();
  }

  async authorize(input: { sessionId: string; robotId: string; missionId?: string }): Promise<TeleoperationReservation> {
    return this.serialize(input.sessionId, async () => {
      let reservation = this.find(input.sessionId);
      if (!reservation) {
        reservation = await this.reservations.request({
          reservationId: input.sessionId,
          robotId: input.robotId,
          missionId: input.missionId,
          reason: this.holdReason,
        });
      }
      if (reservation.status === "WAITING_FOR_ROBOT_STOP") {
        reservation = await this.reservations.reconcile(reservation.reservationId, reservation.revision);
      }
      this.reservations.requireAdmission(reservation.reservationId, input.robotId);
      return reservation;
    });
  }

  async releaseTracked(sessionId: string, reason = this.releaseReason): Promise<TeleoperationReservation | undefined> {
    return (await this.releaseTrackedWithResult(sessionId, reason)).reservation;
  }

  async releaseTrackedWithResult(sessionId: string, reason = this.releaseReason): Promise<FleetReleaseResult> {
    return this.serialize(sessionId, async () => {
      const reservation = this.find(sessionId);
      if (!reservation || reservation.status === "RELEASED") return { reservation, changed: false };
      return {
        reservation: await this.reservations.release(reservation.reservationId, reservation.revision, reason),
        changed: true,
      };
    });
  }

  get(sessionId: string): TeleoperationReservation | undefined {
    return this.find(sessionId);
  }

  private find(sessionId: string): TeleoperationReservation | undefined {
    try {
      return this.reservations.get(sessionId);
    } catch (error) {
      if (error instanceof TeleoperationError && error.code === "FLEET_RESERVATION_NOT_FOUND") return undefined;
      throw error;
    }
  }

  private async serialize<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(sessionId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const tail = current.then(() => undefined, () => undefined);
    this.tails.set(sessionId, tail);
    try {
      return await current;
    } finally {
      if (this.tails.get(sessionId) === tail) this.tails.delete(sessionId);
    }
  }
}

export class FleetReservationCoordinator {
  private readonly reservations = new Map<string, TeleoperationReservation>();
  private readonly fleet: FleetTeleoperationPort;
  private readonly now: () => number;
  private readonly idGenerator: () => string;

  constructor(options: FleetReservationCoordinatorOptions) {
    this.fleet = options.fleet;
    this.now = options.now ?? Date.now;
    this.idGenerator = options.idGenerator ?? randomUUID;
    if (options.initialState) this.restore(options.initialState);
  }

  async request(input: { reservationId?: string; robotId: string; missionId?: string; reason: string }): Promise<TeleoperationReservation> {
    requireText(input.robotId, "robotId");
    requireText(input.reason, "reason");
    const reservationId = input.reservationId ?? this.idGenerator();
    const existing = this.reservations.get(reservationId);
    if (existing) {
      if (existing.robotId !== input.robotId || existing.missionId !== input.missionId) {
        fail("FLEET_RESERVATION_ID_COLLISION", `Reservation ${reservationId} identifies another robot or mission.`);
      }
      return clone(existing);
    }
    const hold = await this.fleet.requestHold({
      requestId: reservationId,
      robotId: input.robotId,
      missionId: input.missionId,
      reason: input.reason,
    });
    validateFleetHold(hold, input.robotId, input.missionId, input.missionId === undefined);
    const now = this.now();
    const reservation: TeleoperationReservation = {
      reservationId,
      robotId: input.robotId,
      missionId: hold.missionId ?? input.missionId,
      fleetHoldId: hold.holdId,
      fleetHoldRevision: hold.revision,
      status: hold.state === "ROBOT_STOPPED"
        ? "RESERVED"
        : hold.state === "REJECTED"
          ? "FAILED"
          : hold.state === "RELEASED"
            ? "RELEASED"
            : "WAITING_FOR_ROBOT_STOP",
      revision: 1,
      requestedAtUnixMs: now,
      changedAtUnixMs: now,
      reason: hold.reason,
    };
    this.reservations.set(reservationId, reservation);
    return clone(reservation);
  }

  async reconcile(reservationId: string, expectedRevision: number): Promise<TeleoperationReservation> {
    const reservation = this.require(reservationId);
    this.requireRevision(reservation, expectedRevision);
    if (reservation.status !== "WAITING_FOR_ROBOT_STOP") return clone(reservation);
    const hold = await this.fleet.inspectHold(reservation.fleetHoldId);
    validateFleetHold(hold, reservation.robotId, reservation.missionId);
    if (hold.revision < reservation.fleetHoldRevision) fail("FLEET_HOLD_REVISION_STALE", "Fleet returned an older hold revision.");
    if (hold.state === "RELEASED") fail("FLEET_HOLD_RELEASED_EARLY", "Fleet hold was released before teleoperation admission.");
    const status = hold.state === "ROBOT_STOPPED" ? "RESERVED" : hold.state === "REJECTED" ? "FAILED" : reservation.status;
    if (hold.revision === reservation.fleetHoldRevision
      && (status !== reservation.status || hold.reason !== reservation.reason)) {
      fail("FLEET_HOLD_REVISION_STALE", "Fleet changed hold state without advancing its revision.");
    }
    if (status === reservation.status && hold.revision === reservation.fleetHoldRevision && hold.reason === reservation.reason) {
      return clone(reservation);
    }
    return this.replace(reservation, {
      status,
      fleetHoldRevision: hold.revision,
      revision: reservation.revision + 1,
      changedAtUnixMs: this.now(),
      reason: hold.reason,
    });
  }

  requireAdmission(reservationId: string, robotId: string): TeleoperationReservation {
    const reservation = this.require(reservationId);
    if (reservation.robotId !== robotId) fail("FLEET_RESERVATION_ROBOT_MISMATCH", "Fleet reservation belongs to another robot.");
    if (reservation.status !== "RESERVED") {
      fail("FLEET_RESERVATION_NOT_READY", "A commanding lease requires Fleet reservation and robot-stopped confirmation.");
    }
    return clone(reservation);
  }

  async release(reservationId: string, expectedRevision: number, reason: string): Promise<TeleoperationReservation> {
    const reservation = this.require(reservationId);
    requireText(reason, "reason");
    if (reservation.status === "RELEASED") return clone(reservation);
    this.requireRevision(reservation, expectedRevision);
    if (reservation.status !== "WAITING_FOR_ROBOT_STOP" && reservation.status !== "RESERVED"
      && reservation.status !== "FAILED" && reservation.status !== "RELEASING") {
      fail("FLEET_RESERVATION_TRANSITION_INVALID", `Cannot release reservation from ${reservation.status}.`);
    }
    const releasing = reservation.status === "RELEASING" ? reservation : this.replace(reservation, {
        status: "RELEASING",
        revision: reservation.revision + 1,
        changedAtUnixMs: this.now(),
        reason,
      });
    const hold = await this.fleet.releaseHold({
      holdId: reservation.fleetHoldId,
      expectedRevision: reservation.fleetHoldRevision,
      reason,
    });
    validateFleetHold(hold, reservation.robotId, reservation.missionId);
    if (hold.state !== "RELEASED") fail("FLEET_RELEASE_NOT_CONFIRMED", "Fleet did not confirm hold release.");
    if (hold.revision <= reservation.fleetHoldRevision) {
      fail("FLEET_HOLD_REVISION_STALE", "Fleet release confirmation did not advance the hold revision.");
    }
    return this.replace(releasing, {
      status: "RELEASED",
      fleetHoldRevision: hold.revision,
      revision: releasing.revision + 1,
      changedAtUnixMs: this.now(),
      reason: hold.reason ?? reason,
    });
  }

  get(reservationId: string): TeleoperationReservation {
    return clone(this.require(reservationId));
  }

  list(): readonly TeleoperationReservation[] {
    return clone([...this.reservations.values()]);
  }

  exportState(): FleetReservationState {
    return clone({ schemaVersion: 1, reservations: [...this.reservations.values()] });
  }

  private replace(current: TeleoperationReservation, changes: Partial<TeleoperationReservation>): TeleoperationReservation {
    const next = { ...current, ...changes };
    this.reservations.set(current.reservationId, next);
    return clone(next);
  }

  private require(reservationId: string): TeleoperationReservation {
    const reservation = this.reservations.get(reservationId);
    if (!reservation) fail("FLEET_RESERVATION_NOT_FOUND", `Reservation ${reservationId} was not found.`);
    return reservation;
  }

  private requireRevision(reservation: TeleoperationReservation, expectedRevision: number): void {
    if (reservation.revision !== expectedRevision) fail("FLEET_RESERVATION_REVISION_MISMATCH", "Fleet reservation revision changed.");
  }

  private restore(state: FleetReservationState): void {
    if (state.schemaVersion !== 1 || !Array.isArray(state.reservations)) {
      fail("FLEET_RESERVATION_STATE_INVALID", "Persisted Fleet reservation state is invalid or unsupported.");
    }
    const statuses = new Set<TeleoperationReservationStatus>([
      "WAITING_FOR_ROBOT_STOP", "RESERVED", "RELEASING", "RELEASED", "FAILED",
    ]);
    for (const reservation of state.reservations) {
      if (!reservation.reservationId?.trim() || !reservation.robotId?.trim() || !reservation.fleetHoldId?.trim()
        || !statuses.has(reservation.status) || !Number.isSafeInteger(reservation.fleetHoldRevision)
        || reservation.fleetHoldRevision < 1 || !Number.isSafeInteger(reservation.revision)
        || reservation.revision < 1 || !Number.isSafeInteger(reservation.requestedAtUnixMs)
        || reservation.requestedAtUnixMs < 0 || !Number.isSafeInteger(reservation.changedAtUnixMs)
        || reservation.changedAtUnixMs < reservation.requestedAtUnixMs
        || this.reservations.has(reservation.reservationId)) {
        fail("FLEET_RESERVATION_STATE_INVALID", "Persisted Fleet reservation is malformed or duplicated.");
      }
      this.reservations.set(reservation.reservationId, clone(reservation));
    }
  }
}

export class InMemoryFleetTeleoperationPort implements FleetTeleoperationPort {
  private readonly holds = new Map<string, FleetHold>();

  async requestHold(input: { requestId: string; robotId: string; missionId?: string; reason: string }): Promise<FleetHold> {
    const existing = this.holds.get(input.requestId);
    if (existing) return clone(existing);
    const hold: FleetHold = {
      holdId: input.requestId,
      robotId: input.robotId,
      missionId: input.missionId,
      state: "PAUSE_REQUESTED",
      revision: 1,
      reason: input.reason,
    };
    this.holds.set(hold.holdId, hold);
    return clone(hold);
  }

  async inspectHold(holdId: string): Promise<FleetHold> {
    return clone(this.require(holdId));
  }

  async releaseHold(input: { holdId: string; expectedRevision: number; reason: string }): Promise<FleetHold> {
    const hold = this.require(input.holdId);
    if (hold.state === "RELEASED") return clone(hold);
    if (hold.revision !== input.expectedRevision) fail("FLEET_HOLD_REVISION_MISMATCH", "Fleet hold revision changed.");
    const released = { ...hold, state: "RELEASED" as const, revision: hold.revision + 1, reason: input.reason };
    this.holds.set(input.holdId, released);
    return clone(released);
  }

  confirmRobotStopped(holdId: string): FleetHold {
    const hold = this.require(holdId);
    const stopped = { ...hold, state: "ROBOT_STOPPED" as const, revision: hold.revision + 1, reason: "Robot adapter confirmed stopped." };
    this.holds.set(holdId, stopped);
    return clone(stopped);
  }

  reject(holdId: string, reason: string): FleetHold {
    const hold = this.require(holdId);
    const rejected = { ...hold, state: "REJECTED" as const, revision: hold.revision + 1, reason };
    this.holds.set(holdId, rejected);
    return clone(rejected);
  }

  private require(holdId: string): FleetHold {
    const hold = this.holds.get(holdId);
    if (!hold) fail("FLEET_HOLD_NOT_FOUND", `Fleet hold ${holdId} was not found.`);
    return hold;
  }
}

function validateFleetHold(
  hold: FleetHold,
  robotId: string,
  missionId: string | undefined,
  allowResolvedMission = false,
): void {
  const missionMatches = hold.missionId === missionId || (allowResolvedMission && missionId === undefined);
  if (!hold.holdId?.trim() || hold.robotId !== robotId || !missionMatches || !fleetHoldStates.has(hold.state)
    || !Number.isSafeInteger(hold.revision) || hold.revision < 1) {
    fail("FLEET_HOLD_INVALID", "Fleet hold response has invalid identity or revision.");
  }
}

function requireText(value: string, field: string): void {
  if (!value.trim()) fail("FLEET_FIELD_REQUIRED", `${field} is required.`);
}

function validateFleetBaseUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Fleet base URL is invalid.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Fleet base URL cannot contain credentials, a query, or a fragment.");
  }
  const isSecure = url.protocol === "https:";
  const isLoopbackHttp = url.protocol === "http:" && isLoopbackHostname(url.hostname);
  if (!isSecure && !isLoopbackHttp) {
    throw new Error("Fleet base URL must use HTTPS, except for loopback development endpoints.");
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "::1" || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function requireBoundedText(value: string, field: string, maximumLength: number): string {
  if (typeof value !== "string" || !value.trim()) fail("FLEET_FIELD_REQUIRED", `${field} is required.`);
  if (value.length > maximumLength) fail("FLEET_FIELD_TOO_LONG", `${field} exceeds ${maximumLength} characters.`);
  return value;
}

async function readBoundedResponse(response: Response, maximumBytes: number): Promise<Buffer> {
  const advertisedLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(advertisedLength) && advertisedLength > maximumBytes) {
    await response.body?.cancel();
    fail("FLEET_RESPONSE_TOO_LARGE", `Fleet response exceeds ${maximumBytes} bytes.`);
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      totalBytes += chunk.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel();
        fail("FLEET_RESPONSE_TOO_LARGE", `Fleet response exceeds ${maximumBytes} bytes.`);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes);
}

function failFleetHttpStatus(status: number): never {
  if (status === 401 || status === 403) {
    fail("FLEET_AUTHENTICATION_FAILED", "Fleet rejected the teleoperation service identity.", { status });
  }
  if (status === 404) fail("FLEET_HOLD_NOT_FOUND", "Fleet hold was not found.", { status });
  if (status === 409 || status === 412) fail("FLEET_REQUEST_CONFLICT", "Fleet rejected a stale or conflicting hold operation.", { status });
  if (status === 408 || status === 429 || status >= 500) {
    fail("FLEET_UNAVAILABLE", "Fleet teleoperation coordination is unavailable.", { status });
  }
  fail("FLEET_REQUEST_REJECTED", "Fleet rejected the teleoperation hold operation.", { status });
}

function decodeFleetHoldDocument(value: unknown): FleetHoldDocument {
  try {
    const document = requireRecord(value);
    const version = requireRecord(document.contractVersion);
    const contractVersion: ContractVersion = {
      major: requireSafeInteger(version.major, "contractVersion.major", 0),
      minor: requireSafeInteger(version.minor, "contractVersion.minor", 0),
    };
    assertContractVersion(contractVersion);
    const item = requireRecord(document.hold);
    const state = requireString(item.state, "hold.state") as FleetHoldState;
    if (!fleetHoldStates.has(state)) throw new Error("hold.state is invalid");
    const missionId = item.missionId === undefined ? undefined : requireString(item.missionId, "hold.missionId");
    const reason = item.reason === undefined ? undefined : requireString(item.reason, "hold.reason");
    const hold: FleetHold = {
      holdId: requireString(item.holdId, "hold.holdId"),
      robotId: requireString(item.robotId, "hold.robotId"),
      ...(missionId === undefined ? {} : { missionId }),
      state,
      ...(reason === undefined ? {} : { reason }),
      revision: requireSafeInteger(item.revision, "hold.revision", 1),
    };
    for (const [field, text] of [["holdId", hold.holdId], ["robotId", hold.robotId], ["missionId", hold.missionId], ["reason", hold.reason]] as const) {
      if (text !== undefined && text.length > (field === "reason" ? 1_024 : 128)) throw new Error(`${field} is too long`);
    }
    return { contractVersion, hold };
  } catch (error) {
    if (error instanceof TeleoperationError && error.code.startsWith("FLEET_RESPONSE_")) throw error;
    fail("FLEET_RESPONSE_INVALID", "Fleet response does not match the teleoperation hold contract.");
  }
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("value is not an object");
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is invalid`);
  return value;
}

function requireSafeInteger(value: unknown, field: string, minimum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) throw new Error(`${field} is invalid`);
  return value;
}
