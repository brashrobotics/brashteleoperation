import { AtomicJsonFileStore } from "../../../packages/persistence/src/index.ts";
import { clone } from "../../../packages/contracts/src/index.ts";
import {
  InMemoryAssistanceOrchestrator,
  type AssistanceOrchestratorState,
} from "../../assistance-orchestrator/src/index.ts";
import {
  InMemorySessionControl,
  InMemoryRobotReadiness,
  FleetCommandLeaseCoordinator,
  type FleetReservationState,
  type FleetTeleoperationPort,
  type RobotReadinessState,
  type SessionControlState,
} from "../../session-control/src/index.ts";
import {
  InMemoryObjectRegistry,
  type ObjectRegistryState,
} from "../../object-registry/src/index.ts";
import {
  InMemoryRealtimeSignaling,
  type RealtimeSignalingState,
} from "../../realtime-signaling/src/index.ts";

export interface ControlPlaneState {
  schemaVersion: 1;
  sessions: SessionControlState;
  assistance: AssistanceOrchestratorState;
  registry?: ObjectRegistryState;
  signaling?: RealtimeSignalingState;
  robotReadiness?: RobotReadinessState;
  fleetReservations?: FleetReservationState;
}

export interface ControlPlaneRuntimeOptions {
  stateFilePath: string;
  now?: () => number;
  fleet?: FleetTeleoperationPort;
}

export class ControlPlaneRuntime {
  readonly sessions: InMemorySessionControl;
  readonly assistance: InMemoryAssistanceOrchestrator;
  readonly registry: InMemoryObjectRegistry;
  readonly signaling: InMemoryRealtimeSignaling;
  readonly robotReadiness: InMemoryRobotReadiness;
  readonly fleetSessions?: FleetCommandLeaseCoordinator;
  private readonly store: AtomicJsonFileStore<ControlPlaneState>;
  private readonly dormantFleetReservations?: FleetReservationState;
  private persistenceTail: Promise<void> = Promise.resolve();

  private constructor(
    store: AtomicJsonFileStore<ControlPlaneState>,
    initialState: ControlPlaneState | undefined,
    now: () => number,
    fleet: FleetTeleoperationPort | undefined,
  ) {
    this.store = store;
    if (initialState && initialState.schemaVersion !== 1) {
      throw new Error("Control-plane state version is invalid or unsupported.");
    }
    this.sessions = new InMemorySessionControl({ now, initialState: initialState?.sessions });
    this.assistance = new InMemoryAssistanceOrchestrator({ now, initialState: initialState?.assistance });
    this.registry = new InMemoryObjectRegistry({ now, initialState: initialState?.registry });
    this.signaling = new InMemoryRealtimeSignaling({ now, initialState: initialState?.signaling });
    this.robotReadiness = new InMemoryRobotReadiness({ now, initialState: initialState?.robotReadiness });
    this.fleetSessions = fleet
      ? new FleetCommandLeaseCoordinator({ fleet, now, initialState: initialState?.fleetReservations })
      : undefined;
    this.dormantFleetReservations = fleet ? undefined : clone(initialState?.fleetReservations);
  }

  static async open(options: ControlPlaneRuntimeOptions): Promise<ControlPlaneRuntime> {
    const now = options.now ?? Date.now;
    const store = new AtomicJsonFileStore<ControlPlaneState>(options.stateFilePath, { now });
    const initialState = await store.load();
    const runtime = new ControlPlaneRuntime(store, initialState, now, options.fleet);
    const expiredSessions = runtime.sessions.expireDue(now());
    const expiredAssistance = runtime.assistance.expireDue(now());
    const expiredSignaling = runtime.signaling.expireDue(now());
    const invalidatedSignaling = initialState ? runtime.signaling.invalidateActiveAfterRestart(now()) : [];
    if (expiredSessions.length > 0 || expiredAssistance.length > 0
      || expiredSignaling.length > 0 || invalidatedSignaling.length > 0) await runtime.persist();
    return runtime;
  }

  async persist(): Promise<void> {
    const snapshot: ControlPlaneState = {
      schemaVersion: 1,
      sessions: this.sessions.exportState(),
      assistance: this.assistance.exportState(),
      registry: this.registry.exportState(),
      signaling: this.signaling.exportState(),
      robotReadiness: this.robotReadiness.exportState(),
      fleetReservations: this.fleetSessions?.exportState() ?? this.dormantFleetReservations,
    };
    const operation = this.persistenceTail.then(() => this.store.save(snapshot));
    this.persistenceTail = operation.catch(() => undefined);
    await operation;
  }
}
