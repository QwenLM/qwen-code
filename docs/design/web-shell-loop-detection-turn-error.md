# Web Shell loop-detection turn errors

## Problem

ACP loop protection currently records unstarted tool calls as failures and then completes the prompt with `stopReason: end_turn`. Web Shell therefore presents the internal tool skip text as the only explanation and treats the turn as successful.

## Design

When a foreground ACP prompt is stopped by loop protection, preserve completed and skipped tool results as today, then reject that prompt with a structured ACP request error. The bridge publishes the existing `turn_error` terminal with `errorKind: loop_detected` and the detector's `loopType`. Cancellation continues to take precedence when it races the loop stop.

Web Shell renders `loop_detected` from the structured kind, using localized plain language: the model repeated tool use or reached a safety limit, only the current turn stopped, and the user can continue with a more specific instruction. No client matches the internal English tool error.

Skipped tools keep their existing failed terminal update and error details so they cannot remain pending and their display behavior does not change. The additional `turn_error` provides the user-facing explanation for the stopped turn.

The session remains alive and the per-turn loop state is recreated for the next prompt. Cron and background-notification work keep their existing non-interactive handling.

When Web Shell reloads a live session from paginated persisted history, the bridge appends the current in-memory `turn_error` to that replay. This keeps the terminal error visible across a page refresh without changing historical persistence.

## Compatibility

`turn_error` already terminates prompts and returns the UI to idle. Adding a known error kind and optional metadata is backward-compatible: older clients show the daemon message, while updated clients show localized guidance.
