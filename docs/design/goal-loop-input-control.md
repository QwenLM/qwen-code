# Goal loop input control

## Problem

An active `/goal` is implemented as a blocking Stop hook. While the model is
running, the interactive queue normally defers slash commands until the stream
becomes idle. A goal loop may never reach that idle boundary, so `/goal clear`
and replacement `/goal` commands cannot take effect.

The Stop response can also aggregate the goal hook with unrelated configured
hooks. Clearing a goal must not discard a blocking decision owned by another
hook.

## Design

During an active turn, the message queue drains `/goal` commands alongside
plain-text steering messages. Other slash commands remain queued for normal
idle processing.

The CLI executes drained goal commands through the existing slash-command
processor:

- Clear commands apply their side effect without producing model input.
- Replacement commands replace the pending goal instruction.
- When multiple goal commands are drained together, only the instruction for
  the final active goal is sent.
- The surviving instruction keeps its position relative to plain-text steering
  messages.
- Executed goal commands are not restored if later steering preparation is
  cancelled; unexecuted plain-text messages are restored.

Core samples the queue before Stop hooks and again after a blocking Stop hook
returns. A blocking goal output carries its goal hook ID and keeps its
continuation reason separate from ordinary hook reasons. The hook bridge also
reports whether another Stop output is blocking. If the goal changes at the
second boundary, core removes only the old goal continuation; it still follows
an independent blocking reason. Non-blocking hook outputs do not force an extra
goal iteration.

## Verification

- Queue tests cover active-turn goal draining and idle-boundary deferral.
- CLI stream tests cover clear, replacement, batched commands, ordering, and
  restore behavior.
- Core tests cover clear and replacement during Stop-hook evaluation, including
  an aggregated independent blocker.
- A local tmux session exercises clear and replacement against the built
  interactive CLI.
