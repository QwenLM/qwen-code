# SessionDelete hook

## Goal

Notify a user's hook after an explicitly selected session has been deleted.

## Contract

- `SessionDelete` runs after `SessionService.removeSession` or
  `removeSessions` reports that a transcript was removed.
- The hook is fire-and-forget. Its output and failure cannot undo or delay a
  completed deletion.
- The payload contains the hook runtime's normal hook fields plus
  `deleted_session_id`. The hook runtime owns the hook configuration;
  the deleted session can be inactive and has no live hook runtime.
- The interactive `/delete` flow and ACP's explicit `deleteSession` extension
  method emit the event. Cleanup, rollback, archive, close, and daemon REST
  batch deletion do not.

## Rationale

`SessionEnd` describes an active conversation lifecycle. Permanent deletion is
storage lifecycle work and can target an inactive transcript, so it needs a
separate event and identifier. Running it only after success prevents hooks
from leaving close-and-delete flows partially completed.

Daemon REST deletion has no `Config` or `HookSystem` owner in the process that
removes transcripts. Wiring that path would require an explicit workspace-hook
execution contract, rather than reconstructing a deleted session's in-memory
hooks. It is intentionally out of scope for this change.
