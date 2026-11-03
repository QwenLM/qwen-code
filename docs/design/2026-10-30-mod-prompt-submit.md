# Mod prompt submission

[English](2026-10-30-mod-prompt-submit.md) | [简体中文](2026-10-30-mod-prompt-submit.zh-CN.md)

Status: proposed. This stage follows the turn events in #15443 and is tracked in #13749. It follows the Claude Code 2.1.310 plugin API declarations of `prompt.submit` and `$.prompt.submit`.

## Problem and current behavior

Mods written for Claude Code act on the prompts a person sends:

- A guard drops a prompt that holds a credential, with `{ drop: reason }`.
- A Mod rewrites a prompt, for example to expand a shorthand, with `next({ ...e, text })`.
- A Mod attaches context the model reads beside the prompt and the person never sees, with `next({ ...e, context: [...] })`.
- A Mod sends a prompt of its own once the session is idle, with `$.prompt.submit`.

Qwen Code skips `prompt.submit` hooks at load and reports `Hooks for unsupported events will not run: prompt.submit`. A guard written there silently does not run.

## Goals and non-goals

Goals, in four pull requests:

1. Core and headless runs: the event, its rules and its context. This document lands with it.
2. The Ink terminal.
3. The OpenTUI terminal.
4. `$.prompt.submit`.

Non-goals:

- Slash commands, which Claude Code raises with `command`. They come with a later step on command rows.
- Prompts the person did not type: background notifications, scheduled prompts, teammate messages, goal continuations and the continuation of an interrupted turn. Claude Code marks some of these with `isMeta`.
- Prompts typed while a turn runs that steer it at a model boundary.
- `attachments` and `$.prompt.media`.

## Proposed changes

### 1. When it fires

`prompt.submit` fires for each prompt a person submits, after the host has its text and before anything reads it: before UserPromptSubmit, before `@` references are read and before the user message is recorded or shown. Only a host that raises the event loads its hooks; any other host skips them at startup with the usual line, so a guard is never silently bypassed. Step 1 raises it in headless runs, for the `-p` prompt and each stream-json user message. Step 2 raises it in the Ink terminal, as described in section 7.

### 2. Input

| Field     | Value                                                                                          |
| --------- | ---------------------------------------------------------------------------------------------- |
| `text`    | the prompt as submitted, with pasted text expanded; for a stream-json message, its text blocks |
| `context` | absent as the host raises it                                                                   |
| `wait`    | `false`                                                                                        |
| `origin`  | `{ kind: 'sdk' }` in headless runs; `{ kind: 'composer' }` in the terminals                    |
| `turnId`  | absent until a terminal raises the event for a prompt typed during a turn                      |

A hook passes `text` and `context` on to `next`; `origin`, `wait` and `turnId` are pinned. `context` is a list of texts.

### 3. What enters

The prompt that enters is the one that arrives beneath the hooks, as in Claude Code: the worker records the `text` and `context` that reach the bottom of the chain. `next(e)` resolves to them with the origin. What a hook answers after its `next` resolved changes nothing, and only a drop there is checked.

The chain settles one of three ways:

- the prompt arrived beneath the hooks: it enters with its text and context;
- a hook answered `{ drop: reason }`: the prompt is dropped by a hook;
- the chain settled without reaching the bottom, because a hook answered `{ text }` without `next`: the prompt is not submitted, as Claude Code's `a hook answered without passing the prompt on`.

A hook that answers a drop after calling `next` fails, as in Claude Code: its `.catch` is asked, or it is skipped and its last `next` stands. A hook that fails or times out is skipped, and a failed worker lets the prompt through unchanged, so a broken plugin never blocks a prompt.

### 4. Rewrite and context

A rewritten text replaces the prompt everywhere the host keeps it: the text sent to the model, the text `@` processing reads, the `turn.start` text, the transcript record and its display text. A stream-json message that also has blocks other than text reaches the model as text with those blocks serialized; the hooks hear only its text blocks, and a rewrite replaces them, with the other blocks after it, in the model's text and in the transcript alike, as without a rewrite.

The context joins UserPromptSubmit's `additionalContext` in the hidden block core already appends after the prompt, ahead of it, escaped the same way. The client takes it as a new send option, `promptContext`, which only the prompt's own UserQuery spends. The transcript records the block as hook context, so resume hides it and compaction keeps it the way it keeps UserPromptSubmit's.

### 5. Drop

A drop stops the prompt before UserPromptSubmit and before any model request, and starts no turn. The reason is one line, kept to its first 4,096 characters with an ellipsis after, as Claude Code keeps it. Headless runs end with the error result `Prompt dropped by a hook: <reason>`, or `Prompt not submitted: a hook answered without passing the prompt on`, and exit code 1. A stream-json session goes on to its next message.

### 6. Limits

A prompt longer than half a Mod payload (128 KiB as JSON) reaches no hook, and the line `prompt.submit hook skipped: the prompt is too long for a Mod payload` appears where transcript logs do. Claude Code passes it whole. A rewrite or context that makes a hook's answer larger than a Mod payload fails that hook.

### 7. The Ink terminal

The Ink terminal raises the event in `prepareQueryForLlm`, for a prompt the person typed, before the input history records it, before its row is added and before `@` references are read. It loads the hooks only once it raises the event: `InteractiveModSession.initialize` takes `{ prompts: true }`, and the terminal host passes it on to the load request.

- **Which prompts.** A typed prompt, including one queued while a turn runs, which raises the event when it is sent. Slash commands, shell-mode commands, scheduled prompts, notifications, teammate messages and retries raise none.
- **Queued prompts wait for the turn to end.** The terminal normally sends a prompt typed during a turn into that turn at the next tool boundary. While a Mod hooks `prompt.submit`, that boundary takes none, so each queued prompt is sent, and heard, once the turn ends.
- **What the hooks hear.** The text the person typed, with pasted text expanded. Attachment references and the one-shot notices the terminal puts ahead of a prompt for the model alone, such as a resumed worktree, are not part of it.
- **A rewrite.** It replaces the typed text in the model's prompt, with the attachment references and notices still ahead of it, and in the prompt's row, the input history, the cancel restore, the workflow keywords and `turn.start`. The terminal finds the typed text at the end of the model's prompt by framing its pastes as the composer did. A paste the rewrite keeps whole is collapsed and framed again. An answer that differs from the prompt only in surrounding whitespace is no rewrite.
- **A drop.** The reason is shown as an error line. The prompt gets no row and is not written to the input history. It goes back to the input box with its pastes collapsed, ahead of anything typed since, so the person can edit it and send it again.
- **Esc while the hooks run.** It cancels the prompt, which goes back to the input box the same way.

## Design decisions

- **The host raises the event.** Each host already holds the submitted text before it expands or records it. Raising the event there keeps the rewrite ahead of every use of the text without changing core's send.
- **UserPromptSubmit runs after the Mod hooks, in core.** Claude Code runs both in one admission and lets a settings hook's block beneath turn `next(e)` into `{ drop }`. Here the bottom of the chain does not wait for UserPromptSubmit, which runs later in the send and can take as long as its commands. A Mod that must know whether UserPromptSubmit blocked a prompt can read `turn.start`, which only an admitted prompt raises.
- **Hosts opt in.** The load request says whether the host raises `prompt.submit`, as it names the sites it draws for `ui.render`, so each step enables only the host it adds.
- **The context shares the hook context block.** It reaches the model, the transcript and resume the way UserPromptSubmit's context does, so no new record kind is needed. A context the conversation already holds word for word is not sent again, as for UserPromptSubmit. Each Mod context and UserPromptSubmit's count on their own, so a Mod context that changes every turn does not make an unchanged UserPromptSubmit context repeat.

- **A dropped prompt is kept out of the input history.** The input history is written to disk and comes back in later sessions, and a guard usually drops a prompt for what it holds, such as a credential. Keeping it out of that history keeps the guard's purpose. Handing it back to the input box still lets the person fix it without retyping; whatever was typed since stays after it.
- **Steering waits while prompt hooks are loaded.** Steering appends queued text to the tool results of a running turn and has no prompt of its own to hold back or rewrite. Holding queued prompts until the turn ends lets every prompt the person types pass the hooks, at the cost of mid-turn steering for sessions with such a hook.
- **The hooks hear the typed text, not the model-only notices.** The person wrote the typed text; the notices belong to the terminal and change from session to session. A rewrite replaces only what the person typed, so a guard cannot drop the terminal's notices by accident.

## Differences from Claude Code

These go into the user guide:

- Until step 3, the OpenTUI terminal raises no `prompt.submit`.
- Slash commands and prompts the person did not type raise none, so `command` and `isMeta` never appear.
- `attachments` never appears, and `$.prompt.media` does not exist.
- A UserPromptSubmit block does not turn `next(e)` into `{ drop }`, and `next(e)` resolves before the turn starts.
- A context the conversation already holds word for word is not sent again, each Mod context and UserPromptSubmit's on its own.
- A prompt longer than 128 KiB as JSON reaches no hook.
- A headless drop is an error result with exit code 1.

## Validation and acceptance

- Real QuickJS worker tests:
  - which plugins hear the event, and a host that raises none skipping its hooks;
  - the prompt and context that arrive beneath the hooks, and an answer after `next` that changes nothing;
  - a hook's drop, and a hook that answers without `next`;
  - a downstream drop's reason survives a post-next text answer across plugins, within one plugin, and during recovery; a caught late drop does not replace a later local continuation's outcome or mark a host continuation as called;
  - a drop after `next`, a changed `origin` or `wait`, a context that is not a list, a wrong answer and a throw, each skipped;
  - a `.catch` that drops for a failed guard.
- Mod session tests: no hooks, the origin, a rewrite with context, a drop's one line and its 4,096 characters, a failed worker, a cancelled prompt, and a prompt too long for a payload.
- Client test: the Mods' context ahead of UserPromptSubmit's, escaped, with and without UserPromptSubmit hooks, and only for a new prompt.
- Headless tests: the rewritten prompt and its context reaching the send and `turn.start`, a drop in JSON and text, and no event for a slash command or a notification.
- The built CLI against a fixture server in headless JSON, text and stream-json: a rewrite that the model request and the transcript both hold, context in the hidden block, a drop, and a guard whose `.catch` drops.

## Risks and open questions

- A slow hook delays the prompt by up to its budget, 10 seconds a hook.
- Masking a slash command's arguments needs `command.run` today; `prompt.submit` with `command` comes later.
