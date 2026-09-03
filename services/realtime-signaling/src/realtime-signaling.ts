import { createHash, randomUUID } from "node:crypto";
import {
  assertRealtimeSignalingMessage,
  clone,
  decodeRealtimeSignalingMessage,
  fail,
  type RealtimeSignalingMessage,
  type RealtimeSignalingPeerRole,
} from "../../../packages/contracts/src/index.ts";

export type RealtimeSignalingStatus =
  | "AWAITING_OFFER"
  | "AWAITING_ANSWER"
  | "CONNECTING"
  | "CONNECTED"
  | "CLOSED"
  | "EXPIRED";

export interface SignalingMessageReceipt {
  messageId: string;
  sha256: string;
}

export interface RealtimeSignalingExchange {
  signalingId: string;
  sessionId: string;
  robotId: string;
  operatorId: string;
  status: RealtimeSignalingStatus;
  revision: number;
  createdAtUnixMs: number;
  changedAtUnixMs: number;
  expiresAtUnixMs: number;
  connectedPeers: readonly RealtimeSignalingPeerRole[];
  messages: readonly RealtimeSignalingMessage[];
  messageReceipts: readonly SignalingMessageReceipt[];
  reason?: string;
}

export type RealtimeSignalingEventType =
  | "SIGNALING_CREATED"
  | "SIGNALING_OFFER"
  | "SIGNALING_ANSWER"
  | "SIGNALING_ICE_CANDIDATE"
  | "SIGNALING_PEER_CONNECTED"
  | "SIGNALING_CLOSED"
  | "SIGNALING_EXPIRED"
  | "SIGNALING_RESTART_INVALIDATED";

export interface RealtimeSignalingEvent {
  eventId: string;
  signalingId: string;
  sessionId: string;
  revision: number;
  type: RealtimeSignalingEventType;
  occurredAtUnixMs: number;
  peer?: RealtimeSignalingPeerRole;
  messageId?: string;
  reason?: string;
}

export interface RealtimeSignalingState {
  schemaVersion: 1;
  exchanges: readonly RealtimeSignalingExchange[];
  events: readonly RealtimeSignalingEvent[];
}

export interface RealtimeSignalingOptions {
  now?: () => number;
  idGenerator?: () => string;
  maximumExchangeDurationMs?: number;
  maximumMessageAgeMs?: number;
  maximumFutureSkewMs?: number;
  maximumMessages?: number;
  maximumSdpBytes?: number;
  maximumCandidateBytes?: number;
  initialState?: RealtimeSignalingState;
}

const terminalStatuses = new Set<RealtimeSignalingStatus>(["CLOSED", "EXPIRED"]);
const signalingStatuses = new Set<RealtimeSignalingStatus>([
  "AWAITING_OFFER", "AWAITING_ANSWER", "CONNECTING", "CONNECTED", "CLOSED", "EXPIRED",
]);
const peerRoles = new Set<RealtimeSignalingPeerRole>(["OPERATOR", "ROBOT_EDGE"]);

export class InMemoryRealtimeSignaling {
  private readonly exchanges = new Map<string, RealtimeSignalingExchange>();
  private readonly eventsByExchange = new Map<string, RealtimeSignalingEvent[]>();
  private readonly now: () => number;
  private readonly idGenerator: () => string;
  private readonly maximumExchangeDurationMs: number;
  private readonly maximumMessageAgeMs: number;
  private readonly maximumFutureSkewMs: number;
  private readonly maximumMessages: number;
  private readonly maximumSdpBytes: number;
  private readonly maximumCandidateBytes: number;

  constructor(options: RealtimeSignalingOptions = {}) {
    this.now = options.now ?? Date.now;
    this.idGenerator = options.idGenerator ?? randomUUID;
    this.maximumExchangeDurationMs = options.maximumExchangeDurationMs ?? 2 * 60_000;
    this.maximumMessageAgeMs = options.maximumMessageAgeMs ?? 30_000;
    this.maximumFutureSkewMs = options.maximumFutureSkewMs ?? 2_000;
    this.maximumMessages = options.maximumMessages ?? 128;
    this.maximumSdpBytes = options.maximumSdpBytes ?? 64 * 1_024;
    this.maximumCandidateBytes = options.maximumCandidateBytes ?? 4 * 1_024;
    validatePositiveInteger(this.maximumExchangeDurationMs, "maximumExchangeDurationMs");
    validatePositiveInteger(this.maximumMessageAgeMs, "maximumMessageAgeMs");
    validateNonNegativeInteger(this.maximumFutureSkewMs, "maximumFutureSkewMs");
    validatePositiveInteger(this.maximumMessages, "maximumMessages");
    validatePositiveInteger(this.maximumSdpBytes, "maximumSdpBytes");
    validatePositiveInteger(this.maximumCandidateBytes, "maximumCandidateBytes");
    if (options.initialState) this.restore(options.initialState);
  }

  createExchange(input: {
    signalingId?: string;
    sessionId: string;
    robotId: string;
    operatorId: string;
    leaseExpiresAtUnixMs: number;
  }): RealtimeSignalingExchange {
    const now = this.checkedNow();
    const signalingId = requiredText(input.signalingId ?? this.idGenerator(), "signalingId");
    const sessionId = requiredText(input.sessionId, "sessionId");
    const robotId = requiredText(input.robotId, "robotId");
    const operatorId = requiredText(input.operatorId, "operatorId");
    validateNonNegativeInteger(input.leaseExpiresAtUnixMs, "leaseExpiresAtUnixMs");
    if (input.leaseExpiresAtUnixMs <= now) fail("SIGNALING_LEASE_EXPIRED", "Cannot signal for an expired session lease.");
    const expiresAtUnixMs = Math.min(input.leaseExpiresAtUnixMs, now + this.maximumExchangeDurationMs);
    this.expireDue(now);
    const existing = this.exchanges.get(signalingId);
    if (existing) {
      if (existing.sessionId === sessionId && existing.robotId === robotId && existing.operatorId === operatorId) return clone(existing);
      fail("SIGNALING_ID_COLLISION", `Signaling ID ${signalingId} identifies another exchange.`);
    }
    const conflict = [...this.exchanges.values()].find((candidate) =>
      candidate.sessionId === sessionId && !terminalStatuses.has(candidate.status));
    if (conflict) fail("SIGNALING_SESSION_CONFLICT", `Session ${sessionId} already has active exchange ${conflict.signalingId}.`);
    const exchange: RealtimeSignalingExchange = {
      signalingId,
      sessionId,
      robotId,
      operatorId,
      status: "AWAITING_OFFER",
      revision: 1,
      createdAtUnixMs: now,
      changedAtUnixMs: now,
      expiresAtUnixMs,
      connectedPeers: [],
      messages: [],
      messageReceipts: [],
    };
    this.exchanges.set(signalingId, exchange);
    this.appendEvent(exchange, "SIGNALING_CREATED");
    return clone(exchange);
  }

  submitMessage(signalingId: string, expectedRevision: number, untrustedMessage: unknown): RealtimeSignalingExchange {
    const now = this.checkedNow();
    this.expireDue(now);
    const exchange = this.requireExchange(signalingId);
    const message = decodeRealtimeSignalingMessage(untrustedMessage);
    assertRealtimeSignalingMessage(message);
    if (message.signalingId !== exchange.signalingId || message.sessionId !== exchange.sessionId) {
      fail("SIGNALING_MESSAGE_MISMATCH", "Signaling message does not belong to this exchange and session.");
    }
    const digest = messageDigest(message);
    const previousReceipt = exchange.messageReceipts.find((receipt) => receipt.messageId === message.messageId);
    if (previousReceipt) {
      if (previousReceipt.sha256 !== digest) fail("SIGNALING_MESSAGE_ID_COLLISION", `Message ${message.messageId} identifies different content.`);
      return clone(exchange);
    }
    this.requireRevision(exchange, expectedRevision);
    if (terminalStatuses.has(exchange.status)) fail("SIGNALING_TERMINAL", `Exchange ${signalingId} is ${exchange.status}.`);
    if (now >= exchange.expiresAtUnixMs) fail("SIGNALING_EXPIRED", `Exchange ${signalingId} has expired.`);
    if (message.sentAtUnixMs > now + this.maximumFutureSkewMs) {
      fail("SIGNALING_MESSAGE_FROM_FUTURE", "Signaling message time exceeds allowed clock skew.");
    }
    if (now - message.sentAtUnixMs > this.maximumMessageAgeMs || message.sentAtUnixMs < exchange.createdAtUnixMs) {
      fail("SIGNALING_MESSAGE_STALE", "Signaling message is older than the exchange or freshness window.");
    }
    if (exchange.messageReceipts.length >= this.maximumMessages) {
      fail("SIGNALING_MESSAGE_LIMIT", "Signaling exchange reached its bounded message limit.");
    }

    const transition = this.validateTransition(exchange, message);
    const receipt = { messageId: message.messageId, sha256: digest };
    const messages = transition.scrubMessages ? [] : [...exchange.messages, clone(message)];
    const next: RealtimeSignalingExchange = {
      ...exchange,
      status: transition.status,
      revision: exchange.revision + 1,
      changedAtUnixMs: now,
      connectedPeers: transition.connectedPeers,
      messages,
      messageReceipts: [...exchange.messageReceipts, receipt],
      reason: transition.reason,
    };
    this.exchanges.set(signalingId, next);
    this.appendEvent(next, transition.eventType, message.from, message.messageId, transition.reason);
    return clone(next);
  }

  getExchange(signalingId: string): RealtimeSignalingExchange {
    this.expireDue(this.checkedNow());
    return clone(this.requireExchange(signalingId));
  }

  getEvents(signalingId: string): readonly RealtimeSignalingEvent[] {
    this.requireExchange(signalingId);
    return clone(this.eventsByExchange.get(signalingId) ?? []);
  }

  listExchanges(sessionId?: string): readonly RealtimeSignalingExchange[] {
    this.expireDue(this.checkedNow());
    return clone([...this.exchanges.values()]
      .filter((exchange) => sessionId === undefined || exchange.sessionId === sessionId)
      .sort((left, right) => right.changedAtUnixMs - left.changedAtUnixMs));
  }

  expireDue(atUnixMs = this.checkedNow()): RealtimeSignalingExchange[] {
    validateNonNegativeInteger(atUnixMs, "atUnixMs");
    const expired: RealtimeSignalingExchange[] = [];
    for (const exchange of this.exchanges.values()) {
      if (!terminalStatuses.has(exchange.status) && atUnixMs >= exchange.expiresAtUnixMs) {
        expired.push(this.terminate(exchange, "EXPIRED", "SIGNALING_EXPIRED", atUnixMs, "Signaling exchange expired."));
      }
    }
    return expired;
  }

  invalidateActiveAfterRestart(atUnixMs = this.checkedNow()): RealtimeSignalingExchange[] {
    validateNonNegativeInteger(atUnixMs, "atUnixMs");
    const invalidated: RealtimeSignalingExchange[] = [];
    for (const exchange of this.exchanges.values()) {
      if (!terminalStatuses.has(exchange.status)) {
        invalidated.push(this.terminate(
          exchange,
          "EXPIRED",
          "SIGNALING_RESTART_INVALIDATED",
          atUnixMs,
          "Signaling negotiation invalidated by control-plane restart.",
        ));
      }
    }
    return invalidated;
  }

  exportState(): RealtimeSignalingState {
    return clone({
      schemaVersion: 1,
      exchanges: [...this.exchanges.values()],
      events: [...this.eventsByExchange.values()].flat(),
    });
  }

  private validateTransition(exchange: RealtimeSignalingExchange, message: RealtimeSignalingMessage): {
    status: RealtimeSignalingStatus;
    connectedPeers: readonly RealtimeSignalingPeerRole[];
    eventType: RealtimeSignalingEventType;
    scrubMessages: boolean;
    reason?: string;
  } {
    const payload = message.payload;
    if (payload.kind === "OFFER") {
      if (message.from !== "OPERATOR") fail("SIGNALING_OFFER_ROLE_INVALID", "Only the bound operator may submit an offer.");
      if (exchange.status !== "AWAITING_OFFER") fail("SIGNALING_OFFER_STATE_INVALID", `Cannot submit an offer from ${exchange.status}.`);
      assertByteLength(payload.description.sdp, this.maximumSdpBytes, "SIGNALING_SDP_TOO_LARGE", "SDP offer");
      return { status: "AWAITING_ANSWER", connectedPeers: exchange.connectedPeers, eventType: "SIGNALING_OFFER", scrubMessages: false };
    }
    if (payload.kind === "ANSWER") {
      if (message.from !== "ROBOT_EDGE") fail("SIGNALING_ANSWER_ROLE_INVALID", "Only the bound robot edge may submit an answer.");
      if (exchange.status !== "AWAITING_ANSWER") fail("SIGNALING_ANSWER_STATE_INVALID", `Cannot submit an answer from ${exchange.status}.`);
      assertByteLength(payload.description.sdp, this.maximumSdpBytes, "SIGNALING_SDP_TOO_LARGE", "SDP answer");
      return { status: "CONNECTING", connectedPeers: exchange.connectedPeers, eventType: "SIGNALING_ANSWER", scrubMessages: false };
    }
    if (payload.kind === "ICE_CANDIDATE") {
      if (exchange.status === "AWAITING_OFFER") fail("SIGNALING_CANDIDATE_STATE_INVALID", "ICE candidates require an accepted offer.");
      const count = exchange.messages.filter((item) => item.from === message.from && item.payload.kind === "ICE_CANDIDATE").length;
      if (count >= 64) fail("SIGNALING_CANDIDATE_LIMIT", `Peer ${message.from} exceeded the ICE candidate limit.`);
      if (payload.candidate !== null) {
        assertByteLength(JSON.stringify(payload.candidate), this.maximumCandidateBytes, "SIGNALING_CANDIDATE_TOO_LARGE", "ICE candidate");
      }
      return { status: exchange.status, connectedPeers: exchange.connectedPeers, eventType: "SIGNALING_ICE_CANDIDATE", scrubMessages: false };
    }
    if (payload.kind === "CONNECTED") {
      if (exchange.status !== "CONNECTING" && exchange.status !== "CONNECTED") {
        fail("SIGNALING_CONNECTED_STATE_INVALID", "Connected acknowledgement requires an offer and answer.");
      }
      if (exchange.connectedPeers.includes(message.from)) fail("SIGNALING_PEER_ALREADY_CONNECTED", `${message.from} already acknowledged connection.`);
      const connectedPeers = [...exchange.connectedPeers, message.from].sort();
      return {
        status: connectedPeers.length === 2 ? "CONNECTED" : "CONNECTING",
        connectedPeers,
        eventType: "SIGNALING_PEER_CONNECTED",
        scrubMessages: false,
      };
    }
    if (payload.reason.length > 512) fail("SIGNALING_REASON_TOO_LARGE", "Close reason exceeds 512 characters.");
    return {
      status: "CLOSED",
      connectedPeers: exchange.connectedPeers,
      eventType: "SIGNALING_CLOSED",
      scrubMessages: true,
      reason: payload.reason,
    };
  }

  private terminate(
    exchange: RealtimeSignalingExchange,
    status: "EXPIRED",
    eventType: "SIGNALING_EXPIRED" | "SIGNALING_RESTART_INVALIDATED",
    atUnixMs: number,
    reason: string,
  ): RealtimeSignalingExchange {
    const next: RealtimeSignalingExchange = {
      ...exchange,
      status,
      revision: exchange.revision + 1,
      changedAtUnixMs: atUnixMs,
      messages: [],
      reason,
    };
    this.exchanges.set(exchange.signalingId, next);
    this.appendEvent(next, eventType, undefined, undefined, reason);
    return clone(next);
  }

  private appendEvent(
    exchange: RealtimeSignalingExchange,
    type: RealtimeSignalingEventType,
    peer?: RealtimeSignalingPeerRole,
    messageId?: string,
    reason?: string,
  ): void {
    const events = this.eventsByExchange.get(exchange.signalingId) ?? [];
    events.push({
      eventId: this.idGenerator(),
      signalingId: exchange.signalingId,
      sessionId: exchange.sessionId,
      revision: exchange.revision,
      type,
      occurredAtUnixMs: exchange.changedAtUnixMs,
      peer,
      messageId,
      reason,
    });
    this.eventsByExchange.set(exchange.signalingId, events);
  }

  private restore(state: RealtimeSignalingState): void {
    if (state.schemaVersion !== 1 || !Array.isArray(state.exchanges) || !Array.isArray(state.events)) {
      fail("SIGNALING_STATE_INVALID", "Persisted signaling state is invalid or unsupported.");
    }
    for (const exchange of state.exchanges) {
      validateExchange(exchange, this.maximumMessages);
      if (this.exchanges.has(exchange.signalingId)) fail("SIGNALING_STATE_INVALID", "Persisted signaling IDs are duplicated.");
      for (const message of exchange.messages) {
        assertRealtimeSignalingMessage(decodeRealtimeSignalingMessage(message));
        if (message.signalingId !== exchange.signalingId || message.sessionId !== exchange.sessionId) {
          fail("SIGNALING_STATE_INVALID", "Persisted signaling message provenance is invalid.");
        }
      }
      this.exchanges.set(exchange.signalingId, clone(exchange));
    }
    for (const event of state.events) {
      const exchange = this.exchanges.get(event.signalingId);
      if (!exchange || event.sessionId !== exchange.sessionId || !Number.isSafeInteger(event.revision)
        || event.revision < 1 || event.revision > exchange.revision || !Number.isSafeInteger(event.occurredAtUnixMs)
        || event.occurredAtUnixMs < 0) {
        fail("SIGNALING_STATE_INVALID", "Persisted signaling event provenance is invalid.");
      }
      const events = this.eventsByExchange.get(event.signalingId) ?? [];
      events.push(clone(event));
      this.eventsByExchange.set(event.signalingId, events);
    }
    for (const exchange of this.exchanges.values()) {
      const events = this.eventsByExchange.get(exchange.signalingId) ?? [];
      if (events.length === 0 || events.at(-1)?.revision !== exchange.revision) {
        fail("SIGNALING_STATE_INVALID", `Persisted events do not cover exchange ${exchange.signalingId}.`);
      }
    }
  }

  private requireExchange(signalingId: string): RealtimeSignalingExchange {
    const exchange = this.exchanges.get(signalingId);
    if (!exchange) fail("SIGNALING_NOT_FOUND", `Signaling exchange ${signalingId} was not found.`);
    return exchange;
  }

  private requireRevision(exchange: RealtimeSignalingExchange, expectedRevision: number): void {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || exchange.revision !== expectedRevision) {
      fail("SIGNALING_REVISION_MISMATCH", `Expected signaling revision ${expectedRevision}, received ${exchange.revision}.`);
    }
  }

  private checkedNow(): number {
    const now = this.now();
    validateNonNegativeInteger(now, "nowUnixMs");
    return now;
  }
}

function validateExchange(exchange: RealtimeSignalingExchange, maximumMessages: number): void {
  requiredText(exchange.signalingId, "signalingId");
  requiredText(exchange.sessionId, "sessionId");
  requiredText(exchange.robotId, "robotId");
  requiredText(exchange.operatorId, "operatorId");
  if (!signalingStatuses.has(exchange.status) || !Number.isSafeInteger(exchange.revision) || exchange.revision < 1
    || !Number.isSafeInteger(exchange.createdAtUnixMs) || exchange.createdAtUnixMs < 0
    || !Number.isSafeInteger(exchange.changedAtUnixMs) || exchange.changedAtUnixMs < exchange.createdAtUnixMs
    || !Number.isSafeInteger(exchange.expiresAtUnixMs) || exchange.expiresAtUnixMs <= exchange.createdAtUnixMs
    || !Array.isArray(exchange.messages) || !Array.isArray(exchange.messageReceipts)
    || exchange.messageReceipts.length > maximumMessages || exchange.messages.length > maximumMessages
    || !Array.isArray(exchange.connectedPeers) || new Set(exchange.connectedPeers).size !== exchange.connectedPeers.length
    || exchange.connectedPeers.some((peer) => !peerRoles.has(peer))) {
    fail("SIGNALING_STATE_INVALID", "Persisted signaling exchange is malformed.");
  }
  const receiptIds = new Set<string>();
  for (const receipt of exchange.messageReceipts) {
    if (!receipt.messageId?.trim() || !/^[a-f0-9]{64}$/.test(receipt.sha256) || receiptIds.has(receipt.messageId)) {
      fail("SIGNALING_STATE_INVALID", "Persisted signaling receipts are malformed or duplicated.");
    }
    receiptIds.add(receipt.messageId);
  }
  if (exchange.messages.some((message) => !receiptIds.has(message.messageId))) {
    fail("SIGNALING_STATE_INVALID", "Persisted signaling messages are missing receipts.");
  }
  for (const message of exchange.messages) {
    const receipt = exchange.messageReceipts.find((candidate) => candidate.messageId === message.messageId);
    if (receipt?.sha256 !== messageDigest(message)) fail("SIGNALING_STATE_INVALID", "Persisted signaling message digest is invalid.");
  }
  if (terminalStatuses.has(exchange.status) && exchange.messages.length !== 0) {
    fail("SIGNALING_STATE_INVALID", "Terminal signaling exchanges must have negotiation material scrubbed.");
  }
}

function messageDigest(message: RealtimeSignalingMessage): string {
  return createHash("sha256").update(JSON.stringify(message)).digest("hex");
}

function assertByteLength(value: string, maximum: number, code: string, label: string): void {
  if (Buffer.byteLength(value, "utf8") > maximum) fail(code, `${label} exceeds ${maximum} bytes.`);
}

function requiredText(value: string, field: string): string {
  if (typeof value !== "string" || !value.trim()) fail("SIGNALING_FIELD_REQUIRED", `${field} is required.`);
  return value;
}

function validatePositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) fail("SIGNALING_OPTION_INVALID", `${field} must be a positive integer.`);
}

function validateNonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) fail("SIGNALING_TIME_INVALID", `${field} must be a non-negative integer.`);
}
