# Web Shell workspace history and session drafts

## Problem

The prompt history currently uses one browser storage key for every workspace.
Its navigation cursor also survives session changes when the editor component
is reused. Unsent editor text is not persisted, so it is lost when a session is
left or the editor remounts.

Queued prompts already enter history through the composer's accepted-submit
commit callback on current `main`. Adding another write in the queue layer
would duplicate that behavior.

## Design

- Derive the prompt-history storage key from the effective workspace cwd.
  Reload the in-memory history and reset navigation whenever that key changes.
  If a workspace has no scoped history yet, read the legacy unscoped history
  and migrate it into the workspace key on the next accepted prompt.
- Pass the active session id and effective workspace cwd through `ChatEditor`.
- Reset prompt and shell history navigation whenever the session or workspace
  changes.
- Persist plain editor text under a session-specific browser storage key. On
  the New Task page, where no session exists yet, use a workspace-specific
  pending-task key instead. Keep the draft in memory until the workspace is
  known so an unscoped key cannot leak text between workspaces. Restore that text
  when its session or New Task workspace returns. Debounce writes by two
  seconds, updating only a deadline on the input path and reading the editor
  when the timer expires. Flush pending text before switching identity,
  unmounting, or leaving the page. Remove the source draft after an accepted
  submission only when the composer still contains the submitted snapshot.
- Keep the existing accepted-submit callback as the only history commit point,
  including the first prompt that lazily creates a session, with regression
  coverage for delayed acceptance. A callback that completes after the user
  switches sessions writes only to its source history and never clears the
  newly active composer.

Composer tags, images, and other transient editor UI state are not persisted by
this change.
