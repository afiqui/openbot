// Preview by default. --write saves only the named profile. Stop that custom server first.
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  decodeServerWorkPolicy,
  defaultServerWorkPolicy,
  SERVER_WORK_POLICY_FILE,
} from "../src/backend/agent/server-work-policy";
import { writeJsonFileAtomically } from "../src/backend/atomic-json-file";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { isMissingFileError } from "../src/backend/file-errors";

const { values } = parseArgs({
  options: {
    profile: { type: "string" },
    agent: { type: "string" },
    "max-concurrent": { type: "string" },
    "max-unfinished": { type: "string" },
    "total-turns": { type: "string" },
    dispatch: { type: "string" },
    enabled: { type: "string" },
    write: { type: "boolean", default: false },
  },
});
if (!values.profile) throw new Error("Pass --profile=<custom server user-data directory>.");
if (values.agent && (values["total-turns"] !== undefined || values.enabled !== undefined))
  throw new Error("The total turn limit and enabled flag belong to the host, not one agent.");
const path = join(resolve(values.profile), SERVER_WORK_POLICY_FILE);
let current = defaultServerWorkPolicy();
try {
  const decoded = decodeServerWorkPolicy(JSON.parse(await readFile(path, "utf8")));
  if (!decoded) throw new Error("Invalid server work policy. The file was not changed.");
  current = decoded;
} catch (cause) {
  if (!isMissingFileError(cause)) throw cause;
}
if (values.enabled !== undefined && values.enabled !== "true" && values.enabled !== "false")
  throw new Error("The enabled flag must be true or false.");
const changed = {
  ...(values["max-concurrent"] === undefined ? {} : { maxConcurrentTasks: Number(values["max-concurrent"]) }),
  ...(values["max-unfinished"] === undefined ? {} : { maxUnfinishedTasks: Number(values["max-unfinished"]) }),
  ...(values.dispatch === undefined ? {} : { dispatchMode: values.dispatch }),
};
const candidate = values.agent
  ? { ...current, agents: { ...current.agents, [values.agent]: { ...current.agents[values.agent], ...changed } } }
  : {
      ...current,
      ...changed,
      ...(values.enabled === undefined ? {} : { enabled: values.enabled === "true" }),
      ...(values["total-turns"] === undefined
        ? {}
        : {
            totalTurnLimit:
              values["total-turns"] === "automatic"
                ? null
                : values["total-turns"] === "unlimited"
                  ? "unlimited"
                  : Number(values["total-turns"]),
          }),
    };
const policy = decodeServerWorkPolicy(candidate);
if (!policy) throw new Error("Invalid server work policy. The file was not changed.");
if (values.write) await runCauseEffect(writeJsonFileAtomically(path, policy, { createDirectory: true }));
process.stdout.write(`${JSON.stringify({ path, written: values.write, policy }, null, 2)}\n`);
