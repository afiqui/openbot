### Added

- Keep the existing desktop, web and mobile clients. Independent single-recipient teammate requests
  run in ordinary side chats on this custom host. Multicast messages and their grouped replies keep
  the released path.
- Add host-only configuration for up to 50 concurrent and unfinished tasks per agent, and a separate
  host total of 64 by default. The provider's serial restriction and host memory gates still apply.
- Add `dispatch_work` and `find_work` provider tools. Scoped work keys find the same persisted chat
  after restart; request IDs prevent duplicate deliveries across provider turns. Replies keep the
  requesting chat. Work metadata can be shared within a real common sidebar section.
- Keep the released 50-open-thread bound. Finished managed work can be archived for room. New work at
  a full active limit is refused with a capacity error. Archived work needs an explicit reopen;
  deletion removes the work, and a new keyed request can create a clean chat.
- Protect the custom package from installation of stock upstream updates. Source updates use the
  reviewed integration and staged package workflow in `docs/custom-server-maintenance.md`. The server
  must install this custom package for these changes. Remote and mobile apps need no update.
