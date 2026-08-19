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
{"v":1,"promptId":"...","terminal":"completed","stopReason":"stop","at":1692000000123}
{"v":1,"promptId":"...","terminal":"error","code":"daemon_shutdown","at":1692000000456}
{"v":1,"promptId":"...","terminal":"interrupted","code":"daemon_lost","at":1692000000789}
```

`terminal` is one of `completed | cancelled | error | interrupted`. `code` carries the flush origin (`daemon_shutdown`, `session_killed`, `channel_closed`, `session_closed`) or the normalized turn error code; `stopReason` carries the agent stop reason when present.

The reader (`readPromptLedgerRecords`) tolerates torn tails: lines that fail structural validation are dropped, a missing file reads as empty. The writer (`appendPromptLedgerRecord`) seals a torn tail before appending: if the file is non-empty and its last byte is not `\n` (a crash mid-append), a newline is appended first so the next record cannot fuse with the torn fragment — without the seal, one torn tail plus one fresh append loses both records.

`danglingInFlightPromptIds` reduces records per promptId (last write wins) and returns ids whose latest record is `in_flight`, in first-appearance order (admission order).

### Write points (acp-bridge)

All writes go through the module-level `appendPromptLedgerBestEffort` helper: any failure is logged via `writeStderrLine` and swallowed. A ledger problem must never block prompt execution or terminal flush.

1. **Admission** — when `sendPrompt` pushes onto `pendingPromptList`, an `in_flight` record is appended synchronously (write-ahead: the in_flight fact must be on disk before the prompt can produce a terminal).
2. **Terminal** — immediately after the `terminalPublished` latch is set inside `publishPromptTerminal`, the terminal record is appended. Because all four `flushPromptTerminals` scenarios (`channel_closed`, `closeSession`/`session_closed`, `killSession`/`session_killed`, `bridge.shutdown`/`daemon_shutdown`) funnel unfinished prompts through `publishPromptTerminal`, one write point covers graceful shutdown too. `daemon_shutdown` persistence therefore precedes process exit without any extra sync path beyond the append being synchronous (`appendFileSync`).

### Layering

`acp-bridge` must gain no new core coupling for the ledger (the ledger module stays dependency-free beyond `node:fs`), and the bridge cannot know the serve-layer storage layout. `BridgeOptions` therefore gains an optional injected sink:

```ts
promptLedger?: PromptLedgerSink;   // { appendSync(sessionId, record): void }
```

`run-qwen-serve.ts` assembles it (`createPromptLedgerSink(workspaceCwd, sessionRuntimeBaseDir)`, backed by `SessionService.getPromptLedgerPath`) and injects it at the three bridge construction sites (primary, secondary, websocket-workspace — the latter skips live-conversation entries, which have no transcript to reconcile against). Reading, reconciliation, and HTTP exposure live in `packages/cli/src/serve/prompt-terminal-ledger.ts`, which may import core.

### Cold-load reconciliation (lazy boot reconciliation)

Hook: `restoreSessionHandler` (`POST /session/:id/load`), after `bridge.loadSession` resolves and before the response, only when `action === 'load' && !restored.attached && !restored.hasActivePrompt && provenance !== 'live-conversation'`. Concurrent loads of the same session already coalesce through the existing `inFlightRestores` map, so reconciliation runs at most once per cold restore.

Algorithm (every step that cannot attribute the tail with confidence returns without appending — fail closed):

1. Read the ledger; on failure return (no evidence, nothing appended). If there are no dangling in-flight prompt ids, return.
2. **Multiple dangling ids → return.** Under FIFO admission the visible transcript tail belongs to the _oldest_ running prompt, but with several prompts dangling the tail's owner cannot be verified (the queued ones never wrote a turn). Synthesizing a terminal for any of them — including the newest — could attribute an earlier prompt's turn to the wrong id, so they all stay `unknown` (omitted from `promptTerminals`).
3. Let `target` be the oldest dangling id. **Attribution guard**: walking the ledger forward, skip the `in_flight` records of prompts that have settled (a terminal record exists for them); the last remaining `in_flight` record must be `target`'s own admission. Skipping settled prompts matters for `[A if, B if, B cancelled]` (B queued, then cancelled while A still ran): the tail belongs to A even though B's `in_flight` line is the later record — a naive "last in_flight must match target" guard would wrongly veto A with B's settled admission. In `[if p1, if p2, term p1]` (valid interleave: p1 settled while p2 runs, daemon dies) the guard passes and p2 is attributed the tail.
4. Load the transcript (`loadSession`); failure or `undefined` → return.
5. **Temporal evidence**: the transcript's last `ChatRecord.timestamp` must be ≥ `target`'s `in_flight` `at`. A dangling prompt that never produced any transcript write (still queued when the daemon died) leaves the tail owned by an earlier settled turn — fail closed rather than attributing that turn to `target`. An empty message list fails the same check.
6. Build the api history (`buildApiHistoryFromConversation`) and classify the last `TURN_INTERRUPTION_HISTORY_TAIL_COUNT` entries with `detectTurnInterruption`, then apply the **id-less tool-call guard**: when the verdict is `none` but the api-history tail's last entry is a model turn holding any `functionCall` part (with or without an id), upgrade to interrupted — `detectTurnInterruption` ignores id-less functionCalls because they cannot be paired on the wire, but reconciliation needs no wire pairing; a model tail holding a tool call means the daemon died mid tool-run.
   - `none` (clean tail) → append `{"terminal":"completed","stopReason":"reconstructed_from_transcript"}`.
   - `interrupted_prompt` / `interrupted_turn` / upgraded tool-call guard → append `{"terminal":"interrupted","code":"daemon_lost"}`.
   - transcript unreadable or history undefined → append nothing (fail closed).
7. Append best-effort; an append failure leaves the prompt `unknown`.

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
- Multiple dangling prompts never receive a synthesized terminal; their tails cannot be attributed.
- The transcript's last write must postdate the target's admission (temporal evidence), otherwise the tail belongs to an earlier turn and nothing is appended.
- A model tail holding any tool call (id or not) is treated as interrupted, never as a clean completion.
- Everything downstream of the guard (ledger read failure, transcript read failure, append failure) degrades to "no terminal emitted", never to a wrong terminal.
- Ledger write failures never affect prompt execution or shutdown flush; ledger move failures never block archive/unarchive (warn-only).

## Verification Plan

- Unit-test the ledger module: append/read round-trip, torn-tail tolerance, torn-tail sealing (a sealed fragment cannot fuse with the next appended record), dangling reduction, recent-terminal windowing.
- Unit-test bridge write points with the existing FakeAgent harness: in_flight on admission, terminal on completion, flush on `daemon_shutdown`, in_flight recorded for queued admissions and both prompts flushed on shutdown, best-effort failure containment.
- Unit-test reconciliation branches with a real `SessionService` fixture: clean tail → completed, `interrupted_prompt`/`interrupted_turn` → interrupted, id-less functionCall tail → interrupted, missing transcript → fail closed, no dangling → no-op, multiple dangling → fail closed (nothing appended), settled-then-queued interleave (`[A if, B if, B cancelled]`) → A attributed, valid interleave (`[if p1, if p2, term p1]`) → p2 attributed, stale tail (last transcript write predates the admission) → fail closed, idempotence.
- Unit-test the sidecar lifecycle in `sessionService`: archive/unarchive move the ledger, move failure is warn-only, destination-exists merges instead of wedging, session removal deletes both states, insight/usage scans skip `.ledger.jsonl`.
- Route-level test through `POST /session/:id/load`: field presence, omission without ledger, attached loads skip reconciliation, active prompts skip reconciliation, resume responses stay free of `promptTerminals`.
- Final verification on root `npm run build` and `npm run typecheck`.
