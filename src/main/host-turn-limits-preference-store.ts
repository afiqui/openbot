import {
  AGENT_TASK_LIMIT_DEFAULT,
  type HostTurnLimit,
  type HostTurnLimits,
  type HostTurnLimitsInput,
  isHostAgentTaskLimit,
  isHostTurnLimit,
} from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { Effect } from "effect";
import { type PreferenceFileFailure, PreferenceStore } from "./preference-file";

export interface HostTurnLimitsOverride {
  read(): HostTurnLimitsInput | null;
  set(input: HostTurnLimitsInput): Effect.Effect<void, PreferenceFileFailure>;
}

export class HostTurnLimitsPreferenceStore {
  readonly #store: PreferenceStore<HostTurnLimitsInput>;
  readonly #automaticTurnLimit: () => number | null;
  readonly #override: HostTurnLimitsOverride | undefined;
  readonly #listeners = new Set<(limits: HostTurnLimits) => void>();

  constructor(path: string, automaticTurnLimit: () => number | null, override?: HostTurnLimitsOverride) {
    this.#store = new PreferenceStore<HostTurnLimitsInput>({
      path,
      defaultValue: { turnLimit: null, agentTaskLimit: null },
      decode: (parsed) =>
        isDynamicRecord(parsed) && parsed.version === 1
          ? {
              turnLimit: isHostTurnLimit(parsed.turnLimit) ? parsed.turnLimit : null,
              agentTaskLimit: isHostAgentTaskLimit(parsed.agentTaskLimit) ? parsed.agentTaskLimit : null,
            }
          : null,
    });
    this.#automaticTurnLimit = automaticTurnLimit;
    this.#override = override;
  }

  load(): Effect.Effect<void, PreferenceFileFailure> {
    return this.#store.load();
  }

  get(): HostTurnLimits {
    const { turnLimit, agentTaskLimit } = this.#override?.read() ?? this.#store.get();
    return {
      turnLimit,
      agentTaskLimit,
      automaticTurnLimit: this.#automaticTurnLimit(),
      defaultAgentTaskLimit: AGENT_TASK_LIMIT_DEFAULT,
    };
  }

  turnLimit(): HostTurnLimit | null {
    return this.get().turnLimit;
  }

  agentTaskLimit(): number {
    return this.get().agentTaskLimit ?? AGENT_TASK_LIMIT_DEFAULT;
  }

  readonly set = Effect.fn("HostTurnLimitsPreference.set")((input: HostTurnLimitsInput) => {
    const override = this.#override;
    const save = override && override.read() !== null ? override.set(input) : this.#store.set(input);
    return save.pipe(
      Effect.map(() => {
        const saved = this.get();
        for (const listener of this.#listeners) listener(saved);
        return saved;
      }),
    );
  });

  onChange(listener: (limits: HostTurnLimits) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
