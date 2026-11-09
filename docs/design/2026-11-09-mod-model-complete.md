# Mod model calls

[English](2026-11-09-mod-model-complete.md) | [简体中文](2026-11-09-mod-model-complete.zh-CN.md)

Status: proposed. This adds `$.model.complete`, the first `$.model` method, tracked in #13749. It follows the Claude Code 2.1.319 plugin API declarations.

## Problem and current behavior

A Mod cannot ask a model anything. Its hooks can read and rewrite what passes through the session, but a Mod that summarizes, classifies or translates text needs its own completion. Claude Code gives Mods `$.model.complete` for this: one text completion on the session's own client, with no tools and no history.

In Qwen Code, `$.model` is unknown. A call rejects with `Mod API not supported: $.model.complete`, and a hook on `model.complete` loads but never runs.

The driving case is a Mod that shows English replies in Chinese: it needs a completion per reply block, and later stages add the message render sites it draws through.

## Goals and non-goals

Goals:

- `$.model.complete(request, {signal})` with Claude Code's request fields and result shapes, in headless runs and both terminals.
- `model.complete` as an API event that other Mods' hooks can rewrite, answer or deny.
- A model call that does not time the calling hook or its dispatch out.

Non-goals:

- `$.model.classify` and `$.model.fork`.
- Sending the named `effort` level or `cache` marks to the provider.
- Model calls that outlive the dispatch that made them, or that run while other Mod dispatches run. Both need work that does not exist yet (timers, concurrent dispatches).
- ACP sessions, which load no Mods yet.

## Proposed changes

### 1. The request and the event

The guest's `$.model.complete(request, options)` checks `options` (only `signal`) and sends the request with a per-call token. The worker turns the request into Claude Code's `ModelCompleteInput`: a block list is joined into `prompt` or `system` and kept beside it in `promptBlocks` or `systemBlocks`. A wrong shape, `maxTokens` above 64000, an unknown `effort` or a `timeoutMs` outside 1 to 2147483647 rejects before any hook runs.

The input then passes through the `model.complete` hooks of every plugin, as other API events do. A hook may pass a rewritten input down, answer `{value: result}`, or `{deny: reason}`. A rewritten input is checked again; `system: null` or `false` sends none. At the bottom the worker asks the host to run the call.

### 2. Running the call

The worker sends `model-complete {id, input}` to the main thread and waits for `model-result {id, result | error}`. The host runs the CLI's `completeModModel`:

- Model names: `haiku` runs the configured fast model, its selector passed on as the config gives it so an endpoint it is pinned to holds, and the session's model when none is set; `sonnet` and `opus` map to `inherit`. Other names go through `resolveModelId`, and must be the session's model or a configured, text-capable model. `BaseLlmClient` would otherwise send an unknown id to the session's model.
- `maxTokens` defaults to 1024 and rejects above a curated output limit.
- `BaseLlmClient.generateText` sends the prompt as the one user message and `system` as the system instruction, with `maxAttempts: 1` and `failClosed: true`. Reasoning is off unless the request names an `effort`.
- An empty reply is `empty-reply`. A failure is `api-error` with the HTTP status and a kind from the shared `classifyApiError`, plus `overloaded` and `model_not_found`. An abort or elapsed `timeoutMs` is `aborted`.
- `usage` uses the same four-count conversion as `turn.complete`, now shared.
- A reply over half a Mod payload keeps its head and tail around a marker.

### 3. Signals and lifetime

The guest relays its `signal` by token: on abort it sends an internal `model.abort`, which no hook hears. The worker aborts that call's controller, tells the host to cancel, and resolves `aborted` at once. An already aborted signal resolves `aborted` without a request.

A call belongs to its dispatch. When the dispatch is abandoned or ends, the worker cancels the host operation, and the host aborts every call still running for that root.

### 4. Budgets

The hook's own budget already stops during `$` calls. The dispatch's 60-second limit did not stop for anything but a native tool. The worker now reports a running model call as the operation it waits on when no guest code, check or other host call is active, and the host stops the root's clock while that operation is one of its model calls, exactly as for a native tool.

## Design decisions

- The model call lives in the CLI, not core: it needs `Config`, `BaseLlmClient` and the CLI's error classifier, and the ACP host will reuse it from there.
- Unknown model ids are refused rather than passed through, because the client's silent fallback to the session model would bill and answer as another model.
- Reasoning stays off by default, as on every Qwen Code side request; a Mod that wants reasoning says so with `effort`.
- One attempt, so a Mod's call does not hold the session's single dispatch slot through a retry loop; the result carries what a Mod needs to retry.

## Differences from Claude Code

- `haiku`, `sonnet` and `opus` are read as Qwen Code's fast and session models.
- `effort` turns reasoning on but its level is not sent; Claude Code sends the level.
- `cache` marks are accepted but not sent.
- Claude Code's default reasoning is the model's own; Qwen Code's is off.
- A session runs one Mod dispatch at a time, so a running call holds up every other Mod hook in the session. Claude Code runs background work on timers; Qwen Code has none yet.

## Validation and acceptance

Core runtime tests with the real QuickJS worker:

- A request with blocks reaches the host joined, with the blocks beside it, and each result shape comes back.
- Wrong shapes, limits and a host refusal reject; a host without model calls rejects, and `$.session.version()` lists `model.complete` only where the host runs it.
- Another plugin rewrites, answers and denies `model.complete`.
- An aborted `signal` cuts a running call and skips a new one.
- The dispatch clock pauses while the host runs a call.

CLI unit tests for `completeModModel`: alias and id resolution, the request sent, the output-limit refusal, and the empty, API-error and timeout results.

Acceptance: a Mod command that calls `$.model.complete({model: 'haiku', prompt})` prints the fast model's answer in a headless run and in both terminals.

## Risks and open questions

- While a call runs, other Mods' `tool.call` hooks wait. Concurrent dispatches are a separate stage.
- Translation Mods will call the model once per message block; cost is visible only in `usage`.
- Whether `effort` should build a dedicated generator view, as subagents do, to send the level.
