# Resume interrupted tasks when the model is available

[English](web-shell-resume-when-available.md) | [简体中文](web-shell-resume-when-available.zh-CN.md)

## Problem and scope

Issue #13784 asks for a user-selected wait after a model rate limit stops a
task. The existing recovery banner and continuation action already preserve
conversation context and repair dangling tool results. This change adds a
delayed trigger to that action, without changing core recovery or automatic
in-flight retry policy.

Unlike silent persistent retries, waiting is explicitly requested, visible,
and cancellable. Merely opening an interrupted conversation never starts work.
Ordinary authentication, billing, transport, and ambiguous admission errors
remain terminal for this wait.

## Design

The recovery banner inspects the latest meaningful transcript block. Only a
terminal model error with explicit rate-limit wording, a 429 code, a quota
exhaustion message with a reset time, or the reported rolling token quota
message can offer **Resume when available** beside **Continue execution**.
Later user, assistant, tool, or cancellation content invalidates old errors.
This narrow UI recognition does not make generic HTTP 403 errors retryable.
Recovery must independently permit continuation; clean or degraded history
never gains a new continuation permission.

Opting in schedules an existing continuation after 60 seconds. Further settled
rate-limit failures double the interval up to five minutes. Waiting has a
six-hour total deadline, matching the persistent retry bound. The banner shows
the next attempt time and Cancel waiting. Provider retry/reset times explicitly
present in the surfaced message take precedence over the fallback interval;
a rolling window such as “every five hours” is not a known reset timestamp.

There is no model-health endpoint. A session context read reports recovery,
not model availability. Each attempt is the real continuation. Its successful
completion ends the wait; another admitted, recognized rate-limit failure may
schedule the next attempt only after current recovery metadata permits it.
The existing session action owns admission, prompt correlation, event replay,
and completion. It does not replay completed tools or add a synthetic user
prompt. Missing tool results retain the existing synthesized interruption
errors; choosing the new button authorizes that existing repair behavior.

Waiting belongs to the current mounted banner, session attachment, workspace,
model, and interrupted turn. Cancel, unmount, owner replacement, model changes,
disconnection, other activity, and blocking states stop future attempts. During
its own admitted attempt, existing progress and cancellation controls apply.
Unknown admission outcomes stop the wait instead of automatically posting
again. Normal continuation remains an immediate, explicit action and cancels
any scheduled wait.

## Files and boundaries

- Web Shell recovery banner, rate-limit message helper, localized text, and
  focused component/helper tests.
- Browser regression coverage through the existing mock daemon transport.
- No new daemon route, SDK field, core classifier, or recovery algorithm.
- Existing continue requests remain live-session-owner scoped, with their
  workspace and admission guards unchanged.
- Provider headers are not forwarded in terminal transcript errors today.
  This change only honors retry/reset timing that reaches the UI as message
  text; header propagation and shared in-flight retry feedback remain #12020.
- Waiting does not persist after navigating away, closing the UI, or restart.

## Validation

Test explicit opt-in, Chinese rolling quota and 429 detection, ordinary 403
rejection, backoff, provider timing, cancellation, owner/model/activity changes,
recovery refresh ordering, successful single continuation, non-rate-limit
failures, ambiguous admission, and degraded history. Verify real browser
placement and transport requests with synthetic errors, and use a local mock
model to exercise the global CLI baseline and built continuation pipeline.
Build, typecheck, focused tests, diff audits, and independent review follow.
