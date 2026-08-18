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
- No reconstruction for queued-but-never-started prompts (see Attribution guard) and none for live-entry loads.
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

The reader (`readPromptLedgerRecords`) tolerates torn tails: lines that fail structural validation are dropped, a missing file reads as empty. `danglingInFlightPromptIds` reduces records per promptId (last write wins) and returns ids whose latest record is `in_flight`, in first-appearance order.

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

Algorithm:

1. Read the ledger; if there are no dangling in-flight prompt ids, return (nothing to reconcile).
2. Let `target` be the last dangling id. **Attribution guard**: scan for the last `in_flight` record in the ledger; it must belong to `target`. Under FIFO prompt settlement this holds whenever the data is real (the newest admitted prompt is the one whose transcript tail is visible). If it does not hold, the ledger interleaving is anomalous and the tail cannot be attributed — skip (fail closed). Note the guard compares against the last _in_flight_ record, not the last record: in `[if p1, if p2, term p1]` (p1 settled while p2 runs, daemon dies) the tail belongs to dangling p2 even though a terminal sits after its in_flight line.
3. Load the transcript and build the api history (`loadSession` → `buildApiHistoryFromConversation`), then classify the last `TURN_INTERRUPTION_HISTORY_TAIL_COUNT` entries with `detectTurnInterruption`:
   - `none` (clean tail) → append `{"terminal":"completed","stopReason":"reconstructed_from_transcript"}`.
   - `interrupted_prompt` / `interrupted_turn` → append `{"terminal":"interrupted","code":"daemon_lost"}`.
   - transcript unreadable or history undefined → append nothing (fail closed).

Multiple dangling ids (queued scenario): only the newest can be attributed to the visible transcript tail. Older queued prompts never produced transcript content, so no verdict is possible; they stay `unknown` (omitted from `promptTerminals`).

### Load response

The serve-layer response type extends `BridgeRestoredSession` with an optional `promptTerminals` array (the trailing 64 terminal records, including reconciliation output). The bridge-level `BridgeRestoredSession` is untouched: the field is serve-layer evidence, so its type lives in the serve layer. When the ledger has no terminal records the field is omitted entirely.

## Concurrency and idempotence

- Ledger appends are single-line and synchronous; concurrent writers on one session are serialized by the OS append path and the reader's last-write-wins reduction absorbs duplicates.
- Reconciliation appends only when a dangling id exists, so a second load of the same session finds no dangling id and appends nothing (persisted verdict, single flight via `inFlightRestores`).
- A terminal record for a prompt that already has one is harmless (reduction keeps the latest), though the `terminalPublished` latch makes bridge duplicates impossible.
- `archiveSessions` / `unarchiveSessions` move the sidecar alongside the transcript (warn-only on failure), so archived sessions keep their evidence.

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
- Everything downstream of the guard (ledger read failure, transcript read failure, append failure) degrades to "no terminal emitted", never to a wrong terminal.
- Ledger write failures never affect prompt execution or shutdown flush.

## Verification Plan

- Unit-test the ledger module: append/read round-trip, torn-tail tolerance, dangling reduction, recent-terminal windowing.
- Unit-test bridge write points with the existing FakeAgent harness: in_flight on admission, terminal on completion, flush on `daemon_shutdown`, best-effort failure containment.
- Unit-test reconciliation branches with a real `SessionService` fixture: clean tail → completed, `interrupted_prompt`/`interrupted_turn` → interrupted, missing transcript → fail closed, no dangling → no-op, multiple dangling → newest only, idempotence, anomalous interleave → guard skip.
- Route-level test through `POST /session/:id/load`: field presence, omission without ledger, attached loads skip reconciliation.
- Final verification on root `npm run build` and `npm run typecheck`.
