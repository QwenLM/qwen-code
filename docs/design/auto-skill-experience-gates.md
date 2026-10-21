# AutoSkill experience gates

[English](auto-skill-experience-gates.md) | [简体中文](auto-skill-experience-gates.zh-CN.md)

## Problem and scope

Issue #9062 remains open: AutoSkill reviews currently depend only on 20 completed
tool calls. Read-only exploration spends a review, while short debugging sessions
and user corrections can miss one. AutoSkill remains opt-in; confirmation,
managed-skill write restrictions and memory-pressure checks remain unchanged.
This design replaces the trigger, not the review agent or shell process lifecycle.
It supersedes the counting, trigger and `ScheduleSkillReviewParams` sections of
[the original AutoSkill proposal](skill-nudge/skill-nudge.md). That proposal's
count-only snippets are historical, not the current caller contract; the review
agent and write-sandbox design remain unchanged. It also supersedes section 7
and the corresponding completed-tool acceptance criterion of
[ACP managed auto-memory](auto-memory/acp-managed-auto-memory.md): ACP forwards
all terminal completions with their call ID and execution status, including
cancellations; the shared client decides protection and accounting.

## Design

The review gate has two paths: at least 5 accepted completed calls plus a
same-tool failure/recovery or accepted mid-turn steer; or at least 20 accepted
completed calls plus substantive work. No new setting is introduced.

The client retains small completion records by call ID until their tool results
are accepted into chat history. Acceptance uses a request-owned receipt of the
submitted parts still resident after setup and inline repair. Parts are tracked
by object identity, not just call ID: a late real result dropped in favor of an
older synthetic response does not count, while a result hoisted to an earlier
turn still counts. Capture follows output-budget rewriting. The first stream
event, normal commit and finally path consume this receipt. Setup rollback
leaves no receipt, so another send's push cannot credit rejected results or steer
evidence. Provider errors following a confirmed push still preserve acceptance.
Direct `addHistory` also consumes matching records. Re-submitted results cannot
count twice. Rejected inputs do not advance the review window.
Skill-file modification protection still updates at local execution completion,
even if a PostToolUse hook subsequently denies the result or the call settles
cancelled after execution started. Denied and cancelled results remain excluded
from experience accounting and unstarted writes do not set protection. Cancelled
executions reserve their completion IDs so replay cannot renew skill protection.
ACP marks code-mode nested and MCP App completions as non-model-facing. TUI also
marks late results dropped by history deduplication as non-model-facing. These
completions do not create pending experience records, recent-tool hints or
ordinary call-ID reservations, since no model submission can accept them. Local
skill writes still set protection and reserve their IDs to prevent replay from
renewing it; these intentional reservations last until the session resets.

Stream ID normalization also reserves the client's session-level recorded
completion IDs, not just IDs in current history. Compression and rewind/restore
therefore cannot let a fresh execution reuse an ID that completion accounting
would discard as a replay. Recreated main chats share the same read-only
reservation view; `/clear` and session changes clear it with the existing review
state. This adds no separate ID store or persistent state.

Tracked terminal status excludes cancelled calls even if execution already
settled successfully. Execution status excludes unstarted and cancelled calls;
terminal error type excludes hook-denied results. Auto Memory recall hints remain
independent of this experience gate: only model-facing, non-cancelled terminal
completions add recent-tool hints, without waiting for result acceptance.
Non-model-facing completions add no hints. A successful shell retry requires an
existing structured `ShellResultDisplay` with completed
outcome and exit code 0; output text is never parsed. Failed shell results use
execution status/error type; structured cancelled results are excluded even if
a front end labels them successful. No shell teardown changes are needed.

A batch containing both failure and success from one tool cannot manufacture a
retry arc from response ordering. A later batch with a successful call and no
failure for that tool can close the pending failure. Recovery across different tools is not inferred.

Substantive work includes built-in write/edit/notebook/shell/code-mode tools,
registered mutator kinds and delegated agent work. MCP tools count when not
annotated read-only (their `Kind.Other` means effects are unknown). This is a
conservative backstop, not proof a file changed: shell reads and delegated reads
can still schedule a review. Read/search/fetch tools and control-flow-only tools
do not qualify merely by call count.

Signals and pending completions are independent of history indexes, surviving
compression. Dispatch resets only consumed count/signals; pending completions
remain available for future acceptance. Session changes and `/clear` clear all
review state. An already-running review retains the new window because its
history snapshot cannot cover work completed after dispatch. Reviews are checked
at turn boundaries, not after every tool result. AutoSkill also checks a completed
Retry: results accepted before a provider failure can qualify even when retrying
finishes without further tool calls. Replayed results still count only once.
Recursive Steer and Hook turns inherit their original interaction's boundary;
Auto Memory extraction, dream and migration retain their existing type gates.
A dispatched review that later fails retains existing behavior: its consumed
window is not retried.

## Affected layers

- `packages/core/src/memory/experience-signals.ts`: outcome classification,
  substantive-work detection and batch accumulation.
- `packages/core/src/memory/manager.ts`: required experience signals and gate.
- `packages/core/src/core/client.ts`: accepted-result accounting, steer and resets.
- `packages/core/src/core/llm-chat.ts`: reserve recorded session IDs during stream
  normalization, including after history removal and main-chat recreation.
- Headless CLI, TUI and ACP completion paths: provide the existing structured
  response; all production callers are covered. TUI forwards cancelled model
  completions even when deduped or owned by a secondary interaction, leaving
  protection and experience filtering to the shared client. Client-initiated
  tools remain excluded. ACP also forwards cancelled completions, preserving
  their settled execution status and cancelled span outcome. ACP uses raw chat
  streams, so it also forwards accepted result batches. Baseline ACP does not schedule AutoSkill
  reviews; this change preserves that activation scope rather than adding a new
  ACP feature.
- Collocated tests and the existing skill-review integration tests: gate,
  outcome, caller and lifecycle regressions.

## Validation and acceptance

Use focused unit tests, repository build/typecheck, and the bundled real CLI
against a scripted OpenAI-compatible provider with real tool execution. Count
extractor requests on the provider wire, not log messages. Establish the global
`qwen` baseline first. Also attempt a real-model smoke using existing auth.
Testing artifacts remain under `.qwen/e2e-tests/issue-9062.md` (git-ignored).

Acceptance: 21 read-only calls dispatch zero reviews; a same-tool retry with
4 calls dispatches zero and with 5 dispatches one; cross-tool success does not
close a retry; 20 shell executions retain the backstop; disabled/manual-skill
protections remain; fresh windows do not reuse old signals. Unit tests cover
rejection, duplicate results, mixed parallel batches, structured unknown shell
status, accepted/rejected steer, compression and session resets. Terminal steer
and retry need no later tool call; retry controls cover recovery below 5 calls,
20 read-only calls, disabled AutoSkill and duplicate replay. Real chat-stream
normalization tests cover reused provider IDs and generated IDs after truncation,
restore, compact-shaped history replacement and chat recreation; fresh completions
still count and protect skill writes, while replay remains idempotent. Clear and
session-switch controls permit ID reuse in a new session. ACP iterator failures
before and after the first chunk retain exactly-once result acceptance. ACP
cancellation tests cover unstarted, execution-stage and post-execution outcomes;
a post-execution skill write still sets protection and reserves its call ID
without contributing experience or recent-tool hints. Nested read and ordinary
write calls, and MCP App calls, leave no pending records or ordinary reservations;
only their model-facing parent results count. Nested skill writes retain protection
and their ID without a pending record, including cancelled or hook-denied writes.
TUI dedup tests verify that dropped ordinary results leave no pending records,
ordinary reservations or recent-tool hints. Started skill writes still protect
and reserve their IDs without counting experience, including cancellation after
execution starts; unstarted writes do not protect, and replay cannot renew
protection. Mixed batches still accept and count only the fresh results.
No new shell process-cancellation semantics are introduced.

## Risks and open questions

Signals are deterministic heuristics, not semantic proof of reusable experience.
MCP tools without read-only hints and agent delegation deliberately favor not
missing substantive work. Pending results occupy memory until acceptance or a
session reset.

The 5-call experience floor is an intentional cost tradeoff against the 20-call
substantive-work backstop: retry- or steer-heavy sessions can dispatch a review
after roughly every 5 accepted calls when each new window qualifies. Dispatch
resets its count and signals; an in-flight review retains the next window, which
may dispatch at the next eligible turn boundary after that review finishes. Each
review processes the full, growing session transcript with default limits of
8 turns / 120 s. Existing `memory.agentMaxTurns` and
`memory.agentTimeoutMinutes` settings can override these limits; 0 disables the
corresponding limit. When confirmation is enabled, newly created skills are
staged and prompt for confirmation. Repeated reviews therefore increase token,
execution-time and potential confirmation costs. A session cap, cooldown and
incremental history processing remain deferred scheduling-policy work.

No persistence, classifier, configurable thresholds, new UI or
changes to Auto Memory extraction cadence are included. There are no open
product decisions for this implementation; platform validation limits must be
reported separately from passing unit tests.
