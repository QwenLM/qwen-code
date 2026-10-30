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

`prompt.submit` fires for each prompt a person submits, after the host has its text and before anything reads it: before UserPromptSubmit, before `@` references are read and before the user message is recorded or shown. Only a host that raises the event loads its hooks; any other host skips them at startup with the usual line, so a guard is never silently bypassed. Step 1 raises it in headless runs, for the `-p` prompt and each stream-json user message.

### 2. Input

| Field     | Value                                                                       |
| --------- | --------------------------------------------------------------------------- |
| `text`    | the prompt as submitted, with pasted text expanded                          |
| `context` | absent as the host raises it                                                |
| `wait`    | `false`                                                                     |
| `origin`  | `{ kind: 'sdk' }` in headless runs; `{ kind: 'composer' }` in the terminals |
| `turnId`  | absent until a terminal raises the event for a prompt typed during a turn   |

A hook passes `text` and `context` on to `next`; `origin`, `wait` and `turnId` are pinned. `context` is a list of texts.

### 3. What enters

The prompt that enters is the one that arrives beneath the hooks, as in Claude Code: the worker records the `text` and `context` that reach the bottom of the chain. `next(e)` resolves to them with the origin. What a hook answers after its `next` resolved changes nothing.

The chain settles one of three ways:

- the prompt arrived beneath the hooks: it enters with its text and context;
- a hook answered `{ drop: reason }`: the prompt is dropped by a hook;
- the chain settled without reaching the bottom, because a hook answered `{ text }` without `next`: the prompt is not submitted, as Claude Code's `a hook answered without passing the prompt on`.

A hook that answers a drop after calling `next` fails, as in Claude Code: its `.catch` is asked, or it is skipped and its last `next` stands. A hook that fails or times out is skipped, and a failed worker lets the prompt through unchanged, so a broken plugin never blocks a prompt.

### 4. Rewrite and context

A rewritten text replaces the prompt everywhere the host keeps it: the text sent to the model, the text `@` processing reads, the `turn.start` text, the transcript record and its display text.

The context joins UserPromptSubmit's `additionalContext` in the hidden block core already appends after the prompt, ahead of it, escaped the same way. The client takes it as a new send option, `promptContext`, which only the prompt's own UserQuery spends. The transcript records the block as hook context, so resume hides it and compaction keeps it the way it keeps UserPromptSubmit's.

### 5. Drop

A drop stops the prompt before UserPromptSubmit and before any model request, and starts no turn. The reason is one line, kept to its first 4,096 characters with an ellipsis after, as Claude Code keeps it. Headless runs end with the error result `Prompt dropped by a hook: <reason>`, or `Prompt not submitted: a hook answered without passing the prompt on`, and exit code 1. A stream-json session goes on to its next message.

### 6. Limits

A prompt longer than half a Mod payload (128 KiB as JSON) reaches no hook, and the line `prompt.submit hook skipped: the prompt is too long for a Mod payload` appears where transcript logs do. Claude Code passes it whole. A rewrite or context that makes a hook's answer larger than a Mod payload fails that hook.

## Design decisions

- **The host raises the event.** Each host already holds the submitted text before it expands or records it. Raising the event there keeps the rewrite ahead of every use of the text without changing core's send.
- **UserPromptSubmit runs after the Mod hooks, in core.** Claude Code runs both in one admission and lets a settings hook's block beneath turn `next(e)` into `{ drop }`. Here the bottom of the chain does not wait for UserPromptSubmit, which runs later in the send and can take as long as its commands. A Mod that must know whether UserPromptSubmit blocked a prompt can read `turn.start`, which only an admitted prompt raises.
- **Hosts opt in.** The load request says whether the host raises `prompt.submit`, as it names the sites it draws for `ui.render`, so each step enables only the host it adds.
- **The context shares the hook context block.** It reaches the model, the transcript and resume the way UserPromptSubmit's context does, so no new record kind is needed. A block the conversation already holds word for word is not sent again, as for UserPromptSubmit.

## Differences from Claude Code

These go into the user guide:

- Until steps 2 and 3, only headless runs raise `prompt.submit`.
- Slash commands and prompts the person did not type raise none, so `command` and `isMeta` never appear.
- `attachments` never appears, and `$.prompt.media` does not exist.
- A UserPromptSubmit block does not turn `next(e)` into `{ drop }`, and `next(e)` resolves before the turn starts.
- A context block the conversation already holds word for word is not sent again.
- A prompt longer than 128 KiB as JSON reaches no hook.
- A headless drop is an error result with exit code 1.

## Validation and acceptance

- Real QuickJS worker tests:
  - which plugins hear the event, and a host that raises none skipping its hooks;
  - the prompt and context that arrive beneath the hooks, and an answer after `next` that changes nothing;
  - a hook's drop, and a hook that answers without `next`;
  - a downstream drop's reason survives a post-next text answer across plugins, within one plugin, and during recovery;
  - a drop after `next`, a changed `origin` or `wait`, a context that is not a list, a wrong answer and a throw, each skipped;
  - a `.catch` that drops for a failed guard.
- Mod session tests: no hooks, the origin, a rewrite with context, a drop's one line and its 4,096 characters, a failed worker, a cancelled prompt, and a prompt too long for a payload.
- Client test: the Mods' context ahead of UserPromptSubmit's, escaped, with and without UserPromptSubmit hooks, and only for a new prompt.
- Headless tests: the rewritten prompt and its context reaching the send and `turn.start`, a drop in JSON and text, and no event for a slash command or a notification.
- The built CLI against a fixture server in headless JSON, text and stream-json: a rewrite that the model request and the transcript both hold, context in the hidden block, a drop, and a guard whose `.catch` drops.

## Risks and open questions

- A slow hook delays the prompt by up to its budget, 10 seconds a hook.
- Masking a slash command's arguments needs `command.run` today; `prompt.submit` with `command` comes later.
