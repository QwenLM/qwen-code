# Immediate Automatic Update Relaunch

## Problem

Updating a global installation in place while the interactive CLI is running
removes content-hashed chunks that the old process may still import. Deferring
the install until the user exits avoids that corruption, but delays every
automatic update and reopens a session the user intentionally closed.

## Design

Reuse the existing update relaunch handoff:

1. The post-render update check discovers an installable update.
2. The UI exits with the update relaunch code after normal cleanup. If a model
   or tool turn, prompt or automatic-notification queue, slash command, or
   unsent draft is active, it waits for a safe idle boundary.
3. The supervisor rechecks and installs the update after the child is gone.
4. The stable launcher starts the updated CLI with the original options and
   resumes the exact durable session without replaying the initial prompt. For
   a session with no recorded messages, the handoff independently records
   whether the initial prompt was already consumed: an unconsumed prompt still
   runs, while an executed slash or shell command is not replayed.

The production wrapper supplies an explicit capability marker only after it
resolves a stable launcher, plus a private handoff file for the session ID.
Container and macOS sandboxes receive the same handoff. If no stable launcher
is available, or a conversation cannot be resumed because recording is
disabled or failed, keep the current manual guidance. Custom or manually
managed sandbox hosts remain manual. Windows standalone installs download in
the background but apply after exit because the running executable is locked.

## Non-goals

This does not hot-swap modules in a running process or introduce versioned
installation directories.
