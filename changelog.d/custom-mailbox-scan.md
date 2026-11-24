### Fixed

- The main chat no longer walks every stored mailbox message on each queue change. It reads only until the newest 100 completed messages, plus any active ones. This removes the minute-by-minute freezes on large mailboxes.
- Message search needs at least 3 characters, so a 1 or 2 letter query no longer scans every message and freezes the window.
- A finished routine delivery is no longer looked up in the database again on every queue change once its run matches it.
- Deleting task, shown, channel or agent messages no longer deep-copies the whole mailbox as a rollback point. With a large mailbox those copies used gigabytes and crashed the app (V8 heap out of memory). The rollback keeps the same top-level lists instead.
- An uncaught error in the main process is logged and no longer opens Electron's modal error box. On an always-on host that box blocked the main thread until someone clicked OK (7 hours on 2026-11-24).
