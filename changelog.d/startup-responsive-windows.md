### Changed

- Show a local loading window while OpenBot prepares the workspace. Database migrations and
  integrity checks run in a separate process, so a large database does not block the main window's
  event loop during those checks. The checks and stored data stay unchanged.
- Reuse an index for repeated mailbox turn lookups until message keys change, which reduces repeated
  history scans without removing messages or changing their turns.
- Compare normalized values at mailbox startup without serializing every message twice. Required
  repairs still persist. A local startup timing report separates database preparation, loading
  feedback and workspace readiness.
