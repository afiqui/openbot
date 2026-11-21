# Queue, Steer and Thread

Custom build `server-work-071-v4` adds a local host selector in **Server Settings > Agents > Messages
while working**. The setting page has Queue, Steer and
Thread choices. Each local agent's Advanced panel has Default, Queue, Steer and Thread and uses
the same saved custom preference. Existing remote/mobile apps keep their released Queue/Steer fields.

Queue waits in the addressed conversation. Steer joins that conversation's running provider turn
when supported. Thread asks Jev through Experiential Labs where a new request belongs before it enters the main
chat's queue. An actionable new job, lookup or report creates a managed work chat even when it shares the
main chat's project; related work joins an existing permitted
chat. A user request can also join an existing ordinary work chat of that agent. Messages in one
work chat remain ordered.

## Set up Jev

Save `EXPERIENTIAL_API_KEY` in the existing OpenBot Vault, accessible to the receiving agents, or set
that environment variable for the server before starting it. The key stays on the server. Jev uses
the official `https://api.experientiallabs.ai/v1/systemone` API and the `jev-latest` model alias. It is a
separate decision request before the agent's normal provider starts the work.

The host sends the incoming message, permitted work titles and a bounded main-chat subject after
masking known secrets. It sends no work transcript or local task ID. The response chooses from
host-generated aliases. The host validates ownership, visibility, scope and current task state.
This choice routes a request; it grants no approval and does not change the request's constraints.
See [Experiential Labs Jev](https://platform.experientiallabs.ai/models/jev-latest) and the
[TypeSafe Choice documentation](https://docs.typesafe.ai/primitives/choice).

Confidence below 0.8 keeps the request in main. That is this build's policy, not a TypeSafe
accuracy guarantee. Missing credentials, a five-second HTTP deadline, invalid output or a service
error also keeps an incoming request in main. The original text and attachments remain intact.
There is no automatic retry. Queue and Steer make no Jev request. The host keeps the last 200
decision observations in `custom-thread-routing-status-v1.json`. The file contains only agent IDs,
fixed outcome/reason codes, elapsed time, candidate count, HTTP status and timestamps. It stores
no prompts, work titles, task IDs, credentials or provider response bodies.

## Context and compatibility

Explicit task destinations and replies keep their routes. Approval answers, routines, channel and
external-conversation routes do not pass through automatic classification. New single-recipient
teammate requests use the same planner, including a new request sent back to an agent whose older
main request is still in the sender's turn. Explicit replies, inferred side-chat follow-ups and
external conversation replies retain their original routes. Multicast keeps the existing grouped-reply behavior.
The original sender, attachments, delivery receipt and source-turn reply route are retained.
Retries with the same client message or work-request ID do not make another task or decision.

The main chat shows a send confirmation derived from the task mailbox record. It never stores a
second runnable message or a main history row. Deleting the confirmation hides it and retains the
work and its files. Returning to the official build leaves task data intact.

Existing task-capable remote and mobile clients can send requests and display the resulting work
chats without an update. A historical client without task support retains the main-chat path.
The visible third choice belongs to this custom host's local settings. No frozen Team API enum or
wire adapter gains a third value.

## Limits and storage

Thread is opt-in. A missing `custom-message-routing-v1.json` follows the saved official modes.
The old `custom-server-work-v1.json` does not enable Thread. Changing the mode preserves the saved
official host and agent concurrency settings. The current host's 128/64 values are not custom
defaults. Provider, sign-in, usage and memory limits still apply. The existing 50-open-task client
bound remains; a configured concurrency ceiling does not create extra task slots.

For an offline example, stop the custom host and save this in its user-data directory:

```json
{
  "version": 1,
  "mode": "thread",
  "agents": {
    "agent-example": "queue",
    "agent-other": null
  }
}
```

A null host mode follows the saved official default. A null agent choice follows the host.
Local UI changes apply without a restart. Existing Queue/Steer editors can replace a custom choice.
No database migration is added. Work-chat identities remain in the existing SQLite thread store.
Selecting Thread affects new messages; it does not redistribute the old queue or remove open waits.
Selected existing requests can still be moved with the explicit backlog tools.

## Background work

Each Claude work chat already runs its model and tools in a separate CLI process. The server still
coordinates approvals, queue state and database writes on its main thread. Concurrent chat limits
do not make that coordination run on more cores.

This build indexes mailbox reads so each queue update avoids repeated scans of retained history.
Internal conversation state reads the latest working messages without counting unloaded history;
public pages retain their history totals, references and cursors. Routine-flow and result discovery
each use an owned read-only utility process. They return bounded pages of run IDs. Main checks the
current run, destination, links and steps before any write or handoff. Discovery has start/query deadlines and cancellation;
it does not retry a failed request. Main does not fall back to synchronous discovery on failure.

Claude transcript parsing, hashing and disposable history-index work use four lazy background
processes. Reads of the same normalized index use the same lane; different indexes can run in
parallel. The worker sends one bounded fragment and waits for main to commit it before continuing.
It advances a resume cursor only after the consumer acknowledges all fragments. Cancellation or
worker failure interrupts the consumer and stops that worker. A replacement waits for its exit.
Tools, approvals and writes to canonical `openbot.db` stay on main. Prepared routine lookups reuse
compiled SQL but read current rows on each call, including changes inside a transaction.

Jev diagnostic recording does not wait for disk. One scoped writer retains the latest 200 events,
coalesces writes, and flushes after the agent service stops. A slow diagnostic write cannot hold a
routing decision until its deadline. No request text or secret is added to the diagnostic file.

The focused checks are `test:mailbox-read-index`, `test:conversation-working-window`,
`test:routine-run-read`, `test:claude-history-host`, `test:routine-flow-discovery` and
`test:routine-flow-sweep`. Synthetic lookup timings do not measure
live model throughput. Main still owns state changes; it is not a pool of database writers.

## Verification

Run focused checks serially: `test:server-work-routing`, `test:jev-work-router`,
`test:server-work-service` and `test:server-work-dispatch`. The Jev HTTP E2E uses an isolated local
server. The service E2E uses the real scheduler and a fake provider process. These checks do not
measure a 50-model workload or prove live Jev classification quality. See the before/after
`Settings/Custom Message Routing` stories for the local selector.
