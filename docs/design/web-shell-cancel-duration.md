# Persistent cancellation elapsed time

[English](web-shell-cancel-duration.md) | [简体中文](web-shell-cancel-duration.zh-CN.md)

## Problem and scope

Web Shell renders a live cancellation event, but loading persisted history loses
that marker. The marker should survive refresh and read “You cancelled this
request after X seconds” (Chinese: “你在 X 秒后取消了请求”). Preserve the existing
right-aligned presentation. No new routes, storage system, or settings.

## Design

Reuse the existing `system/turn_result` record. Capture optional `cancelledAt`
on the turn controller's first explicit user abort, using the same agent clock
as `startedAt`. Keep `endedAt` as settlement time. The displayed whole seconds
are the nonnegative, rounded-up difference between cancellation and execution
start; queue wait and cancellation cleanup are excluded. A cancellation terminal
waits for the pinned recorder to flush, so immediate refresh cannot overtake its
write. Recording failures retain the existing degraded-recording behavior.

Carry this authoritative cancellation timing through the prompt response and
bridge terminal event. Normalize live completion and persisted replay into the
existing `prompt.cancelled` event. Match by `promptId` so authoritative timing
updates the provisional live marker without duplication. Preserve record ids
and timestamps through replay. Overlapping history pages merge the persisted
marker into its existing position, including provisional markers and repair
checkpoints, without replaying cancellation against the active tools. The Web Shell adapter passes duration to the
existing system-message component, which formats localized text. The processed
summary uses the same cancellation duration and rounds up with the same rule,
including an explicit 0s. Direct SDK updates that omit a timestamp preserve the
previous timestamp.

Existing records without explicit cancellation timing retain existing behavior;
do not invent user attribution or duration for session disposal, superseded
prompts, permission denial, or failed forwarding. Existing provisional cancel
markers remain a fallback for older servers. Fork-history semantics are out of
scope.

Interrupted model streams must also retain the thinking and text already emitted.
The shared stream processor saves those partial parts in both in-memory history
and the existing deferred assistant recorder from its cancellation cleanup,
including when the consumer closes the generator. Ordinary transport errors keep
their retry/discard behavior. MAX_TOKENS escalation and continuation retries skip
rollback when the request is cancelled, and recovery rethrows cancellation instead
of synthesizing normal completion. The outer generator cleanup merges retained
continuations and removes internal recovery prompts, including cancellation at a
yield or before continuation content arrives. Synthetic tool-call chunks are
recorded before they are yielded, so closing there preserves recovered tool calls
rather than their original XML. During transport continuation backoff and stream
establishment, the outer generator retains the accumulated text prefix for
cancellation. Once the response processor takes over, or a fresh retry discards
the prefix, this temporary ownership is cleared to prevent duplicate recording.
If an established text continuation fails into reactive compression, the outer
generator takes ownership back until a fresh retry discards the visible text.
Restoring the assistant content also restores the
existing processed summary; no summary-visibility override is needed.

## Affected areas

CLI session turn recording; core stream finalization and turn-result payload
validation; ACP bridge
terminal forwarding and shared transcript replay; SDK normalization and
transcript reduction; Web Shell message adapter, component, and translations.
All data remains within the existing owning session and persisted workspace.

## Validation and acceptance

Attempt baseline with global `qwen`, then verify the local bundle. Cancel an
active request, await settlement, reload from persisted history, and verify one
marker with unchanged elapsed seconds. Cancel after thinking and text have both
arrived and verify their contents and the processed summary survive reload.
Also test cancellation before the first
second, slow cleanup, repeated cancel, a second cancelled turn, and exclusion
of ordinary completion, errors, direct disposal, and supersession. Exercise malformed
metadata and legacy records. Cover cancellation in escalation, the first and
later recovery attempts, empty partial output, consumer closure, and synthetic
recovered-tool-call output. Cancel at the transport continuation retry yield,
backoff, and stream establishment, including a later continuation with overlapping
text; confirm one matching history/record entry and no duplicate after the next
processor takes over. Verify failed partials are still discarded when a
supplied signal is not aborted, and that no internal recovery user prompt remains. Run focused package tests, build, typecheck,
bundle, two self-audit passes, and independent review.

## Open questions

Old history has no reliable explicit-cancel timestamp and is not backfilled.
The existing protocol also maps bridge deadlines and some close paths to its
user-cancel signal. This change preserves that classification; introducing a
cancellation-reason protocol is outside scope.
