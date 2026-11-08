# Channel Lifecycle Status Adapters

Date: 2026-07-01

## Goal

Expose task lifecycle state through the first four channel adapters:

- Telegram
- Weixin
- DingTalk
- Feishu

This is a P1.1 follow-up to the channel identity and lifecycle metadata work.
The goal is to make each supported channel show the best native progress signal
available without changing the shared channel contract again.

## Non-Goals

- Do not implement Slack behavior.
- Do not implement QQ Bot behavior.
- Do not update mock/plugin examples.
- Do not add terminal status emoji for DingTalk.
- Do not introduce a shared status-rendering abstraction for one round of
  adapter-specific mappings.

## References and Alignment

The design follows the current Qwen channel adapter capabilities first.
Lifecycle semantics stay aligned with the existing task/session status model
already used in this repository: a task can start, run, complete, be
cancelled, or fail. No additional external status model is introduced in this
scope because each channel already has a clear native surface for these states.

## Current State

| Channel  | Existing status surface | Current behavior                                                     |
| -------- | ----------------------- | -------------------------------------------------------------------- |
| Telegram | Typing indicator        | Starts typing on prompt start and stops on prompt end.               |
| Weixin   | Typing indicator        | Starts typing on prompt start and stops on prompt end.               |
| DingTalk | Message reaction        | Adds the eye reaction on prompt start and recalls it on prompt end.  |
| Feishu   | Streaming card          | Shows and updates a streaming card, with completion and error paths. |

## Proposed Design

Keep the implementation adapter-local. Each adapter consumes the lifecycle event
hook and maps the event into the platform's existing native status surface.

| Lifecycle event | Telegram      | Weixin        | DingTalk             | Feishu                                                                                           |
| --------------- | ------------- | ------------- | -------------------- | ------------------------------------------------------------------------------------------------ |
| `started`       | Start typing. | Start typing. | Add eye reaction.    | Show/update card as running.                                                                     |
| `text_chunk`    | Ignore.       | Ignore.       | Ignore.              | Ignore in the lifecycle hook. Content streaming stays on the existing response/card stream path. |
| `tool_call`     | Ignore.       | Ignore.       | Ignore.              | Ignore for UI.                                                                                   |
| `completed`     | Stop typing.  | Stop typing.  | Recall eye reaction. | Mark card completed.                                                                             |
| `cancelled`     | Stop typing.  | Stop typing.  | Recall eye reaction. | Mark card cancelled.                                                                             |
| `failed`        | Stop typing.  | Stop typing.  | Recall eye reaction. | Mark card failed.                                                                                |

### Telegram

Telegram keeps the existing typing implementation. The lifecycle hook should map
`started` to the existing typing start path and all terminal events to the
existing typing stop path.

`text_chunk` and `tool_call` do not need Telegram UI changes.

### Weixin

Weixin follows the same shape as Telegram. The lifecycle hook should map
`started` to `setTyping(true)` and terminal events to `setTyping(false)`.

No additional messages are sent.

### DingTalk

DingTalk keeps the existing eye reaction behavior:

- `started`: attach the existing eye reaction.
- `completed`, `cancelled`, `failed`: recall the existing eye reaction.

There is no terminal emoji in this scope. Failed and cancelled tasks should not
send extra status messages unless an existing error path already does so.

### Feishu

Feishu keeps the streaming card as the status surface and makes the terminal
state explicit in card content:

| State     | Card label       |
| --------- | ---------------- |
| Running   | `运行中...`      |
| Completed | `已完成`         |
| Cancelled | `已取消`         |
| Failed    | `已失败，请重试` |

The card still streams answer content as it does today through the existing
response/card stream hook. Lifecycle `text_chunk` is not consumed directly by
the adapter in this scope, which supersedes the earlier adapter-local idea of
using lifecycle chunks to append card content. `tool_call` remains hidden from
the card UI in this scope.

The markdown/card helper can accept a minimal status label option if needed, but
should not grow into a generic rendering framework.

## Data Flow

1. Channel execution emits lifecycle events from the base channel layer.
2. The selected adapter receives the event through its lifecycle hook.
3. The adapter maps the event to the platform status surface.
4. Platform status updates run best-effort and do not affect task execution.

The lifecycle event payload should provide enough existing context to identify
the channel message/session. If a platform-specific identifier is missing, the
adapter skips the status update.

## Error Handling

Platform status updates are non-critical. A failed typing, reaction, or card
status update should be logged or swallowed according to the adapter's existing
style and must not fail the task.

Terminal events should be idempotent for a message/session. Repeated terminal
events should not create duplicate status updates or leave a stale running
indicator.

Feishu needs special care because it already has card completion, error, and
stop-button flows. The lifecycle mapping should reuse the existing card session
state and avoid competing updates that overwrite a more specific terminal state.

## Test Plan

Add focused unit coverage in the affected channel packages:

- Telegram: lifecycle `started` starts typing; terminal events stop typing; no
  duplicate typing interval is introduced.
- Weixin: lifecycle `started` calls `setTyping(true)`; terminal events call
  `setTyping(false)`.
- DingTalk: lifecycle `started` attaches the eye reaction; terminal events
  recall it; no terminal emoji is sent.
- Feishu: running, completed, cancelled, and failed card states render the
  expected labels; lifecycle `text_chunk` remains owned by the existing stream
  path rather than the lifecycle hook; `tool_call` does not add UI output.

Verification should run package-local Vitest commands for the touched adapters,
then project build and typecheck before the PR is submitted.

## Open Decisions

None. The current scope is intentionally narrow and follows existing adapter
capabilities.
