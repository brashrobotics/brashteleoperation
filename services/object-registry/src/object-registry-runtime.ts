import { AtomicJsonFileStore } from "../../../packages/persistence/src/index.ts";
import { InMemoryObjectRegistry, type ObjectRegistryOptions, type ObjectRegistryState } from "./object-registry.ts";

export interface ObjectRegistryRuntimeOptions extends Omit<ObjectRegistryOptions, "initialState"> {
  stateFilePath: string;
}

export class ObjectRegistryRuntime {
  readonly registry: InMemoryObjectRegistry;
  private readonly store: AtomicJsonFileStore<ObjectRegistryState>;
  private persistenceTail: Promise<void> = Promise.resolve();

  private constructor(
    store: AtomicJsonFileStore<ObjectRegistryState>,
    state: ObjectRegistryState | undefined,
    options: ObjectRegistryRuntimeOptions,
  ) {
    this.store = store;
    this.registry = new InMemoryObjectRegistry({
      now: options.now,
      idGenerator: options.idGenerator,
      initialState: state,
    });
  }

  static async open(options: ObjectRegistryRuntimeOptions): Promise<ObjectRegistryRuntime> {
    const store = new AtomicJsonFileStore<ObjectRegistryState>(options.stateFilePath);
    return new ObjectRegistryRuntime(store, await store.load(), options);
  }

  async persist(): Promise<void> {
    const state = this.registry.exportState();
    const operation = this.persistenceTail.then(() => this.store.save(state));
    this.persistenceTail = operation.catch(() => undefined);
    await operation;
  }
}
