// Runs server work dispatch against the real SQLite, thread and mailbox stores in a child process.
// No provider, account, user profile or network is used.
// Run: bun scripts/server-work-dispatch-e2e.ts
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { agentTasksEvent } from "@openbot/contracts/team-protocol/agent-tasks-v1";
import { Effect } from "effect";
import { ConversationRuntime } from "../src/backend/agent/conversation-runtime";
import { ServerWorkDispatch } from "../src/backend/agent/server-work-dispatch";
import type { AgentServerWorkPolicy } from "../src/backend/agent/server-work-policy";
import { ServerWorkRouting } from "../src/backend/agent/server-work-routing";
import { toolCallIdempotencyKey } from "../src/backend/agent/tool-call-idempotency";
import { AgentStore } from "../src/backend/agent-store";
import { AgentTasks } from "../src/backend/agent-tasks/agent-tasks";
import { AgentThreadStore } from "../src/backend/agent-threads/agent-thread-store";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { MailboxStore } from "../src/backend/mailbox-store";
import { OpenBotDatabase } from "../src/backend/openbot-database";
import { agentTasksWireSnapshot } from "../src/main/team-api/route-agent-tasks";

const projectRoot = process.env.OPENBOT_WORK_DISPATCH_ROOT ?? resolve(import.meta.dirname, "..");
const output = join(projectRoot, ".openbot-build", "server-work-dispatch-e2e");
const report: { passed: boolean; checks: string[]; error?: string } = { passed: false, checks: [] };

/** Pauses one real enqueue after thread admission, before attachment transfer and commit. */
class GatedMailbox extends MailboxStore {
  #gate: { enter(): void; wait: Promise<void> } | null = null;

  constructor(...args: ConstructorParameters<typeof MailboxStore>) {
    super(...args);
    const enqueue = this.enqueue;
    this.enqueue = Effect.fn("GatedMailbox.enqueue")((input: Parameters<MailboxStore["enqueue"]>[0]) =>
      Effect.gen({ self: this }, function* () {
        const gate = this.#gate;
        this.#gate = null;
        if (gate) {
          gate.enter();
          yield* Effect.promise(() => gate.wait);
        }
        return yield* enqueue(input);
      }),
    );
  }

  pauseNext(): { entered: Promise<void>; release(): void } {
    assert.equal(this.#gate, null);
    const entered = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    this.#gate = { enter: entered.resolve, wait: released.promise };
    return { entered: entered.promise, release: released.resolve };
  }
}

async function fixture(): Promise<void> {
  const root = mkdtempSync(join(output, "run-"));
  const profile = join(root, "profile");
  let policy: AgentServerWorkPolicy | null = {
    maxConcurrentTasks: 50,
    maxUnfinishedTasks: 50,
    dispatchMode: "new-thread",
  };
  const hidden = new Set<string>();
  let sharedScope = "section:fixture";
  let queued = 0;

  async function open() {
    const database = new OpenBotDatabase(profile);
    const store = new AgentStore(profile, join(root, "home"), database);
    const mailbox = new GatedMailbox(profile, store.sharedRoot, database);
    await runCauseEffect(store.initialize());
    await runCauseEffect(mailbox.initialize());
    const conversation = new ConversationRuntime(
      store,
      () => {},
      () => store.list(),
    );
    const tasks = new AgentTasks({
      store: new AgentThreadStore(database),
      mailbox,
      conversation,
      hooks: {
        emit: () => {},
        agent: (id) => store.list().find((agent) => agent.id === id),
        defaultTaskLimit: () => 4,
        serverWorkPolicy: () => policy,
        hold: () => null,
        queued: () => {},
        turnActive: () => false,
        archived: () => Effect.void,
      },
    });
    const dispatch = new ServerWorkDispatch({
      tasks,
      mailbox,
      policy: () => policy,
      visibleAgents: () => store.list().filter((agent) => !hidden.has(agent.id)),
      sharingScope: () => sharedScope,
      queued: () => queued++,
    });
    return { database, store, mailbox, conversation, tasks, dispatch };
  }

  let state = await open();
  async function cancelAndRemoveTaskMessages(agentId: string, taskId: string): Promise<void> {
    for (const delivery of state.mailbox.taskQueue(agentId, taskId)) {
      assert.equal(delivery.status, "queued", "Only a queued fixture request is cancelled.");
      await runCauseEffect(state.mailbox.cancel(agentId, delivery.id));
    }
    assert.equal(state.mailbox.taskBusy(agentId, taskId), false);
    await runCauseEffect(state.mailbox.deleteTaskMessages(agentId, taskId));
  }
  try {
    const sender = await runCauseEffect(
      state.store.createAgent({ name: "Coordinator", description: "Fixture", avatarSeed: "sender", avatarHue: null }),
    );
    const worker = await runCauseEffect(
      state.store.createAgent({ name: "Worker", description: "Fixture", avatarSeed: "worker", avatarHue: null }),
    );
    const outsider = await runCauseEffect(
      state.store.createAgent({
        name: "Other coordinator",
        description: "Fixture",
        avatarSeed: "other",
        avatarHue: null,
      }),
    );
    const source = state.tasks.create(sender.id, "Source chat", "user");
    assert.equal(state.tasks.limit(worker.id), 50, "The server policy controls the scheduler limit.");
    const send = (
      workKey: string,
      requestId: string,
      extra: Partial<Parameters<ServerWorkDispatch["dispatch"]>[0]> = {},
    ) =>
      runCauseEffect(
        state.dispatch.dispatch({
          senderAgentId: sender.id,
          recipientAgentId: worker.id,
          text: `Work on ${workKey}`,
          title: `Fixture ${workKey}`,
          workKey,
          requestId,
          sourceTurnId: "source-turn",
          senderTaskId: source.taskId,
          ...extra,
        }),
      );

    const [first, duplicate] = await Promise.all([send("alpha", "request-1"), send("alpha", "request-1")]);
    assert.equal(first.work.taskId, duplicate.work.taskId);
    assert.equal(first.receipt.messageId, duplicate.receipt.messageId);
    assert.equal(state.tasks.openTaskIds(worker.id).length, 1);
    assert.equal(state.mailbox.taskIdForDelivery(first.receipt.deliveries[0]?.id ?? ""), first.work.taskId);
    assert.equal(state.mailbox.listQueue(worker.id).deliveries.length, 0, "No request first waits in the main chat.");
    assert.equal(state.mailbox.answerTaskId(worker.id, first.receipt.messageId, [sender.id]), source.taskId);
    assert.equal(state.mailbox.hasRequestFromTurn(sender.id, "source-turn"), true);
    const otherTurnRetry = await send("alpha", "request-1", { sourceTurnId: "later-retry-turn" });
    assert.equal(otherTurnRetry.receipt.messageId, first.receipt.messageId);
    assert.equal(state.mailbox.hasRequestFromTurn(sender.id, "later-retry-turn"), false);
    report.checks.push("Concurrent retries create one work chat and one delivery; replies retain the source chat.");
    await assert.rejects(send("different-key-on-retry", "request-1"));
    assert.equal(
      state.tasks.openTaskIds(worker.id).length,
      1,
      "A request retry cannot create a different empty work chat.",
    );
    report.checks.push("A request id cannot be reused for another work chat.");

    const mainHistory = await send("main-history", "main-history-request", {
      senderTaskId: undefined,
      sourceTurnId: "main-source-turn",
    });
    assert.equal(
      state.mailbox
        .conversationMessages(sender.id)
        .find((message) => message.exchange?.messageId === mainHistory.receipt.messageId)?.turnId,
      "main-source-turn",
    );

    const second = await send("beta", "request-2");
    assert.notEqual(first.work.taskId, second.work.taskId);
    const followup = await send("alpha", "request-3");
    assert.equal(followup.work.taskId, first.work.taskId);
    assert.notEqual(followup.receipt.messageId, first.receipt.messageId);
    const explicit = await send("unused", "request-explicit", { taskId: second.work.taskId, workKey: undefined });
    assert.equal(explicit.work.taskId, second.work.taskId);
    const shared = await send("alpha", "request-4", { senderAgentId: outsider.id, senderTaskId: undefined });
    assert.equal(shared.work.taskId, first.work.taskId);
    const found = state.dispatch.find({ callerAgentId: outsider.id, recipientAgentId: worker.id, workKey: "alpha" });
    assert.equal(found[0]?.taskId, first.work.taskId);
    assert.ok(!JSON.stringify(found).includes("Work on alpha"), "Discovery does not expose the request transcript.");
    sharedScope = `private:${outsider.id}`;
    assert.equal(
      state.dispatch.find({ callerAgentId: outsider.id, recipientAgentId: worker.id, workKey: "alpha" }).length,
      0,
    );
    sharedScope = "section:fixture";
    report.checks.push("Different work keys use independent chats; permitted callers find and continue related work.");

    const unkeyed = await send("no-key", "request-unkeyed", { workKey: undefined });
    const unkeyedRetry = await send("no-key", "request-unkeyed", { workKey: undefined });
    assert.equal(unkeyed.work.taskId, unkeyedRetry.work.taskId);
    const reservedKey = await send(`request:${sender.id}:request-unkeyed`, "request-explicit-key");
    assert.notEqual(
      reservedKey.work.taskId,
      unkeyed.work.taskId,
      "Explicit work keys and automatic request ids have separate namespaces.",
    );
    report.checks.push("Unkeyed retries retain their chat without colliding with an explicit work key.");

    hidden.add(worker.id);
    await assert.rejects(send("hidden", "request-hidden"));
    hidden.delete(worker.id);
    await assert.rejects(send("wrong-owner", "request-wrong-owner", { taskId: source.taskId, workKey: undefined }));
    report.checks.push("Hidden targets and a task owned by another agent are refused.");

    state.tasks.close(state.tasks.require(worker.id, first.work.taskId));
    await assert.rejects(send("alpha", "request-archived"));
    const reopened = await send("alpha", "request-reopened", { reopen: true });
    assert.equal(reopened.work.taskId, first.work.taskId);
    assert.equal(state.tasks.require(worker.id, first.work.taskId).closedAt, null);
    report.checks.push("Archived work is refused unless the caller explicitly reopens it.");

    state.conversation.dispose();
    state.database.close();
    state = await open();
    assert.equal(state.mailbox.hasRequestFromTurn(sender.id, "source-turn"), true);
    assert.equal(state.mailbox.hasRequestFromTurn(sender.id, "later-retry-turn"), false);
    assert.equal(
      state.mailbox
        .conversationMessages(sender.id)
        .find((message) => message.exchange?.messageId === mainHistory.receipt.messageId)?.turnId,
      "main-source-turn",
    );
    const reloadedRetry = await send("alpha", "request-1", { sourceTurnId: "restart-retry-turn" });
    assert.equal(reloadedRetry.receipt.messageId, first.receipt.messageId);
    const afterRestart = await send("alpha", "request-after-restart");
    assert.equal(afterRestart.work.taskId, first.work.taskId);
    assert.equal(state.mailbox.taskIdForDelivery(afterRestart.receipt.deliveries[0]?.id ?? ""), first.work.taskId);
    report.checks.push("A fresh SQLite and controller instance finds the same work chat after restart.");
    report.checks.push(
      "Stable retries across turns and restart keep the original source-turn history and delegation lookup.",
    );

    const attachmentPath = join(root, "fixture-attachment.txt");
    writeFileSync(attachmentPath, "Synthetic attachment for commit-race checks.\n");
    for (const change of ["archive", "delete", "hide", "scope"] as const) {
      const key = `commit-race-${change}`;
      const ready = await send(key, `prepare-${change}`);
      await cancelAndRemoveTaskMessages(worker.id, ready.work.taskId);
      const gate = state.mailbox.pauseNext();
      const pending = send(key, `racing-${change}`, { sourcePaths: [attachmentPath] });
      const refused = assert.rejects(pending);
      await gate.entered;
      const task = state.tasks.require(worker.id, ready.work.taskId);
      if (change === "archive") state.tasks.close(task);
      if (change === "delete") state.tasks.delete(task);
      if (change === "hide") hidden.add(worker.id);
      if (change === "scope") sharedScope = "changed-section";
      gate.release();
      try {
        await refused;
        assert.equal(
          state.mailbox.taskQueue(worker.id, ready.work.taskId).length,
          0,
          "A refused attachment send leaves no queued delivery.",
        );
      } finally {
        hidden.delete(worker.id);
        sharedScope = "section:fixture";
        if (state.tasks.has(worker.id, ready.work.taskId))
          state.tasks.delete(state.tasks.require(worker.id, ready.work.taskId));
      }
    }
    report.checks.push(
      "Archive, delete, hide and scope changes during an awaited attachment send leave no orphan delivery.",
    );

    const limited = await runCauseEffect(
      state.store.createAgent({
        name: "Limited worker",
        description: "Fixture",
        avatarSeed: "limited",
        avatarHue: null,
      }),
    );
    const finished = await send("finished", "limited-finished", { recipientAgentId: limited.id });
    await cancelAndRemoveTaskMessages(limited.id, finished.work.taskId);
    new AgentThreadStore(state.database).setOutcome(finished.work.taskId, "completed");
    const unfinished = await send("unfinished", "limited-unfinished", { recipientAgentId: limited.id });
    const fullPolicy = policy;
    assert.ok(fullPolicy);
    policy = { ...fullPolicy, maxUnfinishedTasks: 1 };
    try {
      await assert.rejects(send("finished", "limited-followup", { recipientAgentId: limited.id }));
      state.tasks.close(state.tasks.require(limited.id, finished.work.taskId));
      await assert.rejects(send("finished", "limited-reopen", { recipientAgentId: limited.id, reopen: true }));
      assert.notEqual(state.tasks.require(limited.id, finished.work.taskId).closedAt, null);
      const retry = await send("unfinished", "limited-unfinished", { recipientAgentId: limited.id });
      assert.equal(retry.receipt.messageId, unfinished.receipt.messageId);
    } finally {
      policy = fullPolicy;
    }
    report.checks.push(
      "The unfinished-work bound covers idle and archived follow-ups without rejecting an admitted retry.",
    );

    const deleted = await send("deleted", "request-deleted");
    await cancelAndRemoveTaskMessages(worker.id, deleted.work.taskId);
    state.tasks.delete(state.tasks.require(worker.id, deleted.work.taskId));
    assert.equal(state.tasks.has(worker.id, deleted.work.taskId), false);
    assert.equal(
      state.dispatch.find({ callerAgentId: sender.id, recipientAgentId: worker.id, workKey: "deleted" }).length,
      0,
    );
    await assert.rejects(send("unused", "request-old-task-id", { taskId: deleted.work.taskId, workKey: undefined }));
    const fresh = await send("deleted", "request-deleted-again");
    assert.equal(state.tasks.has(worker.id, fresh.work.taskId), true);
    assert.equal(
      state.mailbox.taskQueue(worker.id, fresh.work.taskId).length,
      1,
      "Deleted work history does not return.",
    );
    assert.notEqual(fresh.receipt.messageId, deleted.receipt.messageId);
    report.checks.push("Deleted work disappears; an old task id fails; a keyed new request starts a clean chat.");

    while (state.tasks.openTaskIds(worker.id).length < 50) {
      const index = state.tasks.openTaskIds(worker.id).length;
      await send(`scale-${index}`, `scale-request-${index}`);
    }
    assert.equal(state.tasks.openTaskIds(worker.id).length, 50);
    await assert.rejects(send("over-limit", "request-over-limit"));
    const snapshot = state.tasks.snapshot(worker.id);
    assert.equal(snapshot.limit, 50, "The internal snapshot reports the real execution limit.");
    const wire = agentTasksWireSnapshot(snapshot);
    assert.equal(wire.limit, 4, "The existing Team API projection keeps the released bound.");
    assert.ok(agentTasksEvent({ type: "agent-tasks-changed", snapshot: wire }));
    assert.equal(snapshot.tasks.length, 50);
    report.checks.push(
      "Fifty work chats are accepted, the next is refused, and the released client snapshot still decodes.",
    );

    const reverseWorker = await runCauseEffect(
      state.store.createAgent({
        name: "Reverse action worker",
        description: "Isolated retry fixture",
        avatarSeed: "reverse-worker",
        avatarHue: null,
      }),
    );
    let automaticDecisions = 0;
    const reverseDispatch = new ServerWorkDispatch({
      tasks: state.tasks,
      mailbox: state.mailbox,
      policy: () => policy,
      visibleAgents: () => state.store.list(),
      sharingScope: () => sharedScope,
      queued: () => queued++,
      routing: new ServerWorkRouting({
        tasks: state.tasks,
        sharingScope: () => sharedScope,
        decide: () => {
          automaticDecisions++;
          return Effect.succeed({ kind: "new", title: "Reverse action fixture" });
        },
      }),
    });
    const sourceKey = toolCallIdempotencyKey({
      threadId: "reverse-source-provider-thread",
      turnId: "reverse-thread-source-turn",
      callId: "thread-to-queue",
    });
    const automaticInput = {
      senderAgentId: sender.id,
      recipientAgentId: reverseWorker.id,
      text: "One request before a Thread-to-Queue mode change.",
      requestId: sourceKey,
      sourceTurnId: "reverse-thread-source-turn",
      sourceIdempotencyKey: sourceKey,
      senderTaskId: source.taskId,
    };
    const automatic = await runCauseEffect(reverseDispatch.dispatchAutomatic(automaticInput));
    assert.ok(automatic.work);
    const automaticDeliveryId = automatic.receipt.deliveries[0]?.id;
    assert.ok(automaticDeliveryId);
    const normalRetry = await runCauseEffect(
      state.mailbox.enqueue({
        sender: { kind: "agent", agentId: sender.id },
        recipientAgentIds: [reverseWorker.id],
        text: automaticInput.text,
        senderTaskId: source.taskId,
        idempotencyKey: sourceKey,
      }),
    );
    assert.equal(normalRetry.messageId, automatic.receipt.messageId);
    assert.equal(normalRetry.deliveries[0]?.id, automaticDeliveryId);
    assert.equal(state.mailbox.taskIdForDelivery(automaticDeliveryId), automatic.work.taskId);
    assert.equal(state.tasks.openTaskIds(reverseWorker.id).length, 1);
    assert.equal(automaticDecisions, 1);
    report.checks.push(
      "Thread-to-Queue retry uses the original source tool key and keeps one task, message and delivery.",
    );

    const queueKey = toolCallIdempotencyKey({
      threadId: "reverse-source-provider-thread",
      turnId: "reverse-queue-source-turn",
      callId: "queue-to-thread",
    });
    const ordinary = await runCauseEffect(
      state.mailbox.enqueue({
        sender: { kind: "agent", agentId: sender.id },
        recipientAgentIds: [reverseWorker.id],
        text: "One main request before a Queue-to-Thread mode change.",
        senderTaskId: source.taskId,
        idempotencyKey: queueKey,
      }),
    );
    const priorMainRetry = await runCauseEffect(
      reverseDispatch.dispatchAutomatic({
        senderAgentId: sender.id,
        recipientAgentId: reverseWorker.id,
        text: "Retry of the same original main request.",
        requestId: queueKey,
        sourceTurnId: "reverse-queue-source-turn",
        sourceIdempotencyKey: queueKey,
        senderTaskId: source.taskId,
      }),
    );
    assert.equal(priorMainRetry.work, null);
    assert.equal(priorMainRetry.receipt.messageId, ordinary.messageId);
    assert.equal(priorMainRetry.receipt.deliveries[0]?.id, ordinary.deliveries[0]?.id);
    assert.equal(state.mailbox.taskIdForDelivery(ordinary.deliveries[0]?.id ?? ""), null);
    assert.equal(state.tasks.openTaskIds(reverseWorker.id).length, 1);
    assert.equal(automaticDecisions, 1, "An existing main receipt bypasses the injected decider.");
    report.checks.push(
      "Queue-to-Thread retry returns the original main receipt without a new decision, task or replay.",
    );

    for (const delivery of state.mailbox.taskQueue(reverseWorker.id, automatic.work.taskId)) {
      await runCauseEffect(state.mailbox.cancel(reverseWorker.id, delivery.id));
    }
    state.tasks.close(state.tasks.require(reverseWorker.id, automatic.work.taskId));
    const closedAt = state.tasks.require(reverseWorker.id, automatic.work.taskId).closedAt;
    assert.ok(closedAt);
    const savedClosedReceipt = state.mailbox.receiptForKey(sourceKey);
    assert.ok(savedClosedReceipt);
    const closedRetry = await runCauseEffect(reverseDispatch.dispatchAutomatic(automaticInput));
    assert.deepEqual(closedRetry.receipt, savedClosedReceipt);
    assert.equal(state.tasks.require(reverseWorker.id, automatic.work.taskId).closedAt, closedAt);
    assert.equal(state.tasks.openTaskIds(reverseWorker.id).length, 0);
    assert.equal(automaticDecisions, 1, "A closed work retry never invokes the injected decider or reopens the chat.");
    report.checks.push(
      "An automatic retry after normal cancellation and archive returns its saved receipt without reopening or deciding again.",
    );

    policy = null;
    await assert.rejects(send("disabled", "request-disabled"));
    assert.ok(queued >= 50);
    report.checks.push("Disabled policy refuses custom dispatch.");
    report.passed = true;
  } finally {
    state.conversation.dispose();
    state.database.close();
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
  const build = await Bun.build({
    entrypoints: [import.meta.filename],
    target: "node",
    format: "esm",
    outdir: output,
    naming: "fixture.mjs",
  });
  assert.ok(build.success, String(build.logs));
  const child = spawnSync("node", [join(output, "fixture.mjs"), "--fixture"], {
    cwd: projectRoot,
    env: { ...process.env, OPENBOT_WORK_DISPATCH_ROOT: projectRoot },
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000,
  });
  process.stdout.write(child.stdout);
  process.stderr.write(child.stderr);
  assert.ifError(child.error);
  assert.equal(child.status, 0, "Server work dispatch fixture failed.");
}
