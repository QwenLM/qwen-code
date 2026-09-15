# SQLite Sidecar Index for Session Listing & Transcript Navigation

- Status: Draft (feature-flagged, default off)
- Issues: #11433 (design discussion), #11493 (cache-admission cliff found during the evaluation)
- Date: 2026-09-10
- 中文版:[session-sqlite-sidecar.zh-CN.md](./session-sqlite-sidecar.zh-CN.md)

## 1. Problem statement

Session reads are served by two in-memory/file mechanisms that re-derive index
data on every process start:

1. **Session listing** (`SessionService.listSessions`,
   `packages/core/src/services/sessionService.ts:2520`): `readdirSync` +
   per-file `statSync` + full mtime sort per call; filling a page additionally
   opens each candidate file to read its first lines. `MAX_FILES_TO_PROCESS =
10000` truncates enumeration beyond that.
2. **Transcript indexing** (`SessionTranscriptReader.buildIndex`,
   `packages/core/src/services/session-transcript-reader.ts:1939`): on an
   index-cache miss the reader scans the whole snapshot and parses every line
   before any paging operation can be served. The cache is process-local
   (32 entries / 64 MiB / 5 min TTL, `:397`) and enforces its byte budget on
   the admission path without evicting LRU entries (`:2278`), so working sets
   whose combined index estimate exceeds ~64 MiB degrade to _every read = full
   rescan_ (#11493). Snapshots beyond 256 MiB are refused outright (`:89`).

Measured on main @ `19ba03fb70` (Node 22, realistic synthetic corpora; harness
in `.qwen/bench-sqlite/`, methodology posted on #11433):

| Workload                                        | Current                   | Cost driver                        |
| ----------------------------------------------- | ------------------------- | ---------------------------------- |
| First listing page, 1k / 5k / 10k sessions      | 14.9 / 28.9 / 50.7 ms     | O(N) stat + sort                   |
| Full listing paginate, 1k / 5k / 10k (size=100) | 0.42 / 3.0 / 8.3 s        | O(N) file opens + first-line reads |
| Turn page, 11–202 MB session, cold              | 29–365 ms (~1.8 ms/MB)    | full-file scan + parse             |
| Turn page, warm but index cache over budget     | 350–450 ms **every read** | admission-skip, no LRU eviction    |
| Daemon restart + resume/attach                  | full rescan per session   | process-local cache lost           |

Workloads confirmed to exist in production deployments: multi-day sessions
(hundreds of MB), one channel pinned to a single ever-growing session, frequent
daemon restarts with resume/attach, on small 2–4 vCPU hosts where the
in-memory index residency is doubly expensive.

## 2. Proposed design

JSONL transcripts remain the **sole authoritative store**. A per-project
SQLite database is kept as a **rebuildable catalog/index sidecar** alongside
`chats/`. It can be deleted at any time: every read path falls back to today's
behavior, and the index is rebuilt lazily (incrementally from the JSONL tail).

### 2.1 Provider abstraction

```
packages/core/src/services/session-index/
├── types.ts            # SessionIndexProvider interface + option/result types
├── config.ts           # module-level configuration + driver probe + provider cache
├── sqlite/             # node:sqlite driver implementation
```

- `SessionIndexProvider` exposes two capabilities:
  - `listSessionsPage(...)` — catalog paging (replaces the scan-based fill);
  - `sessionTurnIndex(...)` — turn-start rows with byte offsets for one session
    (replaces `buildIndex` for the turn-navigation path).
- A **file-scan provider** is implicit: when no SQLite provider is available
  the existing code paths execute unchanged. There is no separate class;
  "provider returns null" _is_ the fallback, mirroring the `getPty.ts`
  optional-dependency precedent (dynamic import → `null` on failure).
- **Module-level configuration** (`configureSessionIndexing({ mode })`) called
  once from process bootstrap where settings live (CLI config load, daemon
  serve startup), following the `Storage.setRuntimeBaseDir()` static pattern.
  This covers the ~40 `new SessionService(cwd)` call sites that bypass `Config`
  without touching each one, and also covers the 5 other
  `SessionTranscriptReader` instantiation sites via `SessionService`'s internal
  reader (`sessionService.ts:833`) and direct reader construction.

### 2.2 Settings flag

```jsonc
// settings.json
{ "experimental": { "sessionIndex": "file" } } // "file" (default) | "sqlite"
```

- Declared in `packages/cli/src/config/settingsSchema.ts` (source of truth;
  `experimental.agentTeam` is the pattern), schema JSON regenerated via
  `scripts/generate-settings-schema.ts`.
- CLI (`loadCliConfig` in `packages/cli/src/config/config.ts`) and the daemon
  serve bootstrap (`packages/cli/src/commands/serve.ts`, which loads settings
  directly and never goes through loadCliConfig) both translate the setting
  into `configureSessionIndexing()`.
- Off by default upstream. The flag selects a _provider_, not a storage
  format: switching it either way migrates nothing.

### 2.3 Driver selection

`node:sqlite`, dynamically imported once per process:

- Zero dependency / zero bytes / zero supply-chain diff; works unflagged on
  Node ≥22.13 (verified 22.23) and on Bun ≥1.4 (verified 1.4.0), i.e. all
  current runtime flavors (npm, standalone-node, standalone-bun preview).
- Import failure (Node 22.0–22.12, an experimental-API break) → provider
  `null` → file-scan fallback. The feature's default-off + fallback semantics
  make the driver risk invisible to users who didn't opt in.
- `better-sqlite3` is the documented Plan B (both distribution forms already
  ship native addons via esbuild externals and per-arch prebuild copying in
  `scripts/create-standalone-package.js`), deliberately not used to avoid a
  new supply-chain surface for an optional feature.
- wasm SQLite is rejected: Node-side persistence VFS is immature and
  "in-memory DB + whole-file dump" negates incremental-sync write costs.

### 2.4 Schema

`projects/<projectDir>/sessions.index.sqlite` (WAL, `synchronous=NORMAL`):

```sql
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
-- schema_version; mismatch => delete file and rebuild from zero.

CREATE TABLE sessions(           -- session catalog, powers listSessionsPage
  sessionId     TEXT PRIMARY KEY,
  fileName      TEXT NOT NULL,
  mtimeMs       INTEGER NOT NULL,
  sizeBytes     INTEGER NOT NULL,
  startTime     TEXT,
  firstPrompt   TEXT,
  customTitle   TEXT,
  gitBranch     TEXT,
  cwd           TEXT,            -- project-membership filtering, as today
  recordCount   INTEGER NOT NULL,
  indexedBytes  INTEGER NOT NULL -- byte checkpoint: index covers [0, indexedBytes)
);
CREATE INDEX sessions_mtime ON sessions(mtimeMs DESC);

CREATE TABLE records(            -- per-session record offsets, powers turn nav
  sessionId  TEXT NOT NULL,
  seq        INTEGER NOT NULL,   -- line order within the file
  uuid       TEXT NOT NULL,
  parentUuid TEXT,
  type       TEXT NOT NULL,
  subtype    TEXT,
  turnStart  INTEGER NOT NULL DEFAULT 0, -- same hint getSessionTurnRecordHint uses
  offset     INTEGER NOT NULL,
  length     INTEGER NOT NULL,
  PRIMARY KEY(sessionId, seq)
) WITHOUT ROWID;
CREATE INDEX records_uuid ON records(sessionId, uuid);
```

Measured footprint: DB ≈ 6–24 % of the JSONL it indexes (6.4 % for
multi-hundred-MB sessions; 24 % for a 10k-small-session corpus). Full build of
10k sessions / 420k records = 3.9 s once; incremental re-sync of ~60 appended
records = 2.3 ms.

### 2.5 Consistency protocol

The sidecar knows exactly which durable bytes it covers:

1. **Append**: `indexedBytes <= size` → scan only `[indexedBytes, size)` up to
   the last complete line; insert rows in one transaction; update checkpoint.
   (JSONL-appended records are never rewritten in place; a partial final line
   is excluded until completed by the next flush.)
2. **Shrink / replace**: `indexedBytes > size` → rewind: delete the session's
   rows and rebuild from 0. Never "repair" the sidecar against the file.
3. **Validation before serving**: one `stat` per session file on the read
   path (same syscall the current code already issues) compares
   `mtimeMs/sizeBytes` with the catalog row; mismatch ⇒ incremental sync first.
4. **Crash window**: process dies between JSONL append and index update ⇒
   next sync sees `indexedBytes < size` and catches up. A crash mid-transaction
   rolls back atomically; the checkpoint never claims unindexed bytes.
5. **Derived-turn cache**: `readTurnIndexPage` also persists each session's
   derived navigation turns (`turns_cache`), keyed by the `indexedBytes`
   checkpoint they were computed from — later pages cost one row fetch plus
   a handful of `pread`s. Appends past the checkpoint invalidate the cache
   wholesale; its rows are deleted whenever the session row is (GC,
   rewind-rebuild).
6. **Catalog sweep** (listing only): listings reconcile file names on every
   call (`readdir` names only, plus GC of removed files), while the per-file
   stat sweep is gated by a TTL (default 30 s) to bound cost; brand-new
   files are indexed immediately even inside the TTL window, and turn-read
   paths always stat-validate their own file, so staleness is bounded and
   never structural.
7. **Corruption / open failure / schema mismatch**: delete the DB file, fall
   back to file-scan for the current request, rebuild lazily. Log at debug;
   never surface an error to the user over an index problem.

Concurrency: WAL readers don't block the writer; a single writer is enforced
per process via one shared connection with `busy_timeout`, with the daemon
owning long-lived writes. CLI short-lived processes open their own connection;
worst case is a brief busy retry, then fallback.

### 2.6 Read-path integration

| Path                                        | With provider                                                                                                                                                                                                                                                                                      | On any provider failure       |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `SessionService.listSessions`               | names-pass + windowed keyset paging over `sessions` (SQL `LIMIT` per window, mtime-desc; equal-mtime ties skipped exactly like the legacy strict-`<` convention)                                                                                                                                   | current scan exactly as today |
| `SessionTranscriptReader.readTurnIndexPage` | `turns_cache` hit → window slice + `pread` of the selected JSONL segments (uuid/sessionId verified; `SessionTranscriptSnapshotUnavailableError` on mismatch). Miss → derive turns from `records` rows with the same rules as `buildIndex`, persist, serve. The 256 MiB cap is enforced identically | current `buildIndex` path     |
| `SessionTranscriptReader.readPage`          | **unchanged this PR** (still in-memory index)                                                                                                                                                                                                                                                      | —                             |

`readTurnIndexPage` output parity is validated record-for-record against the
file-scan path in the parity suite (`session-index/parity.test.ts`), including
snapshot continuation in both directions, glued-line fragments, and
append-after-cache invalidation. Serial-sync queuing (one shared connection)
and in-flight store memoization keep concurrent daemon routes on a single
safe write timeline.

### 2.7 Relation to daemon catalog cache & #11493

- The daemon's durable JSONL catalog cache (`packages/cli/src/serve/server/
session-list.ts`, "cache is not a filesystem transaction") is philosophically
  the same object as the `sessions` table; when the flag is on, daemon listing
  reads through the provider instead. The JSON cache remains the non-flag
  default. No migration: both are rebuildable sidecars.
- #11493 (byte-budget admission never evicts) is orthogonal and worth fixing
  regardless; with the sidecar enabled it stops being load-bearing because the
  hot path no longer depends on the in-memory cache (which becomes an L1 over
  an L2 durable index).

## 3. Files affected

- **new**: `packages/core/src/services/session-index/{types,config}.ts`,
  `packages/core/src/services/session-index/sqlite/*.ts` (+ collocated tests)
- `packages/core/src/services/sessionService.ts` — provider lookup in
  `listSessions`
- `packages/core/src/services/session-transcript-reader.ts` — provider lookup
  in `readTurnIndexPage` (a write-path inline sync hook was evaluated and
  deferred: read-path stat validation already bounds staleness correctly)
- `packages/cli/src/config/settingsSchema.ts` — `experimental.sessionIndex`
  (+ regenerated `packages/vscode-ide-companion/schemas/settings.schema.json`)
- `packages/cli/src/config/config.ts` (`loadCliConfig`),
  `packages/cli/src/commands/serve.ts` (daemon bootstrap) —
  `configureSessionIndexing()` from settings
- `packages/core/src/config/config.ts` — pass-through where
  `getSessionService()` is lazily constructed (parity with `runtimeBaseDir`)
- tests: provider parity suites, fault-injection tests (corrupt DB, truncated
  JSONL, partial line, schema mismatch), budget-cap navigation test

## 4. Scope boundaries

- **No** authoritative SQLite lifecycle storage (issue model 3): prompt
  journal, state versions, undo events stay append-only JSONL.
- **No** `readPage` / full `SessionIndex` materialization from SQL (follow-up;
  the in-memory index cache remains for record-level paging).
- **No** full-text search / FTS5 in this PR.
- **No** per-workspace daemon catalog semantics changes; ACP / vscode flows
  inherit the behavior transparently through their existing daemon routes.
- **No** migration or backfill command — first use builds indexes lazily and
  incrementally.

## 5. Open questions

1. Sweep TTL default (30 s) — tune from daemon telemetry after rollout.
2. Whether write-path inline sync should also cover out-of-band edits by
   _another_ CLI process in the same project (today covered by the TTL sweep;
   a file watcher was considered and rejected as anti-KISS).
3. Node 24 line: `node:sqlite` stability status should be re-checked before
   flipping the default; Bun CI lane needs a sidecar smoke test if the
   OpenTUI bun flavor graduates from preview.
4. Telemetry: add `session_index.sync_duration_ms` /
   `session_index.fallback_total` as a fast follow-up once the flag sees real
   usage (answering the issue's "measure before defaults" requirement).
