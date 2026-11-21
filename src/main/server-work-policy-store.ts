import { AGENT_TASK_LIMIT_DEFAULT, type HostTurnLimit, type HostTurnLimitsInput } from "@openbot/contracts/ipc";
import type { Effect } from "effect";
import {
  type AgentServerWorkPolicy,
  cloneServerWorkPolicy,
  decodeServerWorkPolicy,
  defaultServerWorkPolicy,
  type ServerWorkPolicy,
  serverWorkPolicyForAgent,
} from "../backend/agent/server-work-policy";
import { type PreferenceFileFailure, PreferenceStore } from "./preference-file";

/**
 * Owns the custom host's local work settings. Load once before queue recovery. A restart applies
 * offline changes. Existing host turn-limit settings can update its global limits. No new remote
 * route, mobile setting or exported agent field owns this policy.
 */
export class ServerWorkPolicyStore {
  readonly #store: PreferenceStore<ServerWorkPolicy>;

  constructor(path: string) {
    this.#store = new PreferenceStore({
      path,
      defaultValue: defaultServerWorkPolicy(),
      decode: decodeServerWorkPolicy,
    });
  }

  load(): Effect.Effect<void, PreferenceFileFailure> {
    return this.#store.load();
  }

  get(): ServerWorkPolicy {
    return cloneServerWorkPolicy(this.#store.get());
  }

  policy(agentId: string): AgentServerWorkPolicy | null {
    return serverWorkPolicyForAgent(this.#store.get(), agentId);
  }

  /** Null restores the upstream host total when the custom policy is disabled. */
  turnLimit(): HostTurnLimit | null {
    const value = this.#store.get();
    return value.enabled ? value.totalTurnLimit : null;
  }

  /** Existing host settings read the effective custom limits while this policy is enabled. */
  readHostTurnLimits(): HostTurnLimitsInput | null {
    const value = this.#store.get();
    return value.enabled ? { turnLimit: value.totalTurnLimit, agentTaskLimit: value.maxConcurrentTasks } : null;
  }

  /** The host settings boundary validates input. Preserve routing, admission and agent overrides. */
  setHostTurnLimits(input: HostTurnLimitsInput): Effect.Effect<ServerWorkPolicy, PreferenceFileFailure> {
    return this.#store.set({
      ...this.#store.get(),
      totalTurnLimit: input.turnLimit,
      maxConcurrentTasks: input.agentTaskLimit ?? AGENT_TASK_LIMIT_DEFAULT,
    });
  }

  /** The offline tool validates the file before saving it. Runtime callers pass a validated policy. */
  set(value: ServerWorkPolicy): Effect.Effect<ServerWorkPolicy, PreferenceFileFailure> {
    return this.#store.set(cloneServerWorkPolicy(value));
  }
}
