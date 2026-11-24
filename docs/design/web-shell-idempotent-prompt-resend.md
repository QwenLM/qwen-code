# Web Shell idempotent prompt resend

[English](web-shell-idempotent-prompt-resend.md) | [简体中文](web-shell-idempotent-prompt-resend.zh-CN.md)

## Problem

When a prompt POST was dispatched but its `202` response was lost (network drop, timeout, gateway `5xx`), Web Shell could not tell whether the daemon admitted the prompt. It showed a composer banner ("delivery uncertain") with "Restore local copy" / "Discard local copy", locked the composer until the user chose, and asked for `window.confirm` before restoring. The banner stayed visible even after the turn visibly ran. Most `4xx` rejections were also misclassified as uncertain.

## Current state

The daemon already deduplicates `POST /session/:id/prompt` by an optional `idempotencyKey` (per-session ring; a repeat returns the original `promptId` with `deduplicated: true`). The daemon Web Shell path never sent a key.

## Goals and scope

- Make lost admission responses mostly invisible by retrying safely.
- When the outcome is still unknown, present it like a chat app: the message stays in the conversation, with a red `!` on its left; hovering shows "Resend", clicking resends.
- Never lock the composer for an unknown outcome.
- Out of scope: daemon changes, managed-agent flows.

## Design

### Idempotency and auto-retry

- Callers mint one key per submission (`createPromptIdempotencyKey`) and pass `idempotencyKey` through `sendPrompt` / `submitPrompt` / `sendDetachedPrompt`.
- `sendPrompt` retries a failed admission silently after 400 ms and 1200 ms with the same request (same key, same uploaded attachment references) when a key is present, the failure is not a definite rejection, the request is not aborted, and the session is unchanged.
- Definite rejections: HTTP `400/401/403/404/409/413/429/501`, `DaemonPendingPromptLimitError`, `PromptDispatchCancelledError`. Only these delete uploaded attachments.
- Post-turn retry after a `turn_error` mints a fresh key (the original turn's key is still remembered by the daemon), and reuses that retry key only while its own admission is uncertain.

### Message-level resend

- A failed or uncertain send records `{ idempotencyKey, reason: 'failed' | 'uncertain' }` on the failed prompt bound to its user block.
- `UserMessage` renders a 20 px red circular `!` button left of the bubble with a tooltip: "Resend" (failed) or "May not have sent — click to resend" (uncertain). Clicking resends with `optimisticUserMessage: false`, `bindBlockId`, and the same key.
- Applies to the main composer, inline message edits, and split-view panes.

### Auto-clear

The indicator is hidden while a turn is running and cleared when the user block gains a `promptId`, or a later rewind user block, assistant, thought, or tool block appears. Background notifications do not clear it.

## Constraints and risks

- The daemon ring is in-memory; after a daemon restart a resend may run again. This is the same as the previous manual behavior.
- Daemons that ignore `idempotencyKey` keep at-least-once semantics on resend.

## Validation and acceptance

- Unit tests: error classification, retry/backoff/abort/attachment cleanup in session actions, `UserMessage` indicator, `MessageList` forwarding, App and ChatPane flows (unlocked composer, same-key resend, auto-clear).
- Acceptance: no "local copy" banner or confirm dialog remains; an uncertain send leaves the message in the stream with `!`; resending an already-admitted prompt does not start a second turn.
