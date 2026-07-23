# Explicit Monitor Cancellation Notifications

## Problem

`task_stop` already returns a synchronous tool result confirming that a monitor
was cancelled. The monitor registry also emits a terminal `cancelled`
notification, which clients record as a notification user message and submit as
a new model turn. A `running` event queued just before cancellation can cause the
same extra turn even if the terminal notification is suppressed.

## Design

- Cancel monitors silently when cancellation comes from `task_stop`; the tool
  result remains the user- and model-visible confirmation.
- Keep the registry's default cancellation behavior unchanged for other callers.
- At drain time, discard queued `running` monitor notifications whose registry
  entry is now explicitly `cancelled`. This check applies to the interactive
  queue, the persistent stream-json queue, and the one-shot headless queue.
- Continue delivering natural `completed` and `failed` notifications, along with
  terminal notifications emitted by non-`task_stop` cancellation paths.

ACP already rejects `running` monitor notifications, so silent explicit
cancellation is sufficient for that client.

Owner-routed monitor notifications stay inside an agent's input queue rather
than the user's conversation. They are outside this session-notification fix;
in the common tool-call path, any queued event is delivered alongside the
already-required `task_stop` tool result instead of creating a session turn.

## Verification

- `task_stop` cancels and aborts a monitor without invoking its notification
  callback.
- Each client drops a queued `running` event after the monitor is explicitly
  cancelled.
- Existing terminal-notification tests continue to demonstrate that natural
  completion and failure are delivered.
- A real model-driven `monitor` then `task_stop` run produces no follow-up
  notification turn.
