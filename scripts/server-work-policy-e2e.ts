// Runs the offline config process and the real preference store against an isolated profile.
// Run: bun scripts/server-work-policy-e2e.ts
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import { SERVER_WORK_POLICY_FILE } from "../src/backend/agent/server-work-policy";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { HostTurnLimitsPreferenceStore } from "../src/main/host-turn-limits-preference-store";
import { ServerWorkPolicyStore } from "../src/main/server-work-policy-store";

const out = resolve(import.meta.dirname, "../.openbot-build/server-work-policy-e2e");
await mkdir(out, { recursive: true });
const profile = await mkdtemp(join(out, "profile-"));
const path = join(profile, SERVER_WORK_POLICY_FILE);
const checks: string[] = [];

function configure(args: string[], success = true): void {
  const result = spawnSync(
    process.execPath,
    [resolve(import.meta.dirname, "configure-server-work.ts"), `--profile=${profile}`, ...args],
    {
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
    },
  );
  assert.ifError(result.error);
  if (success) assert.equal(result.status, 0, result.stderr);
  else assert.notEqual(result.status, 0);
}

async function load(): Promise<ServerWorkPolicyStore> {
  const store = new ServerWorkPolicyStore(path);
  await runCauseEffect(store.load());
  return store;
}

let passed = false;
try {
  configure(["--max-concurrent=50"]);
  assert.equal(existsSync(path), false);
  checks.push("preview does not write a profile");
  configure(["--max-concurrent=50", "--max-unfinished=50", "--total-turns=64", "--write"]);
  let store = await load();
  assert.deepEqual(store.policy("agent-a"), {
    maxConcurrentTasks: 50,
    maxUnfinishedTasks: 50,
    dispatchMode: "new-thread",
  });
  assert.equal(store.turnLimit(), 64);
  checks.push("a new process writes and the preference store reloads the host policy");
  configure(["--agent=agent-a", "--max-concurrent=1", "--max-unfinished=10", "--dispatch=main", "--write"]);
  store = await load();
  assert.deepEqual(store.policy("agent-a"), { maxConcurrentTasks: 1, maxUnfinishedTasks: 10, dispatchMode: "main" });
  assert.equal(store.policy("agent-b")?.maxConcurrentTasks, 50);
  checks.push("one agent override leaves other agents at the host default");
  const saved = await readFile(path, "utf8");
  for (const invalid of ["0", "65", "1.5", "NaN"]) configure([`--max-concurrent=${invalid}`, "--write"], false);
  configure(["--max-unfinished=51", "--write"], false);
  assert.equal(await readFile(path, "utf8"), saved);
  checks.push("invalid counts cannot replace a saved policy");
  assert.deepEqual(store.readHostTurnLimits(), { turnLimit: 64, agentTaskLimit: 50 });
  await runCauseEffect(store.setHostTurnLimits({ turnLimit: "unlimited", agentTaskLimit: 64 }));
  store = await load();
  assert.deepEqual(store.readHostTurnLimits(), { turnLimit: "unlimited", agentTaskLimit: 64 });
  assert.equal(store.turnLimit(), "unlimited");
  assert.equal(store.policy("agent-b")?.maxConcurrentTasks, 64);
  assert.deepEqual(store.policy("agent-a"), { maxConcurrentTasks: 1, maxUnfinishedTasks: 10, dispatchMode: "main" });
  assert.equal(store.get().maxUnfinishedTasks, 50);
  assert.equal(store.get().dispatchMode, "new-thread");
  checks.push("existing host settings persist64 and unlimited while keeping admission, routing and agent overrides");
  await runCauseEffect(store.setHostTurnLimits({ turnLimit: null, agentTaskLimit: null }));
  store = await load();
  assert.deepEqual(store.readHostTurnLimits(), { turnLimit: null, agentTaskLimit: 4 });
  assert.equal(store.turnLimit(), null);
  checks.push("automatic total remainsnull and the default agent limit resolves to the released builtin4");
  configure(["--total-turns=unlimited", "--write"]);
  assert.equal((await load()).turnLimit(), "unlimited");
  configure(["--total-turns=automatic", "--max-concurrent=64", "--write"]);
  store = await load();
  assert.equal(store.turnLimit(), null);
  assert.equal(store.policy("agent-b")?.maxConcurrentTasks, 64);
  checks.push("the offline command preserves unlimited and automatic host totals");
  const bridge = new HostTurnLimitsPreferenceStore(join(profile, "legacy-turn-limits.json"), () => null, {
    read: () => store.readHostTurnLimits(),
    set: (input) => store.setHostTurnLimits(input).pipe(Effect.asVoid),
  });
  await runCauseEffect(bridge.load());
  let changed = 0;
  bridge.onChange(() => changed++);
  assert.equal(bridge.get().agentTaskLimit, 64);
  await runCauseEffect(bridge.set({ turnLimit: 32, agentTaskLimit: 16 }));
  assert.equal(changed, 1);
  assert.equal(bridge.turnLimit(), 32);
  assert.equal(bridge.agentTaskLimit(), 16);
  assert.deepEqual((await load()).readHostTurnLimits(), { turnLimit: 32, agentTaskLimit: 16 });
  await runCauseEffect(bridge.set({ turnLimit: null, agentTaskLimit: null }));
  assert.equal(bridge.turnLimit(), null);
  assert.equal(bridge.agentTaskLimit(), 4);
  checks.push("the released host settings read and write the actual custom policy and notify queue drain listeners");
  configure(["--enabled=false", "--write"]);
  store = await load();
  assert.equal(store.policy("agent-a"), null);
  assert.equal(store.turnLimit(), null);
  assert.equal(store.readHostTurnLimits(), null);
  checks.push("disable restores upstream policy ownership after reload");
  const invalidFile = "{invalid";
  await writeFile(path, invalidFile);
  configure(["--max-concurrent=10", "--write"], false);
  assert.equal(await readFile(path, "utf8"), invalidFile);
  checks.push("the tool preserves an existing invalid file");
  passed = true;
} finally {
  await writeFile(join(out, "report.json"), `${JSON.stringify({ passed, profile, checks }, null, 2)}\n`);
}
