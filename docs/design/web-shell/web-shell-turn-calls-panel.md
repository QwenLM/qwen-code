# Web Shell Tool Calls Panel

[English](web-shell-turn-calls-panel.md) | [简体中文](web-shell-turn-calls-panel.zh-CN.md)

Status: implemented; fresh live backend verification pending restart.

## Problem

Tool calls are scattered through a conversation. Readers need one place to
inspect what a turn actually did, including its recorded outcome and duration.
The original panel read only live blocks: historical viewport IDs did not match,
injected user messages cut turns short, and receipt timestamps lost recorded
execution durations. In the reported session a 57-call turn showed only 13 calls.

## Goals

- Open the selected user message’s calls from the action beside Copy, including
  while the turn is running and when viewing historical pages.
- Show localized tool labels and prefer each invocation’s explicit description.
- Show recorded elapsed time and explicit completed, failed, cancelled, pending
  and running states.
- Expand raw arguments/results in place; preserve nesting when records include it.
- Keep the right dock usable in light/dark themes and narrow layouts.

## Non-goals

No unrelated daemon behavior or unrelated client UI changes. Shared Web Shell message adapters also resolve generic tool wrappers to their real names and arguments, and the Chinese edit label is “编辑文件”, as requested. No inferred skill attribution or business-page links.

## Design

**Entry and identity.** Copy and Edit gain a tool-call entry on user messages
when the public `showToolCalls` prop is `true`. It defaults to `false` for hosts;
the standalone `main.tsx` explicitly enables it.
Document/export mode remains unchanged. The live block ID identifies a running
turn until its persisted record is available. A historical viewport passes the
user record UUID from its own blocks; its page-local ID must never be matched
against the unrelated live projection. A single dock tab retargets on selection.
Persist the durable user record ID or stable prompt ID in the existing
session-scoped dock state, restoring the open state, selected tab and selected
turn after reload. Live tabs acquire the record ID when it arrives. If live
blocks have been trimmed, resolve the prompt ID through the paginated turn
index. Projection-local IDs alone must never be persisted or restored because
they can identify another turn after reload.

**Recorded data.** The workspace-scoped tool-calls endpoint accepts only the
session and persisted turn ID and returns one complete response. It owns
snapshot creation and bounded internal transcript paging. Calls belong to the
navigation prompt where they start. Preserve the reader’s safe prefix and replay
through the next ordinary prompt boundary so results and timing after a visible
scheduled or realtime prompt still pair with their original calls. Replay the bounded segment
once, then filter starts, updates and timing by that ownership. Reuse `projectTrajectoryWindow` and `buildTrajectory`
in the client to correlate tool timing and status. Mid-turn instructions and
notifications do not split a user turn; visible scheduled prompts follow the
same boundary as the left navigation. Partial replay, cursor failures and
response/page ceilings produce explicit errors; they must not masquerade as
empty or complete data. The route is persisted-workspace scoped and uses the
resolved runtime's reader, cursor codec, storage and trust redaction. Before freezing
the snapshot, flush the transcript of an already loaded session through the existing
read barrier; never attach or resume a session to read its calls.

**Live updates.** While the selected prompt is running or waiting, use the
same transcript blocks as Message with no history request or polling. After
settlement, read history once and retain live rows during that read. Selecting
an older prompt while another runs still loads history. Merge by call ID,
preserve terminal recorded results, and discard responses from stale session,
workspace or prompt selections. Keep the resolved record identity after live
blocks are trimmed. Live tool blocks retain the existing event prompt ID; when
the user anchor is evicted, collect retained calls by that stable ID and continue
using live updates without a history request. Replayed history has no valid
browser receipt clock.

**Rows.** Place the prompt Select before the call count, with no All prompt
option, and keep a tool-type Select at the far right. Both Selects use normal
foreground text; the summary has no horizontal padding. The call count has no
leading icon, and the tool-type Select has no border. Default the type filter
to All tools; filter by localized tool type, grouping MCP calls together.
Keep the total call count when filtering. Each row reuses Message’s `ToolSummaryIcon` before the normal foreground tool name, immediately
followed by muted duration, with outcome and expand
chevron at the right end. Completed uses a green check icon and label; running
uses the shared spinner; cancellation uses a slash-circle icon and warning
color on both icon and text. The description occupies one line with ellipsis and
a title tooltip. A nonblank string in `rawInput.description` wins; otherwise
reuse `getToolSummaryDescription`. Escape control characters and cap descriptions
at 2000 characters. `localizeToolDisplayName` retains its fallback for custom
tools without a translation. A chevron and visible keyboard focus indicate
expandable raw arguments/results, capped at 4000 characters per field. Use the
existing theme tokens and native button semantics. Read/write/edit rows reuse
the message area’s file-preview action as an icon with a tooltip and accessible
label, directly after the description without right alignment. This action
does not shrink when the path is truncated and opens a separate dock tab.
It retains the shared workspace ownership and file-availability checks.
Agent rows use the existing summary replay projection: omit child events and
embedded full result text when a structured task summary replaces it, preserve
plain failure diagnostics, retain identity/status/timing, and open the existing
agent detail tab on click to load the full subagent transcript. Edit/write results reuse the message area’s diff extraction and
view, falling back to raw results when no diff is recorded. Valid JSON arguments and results
are identified before display truncation and reuse the message Markdown renderer
with a formatted JSON code fence, including truncated long JSON; other
results remain plain text. Diff rendering takes precedence.

**Duration and status.** Prefer the daemon’s recorded duration, including zero
and subsecond values. Failed or cancelled calls with a valid recorded start also
retain measured zero durations; legacy non-success zeros without a start remain
unknown. Subseconds display milliseconds, longer durations reuse
the existing formatter. Running live calls use the shared one-second clock;
completed calls without a timing record can use a positive client-observed
interval. Hovering the duration opens the shared tooltip with only start and end timestamps,
including milliseconds. These come exclusively from recorded per-call timing;
client receipt times are never used, because replay may deliver a whole turn at
one instant. Only terminal calls with both recorded start and duration expose a tooltip
and accessible timing description. Running calls and incomplete historical
timing retain the elapsed label without a tooltip.

The scheduler now retains the start already used to measure each call's duration
through success, error and cancellation. `ToolCallEvent.started_at` carries it to
telemetry, replay emits `startedAt`, and the SDK/trajectory preserve it. The exact
end is that start plus the recorded duration, independent of when the batch logs.
This retains the existing duration scope, including validation, approval and
scheduling wait; it does not change execution or metric behavior. Old records
remain readable without inventing a start from their batch-log timestamp.

The ACP Session execution path also emits its measured start and duration in
live tool metadata and telemetry. The SDK preserves these fields so the live
clock uses the server start and completion freezes at the recorded duration.

Unavailable timing is an em dash; pending calls have no timer. Recorded
cancellation overrides a generic failed replay block. Completed means the tool
reported completion, not that a business operation succeeded.

**MCP results.** Show an MCP badge before the row status, including when
collapsed. Use regular font weight at 11px. Identify MCP calls by the existing
`mcp_invocation` preview or resolved `mcp__` tool name. Generic `tool_call`
wrappers resolve their actual name and arguments from the input, including
when matching replay timing.

**Shell sections.** The branch incorporates PR #12311’s structured shell result
contract. In Tool calls, Arguments contains only the command string; Result
contains only the version-1 output (including an authoritative empty output).
Remaining invocation arguments and execution metadata are grouped under an
initially collapsed Other disclosure. Live output uses the existing segment
parser; legacy strings remain text unless they are valid JSON, in which case the shared Markdown JSON renderer formats them. Unknown result versions use their text fallback rather than interpreting their fields. Existing display bounds
still apply. This integration is verified with unit tests/build/typecheck only;
fresh live backend verification remains pending.

**Identity, errors and rendering.** The turn index reads `daemonPromptId` from the user record immediately; terminal records remain a fallback for older sessions. This lets the selector merge a persisted prompt with its live admission before completion. An unresolved prompt and a failed prompt-index refresh show distinct retryable notices outside the listbox; neither is reported as an empty turn. Successful prompt-index loads are reused until navigation identities or snapshots change or Refresh is requested. Freshly loaded entries take precedence over the navigation snapshot present when that request began; a later navigation snapshot can update them. The response envelope includes `v: 1`; incomplete replay returns `tool_calls_replay_incomplete`. The scan budget includes later records needed to pair results across scheduled/realtime boundaries, and its limit error names that scan rather than a single page.

Rows use tool-call IDs across live and persisted projections, preserving expansion. Both paths compute nesting from the same retained parent chain. Row rendering is memoized, and collapsed rows do not serialize arguments/results or parse shell details. Missing filter types reset to All tools. File descriptions use the resolved workspace path, and status icons are decorative beside their visible labels.

The ACP post-approval notification carries the tool name, approved arguments and measured start time, so running rows have their command and description before completion. Failure to deliver this informational notification is logged and does not prevent execution; cancellation is checked after delivery. Tests cover notification rejection, historical viewport UUID forwarding, nonempty agent results reduced to summaries, zero durations and scheduler starts on success, error and cancellation.

## Files

- `TurnCallsPanel`, its styles/tests, and `loadTurnCalls`: rendering, live merging,
  history loading and verification.
- `turnCallsContext`, `MessageItem`, `MessageTimestamp`, `App`, `ArtifactPanel`:
  entry and dock wiring.
- `TranscriptViewport`, `useTranscriptViewport`: historical record identity.
- `toolFormatting` and tests: ignore blank/non-string descriptions.
- `toolClassification`, `transcriptToMessages`: shared tool identity and argument projection, including chat messages.
- `i18n`: English and Chinese labels.
- Core scheduler/telemetry, ACP replay, SDK timing reader and trajectory: retain
  the measured call start across recording and replay.

## Verification

Cover localized labels, description priority/fallback, recorded and live timing,
explicit outcomes, historical IDs, stale responses, injected instructions,
cross-page timing, next-turn exclusion, and replay errors. Component tests cover
hover timestamps, missing timestamps and running calls; App tests cover tab
persistence, reload, session isolation and delayed durable record IDs.
Scheduler, replay and SDK tests cover independent starts, delayed batch logging,
legacy records and invalid timestamps. Tests also cover filtering and JSON
versus plain-text arguments/results. Browser checks of the reported 14-call session
confirm reload restoration and the MCP badge with its 515ms duration; old
records still lack real start timestamps. Check actual reported
session turns against persisted call IDs and durations, including 57 calls in
the final turn and 139 in the previous turn. Mock daemon browser checks cover
layout, keyboard expansion and live timers; they do not prove real history
correctness. Results are recorded in
`.qwen/e2e-tests/web-shell-turn-calls-redesign.md`.

## Risks and limits

- Agent children are omitted from the summary list; opening the agent uses
  the existing detail page to fetch its complete transcript.
- A shell script remains one call even if it invokes multiple APIs.
- Legacy live calls without server timing use client-observed elapsed time,
  which can undercount after reconnecting.
- Server-side replay is capped at 100 pages of 250 records and 32 MiB for the retained replay segment and response;
  exceeding them fails explicitly. The public tool-calls API has no pagination.
- Old sessions without timing records cannot recover an exact duration.

## Session-level prompt selection

The dock is session-scoped. Its first row contains a content-width prompt
Select (long labels truncate) and a Refresh icon with text at the right. The
second row shows the total call count and tool-type filter. Refresh updates the
prompt index and, for historical prompts only, reads calls once.
Opening the action on a message selects that prompt. There is no All prompt
option. Reuse the left navigation's persisted index and provisional live
prompts, including its labels and stable identities. Tool-type filtering stays
at the right. Persist prompt selection in the existing dock state.

Historical calls are fetched once on selection from a workspace-scoped
`GET /workspaces/:workspace/session/:id/tool-calls?turnId=...` endpoint.
`turnId` is mandatory; no public cursor or limit is provided. The endpoint
returns the complete selected turn's calls and recorded timing. Reuse existing
transcript snapshot/replay readers internally with explicit size-limit errors;
never return a silently truncated list. Honor resolved workspace ownership,
archive coordination, active-chain boundaries and existing redaction.

While the selected prompt is running, render the Message transcript store
directly and do not request historical calls or poll. Keep live rows while a
single history read after settlement is pending. Switching to an older prompt
during another prompt's run still uses the history endpoint. Discard stale
responses after selection/session changes. Current provisional prompts must
remain selectable before their persistent index mapping arrives. The turn-index
endpoint defaults to its tail page: both the selector and prompt-ID recovery walk
backward in the same snapshot to include early prompts in long sessions.

Acceptance: clicked prompt is preselected, Select precedes the count, no All
prompt option, historical switching loads exactly the selected prompt, running
updates produce no repeated HTTP calls, completion does not flash empty, and
refresh restores the stable selected prompt.

## Tab ordering and entry label

The UI label is Tool calls, including restored tabs, and the Message action and
dock tab use the shared wrench icon. Opening or retargeting the tool list keeps
its tab before file and agent detail tabs. Restore applies the same order so
previously persisted tabs do not retain the old reversed placement.
