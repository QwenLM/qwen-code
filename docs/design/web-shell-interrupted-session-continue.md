# Continue interrupted sessions in Web Shell

[English](web-shell-interrupted-session-continue.md) | [简体中文](web-shell-interrupted-session-continue.zh-CN.md)

## Problem and scope

Opening a saved conversation restores history, but Web Shell has no explicit
action for continuing its interrupted last turn. Existing retry actions serve
failed submissions and are not a replacement for server-side recovery after a
restart. The daemon already provides `POST /session/:id/continue` and core
already classifies interrupted prompts and dangling tool calls.

This change exposes those existing capabilities. Opening a conversation does
not start work. Partial assistant text without a persisted terminal outcome
remains outside the supported interruption classifier; this change does not
introduce new transcript records or provider-specific prefill.

## Design

The existing session context response gains an optional `recovery` summary
containing `kind` and `canContinue`. The ACP session builds it with the existing
recovery planner and uses the same decision for continuation admission. Known
history gaps disable continuation. An active turn or a restorable user question
does not offer continuation. Older servers omit the summary and retain the
existing UI.

The session retains known history gaps after temporary restore state is
finalized. Loading may already replace missing tool results with interruption
errors; the existing classifier then identifies the pending model response as
an interrupted prompt.

The context route remains live-session-owner scoped. The existing continue
mutation also targets the live session owner and retains its workspace and
standalone working-directory checks. No primary-runtime fallback is added.
Consumers are ACP context status, daemon bridge/HTTP context forwarding, the
daemon SDK context type, Web Shell connection state, and the recovery banner.

The daemon SDK exposes a REST continuation method and a session-bound wrapper.
The accepted response permits an absent event epoch from older daemons.
Web Shell integrates acceptance with its existing prompt tracking, event cursor
and epoch handling, terminal events, cancellation, and session-switch guards.
It does not send synthetic user text or insert an optimistic user message.
Concurrent continuation requests are checked against bridge admission state so
only an idle session can admit a continuation. Cancellation invalidates an
outstanding continuation precheck before it can start work. Closing or awaiting
close authorization also blocks admission after that precheck.
After a successful cancellation, the current cancellation owner refreshes
recovery without waiting for a cancellation event, since repeated idle
cancellation events may be suppressed. This read does not delay cancellation.

A shared banner appears above the composer in both the main chat and additional
chat panes. Interrupted prompts and tool turns show a localized explanation
and a Continue execution button. Degraded history shows an explanation only.
Loading, disconnected, catching-up, active, permission-blocked, and read-only
states, including an accepted new-session handoff, do not offer the button.
Submission hides it immediately and uses the existing progress controls. Recovery
metadata is refreshed after settling and invalidated across new work and
session changes. Delayed responses cannot update a different conversation or
overwrite recovery status from a newer event-stream subscription after reconnect.
Recovery merges retain cached metadata only from the same session, including
when a terminal event overtakes the initial metadata read after a session switch.
Metadata, terminal events, and definite rejection refreshes share recovery read
ordering per session. Local continuation and new activity invalidate older reads.
Configuration refreshes preserve cached recovery; configuration changes cannot
discard a valid recovery refresh. Continuations register for existing terminal notifications, including snapshot
replay, without adding a user turn or navigation entry. If a reload snapshot
arrives before admission is acknowledged, its terminal events stay with that
local continuation until the accepted prompt ID identifies the matching event;
unrelated historical turns cannot settle it or notify. Admission during the
reattach gap also retains notification registration. A terminal already applied by the snapshot settles only its continuation
bookkeeping and notification, whether admission arrived before or after the snapshot;
it must not finish a newer streaming turn or release that turn’s composer lock.
Live terminal events received before that ACK also wait for prompt-ID matching;
a newer queued turn cannot consume the original continuation’s result.
An automatic same-session reattach preserves continuation tracking and failure
settlement. Explicit session loads invalidate that ownership; definite rejection
refreshes use the current attachment, with its own recovery-read ordering.

An admitted turn’s failure is reported through the transcript, not as a failed
continuation admission. Failure feedback captures the session and recovery generation when its error
callback runs. Later recovery reads or activity invalidate that feedback, even
when React batches the failure and later work into their first render.

Unknown submission outcomes are reconciled from the session/event stream rather
than automatically posting another continuation. Missing tool results are
represented by the existing synthetic interruption errors; the recovery layer
does not replay the tools itself.

## Files and boundaries

- ACP bridge status types, continuation admission, and focused tests.
- ACP session recovery decision, context response, and focused tests.
- Daemon SDK context/result types, HTTP/session clients, exports, and tests.
- Web Shell session actions, recovery banner, both chat surfaces, i18n, and tests.
- No new daemon route, core recovery algorithm, CLI flag, or automatic resume.

## Validation and acceptance

1. Opening a saved interrupted prompt makes no model request until clicked.
2. Continuing preserves the session ID and sends the original context without
   duplicating a user message; tool interruptions use synthetic error results.
3. Clean, active, pending-question, degraded, and unsupported states cannot
   accidentally start a continuation.
4. Double clicks and concurrent tabs do not enqueue duplicate continuations.
5. Completion, rejection, failure, reconnect, and switching panes leave the
   correct session state and a usable composer; cancellation remains available.
6. Workspace ownership and standalone checks remain enforced.
7. Run focused tests, repository build/typecheck/bundle, isolated global CLI
   baseline and local daemon verification, followed by diff audits and review.

## Open questions

None for this scope. Reliable recovery of truncated assistant text requires a
separate persisted turn-outcome design.
