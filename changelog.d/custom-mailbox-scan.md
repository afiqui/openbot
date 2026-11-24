### Fixed

- The main chat no longer walks every stored mailbox message on each queue change. It reads only until the newest 100 completed messages, plus any active ones. This removes the minute-by-minute freezes on large mailboxes.
- Message search needs at least 3 characters, so a 1 or 2 letter query no longer scans every message and freezes the window.
- A finished routine delivery is no longer looked up in the database again on every queue change once its run matches it.
