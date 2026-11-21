// Local owner administration of selected existing queue deliveries. Listing is the default.
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { AUTOMATION_TOKEN_FILE, AUTOMATION_URL_FILE, automationRoot } from "../src/backend/automation-command";

let secret = "";
const redact = (text: string) => (secret ? text.replaceAll(secret, "[redacted]") : text);

async function main(): Promise<void> {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const allowedValues = new Set(["profile", "agent", "dispatch", "task", "title"]);
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    const argument = args[index] ?? "";
    const match = /^--([a-z-]+)(?:=(.*))?$/u.exec(argument);
    if (!match?.[1]) throw new Error("Use named --profile, --agent and action options.");
    const name = match[1];
    if (["help", "list", "apply"].includes(name)) {
      if (match[2] !== undefined || flags.has(name)) throw new Error(`Invalid --${name} option.`);
      flags.add(name);
    } else {
      if (!allowedValues.has(name) || values.has(name)) throw new Error(`Invalid --${name} option.`);
      const value = match[2] ?? args[++index];
      if (!value || value.startsWith("--")) throw new Error(`--${name} needs a value.`);
      values.set(name, value);
    }
  }
  if (flags.has("help")) {
    process.stdout.write(
      "bun scripts/server-work-queue.ts --profile=<profile folder> --agent=<agent id> [--list]\n" +
        "Move selected existing work: --dispatch=<delivery id> --apply [--title=<title>] [--task=<existing work task id>]\n" +
        "Lists full original text from this agent's own queue. Read the whole request before moving it.\n" +
        "Select only independent work. Keep approvals and context-dependent follow-ups in their original chat.\n",
    );
    return;
  }
  const profile = values.get("profile");
  const agent = values.get("agent");
  if (!profile || !agent) throw new Error("Explicit --profile and --agent options are required.");
  const deliveryId = values.get("dispatch");
  if (deliveryId && !flags.has("apply")) throw new Error("Moving existing work requires --apply.");
  if (deliveryId && flags.has("list")) throw new Error("Choose --list or --dispatch.");
  if (!deliveryId && (flags.has("apply") || values.has("task") || values.has("title")))
    throw new Error("--apply, --task and --title require --dispatch.");
  const root = automationRoot(resolve(profile));
  const base = new URL((await readFile(join(root, AUTOMATION_URL_FILE), "utf8")).trim());
  if (
    base.protocol !== "http:" ||
    base.hostname !== "127.0.0.1" ||
    !base.port ||
    base.username ||
    base.password ||
    base.pathname !== "/" ||
    base.search ||
    base.hash
  )
    throw new Error("The selected profile has no valid loopback automation address.");
  secret = (await readFile(join(root, AUTOMATION_TOKEN_FILE), "utf8")).trim();
  if (!secret) throw new Error("The selected profile has no automation token.");
  const path = `/v1/agents/${encodeURIComponent(agent)}/queued-work${deliveryId ? "/dispatch" : ""}`;
  const response = await fetch(new URL(path, base), {
    method: deliveryId ? "POST" : "GET",
    headers: { Authorization: `Bearer ${secret}`, ...(deliveryId ? { "Content-Type": "application/json" } : {}) },
    ...(deliveryId
      ? {
          body: JSON.stringify({
            deliveryId,
            ...(values.has("title") ? { title: values.get("title") } : {}),
            ...(values.has("task") ? { taskId: values.get("task") } : {}),
          }),
        }
      : {}),
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Queue request failed (${response.status}): ${redact(body)}`);
  if (!deliveryId) {
    const result = JSON.parse(body);
    if (
      !isDynamicRecord(result) ||
      !Array.isArray(result.queued) ||
      result.queued.length > 100 ||
      !result.queued.every(
        (candidate) =>
          isDynamicRecord(candidate) &&
          typeof candidate.text === "string" &&
          typeof candidate.preview === "string" &&
          typeof candidate.deliveryId === "string",
      )
    )
      throw new Error("The selected server does not return full queued request text.");
  }
  process.stdout.write(`${redact(body)}\n`);
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${redact(error instanceof Error ? error.message : String(error))}\n`);
  process.exitCode = 1;
}
