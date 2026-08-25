# Non-blocking Slash Commands During Streaming

## Problem

The interactive input router currently queues every slash command except
`/btw` while a model response is streaming. This makes local UI controls wait
for the active conversation turn even when their result does not depend on that
turn.

## Design

`SlashCommand` gains an opt-in `canRunDuringStreaming` capability. The default
remains false. While the main model is responding, the input router resolves the
submitted command through the existing slash-command tree. An opted-in command
is sent directly to the slash-command processor; all other slash commands keep
using the existing serialized message queue.

The direct path does not go through `submitQuery`. That function owns the model
turn lifecycle and deliberately rejects concurrent top-level turns. Keeping
local commands outside it avoids sharing abort controllers, submission flags,
or model-stream counters with the active response.

The slash-command processor and command results already update Ink through
React state. The initial commands therefore do not write directly to terminal
stdout while Ink is rendering.

## Initial Command Set

- `/status`, `/about`, and `/status paths`: read local runtime information and
  append an Ink history item.
- `/settings`: opens the settings dialog; saved changes apply through the
  existing settings hooks without replacing the active conversation turn.
- `/help`: opens the static help dialog.

## Extended Command Set

The same criteria were later applied to eleven more builtins:

- UI-preference commands whose saved changes apply through the existing
  settings hooks without touching the active turn: `/theme`, `/editor`,
  `/vim`, `/voice`, and `/terminal-setup` (writes only external IDE
  keybinding files).
- Read-only status commands that neither read state the active turn is
  writing nor mutate anything: `/tools`, `/lsp`, `/tasks`, `/hooks`
  (read-only browse dialog), `/docs`, and `/bug` (the latter two only
  append an Ink item and open a browser).

The following categories remain serialized:

- Commands that submit or transform a model turn, such as skills, `/summary`,
  `/compress`, `/model <model> <prompt>`, and `/goal`.
- Commands that replace, clear, rewind, resume, branch, or otherwise mutate
  conversation state.
- Commands that schedule tools or perform long-running external work.
- Commands that read state being mutated by the active turn, such as
  `/context`, `/stats`, `/copy`, `/diff`, and `/recap`.

`/btw` keeps its specialized concurrent model-request path. `/quit` keeps its
existing immediate cancellation path. Ctrl+Q continues to force any submission
to wait for idle, including an otherwise opted-in command.

## Verification

Unit coverage verifies that opted-in commands bypass both `submitQuery` and the
message queue during a response, while unmarked slash commands remain queued.
Command tests pin the initial capability declarations. Interactive E2E checks
should start a visibly streaming response, open each opted-in command, close any
dialog, and confirm that the original response continues and completes.
