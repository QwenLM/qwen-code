# Slash command history feedback

## Problem

Interactive slash commands are added to the TUI history before their action is
known. Commands that only open a dialog can therefore leave a bare invocation
behind after the dialog closes. The model picker has the same problem when it
is dismissed without a selection.

## Design

- Do not add the built-in `/auth`, `/settings`, `/status`, `/help`, `/theme`,
  `/editor`, `/diff`, or `/stats` invocations to visible TUI history. Bare
  `/effort`, `/model`, and `/statusline` pickers are hidden too. Their existing
  UI remains unchanged, as do chat recording and slash-command telemetry. User
  and project commands that override those names keep their invocation
  history.
- Root matches apply to the bare command only; subcommands keep their
  invocation because they perform work (for example `/status paths` prints
  session paths).
- Resolve the command before adding its invocation so aliases use the canonical
  command name for this decision.
- Preserve invocations for commands that directly perform work, change session
  state, write data, or enter a management/security workflow. Argument-sensitive
  commands only hide their bare picker form; for example, `/effort` is hidden
  while `/effort high` remains visible, and `/model` is hidden while
  `/model <id>` remains visible.
- Commands that fail before opening their dialog keep the invocation paired
  with the failure message: `/theme` under `NO_COLOR` is not hidden because it
  prints feedback instead of opening the picker, and a hidden picker-shaped
  `/model` invocation is revealed when its arguments are rejected.
- Record the hiding decision in the chat record (`hiddenInvocation`) so
  `/resume`, `/branch`, and session previews reconstruct the same history the
  live session displayed instead of bringing the bare invocation row back.
- When the primary model picker is dismissed without a selection, add an info
  message identifying the unchanged model. Successful selections keep their
  existing feedback. The other pickers leave no trace when dismissed; the
  model picker states the outcome explicitly because the active model is
  session-critical and otherwise invisible in history, so a silent close would
  leave it ambiguous whether the model changed.
