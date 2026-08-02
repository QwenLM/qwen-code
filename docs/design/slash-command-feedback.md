# Slash command history feedback

## Problem

Interactive slash commands are added to the TUI history before their action is
known. Commands that only open a dialog can therefore leave a bare invocation
behind after the dialog closes. The model picker has the same problem when it
is dismissed without a selection.

## Design

- Do not add the built-in `/auth`, `/settings`, `/status`, `/help`, `/theme`,
  `/editor`, or `/diff` invocations to visible TUI history. Bare `/effort`,
  `/statusline`, and `/stats` pickers are hidden too. Their existing UI remains
  unchanged, as do chat recording and slash-command telemetry. User and project
  commands that override those names keep their invocation history.
- Resolve the command before adding its invocation so aliases use the canonical
  command name for this decision.
- Preserve invocations for commands that directly perform work, change session
  state, write data, or enter a management/security workflow. Argument-sensitive
  commands only hide their bare picker form; for example, `/effort` is hidden
  while `/effort high` remains visible.
- When the primary model picker is dismissed without a selection, add an info
  message identifying the unchanged model. Successful selections keep their
  existing feedback.
