import { randomUUID } from "node:crypto";
import {
  TeleoperationError,
  clone,
  decodeTeleopCommandEnvelope,
  fail,
  type TeleopCommandEnvelope,
  type TeleopSessionLease,
} from "../../../packages/contracts/src/index.ts";
import { LocalRobotAgent, type LocalRobotAgentState } from "./local-robot-agent.ts";

export type RealtimeChannelStatus = "CONNECTING" | "ACTIVE" | "HOLDING" | "CLOSED";

export interface RealtimeChannelEvent {
  eventId: string;
  type: "CHANNEL_OPENED" | "HEARTBEAT" | "COMMAND_ACCEPTED" | "COMMAND_REJECTED" | "CHANNEL_HOLD" | "CHANNEL_CLOSED";
  occurredAtUnixMs: number;
  commandId?: string;
  reason?: string;
}

export interface RealtimeCommandAcknowledgement {
  commandId: string;
  accepted: boolean;
  safetyRevision: number;
  acceptedOutput?: LocalRobotAgentState["baseSafety"]["output"] | NonNullable<LocalRobotAgentState["manipulatorSafety"]>["output"];
  rejectionCode?: string;
}

export interface RealtimeCommandChannelOptions {
  sessionId: string;
  agent: LocalRobotAgent;
  nowUnixMs?: () => number;
  nowMonotonicMs?: () => number;
  heartbeatTimeoutMs?: number;
  idGenerator?: () => string;
  maximumEvents?: number;
}

export class RealtimeCommandChannel {
  private readonly sessionId: string;
  private readonly agent: LocalRobotAgent;
  private readonly nowUnixMs: () => number;
  private readonly nowMonotonicMs: () => number;
  private readonly heartbeatTimeoutMs: number;
  private readonly idGenerator: () => string;
  private readonly maximumEvents: number;
  private readonly events: RealtimeChannelEvent[] = [];
  private status: RealtimeChannelStatus = "CONNECTING";
  private lastHeartbeatMonotonicMs?: number;

  constructor(options: RealtimeCommandChannelOptions) {
    if (!options.sessionId.trim()) throw new Error("Realtime channel sessionId is required.");
    this.sessionId = options.sessionId;
    this.agent = options.agent;
    this.nowUnixMs = options.nowUnixMs ?? Date.now;
    this.nowMonotonicMs = options.nowMonotonicMs ?? (() => performance.now());
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 500;
    this.idGenerator = options.idGenerator ?? randomUUID;
    this.maximumEvents = options.maximumEvents ?? 1_000;
    if (!Number.isSafeInteger(this.heartbeatTimeoutMs) || this.heartbeatTimeoutMs < 1
      || !Number.isSafeInteger(this.maximumEvents) || this.maximumEvents < 1) {
      throw new Error("Realtime channel timeout and event bounds must be positive integers.");
    }
  }

  open(lease: TeleopSessionLease): LocalRobotAgentState {
    if (this.status !== "CONNECTING") fail("REALTIME_CHANNEL_TRANSITION_INVALID", `Cannot open from ${this.status}.`);
    if (lease.sessionId !== this.sessionId) fail("REALTIME_CHANNEL_SESSION_MISMATCH", "Lease belongs to another session.");
    const state = this.agent.installLease(lease);
    this.status = "ACTIVE";
    this.lastHeartbeatMonotonicMs = this.nowMonotonicMs();
    this.append("CHANNEL_OPENED");
    return state;
  }

  openSigned(envelope: unknown): LocalRobotAgentState {
    if (this.status !== "CONNECTING") fail("REALTIME_CHANNEL_TRANSITION_INVALID", `Cannot open from ${this.status}.`);
    const state = this.agent.installSignedLease(envelope, this.sessionId);
    this.status = "ACTIVE";
    this.lastHeartbeatMonotonicMs = this.nowMonotonicMs();
    this.append("CHANNEL_OPENED");
    return state;
  }

  heartbeat(): void {
    if (this.status !== "ACTIVE") fail("REALTIME_CHANNEL_NOT_ACTIVE", `Heartbeat rejected while channel is ${this.status}.`);
    this.lastHeartbeatMonotonicMs = this.nowMonotonicMs();
    this.append("HEARTBEAT");
  }

  receive(untrusted: unknown): RealtimeCommandAcknowledgement {
    if (this.status !== "ACTIVE") fail("REALTIME_CHANNEL_NOT_ACTIVE", `Command rejected while channel is ${this.status}.`);
    let command: TeleopCommandEnvelope | undefined;
    try {
      command = decodeTeleopCommandEnvelope(untrusted);
      if (command.sessionId !== this.sessionId) fail("REALTIME_CHANNEL_SESSION_MISMATCH", "Command belongs to another channel session.");
      const state = this.agent.acceptCommand(command);
      this.append("COMMAND_ACCEPTED", command.commandId);
      return {
        commandId: command.commandId,
        accepted: true,
        safetyRevision: command.actuatorGroup === "BASE" ? state.baseSafety.revision : state.manipulatorSafety!.revision,
        acceptedOutput: command.actuatorGroup === "BASE" ? state.baseSafety.output : state.manipulatorSafety?.output,
      };
    } catch (error) {
      const commandId = commandIdFrom(untrusted);
      const rejectionCode = error instanceof TeleoperationError ? error.code : "REALTIME_COMMAND_INVALID";
      this.append("COMMAND_REJECTED", commandId, rejectionCode);
      return {
        commandId,
        accepted: false,
        safetyRevision: command?.actuatorGroup === "MANIPULATOR"
          ? this.agent.state().manipulatorSafety?.revision ?? this.agent.state().baseSafety.revision
          : this.agent.state().baseSafety.revision,
        rejectionCode,
      };
    }
  }

  tick(): RealtimeChannelStatus {
    if (this.status !== "ACTIVE" || this.lastHeartbeatMonotonicMs === undefined) return this.status;
    if (this.nowMonotonicMs() - this.lastHeartbeatMonotonicMs > this.heartbeatTimeoutMs) {
      this.hold("Realtime heartbeat timed out.");
    }
    this.agent.tick();
    return this.status;
  }

  disconnect(reason = "Realtime transport disconnected."): LocalRobotAgentState {
    if (this.status === "CLOSED") return this.agent.state();
    this.hold(reason);
    this.status = "CLOSED";
    this.append("CHANNEL_CLOSED", undefined, reason);
    return this.agent.state();
  }

  snapshot(): { sessionId: string; status: RealtimeChannelStatus; events: readonly RealtimeChannelEvent[] } {
    return { sessionId: this.sessionId, status: this.status, events: clone(this.events) };
  }

  private hold(reason: string): void {
    if (this.status === "HOLDING" || this.status === "CLOSED") return;
    try {
      this.agent.revokeLease(this.sessionId, reason);
    } catch (error) {
      if (!(error instanceof TeleoperationError && error.code === "SESSION_LEASE_NOT_FOUND")) throw error;
    }
    this.status = "HOLDING";
    this.append("CHANNEL_HOLD", undefined, reason);
  }

  private append(type: RealtimeChannelEvent["type"], commandId?: string, reason?: string): void {
    this.events.push({ eventId: this.idGenerator(), type, occurredAtUnixMs: this.nowUnixMs(), commandId, reason });
    while (this.events.length > this.maximumEvents) this.events.shift();
  }
}

function commandIdFrom(value: unknown): string {
  if (typeof value === "object" && value !== null && "commandId" in value && typeof value.commandId === "string") return value.commandId;
  return "unknown";
}
