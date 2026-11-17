# Summary projection for daemon replay APIs

[English](replay-summary-api.md) | [简体中文](replay-summary-api.zh-CN.md)

## Problem and scope

Subagent detail dominates prompt event streams and history responses even when
Web Shell only renders a top-level Agent card. This first PR adds summary
projection without changing the existing in-memory replay lifecycle. A second,
stacked PR moves saved history to JSONL pagination.

## API behavior

All modes default to `full`. `eventDetailMode: "summary"` on a prompt projects
events before ring-buffer retention, SSE delivery, and replay ingestion.
Filtered events do not consume SSE IDs. The selection controls the session's
events while that prompt executes; settlement resets it to `full`. Events from a
subagent that outlives its originating prompt use the mode at publication:
`full` while idle, or the active prompt's mode after another prompt starts. The
daemon does not retain a mode per originating subagent. This selection is shared
by session subscribers and cannot later recover filtered ring-buffer detail.

`liveReplayMode: "summary"` selects the summary live journal on load.
`compactedReplayMode: "summary"` projects `compactedReplay` on load and `events`
on both transcript pagination routes. These read options do not mutate stored
history or another caller's full response. Web Shell requests all three modes,
including older-page navigation.

Summary retains main conversation content, root tools, Agent status and final
results, and main-model usage. It removes nested subagent text, thinking, tools,
usage and progress-only frames, plus Agent prompts, embedded tool calls and
in-progress token counters. Settled Agent results retain `tokenCount` and
`executionSummary` token totals (including failure/cancellation), so turn
metrics include subagent consumption. No separate aggregate usage event is
added; existing tool-ID deduplication prevents repeated replay from adding it
twice. Task status takes precedence over tool status because a background launch
can finish its tool call while the agent still runs. Subagent details remain
available through their separate view.

The daemon projection is a public data contract: it keeps Agent final results
but removes prompts. Web Shell applies an additional root-card projection,
which omits result text and keeps only a bounded prompt preview when the
incoming event still contains one (for example, a full-mode late event). The
preview is a description fallback, not a guarantee of the summary API. The
separate subagent detail view requests full data. These two projections need
not have identical field sets.

In summary mode, an Agent card does not show an incremental token badge. Its
final aggregate becomes available when that Agent completes, fails or is
cancelled, potentially while the main turn is still processing.

Mid-turn messages carry `eventDetailMode` through the daemon queue into a
promoted prompt, including attachment fallback. Messages drained by the current
turn do not change its mode. Omission means full; same-id retries while queued
or pending must match the effective mode. Mode is part of the payload identity:
accepting a retry with a different mode would acknowledge a payload the daemon
did not retain. REST idle rejection is unchanged. The daemon ACP
`session/prompt` accepts the same optional top-level extension; it is stripped
before forwarding to the child. This is shared session behavior, not a
per-subscriber rendering preference. Public OpenAPI and protocol references must
describe the load, transcript and prompt options and their errors.

## Boundaries and tradeoffs

This PR preserves the existing meanings: `liveJournal` is the current incomplete
turn and `compactedReplay` contains compacted completed turns or a restored
history page. Terminal events still compact the in-memory turn. It adds no
persistence UUID or ACK dependency. Existing truncation limits remain.

Page selection still precedes summary filtering, so a requested page size can
produce fewer visible items. Counting visible replay records belongs to the
second PR. Summary reduces retained prompt detail and response size; it alone
does not eliminate long-turn truncation or compacted-history memory growth.

## Validation and acceptance

Verify full defaults, invalid mode rejection, summary filtering before ring
retention, contiguous SSE IDs, prompt mode reset, independent full/summary load
responses, both transcript routes, and Web Shell older-page options. Verify that
completed turns still replay from memory without a persistence ACK. Use package
unit tests plus an isolated real daemon with a mock model provider; the provider
is simulated, while daemon routing and event retention are real.

Reviewer checks include REST prompt mode forwarding and the Agent token badge
transition above. Existing isolated-daemon verification with a simulated
provider observed summary child SSE/usage counts of 0/0 versus default-full
counts of 7/2, with equal root aggregates of 200 input / 40 output / 240 total.
Live and reconnect streams matched across 31 numbered events. Load and
transcript returned the same aggregate for each call ID while the next prompt
was active and after both prompts settled. These were complete small pages
(`hasMore=false`), not cross-page, browser, or real-model verification. Attach
the E2E report summary to the PR; raw evidence is retained under the ignored
`.qwen/issues/pr1-summary-terminal-usage.md` and its companion directories.
