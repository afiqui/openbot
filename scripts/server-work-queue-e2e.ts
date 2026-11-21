// Checks the real loopback automation routes and local owner CLI without a user profile or provider.
// Run: bun scripts/server-work-queue-e2e.ts
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join, resolve } from "node:path";
import { DEFAULT_AGENT_DEFAULTS } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import type { QueuedWorkCandidate } from "../src/backend/agent/server-work-backlog";
import { AUTOMATION_TOKEN_FILE, AUTOMATION_URL_FILE, automationRoot } from "../src/backend/automation-command";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { AutomationServer, type AutomationServerOptions } from "../src/main/automation-server";

const projectRoot = process.env.OPENBOT_QUEUE_TEST_ROOT ?? resolve(import.meta.dirname, "..");
const output = join(projectRoot, ".openbot-build", "server-work-queue-e2e");
const report: { passed: boolean; checks: string[]; error?: string } = { passed: false, checks: [] };

async function fixture(): Promise<void> {
  const profile = mkdtempSync(join(output, "run-"));
  const root = automationRoot(profile);
  let allowed = true;
  const fullText = `${"Independent fixture notes. ".repeat(30)}Do not execute until the user approves the final changes.`;
  const calls: Array<{ agentId: string; deliveryId: string; title?: string; taskId?: string }> = [];
  const queued: QueuedWorkCandidate[] = [
    {
      deliveryId: "delivery-fixture",
      messageId: "message-fixture",
      sender: { kind: "user" },
      preview: fullText.slice(0, 500),
      text: fullText,
      createdAt: new Date().toISOString(),
      eligible: true,
      reason: null,
    },
  ];
  const options: AutomationServerOptions = {
    root,
    listAgents: () => [
      {
        id: "agent-fixture",
        name: "Fixture",
        allowAutomation: allowed,
        provider: "codex",
        model: "gpt-5.5",
        reasoningEffort: "medium",
      },
    ],
    agentDefaults: () => DEFAULT_AGENT_DEFAULTS,
    listModels: () => [],
    listRoutines: () => [],
    runRoutine: () => Effect.die(new Error("This check never runs a routine.")),
    sendMessage: () => Effect.die(new Error("This check never sends or replays a message.")),
    getLocalAttention: () => ({ prompts: [], approvals: [], browserTakeovers: [] }),
    respondToLocalAttention: () => Effect.die(new Error("This check never answers an approval.")),
    delivery: () => null,
    turnAnswer: () => null,
    updateAgent: () => Effect.die(new Error("This check never changes settings.")),
    clearAgentContext: () => Effect.die(new Error("This check never resets context.")),
    listQueuedWork: () => queued,
    dispatchQueuedWork: (agentId, input) => {
      calls.push({ agentId, ...input });
      return Effect.succeed({
        deliveryId: input.deliveryId,
        messageId: "message-fixture",
        work: {
          workId: input.taskId ?? "work-fixture",
          taskId: input.taskId ?? "work-fixture",
          agentId,
          title: input.title ?? "Fixture work",
          state: "queued",
          hold: null,
          outcome: null,
          updatedAt: new Date().toISOString(),
        },
      });
    },
  };
  const server = new AutomationServer(options);
  await runCauseEffect(server.sync());
  const base = new URL(readFileSync(join(root, AUTOMATION_URL_FILE), "utf8").trim());
  const token = readFileSync(join(root, AUTOMATION_TOKEN_FILE), "utf8").trim();
  const path = "/v1/agents/agent-fixture/queued-work";
  const http = (
    suffix: string,
    input: { method?: string; body?: unknown; authorized?: boolean; host?: string; origin?: string } = {},
  ) =>
    new Promise<{ status: number; body: string }>((done, reject) => {
      const body = input.body === undefined ? undefined : JSON.stringify(input.body);
      const call = request(
        new URL(suffix, base),
        {
          method: input.method ?? "GET",
          headers: {
            Host: input.host ?? base.host,
            ...(input.authorized === false ? {} : { Authorization: `Bearer ${token}` }),
            ...(input.origin ? { Origin: input.origin } : {}),
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
        },
        (response) => {
          let text = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            text += chunk;
          });
          response.on("end", () => done({ status: response.statusCode ?? 0, body: text }));
          response.on("error", reject);
        },
      );
      call.on("error", reject);
      call.end(body);
    });
  const cli = (args: string[]) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
      const child = spawn("node", [join(output, "cli.mjs"), ...args], { cwd: projectRoot, windowsHide: true });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (text: string) => {
        stdout += text;
      });
      child.stderr.on("data", (text: string) => {
        stderr += text;
      });
      child.on("error", reject);
      child.on("close", (code) => {
        assert.equal((stdout + stderr).includes(token), false, "The automation token never reaches CLI output.");
        done({ code, stdout, stderr });
      });
    });
  try {
    assert.equal((await http(path, { authorized: false })).status, 401);
    assert.equal((await http(path, { origin: "https://example.test" })).status, 403);
    assert.equal((await http(path, { host: "example.test" })).status, 403);
    assert.equal(
      (await http(`${path}/dispatch`, { method: "POST", body: { deliveryId: "delivery-fixture" }, authorized: false }))
        .status,
      401,
    );
    allowed = false;
    assert.equal((await http(path)).status, 403);
    assert.equal(
      (await http(`${path}/dispatch`, { method: "POST", body: { deliveryId: "delivery-fixture" } })).status,
      403,
    );
    allowed = true;
    assert.equal(calls.length, 0);
    report.checks.push("Read and move routes retain token, Origin, Host and agent automation permission checks.");

    const list = await http(path);
    assert.equal(list.status, 200);
    assert.deepEqual(JSON.parse(list.body), { queued });
    assert.equal((await http(path.replace("agent-fixture", "another-agent"))).status, 404);
    assert.equal(
      (
        await http(`${path}/dispatch`, {
          method: "POST",
          body: { deliveryId: "delivery-fixture", text: "Replay forbidden" },
        })
      ).status,
      400,
    );
    assert.equal(calls.length, 0);
    report.checks.push("Queue reads do not dispatch; another agent and replay payload fields are refused.");

    const args = [`--profile=${profile}`, "--agent=agent-fixture"];
    const read = await cli(args);
    assert.equal(read.code, 0, read.stderr);
    assert.deepEqual(JSON.parse(read.stdout), { queued });
    assert.ok(
      read.stdout.includes("Do not execute until the user approves"),
      "Late request constraints survive beyond the preview.",
    );
    assert.equal(calls.length, 0);
    const refused = await cli([...args, "--dispatch=delivery-fixture"]);
    assert.notEqual(refused.code, 0);
    assert.equal(calls.length, 0);
    report.checks.push("The CLI lists by default and requires --apply before a selected delivery can move.");

    const applied = await cli([
      ...args,
      "--dispatch=delivery-fixture",
      "--apply",
      "--task=existing-managed-task",
      "--title=Related fixture work",
    ]);
    assert.equal(applied.code, 0, applied.stderr);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      agentId: "agent-fixture",
      deliveryId: "delivery-fixture",
      taskId: "existing-managed-task",
      title: "Related fixture work",
    });
    assert.equal(JSON.parse(applied.stdout).deliveryId, "delivery-fixture");
    report.checks.push(
      "An explicit move forwards the original delivery and optional related-task selection without sending a new message.",
    );
    report.passed = true;
  } finally {
    await runCauseEffect(server.stop());
  }
}

mkdirSync(output, { recursive: true });
if (process.argv.includes("--fixture")) {
  try {
    await fixture();
  } catch (error) {
    report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.exitCode = 1;
  } finally {
    writeFileSync(join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(report)}\n`);
  }
} else {
  for (const [entrypoint, naming] of [
    [import.meta.filename, "fixture.mjs"],
    [join(projectRoot, "scripts/server-work-queue.ts"), "cli.mjs"],
  ] as const) {
    const build = await Bun.build({ entrypoints: [entrypoint], target: "node", format: "esm", outdir: output, naming });
    assert.ok(build.success, String(build.logs));
  }
  const child = spawnSync("node", [join(output, "fixture.mjs"), "--fixture"], {
    cwd: projectRoot,
    env: { ...process.env, OPENBOT_QUEUE_TEST_ROOT: projectRoot },
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000,
  });
  process.stdout.write(child.stdout);
  process.stderr.write(child.stderr);
  assert.ifError(child.error);
  assert.equal(child.status, 0, "Local queue API and CLI check failed.");
}
