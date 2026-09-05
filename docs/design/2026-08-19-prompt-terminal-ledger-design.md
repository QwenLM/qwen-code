# Prompt Terminal Ledger

## Problem

The daemon's turn terminal events (`turn_complete` / `turn_error`) are synthesized by the ACP bridge from agent signals and published over SSE. They are never persisted. After a daemon restart, `POST /session/:id/load` performs a cold restore whose replay is produced by the agent subprocess re-reading the session JSONL transcript (`collectHistoryReplayUpdates` → `HistoryReplayer`), which emits only `session_update` chunk-class events — never terminal events.

External orchestrators that mediate prompts by id therefore cannot resolve a prompt that was in flight when the daemon died: the replay contract "a terminal event for exactly this promptId" can never be satisfied, and the only safe answer is `unknown`.

Two building blocks already exist and this design builds on them instead of adding new state machines:

- `bridge.shutdown()` already flushes a formal error terminal (`flushPromptTerminals(entry, 'daemon_shutdown', ...)`) for every unfinished prompt through `publishPromptTerminal` — but only to memory and SSE, which die with the process.
- `detectTurnInterruption` (`packages/core/src/core/turn-interruption.ts`) is a pure read-only classifier over an api-history tail that distinguishes a clean tail from `interrupted_prompt` / `interrupted_turn`.

## Goals

- Persist one append-only ledger record per prompt admission and per prompt terminal, per session, so terminal facts survive daemon restarts.
- Reconstruct a terminal verdict for the dangling in-flight prompt of a cold-restored session by classifying the transcript tail, and expose the last 64 terminal records on the load response.
- Fail closed: when a verdict cannot be attributed, emit no terminal (the prompt stays `unknown`).
- Add no new core coupling to `acp-bridge` for the ledger; ledger writes are pure `node:fs` and best-effort.

## Non-Goals

- No backfill for sessions whose prompts predate the ledger (no ledger evidence → no reconstruction).
- No ledger truncation/compaction in this PR; records are tiny id/state lines and the sidecar follows the transcript lifecycle (archive/unarchive move it alongside).
- No reconstruction for queued-but-never-started prompts (see the attribution guard, the temporal-evidence check, and the multiple-dangling bail-out) and none for live-entry loads.
- No new SSE events and no change to replay semantics.

## Design

### Ledger format and location

Each session owns a sidecar ledger next to its transcript: `<sessionRuntimeBaseDir>/projects/<hash(workspaceCwd)>/chats/<sessionId>.ledger.jsonl`, resolved by `SessionService.getPromptLedgerPath(sessionId)`. The naming follows the existing `<sessionId>.worktree.json` sidecar convention and does not match `SESSION_FILE_PATTERN`, so directory scans ignore it.

Records are single-line JSON objects, append-only:

```json
{"v":1,"promptId":"...","state":"in_flight","at":1692000000000}
{"v":1,"promptId":"...","state":"in_flight","tailUuid":"rec-uuid","at":1692000000000}
{"v":1,"promptId":"...","terminal":"completed","stopReason":"stop","at":1692000000123}
{"v":1,"promptId":"...","terminal":"error","code":"daemon_shutdown","at":1692000000456}
{"v":1,"promptId":"...","terminal":"interrupted","code":"daemon_lost","at":1692000000789}
```

`terminal` is one of `completed | cancelled | error | interrupted`. `code` carries the flush origin (`daemon_shutdown`, `session_killed`, `channel_closed`, `session_closed`) or the normalized turn error code; `stopReason` carries the agent stop reason when present. `tailUuid` (in_flight only) is the dispatch marker: the uuid of the transcript's last record at admission, best-effort (absent when the transcript is missing/unreadable or for records written before the marker existed).

The reader (`readPromptLedgerRecords`) tolerates torn tails: lines that fail structural validation are dropped, a missing file reads as empty. The writer (`appendPromptLedgerRecord`) seals a torn tail before appending: if the file is non-empty and its last byte is not `\n` (a crash mid-append), a newline is appended first so the next record cannot fuse with the torn fragment — without the seal, one torn tail plus one fresh append loses both records.

`danglingInFlightPromptIds` reduces records per promptId (last write wins) and returns ids whose latest record is `in_flight`, in first-appearance order (admission order).

### Write points (acp-bridge)

All writes go through the module-level `appendPromptLedgerBestEffort` helper: any failure is logged via `writeStderrLine` and swallowed. A ledger problem must never block prompt execution or terminal flush.

1. **Admission** — when `sendPrompt` pushes onto `pendingPromptList`, an `in_flight` record is appended synchronously (write-ahead: the in_flight fact must be on disk before the prompt can produce a terminal). Before the append, the bridge asks the sink for the transcript's last record uuid (`transcriptTailUuid`, best-effort) and stamps it as `tailUuid` — the dispatch marker that binds cold-load evidence to this admission (see step 5 below).
2. **Terminal** — immediately after the `terminalPublished` latch is set inside `publishPromptTerminal`, the terminal record is appended. Because all four `flushPromptTerminals` scenarios (`channel_closed`, `closeSession`/`session_closed`, `killSession`/`session_killed`, `bridge.shutdown`/`daemon_shutdown`) funnel unfinished prompts through `publishPromptTerminal`, one write point covers graceful shutdown too. `daemon_shutdown` persistence therefore precedes process exit without any extra sync path beyond the append being synchronous (`appendFileSync`).

### Layering

`acp-bridge` must gain no new core coupling for the ledger (the ledger module stays dependency-free beyond `node:fs`), and the bridge cannot know the serve-layer storage layout. `BridgeOptions` therefore gains an optional injected sink:

```ts
promptLedger?: PromptLedgerSink;   // { appendSync, transcriptTailUuid? }
```

`run-qwen-serve.ts` assembles it (`createPromptLedgerSink(workspaceCwd, sessionRuntimeBaseDir)`, backed by `SessionService.getPromptLedgerPath`) and injects it at the three bridge construction sites (primary, secondary, websocket-workspace — the latter skips live-conversation entries, which have no transcript to reconcile against). Reading, reconciliation, and HTTP exposure live in `packages/cli/src/serve/prompt-terminal-ledger.ts`, which may import core.

### Cold-load reconciliation (lazy boot reconciliation)

Hook: `restoreSessionHandler` (`POST /session/:id/load`), after `bridge.loadSession` resolves and before the response, only when `action === 'load' && !restored.attached && !restored.hasActivePrompt && provenance !== 'live-conversation'`. Concurrent loads of the same session already coalesce through the existing `inFlightRestores` map, so reconciliation runs at most once per cold restore.

Algorithm (every step that cannot attribute the tail with confidence returns without appending — fail closed):

1. Read the ledger; on failure return (no evidence, nothing appended). If there are no dangling in-flight prompt ids, return.
2. **Multiple dangling ids → return.** Under FIFO admission the visible transcript tail belongs to the _oldest_ running prompt, but with several prompts dangling the tail's owner cannot be verified (the queued ones never wrote a turn). Synthesizing a terminal for any of them — including the newest — could attribute an earlier prompt's turn to the wrong id, so they all stay `unknown` (omitted from `promptTerminals`).
3. Let `target` be the oldest dangling id. **Attribution guard**: walking the ledger forward, skip the `in_flight` records of prompts that have settled (a terminal record exists for them); the last remaining `in_flight` record must be `target`'s own admission. Skipping settled prompts matters for `[A if, B if, B cancelled]` (B queued, then cancelled while A still ran): the tail belongs to A even though B's `in_flight` line is the later record — a naive "last in_flight must match target" guard would wrongly veto A with B's settled admission. In `[if p1, if p2, term p1]` (valid interleave: p1 settled while p2 runs, daemon dies) the guard passes and p2 is attributed the tail.
4. Load the transcript (`loadSession`); failure or `undefined` → return.
5. **Attribution evidence** (five checks, each closing a concrete wrong-terminal class):
   - **Dispatch marker**: when the target's `in_flight` record carries `tailUuid`, the projection must contain that record AND at least one visible write (non-`system`, with a `message`) after it. The transcript is append-only, so anything after the marker postdates admission — an identity/ordering check immune to clock skew. A marker absent from the projection, or present with no visible write beyond it, fails closed. Records without a marker (legacy, or capture failure) fall through to the temporal chain below.
   - **Projection-consistent temporal evidence**: the last transcript write that actually enters the api history the verdict runs on (non-`system` records with a `message`, mirroring `SessionApiHistoryAccumulator`) must be strictly after `target`'s `in_flight` `at`. Measuring the raw stream instead would let evidence the verdict never sees — a post-admission `ui_telemetry`/`custom_title`/… record — pass the check for a prompt that never reached the model. An empty message list (or system-only tail) fails the same check. Equality is vetoed too: both clocks are 1 ms-granularity `Date.now()` reads, so a write landing in the admission millisecond cannot be attributed.
   - **Compression fence**: a `chat_compression` record carrying a `compressedHistory` written at or after `target`'s admission → return. The accumulator swaps the whole history for the compressed snapshot, so the verdict's projection no longer carries `target`'s turn and nothing may be attributed. Marker-bearing admissions detect "after admission" by position (any compression record past the marker) so a backward clock step cannot hide the reset; marker-less admissions compare wall clocks.
   - **FIFO evidence**: the visible tail must be strictly after every _other_ prompt's settled terminal `at` (same-millisecond equality is vetoed, for the same clock-collision reason as above). Under FIFO admission `target`'s turn can only start after every predecessor settled, so an older tail belongs to that predecessor's turn. This closes the queued-never-dispatched class (`[A if, B if(queued), A term]` — A's tail predates A's own terminal, so B gets nothing) and the stale-dangling class left by restore paths that skip reconciliation (a later prompt's completed tail predates its own terminal, so the stale prompt gets nothing).
   - **Deadline fence**: if any other prompt's terminal carries `code: 'prompt_deadline_exceeded'` → return. The deadline path releases the FIFO while the wedged agent is explicitly allowed to keep streaming (DAEMON-003), so that terminal's timestamp does not fence its turn's writes: stale writes can postdate both the terminal and `target`'s admission and the temporal checks above cannot veto them. The veto is deliberately unconditional: the append-only ledger never expires records, so one deadline-exceeded prompt keeps the session fail-closed for every later dangling prompt (a missing terminal, never a wrong one). A recency bound cannot distinguish the stale case from the adjacent-overlap case without daemon-generation tracking, which the ledger does not carry.
6. Build the api history (`buildApiHistoryFromConversation`) and classify the last `TURN_INTERRUPTION_HISTORY_TAIL_COUNT` entries with `detectTurnInterruption`, then apply the **id-less tool-call guard**: when the verdict is `none` but the api-history tail's last entry is a model turn holding any `functionCall` part (with or without an id), upgrade to interrupted — `detectTurnInterruption` ignores id-less functionCalls because they cannot be paired on the wire, but reconciliation needs no wire pairing; a model tail holding a tool call means the daemon died mid tool-run.
   - `none` (clean tail) → append `{"terminal":"completed","stopReason":"reconstructed_from_transcript"}`.
   - `interrupted_prompt` / `interrupted_turn` / upgraded tool-call guard → append `{"terminal":"interrupted","code":"daemon_lost"}`.
   - transcript unreadable or history undefined → append nothing (fail closed).
7. **TOCTOU fence**: re-read the ledger immediately before the append; any change since the step-1 snapshot (the ledger is append-only, so an unchanged record count proves it) → return. A prompt admitted while `loadSession` ran appends its `in_flight` after the snapshot, and the visible tail the verdict was computed from may now belong to it — the verdict must not be stamped onto the old dangling id.
8. Append best-effort; an append failure leaves the prompt `unknown`.

**Residual attribution risk.** The dispatch marker binds evidence to the target's admission by ORDERING, not by OWNERSHIP: transcript records carry no prompt or writer identity, so any visible write landing after the marker passes the guard regardless of which writer produced it. Ordering-breakage classes are closed wherever the marker is present (a recordless predecessor's tail predates the successor's marker, a backward clock step cannot fake record order, a system-reminder-only tail contains no visible write beyond the marker), but two ownership classes survive even with a marker:

- **Recordless predecessor with continued writes**: a predecessor whose best-effort ledger appends were swallowed leaves no records while its turn keeps writing past the queued successor's marker (reachable only under compound failure: swallowed appends plus post-settle streaming, e.g. the DAEMON-003 deadline wedge whose terminal append was also swallowed).
- **Ledger-less cross-client writer**: serve and the interactive CLI share the `<runtimeBase>/projects/<hash>/chats` tree, and `/resume` lists serve-created sessions without a provenance filter; an interactive turn writes transcript records but no ledger records, invisible to every guard.

Closing ownership requires binding transcript records to a writer identity (a transcript-record schema change, tracked in https://github.com/QwenLM/qwen-code/issues/9483); until then these entrances stay fail-open by design limitation, not by evidence. Marker-less admissions — legacy `in_flight` records written before the marker existed, marker capture failure (unreadable transcript, or a final record larger than the 64 KiB tail window) — additionally fall back to the temporal evidence chain and its documented classes (recordless-predecessor inheritance, backward clock steps, non-model-record tails). Ledger records written before this change never gain a marker retroactively; they stay on the temporal chain permanently.

### Load response

The serve-layer response type extends `BridgeRestoredSession` with an optional `promptTerminals` array (the trailing 64 terminal records, including reconciliation output). The bridge-level `BridgeRestoredSession` is untouched: the field is serve-layer evidence, so its type lives in the serve layer. When the ledger has no terminal records the field is omitted entirely.

## Concurrency and idempotence

- Ledger appends are single-line and synchronous; concurrent writers on one session are serialized by the OS append path and the reader's last-write-wins reduction absorbs duplicates.
- Reconciliation appends only when a dangling id exists, so a second load of the same session finds no dangling id and appends nothing (persisted verdict, single flight via `inFlightRestores`).
- A terminal record for a prompt that already has one is harmless (reduction keeps the latest), though the `terminalPublished` latch makes bridge duplicates impossible.
- `archiveSessions` / `unarchiveSessions` move the sidecar alongside the transcript via `moveLedgerSidecar` (warn-only on failure, both directions log the full source and destination paths). When the destination already exists (a partially completed earlier archive cycle), the source is not clobbered and the move does not wedge: the source contents are appended to the destination (append-only JSONL, write order preserved) and the source is unlinked — merge semantics instead of a permanent split.
- `removeSessionFiles` deletes the ledger in both states (active and archived) alongside the worktree sidecars, so removing a session leaves no orphan evidence.
- Insight and usage scans exclude the sidecar: `DataProcessor.scanChatFiles` and `usageHistoryService.rebuildFromSessionJsonl` select `.jsonl` files but reject `.ledger.jsonl` — the ledger is not a transcript and must never be parsed as chat records or usage evidence.

### Ledger file lifecycle

The sidecar follows the transcript through every state transition: created on first admission (best-effort), moved alongside on archive/unarchive (merge semantics on collision), and deleted in both states on session removal. All paths are derived from one helper (`getPromptLedgerPathForState`) so no call site hand-assembles the file name.

## Privacy boundary

Records contain only `v`, `promptId`, `state`/`terminal`, `code`, `stopReason`, `at`. No prompt text, user content, tool input/output, or file paths are ever written. The ledger inherits the transcript directory's permissions.

## Compatibility matrix

| Daemon | Client | Behavior                                                                     |
| ------ | ------ | ---------------------------------------------------------------------------- |
| new    | new    | Cold load returns `promptTerminals`; orchestrators resolve dangling prompts. |
| new    | old    | Client ignores the unknown field; behavior identical to today.               |
| old    | new    | No ledger file → field omitted; client falls back to `unknown` as today.     |
| old    | old    | Unchanged.                                                                   |

## Fail-closed invariants

- No verdict is ever synthesized without ledger evidence of an in-flight admission.
- A verdict requires both a readable transcript tail and a passing attribution guard.
- When the admission carries a dispatch marker, at least one visible write must land beyond it (ordering-based attribution, immune to clock skew); a missing marker or no write beyond it appends nothing.
- Multiple dangling prompts never receive a synthesized terminal; their tails cannot be attributed.
- The temporal evidence is measured on the same projection the verdict uses: the last write that enters the api history must be strictly after the target's admission (same-millisecond equality is vetoed — both clocks are 1 ms-granularity `Date.now()` reads), otherwise the tail belongs to an earlier turn and nothing is appended.
- A compression checkpoint written at or after the target's admission voids the evidence chain (nothing appended).
- The visible tail must be strictly after every other prompt's settled terminal (FIFO evidence); otherwise it belongs to that prompt's turn.
- A `prompt_deadline_exceeded` terminal of another prompt voids the evidence chain: the deadline path releases the FIFO while the wedged agent may keep writing, so that terminal does not fence its turn's writes. The veto is unconditional and permanent (missing terminals over wrong ones).
- The verdict is re-checked against the ledger immediately before the append (TOCTOU fence): any record landed during the reconciliation window voids the verdict.
- Residual ordering-breakage classes (recordless predecessors, backward clock steps, non-model-record tails) survive only on marker-less admissions (legacy records, capture failure); they are documented under "Residual attribution risk" and can only degrade attribution quality under compound failures. Ownership classes (recordless predecessor with continued writes, ledger-less cross-client writers) survive even with a marker: transcript records carry no writer identity, and closing them requires a transcript-record schema change (see "Residual attribution risk").
- The ledger sidecar is created owner-only (`0o600`), matching the transcript's protection; it is never created with umask-default permissions.
- A model tail holding any tool call (id or not) is treated as interrupted, never as a clean completion.
- Everything downstream of the guard (ledger read failure, transcript read failure, append failure) degrades to "no terminal emitted", never to a wrong terminal.
- Ledger write failures never affect prompt execution or shutdown flush; ledger move failures never block archive/unarchive (warn-only).

## Verification Plan

- Unit-test the ledger module: append/read round-trip, torn-tail tolerance, torn-tail sealing (a sealed fragment cannot fuse with the next appended record), dangling reduction, recent-terminal windowing.
- Unit-test bridge write points with the existing FakeAgent harness: in_flight on admission, terminal on completion, flush on `daemon_shutdown`, in_flight recorded for queued admissions and both prompts flushed on shutdown, best-effort failure containment.
- Unit-test reconciliation branches with a real `SessionService` fixture: clean tail → completed, `interrupted_prompt`/`interrupted_turn` → interrupted, id-less functionCall tail → interrupted, missing transcript → fail closed, no dangling → no-op, multiple dangling → fail closed (nothing appended), settled-then-queued interleave (`[A if, B if, B cancelled]`) → A attributed, valid interleave (`[if p1, if p2, term p1]` on a real time axis) → p2 attributed, stale tail (last transcript write predates the admission) → fail closed, queued-never-dispatched (`[A if, B if, A term]` with A's terminal postdating its turn) → fail closed, stale dangling behind a later settled prompt → fail closed, post-admission compression checkpoint → fail closed, post-admission system-record-only tail → fail closed, idempotence.
- Unit-test the sidecar lifecycle in `sessionService`: archive/unarchive move the ledger, move failure is warn-only, destination-exists merges instead of wedging, session removal deletes both states, insight/usage scans skip `.ledger.jsonl`.
- Route-level test through `POST /session/:id/load`: field presence, omission without ledger, attached loads skip reconciliation, active prompts skip reconciliation, resume responses stay free of `promptTerminals`.
- Final verification on root `npm run build` and `npm run typecheck`.
