import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { HOST_AGENT_TASK_LIMIT_MAX, HOST_TURN_LIMIT_MAX } from "@openbot/contracts/ipc";
import { Schema } from "effect";

export const SERVER_WORK_POLICY_FILE = "custom-server-work-v1.json";

const unfinishedTaskCount = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: INPUT_LIMITS.agentTasks }));
const concurrentTaskCount = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: HOST_AGENT_TASK_LIMIT_MAX }));
const dispatchMode = Schema.Literals(["new-thread", "main"]);
const agentOverride = Schema.Struct({
  maxConcurrentTasks: Schema.optionalKey(concurrentTaskCount),
  maxUnfinishedTasks: Schema.optionalKey(unfinishedTaskCount),
  dispatchMode: Schema.optionalKey(dispatchMode),
});

/** Host-only policy. It does not change an IPC, Team API or instance archive contract. */
export const ServerWorkPolicySchema = Schema.Struct({
  version: Schema.Literal(1),
  enabled: Schema.Boolean,
  maxConcurrentTasks: concurrentTaskCount,
  maxUnfinishedTasks: unfinishedTaskCount,
  totalTurnLimit: Schema.NullOr(
    Schema.Union([
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: HOST_TURN_LIMIT_MAX })),
      Schema.Literal("unlimited"),
    ]),
  ),
  dispatchMode,
  agents: Schema.Record(Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u)), agentOverride),
});

export type ServerWorkPolicy = typeof ServerWorkPolicySchema.Type;
export type AgentServerWorkPolicy = Pick<
  ServerWorkPolicy,
  "maxConcurrentTasks" | "maxUnfinishedTasks" | "dispatchMode"
>;

const decodePolicy = Schema.decodeUnknownOption(ServerWorkPolicySchema);

/** Rejects an invalid file as a whole, so no partial override changes queue ownership. */
export function decodeServerWorkPolicy(value: unknown): ServerWorkPolicy | null {
  const result = decodePolicy(value);
  return result._tag === "Some" ? result.value : null;
}

/** Defaults belong to this custom build only. Provider and host memory gates still apply. */
export function defaultServerWorkPolicy(): ServerWorkPolicy {
  return {
    version: 1,
    enabled: true,
    maxConcurrentTasks: INPUT_LIMITS.agentTasks,
    maxUnfinishedTasks: INPUT_LIMITS.agentTasks,
    totalTurnLimit: 64,
    dispatchMode: "new-thread",
    agents: {},
  };
}

/** A caller cannot change a nested override in the cached policy through a returned value. */
export function cloneServerWorkPolicy(policy: ServerWorkPolicy): ServerWorkPolicy {
  return {
    ...policy,
    agents: Object.fromEntries(Object.entries(policy.agents).map(([id, value]) => [id, { ...value }])),
  };
}

/** An explicit custom policy takes precedence over the released agent's 1-to-4 setting. */
export function serverWorkPolicyForAgent(policy: ServerWorkPolicy, agentId: string): AgentServerWorkPolicy | null {
  if (!policy.enabled) return null;
  const override = Object.hasOwn(policy.agents, agentId) ? policy.agents[agentId] : undefined;
  return {
    maxConcurrentTasks: override?.maxConcurrentTasks ?? policy.maxConcurrentTasks,
    maxUnfinishedTasks: override?.maxUnfinishedTasks ?? policy.maxUnfinishedTasks,
    dispatchMode: override?.dispatchMode ?? policy.dispatchMode,
  };
}
