# Local notes compaction and session history recovery

[English](2026-09-19-local-notes-compaction.md) | [简体中文](2026-09-19-local-notes-compaction.zh-CN.md)

Status: implemented locally behind the opt-in strategy setting; validation is
recorded in section 8.
Date: 2026-09-19.
Source baselines: Qwen Code `42f9d13cdae0a7d462019487646bf7fb4995bf24`;
Codex `5b1d6560181680f95cde95c14ed042acc02248ed`.

## 1. Problem and recommendation

Long tasks need a compact account of their current state and a way to recover
details that were omitted from it. Qwen Code currently generates a new summary
when compacting the conversation. Repeated summarization can lose an earlier
constraint, unsuccessful approach, or exact tool result. The original session
records often still exist locally, but the model has no dedicated tool for
retrieving them.

Add an opt-in `notes` compaction strategy. The working model maintains one
bounded Markdown checkpoint during the task. At a safe boundary, the runtime
replaces the active model history with that checkpoint, the latest real user
request, and required runtime context. A read-only history tool retrieves older
records from the existing local session log. A successful notes rollover makes
no summarization model call.

Keep the existing summary strategy as the default and compatibility fallback.
Local storage and retrieval require neither a Codex account nor a new memory
backend. Normal model inference still uses the configured provider; retrieved
text and injected notes become part of that provider's input.

## 2. Verified baseline

### 2.1 What to take from Codex

The inspected source separates four capabilities:

| Capability              | Confirmed behavior                                                                                                                           | Qwen Code adaptation                                                               |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `get_context_remaining` | Reports runtime-accounted remaining tokens; it can return an unknown value.                                                                  | Reuse Qwen Code's per-chat, per-route prompt accounting and threshold calculation. |
| `new_context`           | Sets a pending request; the runtime installs a fresh window without summarization. It does not write or validate notes.                      | Require a valid persisted notes revision and commit at a safe send boundary.       |
| `notes.*`               | Dedicated tools call `alpha/notes/v2/*`; file paths are virtual. The extension requires the appropriate provider and backend authentication. | Store session-scoped notes locally, behind a small built-in tool.                  |
| `history.*`             | Dedicated tools query normalized backend history.                                                                                            | Query the existing local session transcript through its validated active branch.   |

Codex retains budget reminders and a forced-rollover threshold. Its notes hint
is capped at 4,000 bytes and supplies an entry point rather than automatically
loading every note. Enabling only its low-level token-budget feature does not
provide a local notes/history implementation or automatically restore summary
fallback. These are source facts, not a claim that every deployed Codex session
uses this mode.

Qwen Code should adopt the separation of working state and recoverable history,
with two deliberate changes: capability checks before enabling rollover, and
direct injection of the small checkpoint. Generic tool-capable models should
not have to discover and read a note before knowing what task to continue.

Source references:

- [Codex budget accounting](https://github.com/openai/codex/blob/5b1d6560181680f95cde95c14ed042acc02248ed/codex-rs/core/src/session/context_window.rs#L57),
  [reminders](https://github.com/openai/codex/blob/5b1d6560181680f95cde95c14ed042acc02248ed/codex-rs/core/src/session/token_budget.rs#L161).
- [Pending window request](https://github.com/openai/codex/blob/5b1d6560181680f95cde95c14ed042acc02248ed/codex-rs/core/src/tools/handlers/new_context_window.rs#L27),
  [window replacement](https://github.com/openai/codex/blob/5b1d6560181680f95cde95c14ed042acc02248ed/codex-rs/core/src/session/mod.rs#L4385).
- [Notes/history tools and endpoints](https://github.com/openai/codex/blob/5b1d6560181680f95cde95c14ed042acc02248ed/codex-rs/ext/history-notes/src/tools.rs#L24),
  [extension gating and hint](https://github.com/openai/codex/blob/5b1d6560181680f95cde95c14ed042acc02248ed/codex-rs/ext/history-notes/src/extension.rs#L45).
- [Token-budget compaction branch](https://github.com/openai/codex/blob/5b1d6560181680f95cde95c14ed042acc02248ed/codex-rs/core/src/session/turn.rs#L1408).

### 2.2 What Qwen Code already provides

| Existing component            | Relevant behavior and consequence                                                                                                                                                                                                                                                                                       |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ChatCompressionService`      | Summarizes the entire curated history, then reconstructs summary, acknowledgment, recent file/image attachments, and runtime reminders. There is no general recent-turn tail to reuse.                                                                                                                                  |
| `LlmChat` and `LlmClient`     | Own automatic/manual compression, send admission, token accounting, cache invalidation, and compression events. Notes rollover must join these paths.                                                                                                                                                                   |
| `ChatRecordingService`        | Appends UUID/parent-UUID records. A `system/chat_compression` record already stores `compressedHistory: Content[]` for resume.                                                                                                                                                                                          |
| Recorder strict writes        | `recordChatCompression()` is currently fire-and-forget; inactive recorders can silently ignore ordinary appends. `appendRecordStrict()` rejects unavailable writers and awaits the actual write. The normal writer already fsyncs each JSONL append; lease mode additionally fences ownership and checks file identity. |
| `SessionTranscriptReader`     | Provides bounded reads, frozen snapshots, active-branch resolution, and selective restore. It can underpin history retrieval without another transcript store.                                                                                                                                                          |
| Session search and references | Picker search scans physical logs and does not enforce the current branch. `@session` references omit tool-result bodies. Neither is the required history tool.                                                                                                                                                         |
| Subagents                     | Their `LlmChat` does not use the main session recorder; they have separate agent transcripts. Sharing the parent's notes would be incorrect.                                                                                                                                                                            |

The session log is the recorded canonical conversation, not a guarantee of full
raw provider or tool output. Large results may already be truncated and point
to temporary artifacts; reasoning and media require separate handling. History
retrieval must report these limits instead of claiming lossless recovery.

Key source locations at the Qwen baseline:

- [Summary construction](../../packages/core/src/services/chatCompressionService.ts),
  `compress()` around lines 535 and 1095;
  [history installation](../../packages/core/src/core/llm-chat.ts), around 2733.
- [Recording contracts and strict append](../../packages/core/src/services/chatRecordingService.ts),
  around 259, 518, 1453, and 2518;
  [checkpoint replay](../../packages/core/src/services/session-api-history.ts), around 191.
- [Transcript reader](../../packages/core/src/services/session-transcript-reader.ts),
  `readPage()` and selective restore;
  [session lifecycle](../../packages/core/src/services/sessionService.ts),
  search and fork.

## 3. Goals and first-release scope

The first release covers a main conversation with a writable, recoverable local
session transcript: interactive CLI, headless CLI/SDK, and ACP-backed sessions
when they meet that condition. It supports proactive model rollover, automatic
budget-triggered rollover, `/compress`, resume, and existing supported
fork/rewind boundaries.

Use one checkpoint per session and literal history retrieval. Multi-file notes,
cross-session or cross-agent searches, embeddings, a new database, and a notes
editor UI are follow-ups. Auto Memory, `QWEN.md`, `/remember`, `/dream`, and
external memory providers remain separate features with different lifetimes.
Subagents, inherited side-task replay, and chats without a suitable recorder
retain the existing compaction behavior in this release.

## 4. Proposed design

### 4.1 Activation and ownership

Add one setting under the existing compression object:

```json
{
  "model": {
    "chatCompression": {
      "strategy": "notes"
    }
  }
}
```

Accepted values are `summary` and `notes`; the default is `summary`.
`/settings` exposes **Chat Compression Strategy**, with **Summary** and
**Notes and History** options, using the same `settings.json` property.
The change requires restarting Qwen Code; resuming inside the same process
does not reload this setting. Changing strategy does not rewrite active history.

Enable notes rollover only when the current chat owns an active recorder,
strict persistence is available, history can resolve its active branch, and all
four required tools survive the effective tool/permission policy. Otherwise,
report the concrete reason once and use summary compression. Recheck readiness
on resume, model/tool-policy changes, and before every rollover. A provider name
or subscription must not determine eligibility.

Retain the recorder's two existing write modes. Normal CLI/headless sessions
use their current single-writer assumption and await the strict append, which
reaches `jsonl.writeLine()` and `appendFile({ flush: true })`. Leased ACP sessions
also retain their ownership and file-identity checks. Do not use the lease-only
`hasWriteOwnership()` as a universal readiness check. This feature does not
extend the cross-process writer protocol: concurrent ordinary CLI writers to
one transcript are outside the first-release contract, and a detected integrity
conflict must stop the transition.

Bind the controller and tools to the owning chat and recorder. Resolve storage
through that session's runtime and project, including remote runtimes. Local
means local to the runtime executing Qwen Code. Do not obtain a parent session
or primary daemon runtime as a fallback. This proposal adds no daemon route.

### 4.2 Canonical notes and Markdown projection

Reuse the transcript's storage directory:

```text
<Storage.getProjectDir()>/chats/<session-id>.jsonl
<Storage.getProjectDir()>/chats/<session-id>.notes.md
```

The actual default is under the configured runtime base's `projects` tree;
do not copy the outdated `~/.qwen/tmp/...` comment as the storage contract.

The JSONL is the replay authority. Each notes write appends a
`system/session_notes` record containing `version: 1`, `windowId`,
`sourceLeafUuid`, and the complete checkpoint `text`. The record's existing
UUID is its notes revision. The host captures `sourceLeafUuid` from the
substantive transcript frontier actually included in the model request that
generated the notes call, and carries that observation through tool execution.
It must not stamp the latest disk leaf at write time: user input and ordinary
tool results can already be recorded before this model response has seen them.
Validate the observed frontier against the current frontier inside the serialized
append operation; reject a stale write instead of upgrading its coverage.
Treat a notes call mixed with ordinary tool calls as stale regardless of their
completion order. The CLI observes the original request after accepting any
queued steering, before tool execution; the OpenTUI delivery boundary includes
its deferred recordings. ACP binds the persisted user record UUID to resolved
input parts so images, hooks and expanded commands do not break coverage.
A cancelled or locally handled input releases its pending delivery marker; it
does not make an old note fresh. The built-in ACP `/compress` is recorded as
existing slash-command bookkeeping rather than a new model-facing user request. Use relative record references; never persist a parent
session ID or an absolute notes path inside this payload.

Derive the current `windowId` from the latest compression checkpoint UUID on
the active chain, or its first substantive record UUID before the first compression.
Creation metadata is excluded because forks can replace it. A new
window uses its committed compression record UUID. These identities survive
resume and fork without another window ledger. Notes from the preceding window
remain readable, but only a fresh write in the current window can authorize
the next notes rollover.

Write the canonical record through a strict recorder method, then atomically
materialize the Markdown sidecar using a temporary sibling and rename. The tool
reports success only after both operations succeed. A projection failure can
leave a recoverable canonical revision, but it cannot authorize a rollover.
Resume reconstructs the sidecar from the current active chain. Direct edits to
this generated file are not automatically imported; a future explicit import
can add that capability without creating two authorities.

Limit checkpoint text to both 16 KiB UTF-8 and
`min(2048, floor(contextWindowSize * 0.1))` estimated tokens. Reject oversized or
empty writes with a useful error; do not silently truncate them. These are
initial internal limits, not new configuration knobs. The prompt recommends
goals, user constraints, decisions, completed work, failed approaches, next
steps, and exact history references; it does not mandate a rigid Markdown schema.

Reading a persisted note retains the fixed 16 KiB and 2,048-token bounds. After
switching to a smaller model, the old note remains readable so it can be
shortened. Writes and rollover eligibility additionally enforce the current
model's 10% budget; reading an oversized old note does not authorize a reset.

### 4.3 Model tools

Use ordinary built-in function tools so all supported tool-capable providers
can use the same contract. They operate on the current session only.

| Tool                    | Initial contract                                                                                                                                                                                                                                                                    |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session_notes`         | `action: read \| write`; `write` takes complete `text` and returns the persisted revision and coverage reference. There is no caller-supplied path. `read` returns the latest valid note and revision.                                                                              |
| `session_history`       | `action: list \| search \| read`; list/search return opaque record references and bounded previews; read accepts a returned reference and a text range. Literal, case-sensitive search accepts an optional role filter. All operations support bounded pagination where applicable. |
| `get_context_remaining` | No arguments. Returns current window ID, estimated input usage, remaining tokens until automatic compaction, remaining hard-limit headroom, and estimate provenance. Unknown counts are explicit.                                                                                   |
| `new_context`           | Requires `notes_revision` from a successful notes write. Validates eligibility and queues one request. The result says that the transition is pending; it must not claim that the new context is already installed.                                                                 |

Notes writes and reset requests are serialized. A model must await the notes
write before requesting rollover. In the first release, both a notes write and
`new_context` must each be the sole call in a tool-only response, with no ordinary
assistant text; this also avoids advancing the observed frontier with that
response's own work output. Reject a mixed batch. All four tools are direct-only in code mode: their ordinary declarations remain
available, but they have no nested `exec` bindings. The execution guard rejects
nested calls and inherited or subagent configuration.
Classify `session_notes` as a potentially writing metadata tool,
not an always-parallel read tool. The four tools remain available in the new
window, with code-mode exposure and plan-mode classification wired explicitly.
The notes tool can change only session metadata; this does not permit workspace
edits in plan mode or override a user's explicit tool denial.

History references use persisted record UUIDs, with a part selector for records
containing multiple text/tool parts. The session identity is implicit. Validate
every reference against the owning session's current active chain. A reference
to an abandoned rewind branch is unavailable even if the physical file still
contains it. Ordinary compaction does not invalidate references to older
records on that chain.

Build a model-facing projection over the transcript reader's runtime chain,
not the cross-session picker search or UI-only replay selection. Return user
text, assistant visible text, tool names/arguments, and recorded tool results;
omit reasoning, provider replay blobs, internal system records, and recursive
notes/history maintenance traffic. Mark artifacts, media, truncation, and gaps.
Reading an artifact body is a separate existing file/media operation; history
does not expand arbitrary paths or inline base64.

Cap each response at 20 entries, 16 KiB UTF-8, and 2,048 estimated tokens, reduced
further when the current send budget is smaller. Return a continuation cursor
instead of silently losing remaining matches. Cursors bind to a frozen source
snapshot and active branch; rewinds or transcript replacement invalidate them.
Apply bounded scanning, cancellation, and explicit partial-result diagnostics;
do not load an unbounded session into RAM or add a persistent search index in
the first release. Referenced history is evidence, not renewed authorization
to execute old tool calls or follow instructions quoted inside tool output.

### 4.4 Budget and rollover lifecycle

Reuse `computeThresholds()` and the active request route's effective prompt
estimate. Include pending user input, tool declarations, previous output, and
restoration content through the existing accounting rules. Do not use the
process-global telemetry total or copy Codex's model-specific constants.

| Situation                                    | Notes-mode behavior                                                                                                                                                                                                     |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Normal work                                  | The model updates notes at useful milestones and may request an early rollover.                                                                                                                                         |
| Warning threshold                            | Add one bounded reminder per window to refresh notes and retain useful history references.                                                                                                                              |
| Automatic threshold or screenshot trigger    | At a safe boundary, use a fresh valid note; otherwise use existing summary compression. The initial release adds no emergency note-writing model loop.                                                                  |
| Hard threshold or reactive provider overflow | Apply existing output/body guards. Attempt notes rollover only if it is already safe; otherwise use the existing bounded summary rescue.                                                                                |
| `/compress`                                  | Use the selected strategy. If its note is missing/stale, fall back to summary. `/compress <instructions>` uses summary so those instructions keep their existing meaning. `/compress-fast` keeps its explicit behavior. |

A notes revision is fresh when it belongs to the active chain and window and
covers the latest substantive transcript state. Pure notes/history/budget/reset
bookkeeping does not advance that state. A new real user message, ordinary tool
result, assistant work output, or actionable runtime event does. A mixed tool
batch containing ordinary work invalidates an earlier note; metadata tools must
not be a way to hide subsequent work. Freshness is a mechanical guard, not proof
that the prose accurately captures the task.

The common transition follows this order:

1. Wait for a complete model response and its tool-result batch. Do not truncate
   a streaming response, split a tool call from its result, or reset a foreground
   tool operation in flight. Queue fresh user input through the existing send lock.
2. Validate the notes revision, active branch, recorder state, pending input,
   and request route. Consume only one pending reset. Run `PreCompact` under the
   existing trigger semantics, preserve its returned context, and recheck state.
3. Build the candidate history and verify it is smaller, fits below the automatic
   target with usable output room, and has valid provider message ordering.
   Perform every rejectable size/protocol guard before recording the checkpoint.
4. Strictly append one `system/chat_compression` checkpoint with the complete
   `compressedHistory`, existing completion metadata, and additive notes metadata:
   `strategy: notes`, new/previous window IDs, notes revision, and covered leaf.
   Confirm this specific append; `recordChatCompression(); await flush()` is
   insufficient because an inactive recorder can silently skip the append.
5. Once the commit is durable, install that exact history, update per-chat token
   estimates, invalidate the same caches as ordinary compression, and emit the
   completion event and `PostCompact` once. Restart after a crash uses the same
   checkpoint. An abort after durable commit does not revert the persisted state.

One compaction attempt owns the hooks, including a notes attempt that falls
back to summary. Reuse already obtained `PreCompact` context on fallback rather
than firing a side-effecting hook twice. A summary fallback in a notes-enabled
chat uses the same durable commit boundary. Emit no completion or `PostCompact`
for an uncommitted candidate.

Model-requested `new_context` uses the existing `auto` hook trigger; the slash
command uses `manual`. For notes rollover, `PostCompact.compact_summary` carries
the committed checkpoint text. Move the notes/fallback post-hook notification
out of pre-commit summary construction; wrapping that code with another hook
would incorrectly fire it twice.

Keep the commit inside the existing serialized session operation boundary.
Do not enqueue a strict write and wait for it from inside its own recorder
queue callback. New input or an abort before the strict append is accepted
cancels the pending reset; the next attempt must capture the new state. Once
that append starts, do not cancel or roll back its write: input/abort arriving
during I/O is handled after the commit boundary, or under write-failure handling
if the append fails. A bare `new_context` with missing
or stale notes returns an actionable error and leaves history intact.

### 4.5 New-window content

Rebuild the existing system instructions, effective tools, permissions, and
environment. The replacement conversation contains:

- A recognized compression/restoration wrapper with the bounded checkpoint
  text, previous window ID, notes revision, and history-retrieval hint. The new
  window ID is the committed compression record UUID and is available through
  `get_context_remaining`.
- The latest actual user request already consumed by the old window, selected
  from recorded provenance and including consumed mid-turn steering, preserved
  verbatim with its source UUID inside the synthetic
  restoration prefix. Do not duplicate it as another ordinary user turn.
  Pending input is appended exactly once. Older user requests
  remain addressable through history and must be represented in the notes when
  still relevant.
- Existing required runtime reminders, active plan/goal state, tool-discovery
  state, and bounded recent file/image restoration according to current policy.

Use valid `Content[]` role alternation and the recognized compression prefix.
Do not turn notes into a synthetic user turn that rewind or UI history mapping
counts as a human prompt. Earlier messages are removed only from active model
input, not from the canonical transcript. A new context window does not create
a new session, reset usage budgets, or cancel background tasks.

Exactly-once pending input must hold in the persisted checkpoint, live history,
and cold replay. A pending user message or ordinary tool result may have been
recorded before the checkpoint even though it has not yet been sent. Such unseen
input invalidates a proactive notes reset. If compression falls back to summary,
the candidate must contain that pending content once, retain the matching call
for a pending tool result, and tell the caller it has already included it.
Appending it only to memory after commit loses it on
resume; selecting it as the old window's latest user request duplicates it.

Refresh restoration attachments before sizing; images are not assumed to be
recoverable from textual history. If the mandatory content cannot fit, reject
the notes candidate and follow the failure behavior below. Never trim a user
constraint or a note silently to report a successful transition.

### 4.6 Failure, resume, fork, and cleanup

| Condition                                                       | Required outcome                                                                                                                                                                                             |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Notes are missing, stale, oversize, or projection repair fails  | Explicit reset fails without changing history; automatic/manual compression uses summary while the recorder is healthy.                                                                                      |
| Recording is disabled from session start                        | Use existing summary mode. Do not create notes/history storage against the user's setting.                                                                                                                   |
| Writer is lost, inactive, or has failed after notes mode starts | Preserve the active history and stop the transition under existing session-write failure semantics. Do not bypass the failed writer with a summary reset.                                                    |
| Neither notes nor summary can produce an admissible request     | Surface the existing recoverable compression failure; retain history and notes. No empty-window fallback or unbounded retry.                                                                                 |
| Process dies during commit or Markdown rename                   | Replay the last complete valid canonical record, repair the projection, and use existing partial-tail/integrity handling. Never prefer a newer orphan sidecar.                                               |
| Resume                                                          | Restore compressed history, window metadata, and latest valid notes on the active branch. Include notes in selective cold restore used by ACP/daemon, not only the full-file loader.                         |
| Fork                                                            | Copy canonical records using existing fork rules, retain stable record references, and materialize an independent sidecar in the destination session. No writes flow back to the parent.                     |
| Rewind                                                          | Use existing supported targets, clear pending resets, invalidate cursors, and regenerate notes from the resulting branch. Do not resurrect post-target notes or relax current compressed-turn restrictions.  |
| Archive/delete/retention                                        | Move or delete the Markdown sidecar with its transcript through existing session maintenance ownership. Clear in-memory cursors/caches. Rebuildable sidecars do not justify an independent retention system. |

Old transcripts have no notes metadata and retain existing replay behavior.
The additive checkpoint still carries ordinary `Content[]`, allowing an older
reader to recover the installed conversation even though it cannot offer notes
tools. Do not promise full downgrade compatibility: new record subtypes must be
recognized by the new validator, and older binaries may report diagnostics.

## 5. Integration points and consumers

| Area                                                                                                   | Required implementation work                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config/config.ts`, CLI settings loading/schema                                                        | Add and validate `model.chatCompression.strategy`; bind readiness to the actual chat. Ensure effective tool policy is respected.                                             |
| New `services/session-notes-service.ts` and `services/session-history-service.ts`                      | Own bounded notes projection and model-facing active-chain history retrieval. Reuse recorder/reader services; no provider-specific backend.                                  |
| New `tools/session-context.ts` and `services/session-notes-state.ts`                                   | Add schemas, registrations, code-mode exposure, and session-bound execution. Audit the tool-name inventory, policy, and plan-mode consumers.                                 |
| `core/llm-chat.ts`, `core/client.ts`, `services/chatCompressionService.ts`                             | Use one strategy decision and one commit path for proactive, automatic, manual, hard-limit, and reactive-overflow entry points. Preserve reset callbacks and hook ownership. |
| `services/chatRecordingService.ts`, `session-writer-lease.ts`                                          | Add notes records and an awaitable compression commit using existing strict writes and ownership checks. Reuse the lease implementation.                                     |
| `transcript-records.ts`, `session-api-history.ts`, `session-transcript-reader.ts`, `sessionService.ts` | Recognize payloads, restore notes in selective projections, validate references, and cover fork/rewind/archive/delete.                                                       |
| Prompt assembly and `core/environmentContext.ts`                                                       | Add notes guidance only when tools are available; recognize the restoration prefix and preserve cache/skill/memory invalidation.                                             |
| CLI Ink/OpenTUI history mapping and compression display                                                | Keep synthetic notes out of user-turn counting. Display a notes rollover distinctly from a generated summary.                                                                |
| ACP `Session.ts` / `acpAgent.ts`, SDK stream consumers, daemon/Web Shell                               | Consume the same compression outcome; avoid an ACP summary before a second notes reset in `LlmChat`. Thread additive strategy metadata through existing events where needed. |
| `agents/runtime/agent-core.ts` and agent transcripts                                                   | Explicitly remain on summary in the first release; verify no parent recorder/notes access through shared configuration.                                                      |

An absent strategy field preserves existing summary/fast marker behavior; it
must not cause all historical `/compress-fast` markers to be reclassified as
summaries. No provider wire-format rewrite or new public daemon API is required.
Runtime-only metadata stays out of model-visible JSONL retrieval results.

Tool registration has separate normal, bare-mode, and execution-environment
paths with early returns. Each path must either install the complete bundle for
an eligible main chat or explicitly retain summary mode. An implementation that
only registers tools on the normal path does not meet this contract.

## 6. Decisions and tradeoffs

| Decision                                           | Reason                                                                                                   |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| One bounded checkpoint                             | Enough for goals, state, next steps, and history references; avoids a second file-management product.    |
| Canonical log plus generated Markdown              | Supports inspection and branch-correct recovery using one replay authority.                              |
| Inject checkpoint text on reset                    | Removes a recovery tool round trip and a fragile dependency on model compliance.                         |
| Dedicated scoped tools                             | Work with hosted, sandboxed, and read-only-workspace flows without granting arbitrary filesystem access. |
| No final summarizer on a successful notes rollover | The main model maintains state incrementally; no repeated full-history summary is needed.                |
| Summary default and fallback                       | Notes quality and retrieval behavior must be measured across models before changing the default.         |
| Reuse existing thresholds initially                | Preserves established safety margins while the new handoff behavior is evaluated.                        |

## 7. Constraints and risks

- A fresh note can still be inaccurate. The transcript and explicit references
  make omissions recoverable, but do not prove that the model will recover them.
- Notes writes, retrieval calls, and extra tool schemas consume tokens. Removing
  summarization calls alone does not establish a total cost or latency benefit.
- A very large incoming message can skip the warning interval. Summary rescue
  remains necessary; the system must never require another model call after
  there is insufficient context to make it safely.
- Session logs may contain sensitive user/tool text. Use the existing local
  storage protections; keep the sidecar under the runtime data directory with
  restrictive file permissions. Do not add notes/history content to ordinary
  telemetry. Existing explicit prompt logging is still governed by its setting.
- A tool denial, model switch, or lost writer can make the complete mechanism
  unavailable. Revalidate the bundle and preserve pending work on failure.
- This feature crosses core recording, replay, and tool boundaries. Implement
  it in reviewable stages and apply the repository's core maintainer review
  rules to the eventual code changes.

## 8. Validation and acceptance criteria

The E2E plan and results are in `.qwen/e2e-tests/local-notes-compaction.md`;
the deterministic localhost-model fixture is
`.qwen/scripts/local-notes-compaction-e2e.mjs`. The global CLI baseline was
verified before implementation. Runtime verification uses the local build,
focused package tests, build and typecheck. These checks verify the protocol
and persistence; they do not establish a model-quality or cost advantage.

Local checks cover repeated notes rollover without a summarizer, history
retrieval, restart/projection repair, invalid revisions and mixed tool responses,
the settings selector, branch lifecycle, bounded CJK content, delayed/failed
checkpoint writes, and lost-lease projection protection. ACP tests cover
resolved input binding, cancelled commands, and built-in/custom `/compress`;
OpenTUI tests cover observation after delivered steering is recorded.
Full ACP/Web Shell sessions, other provider protocols, process-crash injection,
and paired real-model quality/cost evaluation remain follow-up validation before
wider rollout. The evidence list below defines that broader acceptance target.

Required evidence:

1. **Handoff without a summarizer:** carry a long task through at least three
   windows, preserve its goal and steering, and recover a deliberately omitted
   identifier/tool result through `session_history`. Count model requests to
   show that successful notes rollover sends no compression side-query.
2. **Durability:** inject inactive writer, sync failure, disk-full, partial-tail,
   and crash points around note/checkpoint writes and projection rename. Confirm
   that no uncommitted candidate replaces the active context and restart selects
   the committed branch state.
3. **Concurrency and topology:** test a notes write followed by user steering,
   a mixed parallel tool batch, abort, rewind, fork, and session rotation. Reject
   stale revisions and branch-invalid history cursors; parent and child notes
   must remain independent.
4. **Bounded retrieval:** test long and CJK-heavy logs, tool-call/result pairing,
   large truncated outputs, unavailable media/artifacts, partial scans, and
   pagination. Verify byte/token ceilings and no abandoned-branch results.
5. **Protocol and surfaces:** exercise CLI, headless SDK, ACP and Web Shell;
   OpenAI-compatible and other supported provider converters; plan/code modes;
   hooks, manual compression, automatic triggers, hard/HTTP-overflow rescue,
   compression events, and synthetic-turn rewind mapping. Subagents remain
   isolated on the existing strategy.
6. **Compatibility:** summary default, recording disabled, legacy transcripts,
   `/compress <instructions>`, `/compress-fast`, managed memory, skills, goals,
   file caches, and screenshot restoration keep their declared behavior.
7. **Evaluation before rollout:** compare task completion, exact constraint
   retention, recovery success, total tokens, time, summarization calls, and
   fallback frequency against summary mode on paired long-task runs. Record
   notes quality failures; do not infer a quality win from lower token counts.

Acceptance requires the first six groups to pass and the seventh to be reported
before widening the experimental rollout. Both language versions must stay in
sync with any implementation decisions.

## 9. Delivery stages and open questions

1. Land canonical notes records, strict checkpoint commit, bounded history
   access, and branch-aware recovery tests behind the strategy setting.
2. Wire the four tools, prompt guidance, candidate construction, thresholds,
   fallback, and existing compression consumers as one usable opt-in feature.
3. Run the paired evaluation and refine prompts/internal budgets. Decide on
   broader rollout only from those results.

Open questions for evaluation: Is the initial 2,048-token checkpoint sufficient
across model families? How frequently should models update it to balance cost
and freshness? Does the bounded transcript reader need a rebuildable local
search cache at real session sizes? Should multi-file notes or independently
recorded subagents be the next increment? None blocks the first-release design.

## 10. Related issues and alternatives

Existing open and closed issues were searched for `compaction`, `notes`,
`compression memory`, `new_context`, `notes context`, and `笔记 压缩` on
2026-09-19. No issue with this complete local-notes rollover scope was found.

| Issue                                                                                           | Relationship                                                                                                                   |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| [#7021 — Better Context & Memory](https://github.com/QwenLM/qwen-code/issues/7021)              | Umbrella tracker for context/memory reliability.                                                                               |
| [#10151 — Structured Auto Memory](https://github.com/QwenLM/qwen-code/issues/10151)             | Cross-session knowledge recall; its lifetime and migration scope differ from per-session working notes.                        |
| [#4592 — Summary plus restoration attachments](https://github.com/QwenLM/qwen-code/issues/4592) | Closed predecessor describing the current compression composition, which remains the fallback.                                 |
| [#5760 — llama.cpp slot save/restore](https://github.com/QwenLM/qwen-code/issues/5760)          | Backend-specific model-state reuse; local notes/history operate at the conversation layer across providers.                    |
| [#621 — Context management system](https://github.com/QwenLM/qwen-code/issues/621)              | Broad older proposal for semantic pruning and vector memory, without this concrete handoff contract.                           |
| [#8356 — Recording after abort](https://github.com/QwenLM/qwen-code/issues/8356)                | Relevant failure report; readiness must be demonstrated by the active writer and exact append, not assumed from configuration. |
