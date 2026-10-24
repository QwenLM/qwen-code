# Selective session restore, phase 2: sidecar-backed index basis

- Status: Draft (design-only change; no runtime behavior)
- Base design: [2026-08-08-selective-session-restore.md](./2026-08-08-selective-session-restore.md) (projection shape, replay options, release discipline, compatibility constraints)
- 中文版:[2026-09-10-selective-restore-index-basis.zh-CN.md](./2026-09-10-selective-restore-index-basis.zh-CN.md)
- Enabling change: PR #11527 (opt-in SQLite session-index sidecar, `experimental.sessionIndex`)
- Related: #11433 (SQLite evaluation), #11493 (in-memory index-cache admission cliff), tracks #8678 (bounded hydration)

## 1. Problem statement

The existing selective-restore design already provides a correct, consumer-specific cold projection (`readRestoreProjection` / `readLiveRestoreProjection`). But its own non-goal section names what is still paid on every cold restore: **without a durable index, a cold restore still scans the transcript once and remains O(file bytes)** — and worse, the in-memory copy of that scan is thrown away when it doesn't fit the 32-entry / 64 MiB index cache, so:

- daemon restart ⇒ every resumed/attached session pays a full JSONL read + parse of its entire transcript before any projection or replay can be served (measured ~1.8 ms/MB on the #11433 benchmark; 365 ms for a 203 MB session — seconds for the multi-hundred-MB sessions we see in production), per process lifetime;
- working sets whose combined index estimate exceeds the in-memory budget degrade to _every read = full rescan_ (#11493);
- TUI `--resume`, ACP `session/load`, daemon live-task restore, and the prompt ledger all go through `SessionService.loadSession`, i.e. **full** read + `reconstructHistory` + `buildApiHistoryFromConversation`, with no record/token truncation after that — the transcript is parsed wide even though the model context is later bounded by `chat_compression` anyway;
- sessions beyond 256 MiB can't even take that path: projections throw `SessionTranscriptTooLargeError`, the full loader (active state) has no cap at all.

The durable sidecar from #11527 (`sessions` catalog + `records` byte-offset index, incrementally maintained, JSONL-authoritative) is exactly the missing piece the base design calls "the checkpoint follow-up": it makes index existence a per-project, restart-surviving property instead of a per-process guess.

## 2. Scope

Two slices, deliberately separable:

### 2.1 Slice A — sidecar-backed projection basis (behavior-neutral)

The projection's index computation (active chain, replay selection, hint candidates) is re-derivable byte-identically from the `records` table — it is the same derivation the sidecar's turn navigation already runs with full parity coverage (`session-index/parity.test.ts`). This slice:

- extends the `records` schema (additive, schema-versioned) with the hint columns the projection reducer needs beyond turn boundaries (compression candidates, UI-telemetry and attribution positions, file-history positions, artifact side-record markers, goal-state / goal-card candidates, background-notification task ids — most of which are fully discriminated by `(type, subtype, systemPayload)` at sync time);
- routes `readRestoreProjection` / `readLiveRestoreProjection` through the same provider lookup the turn path already uses: sidecar hit → SQL row subset + `pread` of selected segments (uuid/sessionId-verified, identical typed errors); any provider failure → today's `buildIndex(file)` path;
- keeps `loadSession` semantics and output shape untouched — no behavior change intended or claimed; existing suites plus an extended parity corpus (projection outputs across both modes) are the proof.

Expected effect (same corpora): cold projection for a 203 MB session drops from ~365 ms + one full in-memory index to tens of milliseconds, restart-surviving, and the >64 MiB admission cliff ceases to exist on this path.

### 2.2 Slice B — bounded replay by default on resume paths (behavior change, opt-out-able)

With a cheap index basis, the base design's bounded-hydration goal becomes free to flip on:

- daemon/ACP resume paths (`acpAgent.loadSession`, `sessionService.loadSession` via the ACP-embedded config flow) default to `replay: { kind: 'recent', limit, hideInheritedHistory }` with `limit` derived from the project's `historyPageSize` (proposed default: `max(2 × historyPageSize, 200)` records, still turn-aligned and under the existing 4 MiB page budget), so a resumed session hydrates with its last page of records instead of the whole transcript;
- model context is _unchanged_ by this: it keeps the exact `buildApiHistoryFromConversation` `chat_compression` + tail selection — that was never the full transcript by design;
- pure-interactive CLI `--resume` (no host projection source) is a separate, explicit gate: it may keep full hydration initially (TUI scroll-back semantics differ from a bounded web page) or adopt the same default behind a settings key (`experimental.restoreHistoryWindow`), decided with maintainers — it is NOT bundled into slice B's default;
- `replay: { kind: 'all' }` must remain available for legacy clients that omit `historyPageSize`, exactly as the base design's compatibility constraints require; and for uncompressed legacy sessions the reducer keeps reading the complete model-facing history (the existing correctness rule the base design treats as non-negotiable).

Rollback: slice B reverts to `replay: all` defaults; slice A reverts by disabling the sidecar flag. Neither migrates data.

### 2.3 Explicit non-goals (unchanged from the base design unless listed)

- No authoritative lifecycle/checkpoint store; JSONL stays sole authority.
- No compaction/`chat_compression` behavior changes; no `readPage` rework; no `readRestoreProjection` contract changes.
- Live-task read/wait/startup and realtime startup-context full-content reads are a separate consumer contract (base design §Non-goals) — untouched.
- The 256 MiB daemon-restore cap (`413 transcript_too_large`) is preserved verbatim, including on the sidecar basis: sidecar-basis projections throw the same typed error instead of serving unbounded.
- The double full load in the writer-lease flow is reduced by the base design's projection work, not revisited here.

## 3. Design

### 3.1 Records hint columns (slice A)

Additive per-row flags derived during sync from `(type, subtype, systemPayload)` — no payload bytes stored; selection runs on this subset, payloads come from the same byte-offset segments used today:

- compression/telemetry/attribution: `chat_compression` candidates (with active-chain membership test), UI-telemetry record mark, latest-attribution mark;
- rewind/fork/artifact:`user`-turn parent candidates (already derivable from `navKind`/`conversation`), file-history record marks, artifact side-record marks (including the abandoned-branch exclusion the active-chain computation already applies);
- goals: v2 goal-state candidates with a validity flag (malformed-state recovery parity), legacy goal-card slash-command marks including position (the existing precedence: newest valid v2 wins; unsupported stays unsupported);
- background notifications: last `task-notification` task id per turn.

Anything not fully determined by these three fields is out — the base design's hint inventory is the checklist; each hint that ends up needing payload text stays segment-selected at read time, as today.

### 3.2 Projection basis routing (slice A)

`SessionTranscriptReader.readRestoreProjection` gains an internal index-source parameter (`fileScan`, default | `sessionIndexStore` when the flag is enabled and a store resolves). The derivation function is the single one already parity-tested for turn navigation; both basis modes must produce byte-identical projection outputs for the same bytes — verbosely: new parity tests run projection-mode reads across both bases over the extended corpus (compression-on-chain, no-compression legacy chain, rewind branches, forked/side-task boundaries, goal-state v2 valid/malformed/none, goal-card mixes, notification marks) and assert deep equality of `runtime` + `replay` fields. The 256 MiB cap, snapshot continuity checks, failure taxonomy, and the "never fall back to the old full loader" rule from the base design are preserved exactly — a basis failure falls to `buildIndex(file)` only before index construction, never after selection begins.

### 3.3 Bounded resume default (slice B)

Where `loadSession` is currently invoked on resume paths, the call becomes a projection request with the base design's `replay` selection — reusing the already-implemented ACP `projectionSource` flow (`preloaded` / `after_writer_lease`). The default window follows the client's `historyPageSize` (2.2); results surface through the existing `historyPageSize`/`historyHasMore`/`historyAnchorRecordId` pagination surface. Pure CLI `--resume` is gated separately (2.2). Consumers of `ResumedSessionData` outside the daemon restore path (export, archive, fork, TUI) are untouched.

`historyGaps` semantics, sources completeness, `fileHistorySnapshots`, and `artifactSnapshot` are defined at file level by the projection exactly as the base design requires — one reason the naive "truncate `messages`" shortcut was ruled out there and remains ruled out here.

### 3.4 Rollout

1. PR-1 (slice A): schema hint columns + projection basis routing + parity extension. No behavior change; same flag governs.
2. PR-2 (slice B): daemon/ACP resume default window + compatibility guard + telemetry (`restore_index.basis`, `restore_replay.selected_records`, restore durations per class). Maintainer signoff on the default-window compatibility change is a separate, named approval (mirroring the base design's sizing rulings).
3. CLI `--resume` gate decision folded into PR-2's review; settings key added only if the maintainer consensus is to bundle it.

## 4. Compatibility and release

- Flag default stays off; slice A is inert under `file` mode.
- `loadSession` contract unchanged for non-daemon callers.
- Legacy uncompressed sessions: model-facing history remains fully read (existing correctness rule); the bounded window applies to UI replay only in exactly the base design's existing split.
- Legacy clients without `historyPageSize` keep full replay (`replay: all`), per the base design's constraints — slice B proposes narrower defaults only where the client negotiates pagination.

## 5. Files affected (anticipated)

- `packages/core/src/services/session-index/sqlite.ts` (+schema version, hint extraction at sync)
- `packages/core/src/services/session-transcript-reader.ts` (projection basis routing; no reducer contract change)
- `packages/core/src/services/sessionService.ts` (projection entry points delegate unchanged)
- `packages/cli/src/acp-integration/acpAgent.ts` (resume call → projection with default window; pure CLI gate + optional settings key)
- `packages/core/src/services/session-index/parity.test.ts` (projection-parity corpus extension)
- `docs/design/2026-09-10-selective-restore-index-basis.{md,zh-CN.md}` (this doc, both languages)
- benchmarks: cold restore per session size on the #11433 corpus, daemon-restart resume storm (N sessions × size), appended-turn invalidation

## 6. Open questions

1. Exact hint column set vs. query-time systemPayload discrimination — verify against the projection reducer's actual selection code during slice-A implementation; anything payload-dependent stays segment-selected.
2. Default window policy: records with byte budget (proposed) vs. token budget — tokens are the truer UX signal but require the payload to count, defeating the sub-file property; a hybrid (record window + byte budget, as today) is the proposed default.
3. Pure interactive `--resume`: adopt the daemon window, keep full hydration, or settings-gated — maintainer call.
4. Daemon hot-session invalidation: a resumed live session appends new turns; the next cold restore after that daemon restart must not reuse a stale window — the sidecar's indexedBytes checkpoints already bound this; the projection mode must document it.
