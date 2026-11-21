# Custom server work settings

**Archived v1/v2 behavior.** For the current opt-in Queue/Steer/Thread selector and official
concurrency settings, use [custom message routing](custom-message-routing.md). The older automatic
enablement and limit overrides below do not describe build `server-work-071-v3`.

The custom host reads `custom-server-work-v1.json` from its user-data directory before queue recovery.
Remote desktop clients, mobile apps and released wire contracts do not change.
The file stays with the server profile, outside source control. It is not part of an agent export.

The custom default is enabled, with 50 concurrent side-thread turns per agent, up to 50 unfinished
agent-created tasks, and 64 total active turns across the host. Each conversation still runs one turn
at a time. Provider restrictions, low memory, sign-in and usage limits can hold new work. A provider
that supports one turn at a time still runs one turn.

## Configure through existing clients

Server Settings > General controls the global task limit and total host limit in the enabled custom
policy. The existing host-setting routes read and write the effective values; no client update is
required. A saved per-agent default of 64 now sets this policy to 64 instead of
changing an unused upstream preference. New turns read each change, so a higher limit can release
waiting work. Running turns are not cancelled when a limit is reduced.

The host's Automatic total keeps the automatic memory-based limit. Unlimited removes the numeric
total limit; memory and provider restrictions still apply. The default per-agent choice resets the
global task limit to the built-in value of 4. Custom per-agent overrides, dispatch mode and unfinished
work admission remain in the local policy file. A per-agent override takes precedence over the global
task limit shown in Server Settings.

## Configure an offline custom profile

Stop the custom server before writing the file. Pass its **user-data directory**, not its workspace.
When the custom package replaces the installed host, this is the usual `%APPDATA%\OpenBot` profile.
Tests must use an isolated profile. The command prints a preview unless `--write` is present:

```powershell
bun scripts/configure-server-work.ts --profile=C:\custom-openbot\user-data --max-concurrent=50 --max-unfinished=50 --total-turns=64
bun scripts/configure-server-work.ts --profile=C:\custom-openbot\user-data --max-concurrent=50 --max-unfinished=50 --total-turns=64 --write
bun scripts/configure-server-work.ts --profile=C:\custom-openbot\user-data --agent=agent-example --max-concurrent=1 --max-unfinished=10 --write
bun scripts/configure-server-work.ts --profile=C:\custom-openbot\user-data --total-turns=automatic --write
bun scripts/configure-server-work.ts --profile=C:\custom-openbot\user-data --max-concurrent=64 --total-turns=unlimited --write
```

Restart the custom host to apply a change. `--enabled=false --write` disables the custom policy and
restores upstream settings. `--dispatch=main` restores main-chat dispatch for new independent
requests; `--dispatch=new-thread` selects side-thread dispatch. Follow-up messages keep their related
conversation. A per-agent override can set either task limit and dispatch mode. Unset fields inherit
the host values. An enabled custom policy takes precedence over the released per-agent 1-to-4 limit.

```json
{
  "version": 1,
  "enabled": true,
  "maxConcurrentTasks": 50,
  "maxUnfinishedTasks": 50,
  "totalTurnLimit": 64,
  "dispatchMode": "new-thread",
  "agents": {
    "agent-example": { "maxConcurrentTasks": 1, "maxUnfinishedTasks": 10 }
  }
}
```

Concurrent-task limits must be whole numbers from 1 to 64. Unfinished-task admission stays between 1
and 50. The separate total host limit is 1 to 128, `null` for Automatic, or `"unlimited"`. The
main chat and other agents also use host slots. Set the total to allow room for them. Lowering a limit
does not cancel running work; it holds later turns until enough slots are free.

The upstream limit of 50 open side threads remains. Idle, routine and unfinished threads can occupy
these places. Finished managed work is archived for room when needed. A full active list refuses new
work with a capacity error. Busy work can take ordered follow-ups; idle work must pass unfinished-work
admission again. A limit of 50 is a configured maximum, not a measured workload guarantee.
The 50-open-thread bound also remains when the configured concurrent limit is 64; that value does
not create 64 open side chats. The main chat and separate channel work have their own lanes.

## Dispatch and find work

The server routes an independent single-recipient `send_message` request to an ordinary side chat.
Replies and information keep their existing return path. Multicast messages keep the released main
queue and grouped-result behavior. Use separate `dispatch_work` calls for independent side-chat work
on several agents.

An agent can call these provider tools, with no client update:

```json
{"name":"openbot.dispatch_work","arguments":{"recipientAgentId":"agent-example","workKey":"customer-123","requestId":"customer-123-first","text":"Review the customer request."}}
{"name":"openbot.find_work","arguments":{"recipientAgentId":"agent-example","workKey":"customer-123"}}
{"name":"openbot.dispatch_work","arguments":{"recipientAgentId":"agent-example","taskId":"<returned taskId>","requestId":"customer-123-followup","text":"Include the new details."}}
```

Use the same request ID only for a retry of that request. A work key groups different requests in one
chat. The chat ID persists in the existing SQLite thread store; the key is hashed into its scoped ID.
No custom database migration is added. Callers in the same real sidebar section as the recipient can
find shared work metadata. Other work is scoped to its sender. Lookup returns titles and status, not
another agent's transcript. Moving agents between sections changes which shared work they can find.

An archived chat requires `reopen: true`. A deleted chat is absent: an explicit old task ID fails, and
a new keyed request can create a clean chat. No deleted transcript is restored. Requests whose chat
was deleted, archived or hidden during an attachment transfer fail before the mailbox commit.

After dispatch, finish other work and end the sending turn. Replies arrive later. Do not hold a
provider turn while waiting for child work: it uses capacity that the child may need. Threads share
the workspace. Coordinate file writes, and keep one owner of shared desktop or Blender sessions.

The existing host settings control the enabled custom policy's global limits. Disable the policy to
restore upstream settings and dispatch, or change the local file while the host is stopped.

## Existing main-queue backlog

The host also gives an agent `list_queued_work` and `dispatch_queued_work`. These read its own main
queue and move one selected independent request to a side chat. The original message, delivery ID,
sender, attachments and reply path stay in place; the request is not copied or sent a second time.
The original sender can find moved teammate work through `find_work` under the same sharing scope.

This is a selected move, not a content classifier. The agent must read the whole request and keep
approvals, clarifications and related follow-ups with their job context. Routine wakes, replies,
multicast, external conversations and continuations are not eligible. The normal client action still
accepts only user messages; the extra teammate-request path is internal to this custom host.

The open-waits panel is separate from the runnable queue. A wait marked as woken does not reserve an
execution slot and does not prove the work finished. Its marker stays until the agent closes it or
the user removes it. This build does not delete old wait records to hide a backlog.

The existing preference store uses defaults if a file is missing, has invalid JSON, or fails schema
validation. An I/O failure other than a missing file stops the load. The offline tool refuses to
replace an existing invalid file. Keep a valid `enabled: false` policy to disable this feature.

Older remote clients can display a task limit of 4 because their released snapshot is bounded at 4.
The host runs the configured number of turns. The client does not schedule these turns.
