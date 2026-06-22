# F2: Shared MCP Transport Pool — Design v2.2

> Targets `daemon_mode_b_main` (per #4175 branching strategy). Replaces #4175 Wave 5 PR 23.
> **Single-PR delivery** per maintainer's feature-cohesive batch guidance (2026-05-19).
> Author: doudouOUC. Date: 2026-05-20. Revised: 2026-05-20 (v2.2 — implementation review fold-ins).

---

## 0. Changelog

### v2.2 (2026-05-20) — PR #4336 implementation + 32 review fold-ins

PR #4336 shipped F2 as 6 atomic commits + 6 fix commits over ~4 hours. Wenshao reviewed cumulatively in 3 batches; each batch produced inline + critical fixes that were folded back. The table below records what changed vs. v2.1, organized by review batch.

#### v2.1 → first-review batch (commits 1-4, wenshao C1-C7 + S1-S4)

| #   | Site                                                       | What was wrong                                                                                                                                              | Fold-in commit |
| --- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| C1  | `acpAgent.ts:269` — IDE-close path                         | Pool drain only ran in SIGTERM handler; IDE-initiated normal close leaked entries until OS reaped. Mirror SIGTERM's pool drain on `await connection.closed` | `ae0b296c4`    |
| C2  | `mcp-pool-entry.ts:cancelDrainTimer`                       | `cancelDrainTimer` reset `maxIdleTimer` on every flap, defeating the §6.3 hard cap. Now only clears `drainTimer`; max-idle survives entire entry lifetime   | `ae0b296c4`    |
| C3  | `mcp-pool-entry.ts:doRestart`                              | Reconnect failure left entry in zombie state (`localStatus=CONNECTED`, `state='active'`, stale snapshot). Try/catch + transition to `'failed'` on failure   | `ae0b296c4`    |
| C4  | `mcp-pool-entry.ts:forceShutdown`                          | `state='closed'` set AFTER awaits, so concurrent `acquire` could observe `'active'` and hand out stale connection. Set synchronously at top                 | `ae0b296c4`    |
| C5  | `mcp-transport-pool.ts:drainAll`                           | Concurrent `acquire` could spawn fresh entry mid-drain. Added `draining` mutex flag + `await Promise.allSettled(spawnInFlight)` before clearing             | `ae0b296c4`    |
| C6  | `mcp-pool-entry.ts:statusChangeListener`                   | Listener wasn't filtered by `serverName`; every entry got every server's status notifications + entry's own `markActive` write echoed back                  | `ae0b296c4`    |
| C7  | `mcp-client-manager.ts:discoverAllMcpToolsIncremental`     | Pool-mode gate added to `discoverAllMcpTools` but missed `Incremental` — `/mcp refresh` bypassed pool, spawned per-session client                           | `ae0b296c4`    |
| S1  | `session-mcp-view.ts:passesSessionFilter`                  | Doc didn't call out that `excludeTools` uses direct equality (no parens-form support); divergence vs. `mcp-client.ts:isEnabled`                             | `ae0b296c4`    |
| S2  | `pid-descendants.ts` docstring                             | Claimed Windows-specific `taskkill /F` branch that didn't exist — Node polyfills `process.kill('SIGTERM')` to `TerminateProcess`                            | `ae0b296c4`    |
| S3  | `session-mcp-view.ts:applyTools` debug log                 | String contained literal `"N"` instead of interpolation — operators saw `applied 12 tools (filtered to N registered)`                                       | `ae0b296c4`    |
| S4  | `mcp-transport-pool.ts:createUnpooledConnection` status cb | Hardcoded to `() => CONNECTED` so `aggregateStatusByName` lied after disconnect. Now `() => client.getStatus()`                                             | `ae0b296c4`    |

#### Commit-5 self-review batch (R1-R3 small)

| #   | Site                                            | What was wrong                                                                                                                                           | Fold-in commit |
| --- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| R1  | `server.test.ts:918` `/capabilities` envelope   | Test asserted `getAdvertisedServeFeatures()` (no toggles) but server.ts passes `mcpPoolActive: opts.mcpPoolActive !== false` (default-on). Anchor toggle | `3e68c00bc`    |
| R2  | `server.test.ts` capability default-on coverage | No test booted with default options to verify pool tags advertise. Added explicit `mcpPoolActive: false` test                                            | `3e68c00bc`    |
| R3  | `events.ts:DaemonMcpServerRestartRefusedData`   | Doc said pre-PR SDKs would "see new value as unknown and surface generically" — actually `MCP_RESTART_REFUSED_REASONS.has(...)` rejects → silent drop    | `3e68c00bc`    |

#### Second-review batch (commits 1-5, wenshao R1-R10)

| #   | Site                                                | What was wrong                                                                                                                                                                          | Fold-in commit |
| --- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| WR1 | `mcp-pool-entry.ts:maxIdleTimer`                    | C2 fix correctly preserved `maxIdleTimer` across flap, but fire-action force-closed regardless of `refs.size`. Active session with re-attach inside grace would lose tools after 5min   | `72399f109`    |
| WR2 | `mcp-client-manager.ts:discoverAllMcpToolsViaPool`  | `releaseAllPooledConnections` + re-acquire ALL on every pass left brief window with zero MCP tools registered AND bounced every drain timer. Diff against desired `(name, fingerprint)` | `72399f109`    |
| WR3 | `mcp-pool-entry.ts:doRestart` snapshot fan-out      | Restart updated `toolsSnapshot`/`promptsSnapshot` and emitted typed events — but no `SessionMcpView` instance subscribed to that stream. Iterate `subscribers` directly post-snapshot   | `72399f109`    |
| WR4 | `mcp-transport-pool.ts:getSnapshot subprocessCount` | Counted websocket toward `subprocessCount` — websocket dials remote, no local child. Restricted to `'stdio'` only                                                                       | `72399f109`    |
| WR5 | `pid-descendants.ts` PowerShell `-Filter`           | Interpolated `${pid}` directly into `-Filter` string. Entry-point `Number.isInteger` guard prevents injection today; bind to `$p` for defense-in-depth against future guard relaxations | `72399f109`    |
| WR6 | `mcp-pool-entry.ts` ctor `cfg` field                | `readonly cfg: MCPServerConfig` was implicitly public, exposing env API keys / header auth / OAuth fields. Made `private`; new `transportKind` getter for the only external reader      | `72399f109`    |
| WR7 | `mcp-pool-events.ts` premature exports              | 5 PoolEvent type guards + `Prompt` re-export + `PoolEntryConnectionStatus` had zero callers. Removed; kept `MCPCallInterruptedError` (design §13.4 mandate)                             | `72399f109`    |
| WR8 | `acpAgent.ts:269,300` pool drain duplication        | SIGTERM + IDE-close had identical `if (agentInstance) { try { await shutdownMcpPool(8_000) } catch... }` blocks. Extracted `drainPoolBeforeExit(label)` helper                          | `72399f109`    |

#### Commit-6 self-review batch (R1-R3 critical race)

| #   | Site                                    | What was wrong                                                                                                                                                               | Fold-in commit |
| --- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| 6R1 | `mcp-transport-pool.ts:onClosed`        | Slot-release race: A finishes spawn, B (different fingerprint, same name) starts spawn, A drains. Close-cb checked only `entries` (B not yet registered) → premature release | `0e58a098f`    |
| 6R2 | `events.ts:mcpBudgetWarningCount` JSDoc | Workspace-scoped events fan to N sessions → N reducer increments; consumers aggregating across sessions double-count. Docstring updated to call out the multiplier           | `0e58a098f`    |
| 6R3 | `acpAgent.ts:broadcastBudgetEvent`      | Iterated `this.sessions.keys()` directly during async fan-out; concurrent `killSession` could corrupt iterator. Snapshot via `Array.from(...)`                               | `0e58a098f`    |

#### Third-review batch (commits 1-6, wenshao W1-W15)

| #   | Site                                                           | What was wrong                                                                                                                                                                                | Fold-in commit |
| --- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| W1  | `mcp-transport-pool.ts:spawnEntry` catch                       | Spawn failure leaked `statusChangeListener` permanently — only `forceShutdown` removes it. Added `entry.forceShutdown('manual')` to catch                                                     | `4a3c5cd90`    |
| W2  | `mcp-pool-entry.ts:statusChangeListener` cross-check           | Module-level `serverStatuses` map shared across multi-fingerprint entries. A's transport error wrote DISCONNECTED, B's listener corrupted B's `localStatus`. Added `client.getStatus()` check | `4a3c5cd90`    |
| W3  | `mcp-pool-entry.ts:doRestart` pid sweep                        | Restart skipped `listDescendantPids` + `sigtermPids` — every restart of `npx`/`uvx`-wrapped stdio orphaned the actual MCP grandchild. Added sweep before disconnect                           | `4a3c5cd90`    |
| W4  | `mcp-pool-entry.ts:doRestart` drain timer race                 | Drain timer could fire mid-restart yield → `forceShutdown` removes entry → `client.connect` spawns orphan. Added `cancelDrainTimer` + `state→active` at top of `doRestart`                    | `4a3c5cd90`    |
| W5  | `mcp-client-manager.ts:pooledConnections` dead handles         | When entry transitioned to `'failed'`, manager held dead `PooledConnection` forever. Subscribe to entry events; evict on `'failed'` (idempotent via `get(name) === conn` guard)               | `4a3c5cd90`    |
| W6  | `mcp-client-manager.ts:discoverAllMcpToolsViaPool` re-entrancy | Two passes interleaving could both `set(name, conn)` → first conn leaked. Added `discoveryInFlight` mutex; second caller awaits same promise. New regression test                             | `4a3c5cd90`    |
| W9  | `acpAgent.ts:parsePoolDrainMs` strictness                      | `Number.parseInt` accepted `'30000ms'` / `'30000abc'`. Strict `^\d+$` regex; reject with stderr warning + default fallback                                                                    | `4a3c5cd90`    |
| W10 | `mcp-transport-pool.ts:acquire` indexAttach order              | `indexAttach` mutated `sessionToEntries` BEFORE `entry.attach()`. If `attach` threw, stale reverse-index mapping. Moved `indexAttach` after `attach` succeeds (both fast + in-flight paths)   | `4a3c5cd90`    |
| W13 | `mcp-transport-pool.ts:subprocessCount` JSDoc                  | Doc still claimed `stdio + websocket` after WR4 restricted to stdio. Updated                                                                                                                  | `4a3c5cd90`    |
| W14 | `mcp-transport-pool.ts:createUnpooledConnection` catch         | Same `statusChangeListener` leak as W1 in the unpooled path. Same mirror: `forceShutdown` before disconnect                                                                                   | `4a3c5cd90`    |
| W15 | `bridge.ts:restartMcpServer` response                          | `as PoolEntries` cast was unsound — untyped JSON from ACP child. `Array.isArray` check + per-entry shape guard; malformed entries skipped with stderr breadcrumb                              | `4a3c5cd90`    |

#### Declined-with-reply (filed as F2 follow-ups)

| #   | Site                                                | Reason for declining                                                                                                                                                             |
| --- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W7  | Test coverage gaps (4 untested critical paths)      | 1/4 added (W6 regression test); rest deferred to focused test-coverage PR after F2 series merges                                                                                 |
| W8  | `maxReconnectAttempts` / `reconnectStrategy` unused | Forward-compat placeholders for the deferred health-monitor-driven reconnect (design §6.6); removing + re-adding churns the public type                                          |
| W11 | Duplicate fast-path / in-flight-path attach blocks  | ✅ Done in PR A: `attachPooledSession` + `rollbackReservationOnSpawnFailure` private helpers (commit `2d546efca`)                                                                |
| W12 | `passesSessionFilter` O(M×N) per `applyTools`       | ✅ Done in PR A: `applyTools` / `applyPrompts` precompute filter `Set`s once per pass; predicate becomes O(1) per tool (commit `a4a855ab3`)                                      |
| R9  | `McpClientManager` ctor 7-positional sentinels      | ✅ Done in PR A: options-object ctor + `mkManager` test factory (commit `0cb1eaa27`)                                                                                             |
| R10 | `pgrep -P <pid>` per-PID-per-level cost             | ✅ Done in PR A: single `ps -A -o pid=,ppid=` snapshot + in-memory BFS walk; pgrep BFS retained as fallback for BusyBox <v1.28 / distroless (commit landing as final PR A piece) |

#### Bug count

- **3 batches × 27 critical / important fixes** + 5 doc / suggestion folds = **32 review fold-ins** total
- **2 critical races caught only on second look** (6R1 slot-release-during-spawn race; W6 discovery re-entrancy)
- **0 silent failures shipped** — every fix carries an inline `// F2 (#4175 commit X review fix — wenshao YN):` breadcrumb pointing at the original review

### v2.1 (2026-05-20) — single-PR strategy + 12 review fold-ins

| #      | What                                                                                                          | Why                                                                                                             |
| ------ | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| V21-1  | Switched from 6-sub-PR plan to **single feature-cohesive PR** with 6 atomic commits                           | Per maintainer guidance (#4175 branching strategy); reviewer can read commit-by-commit via `git log -p`         |
| V21-2  | Added `sessionToEntries: Map<sid, Set<ConnectionId>>` reverse index in pool (§6)                              | `releaseSession` O(N entries) → O(refs of session); needed for 1000-session scale                               |
| V21-3  | `?fingerprint=` query param on restart route (§13.1)                                                          | Operator may want to restart only one entry when same name has multiple fingerprints; near-zero cost to add now |
| V21-4  | Spawn-failure path explicitly releases reserved slot (§6.1, §6.5)                                             | Otherwise slot leaks until next health-monitor pass; subtle real bug                                            |
| V21-5  | New §13.4: in-flight tool call during reconnect semantics                                                     | `MCPCallInterruptedError`; pool does NOT auto-replay (writes unsafe)                                            |
| V21-6  | New §10.4: `/mcp disable X` triggers `SessionMcpView` re-apply                                                | Otherwise mid-session disable doesn't drop already-registered tools                                             |
| V21-7  | Status route exposes `entryIndex` not raw fingerprint (§8.3)                                                  | Avoids side-channel exposure of OAuth token rotation via fingerprint change                                     |
| V21-8  | Reconnect backoff spec'd: stdio fixed 5s × 3, HTTP/SSE exponential 1/2/4/8/16s × 5 (§6.6)                     | v2 didn't say; HTTP needs longer retry budget for network flap                                                  |
| V21-9  | `canonicalOAuth(o)` normalizes `{enabled: false}` ≡ `undefined` ≡ `null` (§5.1)                               | Otherwise functionally equivalent configs produce distinct entries                                              |
| V21-10 | Renamed pool fallback helper from "legacy in-process acquire" to `createUnpooledConnection` (§5.3, §6.1)      | SDK MCP bypass is permanent, not legacy                                                                         |
| V21-11 | `drainAll(opts?)` returns `Promise<void>` with `timeoutMs` wall-clock budget (§17)                            | Caller needs to know when drain finishes for shutdown ordering                                                  |
| V21-12 | Locked SDK reducer field names (Q1 resolved): keep `mcpBudgetWarningCount` etc. with scope semantics in JSDoc | No public-API rename mid-PR                                                                                     |
| V21-13 | Locked Q3 (default pool-on, `--no-mcp-pool` kill switch), Q4 (HTTP/SSE opt-in), Q6 (eager construction)       | Single-PR delivery; no flag gating needed                                                                       |
| V21-14 | Added R9/R10/R11 single-PR risks (§23)                                                                        | Review fatigue, daemon_mode_b_main merge conflict, CI time                                                      |
| V21-15 | Extension uninstall orphan entry handling deferred to `MAX_IDLE_MS` natural reap (§16.3)                      | No explicit `invalidateByExtension`; keeps model uniform                                                        |

### v2 (2026-05-20) — initial review fold-ins from v1 sketch

| #   | What                                                                                                  | Why                                                                                        |
| --- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| C1  | Pool fans out **Tools + Prompts** (was: tools only)                                                   | `McpClient` ctor takes both registries; prompts otherwise silently lost in pool mode       |
| C2  | New section on **global state coexistence** (`serverStatuses` / `mcpServerRequiresOAuth` module Maps) | Cross-session sharing already exists today; pool inherits + formalizes                     |
| C3  | `connectToMcpServer` factory path **unified** with `McpClient` class in F2-1                          | v1 only refactored the class; would leave a parallel non-pooled path                       |
| C4  | Snapshot replay on attach (earlyEvents-style) added to `PoolEntry.attach()`                           | New race: session-B attaches → server emits `tools/list_changed` before subscription wired |
| C5  | `spawnInFlight: Map<ConnectionId, Promise<PoolEntry>>` for concurrent-acquire dedupe                  | v1 mentioned in test matrix but missed in implementation contract                          |
| C6  | Cross-platform descendant-pid sweep (Linux/macOS pgrep, Windows wmic/PowerShell)                      | v1 said "copy opencode's `pgrep -P`" — that's Unix-only                                    |
| C7  | `trust` field per-session **copy** of tool object                                                     | trust lives on `DiscoveredMCPTool`; shared instance would mix per-session trust            |
| C8  | HTTP/SSE transports **opt-in** to pooling (default: stdio + websocket only)                           | Some MCP HTTP servers maintain per-transport session state; sharing risks state-bleed      |
| C9  | SDK MCP server (`isSdkMcpServerConfig`) explicit bypass                                               | `sendSdkMcpMessage` is per-session by design                                               |
| C10 | OAuth path explicitly **deferred to F3**                                                              | OAuth flow needs PermissionMediator-style routing; not F2 scope                            |
| C11 | Restart route semantics spec'd (name → all matching entries)                                          | PR 17's `POST /workspace/mcp/:server/restart` previously unambiguous (1 entry); now 1..N   |
| C12 | Status route refactor section (new path: `QwenAgent.getMcpPoolAccounting()`)                          | `httpAcpBridge.ts:733-770` currently reads bootstrap session's manager — must change       |
| C13 | Generation counter on `PoolEntry` for stale `tools/list_changed` handler guard                        | Opencode pattern: `if (s.clients[name] !== client) return`                                 |
| C14 | Sub-PR breakdown 4 → **6**                                                                            | v1 underestimated; A2/B1/B3/C6 each add real work                                          |
| C15 | Lazy pool construction (only when N≥2 sessions seen) — optional                                       | `qwen serve --foreground` single-session won't benefit; saves init cost                    |

---

## 1. Goals / Non-goals

**Goals**

- N sessions in 1 workspace sharing 1 process per unique-server-config — fingerprint-keyed
- Per-session `ToolRegistry` / `PromptRegistry` views preserved (filtering, trust)
- Refcount + grace-drain lifecycle resilient to reattach
- Cross-platform descendant-pid cleanup
- Budget guardrails graduate from per-session to per-workspace (PR 14 promised this)
- Backward compat with non-daemon standalone qwen (pool not constructed there)

**Non-goals (F2 scope)**

- Cross-workspace pooling (1 daemon = 1 workspace invariant from PR #4113 stands)
- Cross-daemon pooling (out of scope — multi-process orchestrator territory)
- OAuth routing rework (F3 with `PermissionMediator`)
- Pool persistence across daemon restart (in-memory only)
- Auto-detection of "pool-safe" HTTP servers (opt-in flag only)
- Live `MCPServerConfig` diff to in-place mutate entries (config change → new entry, old drains)

---

## 2. Current State (replacement target)

```
acpAgent.newSession(sessionId)
  → newSessionConfig(cwd, mcpServers)                  // acpAgent.ts:1771
  → loadCliConfig → new Config → config.initialize()
  → ToolRegistry ctor → new McpClientManager(config, ...)   // tool-registry.ts:199
  → for (name, cfg) in config.getMcpServers():
      new McpClient(name, cfg, toolRegistry, promptRegistry, workspaceContext, ...)
      → client.connect() → client.discover(config)
```

**Coupling map (what must be broken or threaded through):**

| Coupling                                                                         | Location                                          | Action in F2                                                                        |
| -------------------------------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `McpClient` ctor binds 1 ToolRegistry + 1 PromptRegistry                         | mcp-client.ts:106-119                             | Pool owns transport; `SessionMcpView` (per session) owns the per-session registries |
| `McpClient.discover()` calls `toolRegistry.registerTool()` inline                | mcp-client.ts:178-198                             | Split: `discoverAndReturn()` returns snapshot; view registers                       |
| `ListRootsRequestSchema` handler closes over `workspaceContext.getDirectories()` | mcp-client.ts:142-153 + connectToMcpServer.ts:893 | Pool's single workspace-bound context                                               |
| `workspaceContext.onDirectoriesChanged` listener registered per connect          | mcp-client.ts:907                                 | Pool registers once per entry                                                       |
| `McpClientManager` `new`'d inside ToolRegistry                                   | tool-registry.ts:199                              | Add optional `pool?` ctor param; injection from Config                              |
| Budget enforcement per-session                                                   | mcp-client-manager.ts:91-95 comment               | Move state machine into pool                                                        |
| `serverDiscoveryPromises` dedupe in-flight per server                            | mcp-client-manager.ts:350                         | Pool has `spawnInFlight: Map<ConnectionId, Promise<PoolEntry>>`                     |
| `setMcpBudgetEventCallback` per-session registration                             | acpAgent.ts:1851-1899                             | Pool emits → `QwenAgent` broadcasts to all sessions                                 |

**Already-shared state (pool inherits, does not introduce):**

| State                                          | Location                         | Note                                                              |
| ---------------------------------------------- | -------------------------------- | ----------------------------------------------------------------- |
| `serverStatuses: Map<string, MCPServerStatus>` | mcp-client.ts:292 (module-level) | Process-wide today; pool key still by name → "any-CONNECTED-wins" |
| `mcpServerRequiresOAuth: Map<string, boolean>` | mcp-client.ts:302 (module-level) | Same                                                              |
| `MCPOAuthTokenStorage` on-disk tokens          | `~/.qwen/mcp-oauth/<name>.json`  | Daemon-host shared; pool just exploits more efficiently           |

---

## 3. Reference Findings

| Project         | Pool?              | Key                                           | Lifecycle                                                                               | Patterns to steal                                                                                                                |
| --------------- | ------------------ | --------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **claude-code** | No, per-process    | `name + JSON.stringify(cfg)` (lodash.memoize) | `clearServerCache` + remote backoff×5; stdio crash → `failed`                           | Sorted-key SHA-256 `hashMcpConfig` for invalidation/keying                                                                       |
| **opencode**    | Yes, per workspace | server **name only** (no config hash)         | No refcount / no eviction / no restart; Effect finalizer + `pgrep -P` recursive SIGTERM | Descendant-pid sweep, stale-handler guard (`if (s.clients[name] !== client) return`), `tools/list_changed` fan-out via event bus |

**What F2 inherits from each:** config-hash from claude-code (handles per-session env/auth divergence opencode doesn't), descendant-pid sweep from opencode (npx/uvx wrappers leak). What we add: refcount + drain (multi-client daemon), auto-restart (long-running daemon), prompt fan-out, generation guard.

---

## 4. Architecture

### 4.1 Process layout

```
HTTP daemon (packages/cli/src/serve, qwen serve)
  │ spawns
  ▼
ACP child (qwen --acp, single process per workspace)
  │
  QwenAgent (acpAgent.ts)
  ├── McpTransportPool ◄── new, workspace-scoped, 1 instance
  │     ├── entries: Map<ConnectionId, PoolEntry>
  │     ├── spawnInFlight: Map<ConnectionId, Promise<PoolEntry>>
  │     ├── workspaceContext (bound to daemon workspace)
  │     └── budget guardrails (PR 14 state machine, graduated to workspace)
  │
  └── sessions: Map<sessionId, Session>
        └── Session.Config → ToolRegistry → McpClientManager(pool?)
                                                     │
                                            ┌────────┴────────┐
                                            │ pool injected   │
                                            ▼                 ▼
                                pool.acquire(name,cfg,sid)   legacy in-process
                                  → SessionMcpView            (standalone qwen)
                                    .applyTools/Prompts
                                    (filter + register into
                                     session's own registries)
```

**Pool lives in the ACP child**, not the HTTP daemon. The HTTP daemon queries pool state via the existing `bridge.client` extMethod surface (`getMcpPoolAccounting`, `restartMcpServer`). F2 code lives in **`packages/core/src/tools/`** (peer of `mcp-client-manager.ts`), not `packages/acp-bridge/`.

### 4.2 Class diagram

```
McpTransportPool
  ├─ acquire(name, cfg, sid) → PooledConnection
  ├─ release(connectionId, sid) → void
  ├─ releaseSession(sid) → void   (bulk release for session teardown)
  ├─ restartByName(name) → RestartResult[]
  ├─ getAccounting() → McpClientAccounting   (workspace-scope)
  ├─ getBudgetMode/Budget()
  ├─ drainAll() → Promise<void>   (shutdown)
  └─ onBudgetEvent: (event) => void   (set by QwenAgent)

PoolEntry (internal)
  ├─ refs: Set<sessionId>
  ├─ client: McpClient
  ├─ toolsSnapshot: DiscoveredMCPTool[]
  ├─ promptsSnapshot: Prompt[]
  ├─ generation: number   (++ on reconnect; stale-event guard)
  ├─ state: 'spawning' | 'active' | 'draining' | 'closed' | 'failed'
  ├─ drainTimer?: NodeJS.Timeout
  ├─ healthMonitor: { intervalTimer, consecutiveFailures, isReconnecting }
  ├─ subscribers: Map<sid, SessionMcpView>
  ├─ attach(sid, view) → PooledConnection
  └─ detach(sid) → void

PooledConnection (handle returned to caller)
  ├─ id: ConnectionId
  ├─ on('toolsChanged' | 'promptsChanged' | 'disconnected' | 'reconnected' | 'failed', cb)
  ├─ callTool(name, args, { sessionId }) → CallToolResult
  ├─ readResource(uri, { sessionId, signal })
  └─ release()

SessionMcpView (per session, per server)
  ├─ ctor(toolRegistry, promptRegistry, sessionId, serverName, cfg)
  ├─ applyTools(snapshot) → void   (filters by include/exclude, decorates trust)
  ├─ applyPrompts(snapshot) → void
  └─ teardown() → void   (removes its registrations)
```

---

## 5. Pool Key (Fingerprint)

### 5.1 Hashed canonical fields

```ts
type PoolKey = string; // sha256 hex, first 16 chars sufficient (collision-free for realistic N)
type ConnectionId = `${serverName}::${PoolKey}`;

function fingerprint(cfg: MCPServerConfig): PoolKey {
  const canonical = {
    transport: mcpTransportOf(cfg),
    command: cfg.command ?? null,
    args: cfg.args ?? [],
    cwd: cfg.cwd ?? null,
    env: sortedEntries(cfg.env ?? {}), // [[k,v],...] sorted by k
    url: cfg.url ?? null,
    httpUrl: cfg.httpUrl ?? null,
    headers: sortedEntries(cfg.headers ?? {}),
    timeout: cfg.timeout ?? null,
    oauth: canonicalOAuth(cfg.oauth),
  };
  return sha256(JSON.stringify(canonical)).slice(0, 16);
}

/**
 * V21-9: normalize functionally-equivalent OAuth configs so they
 * collapse to the same fingerprint. `{enabled: false}`, `undefined`,
 * `null`, and `{}` all mean "no OAuth" → all return `null`.
 */
function canonicalOAuth(o?: OAuthConfig | null): OAuthConfig | null {
  if (!o || !o.enabled) return null;
  return {
    enabled: true,
    clientId: o.clientId ?? null,
    scopes: o.scopes ? [...o.scopes].sort() : null,
    authorizationUrl: o.authorizationUrl ?? null,
    tokenUrl: o.tokenUrl ?? null,
  };
}

// Excluded fields (per-session filters, NOT transport-level):
//   includeTools, excludeTools, trust, description, extensionName
```

### 5.2 Transport-class gating

```ts
const POOLED_TRANSPORTS_DEFAULT = new Set(['stdio', 'websocket']);

function isPoolable(cfg: MCPServerConfig, opts: PoolOptions): boolean {
  if (isSdkMcpServerConfig(cfg)) return false;
  const transport = mcpTransportOf(cfg);
  return opts.pooledTransports.has(transport);
}
```

**Default `pooledTransports = {stdio, websocket}`**. Operators opt HTTP/SSE in via:

- CLI: `--mcp-pool-transports=stdio,websocket,http,sse`
- Env: `QWEN_SERVE_MCP_POOL_TRANSPORTS=stdio,websocket,http`

**Why default exclude HTTP/SSE**: some MCP HTTP server implementations bind state (auth context, conversation memory) to the TCP/SSE stream; multiple ACP sessions sharing it would bleed state. stdio + websocket are true OS processes whose state is observable and isolatable.

### 5.3 SDK MCP bypass

`isSdkMcpServerConfig(cfg)` true → pool returns a thin `PooledConnection` wrapper via `createUnpooledConnection(name, cfg, sid)` that constructs an `McpClient` immediately, no sharing, no entry stored in pool. Reason: `sendSdkMcpMessage` is per-session by design (routes through ACP control plane back to the originating session). Same path used for HTTP/SSE when transport not in `pooledTransports` (§10.3).

V21-10: name is `createUnpooledConnection`, not `legacyInProcessAcquire` — SDK MCP and HTTP-opt-out are permanent design choices, not legacy code.

---

## 6. Lifecycle

### 6.1 acquire / release

```ts
class McpTransportPool {
  private entries = new Map<ConnectionId, PoolEntry>();
  private spawnInFlight = new Map<ConnectionId, Promise<PoolEntry>>();

  /** V21-2: reverse index, O(refs) releaseSession instead of O(entries). */
  private sessionToEntries = new Map<string, Set<ConnectionId>>();

  async acquire(
    name: string,
    cfg: MCPServerConfig,
    sid: string,
  ): Promise<PooledConnection> {
    if (!isPoolable(cfg, this.opts)) {
      return this.createUnpooledConnection(name, cfg, sid);
    }
    const id: ConnectionId = `${name}::${fingerprint(cfg)}`;

    if (this.entries.has(id)) {
      this.indexAttach(sid, id);
      return this.entries.get(id)!.attach(sid);
    }
    let inFlight = this.spawnInFlight.get(id);
    if (!inFlight) {
      const slot = this.tryReserveSlot(name);
      if (slot === 'refused') {
        throw new BudgetExhaustedError(
          name,
          this.clientBudget!,
          this.reservedSlots.size,
        );
      }
      inFlight = this.spawnEntry(name, cfg, id)
        .catch((err) => {
          // V21-4: release reserved slot on spawn failure. Without
          // this, slot leaks until health monitor's release path
          // runs (which it doesn't, because there's no entry to monitor).
          if (slot === 'reserved') this.releaseSlotName(name);
          throw err;
        })
        .finally(() => this.spawnInFlight.delete(id));
      this.spawnInFlight.set(id, inFlight);
    }
    const entry = await inFlight;
    this.indexAttach(sid, id);
    return entry.attach(sid);
  }

  release(id: ConnectionId, sid: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.detach(sid);
    this.indexDetach(sid, id);
    if (entry.refs.size === 0) entry.startDrainTimer(this.opts.drainDelayMs);
  }

  /** V21-2: O(refs of this session), not O(all entries). */
  releaseSession(sid: string): void {
    const ids = this.sessionToEntries.get(sid);
    if (!ids) return;
    for (const id of ids) {
      const entry = this.entries.get(id);
      if (!entry) continue;
      entry.detach(sid);
      if (entry.refs.size === 0) entry.startDrainTimer(this.opts.drainDelayMs);
    }
    this.sessionToEntries.delete(sid);
  }

  private indexAttach(sid: string, id: ConnectionId): void {
    let ids = this.sessionToEntries.get(sid);
    if (!ids) {
      ids = new Set();
      this.sessionToEntries.set(sid, ids);
    }
    ids.add(id);
  }

  private indexDetach(sid: string, id: ConnectionId): void {
    const ids = this.sessionToEntries.get(sid);
    if (!ids) return;
    ids.delete(id);
    if (ids.size === 0) this.sessionToEntries.delete(sid);
  }
}
```

### 6.2 Concurrent-acquire dedupe (`spawnInFlight`)

Mirrors `McpClientManager.serverDiscoveryPromises` (mcp-client-manager.ts:350). Without it, 5 sessions spawning at boot all see `entries.has(id) === false` and race to spawn 5 child processes.

### 6.3 Drain grace + idle cap

```ts
const DRAIN_DELAY_MS_DEFAULT = 30_000; // grace after last release
const MAX_IDLE_MS_DEFAULT = 5 * 60_000; // hard cap (defense against drain cancellation loop)
```

State machine in `PoolEntry`:

```
spawning ──spawn ok──► active ──last detach──► draining ──timeout──► closed
   │                     │                       │
   │                     │                       └──attach──► active (cancel timer)
   spawn fail───────────►failed
                          │
                          └──manual restart──► spawning
```

Hard idle cap: drain timer can be cancelled+restarted indefinitely (acquire/release flap). `MAX_IDLE_MS` is a separate timer started **at first idle** and never reset; when it fires, force-close even if drain is currently in active grace. Prevents zombie pool entries from buggy clients that thrash acquire/release.

### 6.4 Cross-platform descendant-pid sweep

**R10 / R23 T7 / PR A update (2026-05-22)**: switched from per-pid BFS (one `pgrep -P <pid>` / `Get-CimInstance -Filter` subprocess per node) to a single process-table snapshot followed by in-memory tree walk. Two motivations: (1) one fork instead of B^D forks on the hot pool-shutdown path; (2) snapshot consistency — pre-fix BFS could miss descendants that forked between adjacent BFS levels. Per-pid path retained as fallback for BusyBox `ps` <v1.28 (no `-o` support) and distroless containers without `ps`.

```ts
// packages/core/src/tools/pid-descendants.ts
export async function listDescendantPids(rootPid: number): Promise<number[]> {
  if (!Number.isInteger(rootPid) || rootPid <= 0) return [];
  try {
    if (process.platform === 'win32')
      return await listDescendantPidsWin(rootPid);
    return await listDescendantPidsUnix(rootPid);
  } catch {
    return []; // OS reaps orphans; pool shutdown still proceeds.
  }
}

async function listDescendantPidsUnix(root: number): Promise<number[]> {
  let tree: Map<number, number[]> | undefined;
  try {
    tree = await snapshotProcessTreeUnix(); // ps -A -o pid=,ppid=
  } catch {
    /* fall through to fallback */
  }
  if (tree) return walkDescendants(tree, root); // O(descendants), 1 fork
  return await listDescendantPidsUnixPgrepFallback(root); // legacy BFS
}

async function snapshotProcessTreeUnix(): Promise<Map<number, number[]>> {
  // -A: all processes (POSIX, equivalent to -e but unambiguous on BSD).
  // -o pid=,ppid=: pid + ppid columns, trailing `=` suppresses headers.
  const { stdout } = await execFile('ps', ['-A', '-o', 'pid=,ppid='], {
    timeout: 2000,
    maxBuffer: 8 * 1024 * 1024, // covers >250k-process pathological hosts
  });
  const childrenByPpid = new Map<number, number[]>();
  for (const line of stdout.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!m) continue;
    /* parse, push into childrenByPpid */
  }
  return childrenByPpid;
}

// Windows: single Get-CimInstance Win32_Process | ConvertTo-Csv snapshot
// of all (ProcessId, ParentProcessId) rows + in-memory walk; per-pid
// `Get-CimInstance -Filter "ParentProcessId=$p"` retained as fallback.
```

Called from `PoolEntry.shutdown()` before `client.disconnect()`. Handles `npx @modelcontextprotocol/server-X`, `uvx ...`, `pnpm dlx ...` wrapper leaks. MAX_DESCENDANTS=256 / MAX_DEPTH=8 caps preserved.

### 6.5 Spawn failure handling

If `spawnEntry` rejects after multiple subscribers attached (via `spawnInFlight`):

- All awaiters get the rejection
- `tryReserveSlot` released **via explicit `.catch` arm in `acquire`** (V21-4); without this fix the slot leaked until next health-monitor pass, which never ran because no entry existed to monitor.
- Failed entry NOT stored in `entries`
- Subscribers' code paths handle as if `acquire` originally failed (existing per-session `discoverMcpToolsForServer` catch logic remains valid)

### 6.6 Reconnect backoff (V21-8)

When a `PoolEntry` enters reconnect after transport drop:

| Transport family | Strategy                                     | Cap                                                              |
| ---------------- | -------------------------------------------- | ---------------------------------------------------------------- |
| stdio            | Fixed 5s × 3 attempts                        | Per existing `DEFAULT_HEALTH_CONFIG.reconnectDelayMs`            |
| websocket        | Fixed 5s × 3 attempts                        | Same as stdio                                                    |
| http (opt-in)    | Exponential 1s, 2s, 4s, 8s, 16s × 5 attempts | Remote endpoints flap on transient network issues; longer budget |
| sse (opt-in)     | Exponential 1s, 2s, 4s, 8s, 16s × 5 attempts | Same as http                                                     |

After cap exhaustion: entry transitions to `failed` state; subscribers receive `failed` event; new `acquire` for same `ConnectionId` retries spawn once, then throws. Operator restart (§13) resets state.

---

## 7. Discovery / SessionMcpView

### 7.1 Tools + Prompts dual fan-out

```ts
// packages/core/src/tools/mcp-client.ts — split discover into pure
async discoverAndReturn(cliConfig: Config): Promise<{
  tools: DiscoveredMCPTool[];
  prompts: Prompt[];
}> {
  if (this.status !== MCPServerStatus.CONNECTED) throw new Error('Client is not connected.');
  try {
    const [prompts, tools] = await Promise.all([
      discoverPrompts(this.serverName, this.client, /* no registry */),
      discoverTools(this.client, this.serverConfig, this.serverName, this.debugMode, this.workspaceContext),
    ]);
    if (prompts.length === 0 && tools.length === 0) {
      throw new Error('No prompts or tools found on the server.');
    }
    return { tools, prompts };
  } catch (e) {
    this.updateStatus(MCPServerStatus.DISCONNECTED);
    throw e;
  }
}

// Legacy discover() retained, delegates to discoverAndReturn + registers (for standalone qwen)
async discover(cliConfig: Config): Promise<void> {
  const { tools, prompts } = await this.discoverAndReturn(cliConfig);
  for (const t of tools) this.toolRegistry.registerTool(t);
  for (const p of prompts) this.promptRegistry.registerPrompt(p);
}
```

```ts
class SessionMcpView {
  applyTools(snapshot: DiscoveredMCPTool[]) {
    this.sessionToolRegistry.removeToolsByServer(this.serverName);
    for (const tool of snapshot) {
      if (!this.passesFilter(tool)) continue;
      // C7: per-session copy of trust (don't mutate shared snapshot)
      const localTool = tool.withTrust(this.cfg.trust);
      this.sessionToolRegistry.registerTool(localTool);
    }
  }
  applyPrompts(snapshot: Prompt[]) {
    this.sessionPromptRegistry.removePromptsByServer(this.serverName);
    for (const p of snapshot) this.sessionPromptRegistry.registerPrompt(p);
  }
}
```

### 7.2 Snapshot replay on attach (earlyEvents-style)

```ts
class PoolEntry {
  attach(sid: string): PooledConnection {
    this.refs.add(sid);
    this.cancelDrainTimer();
    const view = new SessionMcpView(...);
    this.subscribers.set(sid, view);
    // Immediately replay current snapshot so subscriber doesn't miss
    // updates that landed between in-flight discover completion and
    // attach.
    if (this.state === 'active') {
      view.applyTools(this.toolsSnapshot);
      view.applyPrompts(this.promptsSnapshot);
    }
    return this.makeHandle(sid, view);
  }
}
```

Mirrors PR 14b fix #1's `BridgeClient.earlyEvents` pattern — solves analogous race for pool attachment.

### 7.3 Stale-handler guard (generation counter)

```ts
class PoolEntry {
  private generation = 0;

  private async reconnect(): Promise<void> {
    this.generation += 1;
    const myGen = this.generation;
    await this.client.disconnect();
    await this.client.connect();
    if (myGen !== this.generation) return; // superseded by another reconnect
    const snap = await this.client.discoverAndReturn(this.cfg);
    if (myGen !== this.generation) return;
    this.toolsSnapshot = snap.tools;
    this.promptsSnapshot = snap.prompts;
    this.fanOut('toolsChanged');
    this.fanOut('promptsChanged');
  }

  private onServerToolsListChanged = () => {
    const myGen = this.generation;
    this.client
      .discoverAndReturn(this.cfg)
      .then((snap) => {
        if (myGen !== this.generation) return;
        this.toolsSnapshot = snap.tools;
        this.fanOut('toolsChanged');
      })
      .catch(/* swallow + log */);
  };
}
```

Without this, a stale handler from a pre-reconnect Client instance could overwrite the post-reconnect snapshot with stale data.

**Monotonicity invariant** (V21 clarification): `generation` only increments, never resets. Any in-flight operation captures `myGen` at entry, then post-`await` checks `myGen === this.generation`. Equivalent to "no superseding event has happened since I started". Bounded by Number.MAX_SAFE_INTEGER (~285k years at 1Hz reconnect), no overflow concern.

### 7.4 Path unification (F2-1 scope expansion)

`packages/core/src/tools/mcp-client.ts` has TWO connect-to-server paths:

1. `McpClient` class (mcp-client.ts:100) — used by `McpClientManager`
2. `connectToMcpServer` factory function (mcp-client.ts:875) — used by `discoverMcpTools` (line 560) and `connectAndDiscover` (line 607)

F2-1 must converge both behind `McpClient.discoverAndReturn` (with `connectToMcpServer` becoming a private helper of `McpClient` or both calling a shared `establishConnection()` primitive). Otherwise pool only covers the class path; the factory path remains per-session and undermines the whole effort.

---

## 8. Global State Coexistence

### 8.1 `serverStatuses` (mcp-client.ts:292) — collision-tolerant write

Module-level `Map<serverName, MCPServerStatus>`. Pool's `ConnectionId` is `name::hash`, but `updateMCPServerStatus(name, status)` writes by name. **Multiple pool entries for same name (different fingerprints, e.g. token-divergence) would clobber each other's status.**

**Resolution**: pool intercepts status writes:

```ts
class PoolEntry {
  updateStatus(s: MCPServerStatus) {
    this.localStatus = s;
    const aggregated = this.pool.aggregateStatusByName(this.serverName);
    updateMCPServerStatus(this.serverName, aggregated);
  }
}

class McpTransportPool {
  aggregateStatusByName(name: string): MCPServerStatus {
    // Any CONNECTED ⇒ CONNECTED
    // Else any CONNECTING ⇒ CONNECTING
    // Else DISCONNECTED
    const entries = [...this.entries.values()].filter(
      (e) => e.serverName === name,
    );
    if (entries.some((e) => e.localStatus === CONNECTED)) return CONNECTED;
    if (entries.some((e) => e.localStatus === CONNECTING)) return CONNECTING;
    return DISCONNECTED;
  }
}
```

Status route surfaces `entryCount: number` so operators see when name → multiple entries.

### 8.2 OAuth token storage

`MCPOAuthTokenStorage` writes to `~/.qwen/mcp-oauth/<serverName>.json` — already daemon-host-shared. Pool benefits incidentally (first session's OAuth completes → token on disk → pool entry's reconnect picks up token → all other sessions piggy-back).

**Caveat — multi-fingerprint case**: 2 entries for same name (different headers/env) but same OAuth provider → both read the same token file. If tokens are server-scoped (OAuth typical), this works. If tokens are env-scoped (rare), explicit storage key extension needed. **Punt to F3** with a documented known-limitation.

### 8.3 `entryCount` in snapshot

`GET /workspace/mcp` per-server cell adds:

```ts
{
  kind: 'mcp_server',
  name: 'github',
  status: 'ok',
  mcpStatus: 'connected',
  entryCount: 2,                          // NEW — N pool entries for this name
  entrySummary?: [                        // NEW — opaque per-entry breakdown
    { entryIndex: 0, refs: 2, status: 'connected' },
    { entryIndex: 1, refs: 1, status: 'connecting' },
  ],
  ...
}
```

**V21-7**: `entrySummary[].entryIndex` is a **stable opaque integer** assigned at entry creation (insertion order within name group), NOT the raw fingerprint. Reasoning: fingerprint changes when OAuth tokens or env vars rotate, which would leak that information through snapshot diffs (operator could infer "token rotated at T+5min" from `'a3b1' → 'f972'` transition). `entryIndex` is monotonic within name group but stays stable across rotations because old entry drains and new entry gets next index.

Old SDK clients ignore unknown fields per PR 14 contract; new clients use `entryCount` for badges. Internal restart-by-fingerprint path uses an opaque token returned only via privileged extMethod, not exposed in HTTP snapshot.

---

## 9. WorkspaceContext / ListRoots

### 9.1 Single registration

Pool's `McpClient` instances share **one** `WorkspaceContext` — the daemon's bound workspace context (PR #4113 invariant). `connectToMcpServer`'s `ListRootsRequestSchema` handler closes over this single context.

`onDirectoriesChanged` listener registered **once per entry**, not once per `acquire`. Detached on entry shutdown.

### 9.2 `roots/list_changed` fan-up

Server notifies client of new roots → pool fans out:

- Pool re-discovers (server may report different tool set under new roots) → `toolsChanged` event → all subscriber views re-apply

### 9.3 Per-session `updateWorkspaceDirectories`

**Contract**: in Mode B, per-session directory additions are a soft hint, not authoritative. Pool's `WorkspaceContext` is daemon-level.

Two implementations choices:

- **v1 simple**: ignore per-session adds, log warning when detected
- **v2 union**: pool maintains `extraRoots: Map<sessionId, Set<dir>>`, ListRoots handler returns union of bound workspace + all extras. Per-session removal triggers `roots/list_changed`. Adds 50-80 LOC complexity.

**Pick v1 simple for F2**; v2 union as follow-up if user pain materializes.

---

## 10. Per-session Injection

### 10.1 `mcpServers` from `newSession({mcpServers})`

`newSessionConfig(cwd, mcpServers, ...)` merges injected list with `settings.merged.mcpServers` (acpAgent.ts:1778-1831). Pool consumes the **per-session merged view**:

```ts
async newSessionConfig(...) {
  const config = await loadCliConfig(...);
  if (this.mcpPool) config.setMcpTransportPool(this.mcpPool);
  // ...existing setMcpBudgetEventCallback REMOVED — pool handles broadcast directly
}
```

When two sessions inject same-name server with different env/headers → different fingerprints → two pool entries. Pool sharing kicks in only when sessions agree exactly.

### 10.2 Auth divergence

Static `~/.qwen/settings.json` mcpServers are identical across sessions → all share → 80% case. Per-session injected mcpServers with per-user tokens → unique fingerprints → no sharing. Both safe.

### 10.3 HTTP transport opt-in (recap from §5.2)

Default `pooledTransports = {stdio, websocket}`. HTTP/SSE servers go through `createUnpooledConnection` path (one McpClient per session) unless operator opts in.

### 10.4 `/mcp disable X` mid-session (V21-6)

When operator runs `/mcp disable github` against a live session:

1. `Config.disableMcpServer('github')` adds to per-Config `disabledMcpServers` set
2. **F2 hook**: `Config.onDisabledMcpServersChanged` fires; `SessionMcpView` for that name calls `teardown()` (removes its tool/prompt registrations from session registries)
3. Pool entry **may stay alive** if other sessions still reference it (refcount > 0) — only the disabling session's view detaches
4. If all sessions disable → refcount → 0 → drain timer starts

Without step 2, mid-session disable would leave already-registered tools in the session's `ToolRegistry` until next session restart. Test 21.4 covers this.

`/mcp enable github` is the inverse: triggers fresh `pool.acquire` for the session, attaches new view, re-applies snapshot.

---

## 11. Budget Guardrails Graduation

### 11.1 State machine moves to pool

`tryReserveSlot` / `releaseSlotName` / 75% hysteresis / refused_batch coalescing / `bulkPassDepth` / `pendingRefusalNames` — all migrate from `McpClientManager` to `McpTransportPool`. `McpClientManager` retains the state only when running standalone (no pool injected).

### 11.2 Snapshot cell scope

```ts
{
  kind: 'mcp_budget',
  scope: 'workspace',          // NEW value (PR 14 v1 returned 'session')
  liveCount: 5,
  clientBudget: 10,
  budgetMode: 'enforce',
  status: 'ok',
}
```

Per PR 14 contract: "Consumers MUST tolerate additional entries with unrecognized scope values (drop, don't fail)." Old SDK clients see `scope: 'workspace'`, render as unknown (or fallback to top-level numbers). New SDK adds `isWorkspaceScopedBudget(cell)` helper.

### 11.3 Event fan-out

```ts
class QwenAgent {
  constructor() {
    this.mcpPool = new McpTransportPool({
      onBudgetEvent: (event) => this.broadcastBudgetEvent(event),
    });
  }

  private broadcastBudgetEvent(event: McpBudgetEvent) {
    for (const [sid, session] of this.sessions) {
      const enriched = {
        ...event,
        scope: 'workspace' as const,
        sessionId: sid,
      };
      session.connection
        .extNotification('qwen/notify/session/mcp-budget-event', enriched)
        .catch((err) =>
          debugLogger.debug('budget event delivery failed', { sid, err }),
        );
    }
  }
}
```

### 11.4 SDK type contract changes

PR 14b exported these (must extend additively):

- `DaemonMcpBudgetWarningData` — add `scope?: 'workspace' | 'session'` (optional for backward compat; absent = 'session')
- `DaemonMcpChildRefusedBatchData` — same `scope?` extension
- `DaemonMcpGuardrailEvent` — discriminator unchanged

New SDK helpers:

```ts
export function isWorkspaceScopedBudgetEvent(
  e: DaemonMcpGuardrailEvent,
): boolean;
```

Reducer state on `DaemonSessionViewState`:

- **No new fields** — `mcpBudgetWarningCount` / `mcpChildRefusedBatchCount` increment regardless of scope (scope is a property of each event, not a separate stream)
- Document that under F2 these counts reflect workspace-level events fanned to every session — they will increment **simultaneously across all attached sessions** when budget pressure occurs

**V21-12 (Q1 resolved, locked in v2.1)**: keep existing field names (`mcpBudgetWarningCount`, `mcpChildRefusedBatchCount`, `lastMcpBudgetWarning`, `lastMcpChildRefusedBatch`) with extended scope semantics documented in JSDoc:

```ts
/**
 * Count of `mcp_budget_warning` events the session has observed.
 * Under F2 (`scope: 'workspace'`), this increments simultaneously
 * across all attached sessions because budget events fan out at
 * workspace level. Use `isWorkspaceScopedBudgetEvent(lastMcpBudgetWarning)`
 * to inspect scope of the most recent event.
 */
mcpBudgetWarningCount: number;
```

Rationale: PR 14b already shipped these names as public SDK surface; renaming is a breaking change worse than the slightly imprecise semantics.

---

## 12. OAuth — Explicit F3 Deferral

OAuth 401 fallback in `connectToMcpServer` (mcp-client.ts:950-1010) needs interactive resolution (browser open or device-flow). Mode B daemon **must not spawn a browser** (per PR 21 design — static-source grep test fails build on `open`/`xdg-open`/`shell.openExternal`).

**F2 behavior on OAuth-requiring server**:

1. First acquire triggers `connectToMcpServer` → 401 detected
2. Pool catches OAuth-required exception, marks entry as `failed_auth_required`
3. Status route surfaces `errorKind: 'auth_env_error'` (existing PR 13 errorKind)
4. Pool **does not retry automatically**
5. Operator runs `/mcp auth <name>` (existing CLI) OR uses PR 21's device-flow route to get a token on disk → next session acquire re-attempts and succeeds

**F3 will replace step 4-5** with `PermissionMediator` routing OAuth completion request to attached sessions for first-responder.

This avoids F2 mixing into auth state-machine work.

---

## 13. Restart Route Semantics

### 13.1 `POST /workspace/mcp/:server/restart` under pool

Today (PR 17): restart in bootstrap session's manager = restart the single entry for that name.

Under pool: name → possibly multiple entries (different fingerprints for same name = different sessions with different configs).

**Spec'd behavior**:

| Request                                            | Behavior                                                                             |
| -------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `POST /workspace/mcp/:server/restart`              | Restart **all** entries matching `serverName` (parallel via `Promise.allSettled`)    |
| `POST /workspace/mcp/:server/restart?entryIndex=0` | V21-3: restart only entry #0 (the opaque index from snapshot §8.3); 404 if not found |
| `POST /workspace/mcp/:server/restart?entryIndex=*` | Explicit "all" (same as no param)                                                    |

Response shape:

```ts
type RestartResult = {
  entryIndex: number;        // V21-7: opaque index, not raw fingerprint
  restarted: boolean;
  durationMs?: number;
  reason?: string;           // 'budget_would_exceed' | 'not_connected' | 'in_flight'
};
POST /workspace/mcp/:server/restart → { entries: RestartResult[] }
```

Old shape `{restarted: true, durationMs}` retained when `entries.length === 1` AND no `entryIndex` query param for backward compat; clients can detect new shape by checking `'entries' in response`.

### 13.2 In-flight restart dedupe

```ts
class PoolEntry {
  private restartInFlight?: Promise<void>;
  async restart(): Promise<void> {
    if (this.restartInFlight) return this.restartInFlight;
    this.restartInFlight = this.doRestart().finally(() => {
      this.restartInFlight = undefined;
    });
    return this.restartInFlight;
  }
}
```

### 13.3 Budget check (preserves PR 17 behavior)

Pre-restart, pool checks budget: if disconnect+reconnect would still fit, OK. The current PR 17 `{restarted:false, skipped:true, reason:'budget_would_exceed'}` semantic preserved (just now applied per-entry).

### 13.4 In-flight tool call during reconnect (V21-5, new)

Session A invokes `pool.callTool('git.commit', args)` → request hits stdin of underlying child → child process crashes mid-write → entry transitions to reconnect:

```ts
class MCPCallInterruptedError extends Error {
  readonly serverName: string;
  readonly entryIndex: number;
  readonly clientGeneration: number;   // pre-reconnect generation
  readonly args: unknown;              // original args, for caller to retry if safe
  constructor(serverName, entryIndex, clientGeneration, args) { ... }
}
```

**Spec**:

- The in-flight call promise rejects with `MCPCallInterruptedError` as soon as transport drop detected (don't wait for reconnect)
- Pool **does NOT auto-retry** the call; semantics unsafe for writes (commit, file edit, etc.) and pool can't distinguish read from write
- Caller (typically tool execution layer in agent loop) catches this error and decides: retry / surface to user / abort
- After reconnect: session A can re-call (same `PooledConnection.callTool`); pool routes to the new transport instance transparently
- `MCPCallInterruptedError.clientGeneration` lets caller correlate with subsequent `reconnected` event if needed

Test 21.6 must cover: spawn a long-running stdio MCP, send tool call, kill the child mid-call, assert `MCPCallInterruptedError` rejection with non-zero `clientGeneration`.

---

## 14. Status Route Refactor

### 14.1 New query path

```ts
// httpAcpBridge.ts:733 buildWorkspaceMcpStatus — replace data source
let accounting: McpClientAccounting | undefined;
try {
  // NEW: query pool directly via bridge extMethod, not bootstrap session
  accounting = await this.bridge.client.getMcpPoolAccounting();
} catch (err) {
  // Fallback to legacy bootstrap session path for non-pool daemon
  const manager = config.getToolRegistry()?.getMcpClientManager();
  if (manager) accounting = manager.getMcpClientAccounting();
}
```

`QwenAgent` exposes `getMcpPoolAccounting()`:

```ts
class QwenAgent {
  getMcpPoolAccounting(): McpClientAccounting | undefined {
    return this.mcpPool?.getAccounting();
  }
}
```

ACP child bridges through `extMethod` for the daemon to call.

### 14.2 entryCount + entrySummary

Per §8.3.

### 14.3 No-bootstrap-session case

Today (PR 12), when daemon is idle (no sessions yet), `GET /workspace/mcp` returns `initialized: false` because there's no bootstrap session to query.

Under pool: pool exists from `QwenAgent` ctor → status route can return live accounting **even with zero sessions**. Cell `initialized: true` even pre-first-session. **Documented behavior change** in PR description; not a regression.

---

## 15. loadSession / resume Interaction (PR 6 #4222)

### 15.1 Drain cancellation on resume

```
session-A active, holds entry-X ref
session-A disconnect (no explicit close) → eventually killSession → pool.releaseSession(A) → entry-X.refs.size === 0 → drain timer starts (30s)
session-A resume within 30s → new newSessionConfig → pool.acquire returns entry-X → attach cancels drain
session-A resume after 30s → entry-X already closed → pool spawns new entry (cold start)
```

### 15.2 `restoreState` cache window (5min, from PR 6)

`acpAgent.restoreState` is held 5 min after disconnect. Pool drain (30s default) < restore window (5min) → resume between 30s and 5min pays MCP cold start. Acceptable trade-off (resume itself is rare path).

Alternative: pool reads daemon's restore-window config and extends drain to match. Adds coupling between pool and session state machine; **defer to follow-up unless user reports cold-start pain**.

### 15.3 `pendingRestoreIds` interaction

`acpAgent.killSession()` must call `pool.releaseSession(sid)` AFTER cleaning `pendingRestoreIds`. Order:

1. Session marked as restorable (`pendingRestoreIds.add(sid)`)
2. Session.close() — but pool ref still held
3. After `RESTORE_WINDOW_MS` elapses without resume: `killSession` permanently cleans → `pool.releaseSession(sid)` triggers drain

Avoids drain firing during a restore window.

---

## 16. Hot Config Reload

### 16.1 Implicit reload via fingerprint change

User edits `~/.qwen/settings.json` mid-flight, changes a server's env:

1. Old sessions keep old `Config`/`McpServers` snapshot → keep acquiring old fingerprint → entry-OLD ref persists
2. New session reads fresh settings → new fingerprint → entry-NEW created → coexists with entry-OLD
3. Old sessions naturally close → entry-OLD drains → eventually closed
4. Steady state: only entry-NEW remains

**No live-mutation of running connections** — clean separation between sessions on different config versions.

### 16.2 Forced reload route (optional)

```
POST /workspace/mcp/reload-all
  → for each session: re-load settings, swap Config.mcpServers
  → for each entry no longer referenced: schedule eviction
```

Useful for "I changed env vars and want immediate effect across all sessions." Defer to F2 follow-up (not blocking).

### 16.3 Extension uninstall orphan entries (V21-15)

Scenario: extension `foo-ext` registers MCP server `foo-server`. Operator runs `/extension uninstall foo-ext`. Extension lifecycle removes `foo-server` from `extensionMcpServers` so future `loadCliConfig` calls don't include it. But:

- Live sessions hold `Config` snapshots that still include `foo-server` → those sessions keep using the entry
- New sessions after uninstall don't acquire (server no longer in their merged mcpServers) → no refcount increase

**Resolution**: rely on natural drain. As old sessions close, refcount drops; eventually entry hits `MAX_IDLE_MS = 5min` and is force-closed. **No explicit `pool.invalidateByExtension(name)` API** — keeps the model uniform with hot config reload (§16.1).

Trade-off: extension's server may run up to 5min after uninstall if a long session keeps it alive. Acceptable; operators can `/mcp restart foo-server` then kill the session if urgency requires.

---

## 17. Shutdown Ordering

`QwenAgent.close()` sequence (must be enforced):

```
1. Set acceptingNewSessions = false; reject new POST /session
2. For each in-flight prompt: signal cancel, await completion (existing PR 11 lifecycle)
3. For each session: trigger close → pool.releaseSession(sid)
4. await pool.drainAll({ force: true, timeoutMs: 10_000 })   ← bypasses 30s grace
   ├── For each entry: cancel drain + health timers, mark draining
   ├── For each entry in parallel: listDescendantPids → SIGTERM children
   ├── For each entry in parallel: client.disconnect()
   └── Promise.race against timeoutMs; abandoned entries get SIGKILL
5. Bridge channel close
6. Process exit
```

**V21-11**: `drainAll` signature:

```ts
async drainAll(opts?: {
  force?: boolean;       // default false; true bypasses 30s grace timer
  timeoutMs?: number;    // default 10_000; wall-clock budget; SIGKILL stragglers after
}): Promise<DrainResult>;

type DrainResult = {
  drained: number;       // entries that disconnected cleanly
  forced: number;        // entries SIGKILLed after timeout
  errors: Array<{ entryIndex: number; serverName: string; error: string }>;
};
```

Caller uses `DrainResult` for shutdown logging; on `forced > 0` log a warning so operator knows a server didn't shut down cleanly.

---

## 18. File Layout

**New files:**

```
packages/core/src/tools/
  mcp-transport-pool.ts        # McpTransportPool main (~700 LOC)
  mcp-pool-key.ts              # fingerprint + canonicalize helpers (~150 LOC)
  mcp-pool-entry.ts            # PoolEntry: refcount + drain + health + generation (~500 LOC)
  session-mcp-view.ts          # SessionMcpView: filter + register tools/prompts (~200 LOC)
  mcp-pool-events.ts           # PoolEvent discriminated union (~80 LOC)
  pid-descendants.ts           # listDescendantPids cross-platform (~150 LOC, incl. tests)

packages/core/src/tools/
  mcp-transport-pool.test.ts   # ~900 LOC
  mcp-pool-entry.test.ts       # ~400 LOC
  session-mcp-view.test.ts     # ~250 LOC
  mcp-pool-key.test.ts         # ~150 LOC
  pid-descendants.test.ts      # ~200 LOC (Unix + Windows skip-gated)
```

**Changed files:**

```
packages/core/src/tools/mcp-client.ts            # discoverAndReturn() split; connectToMcpServer unified
packages/core/src/tools/mcp-client-manager.ts    # optional pool param; budget state conditional
packages/core/src/tools/tool-registry.ts         # threads pool from config into McpClientManager
packages/core/src/config/config.ts               # setMcpTransportPool / getMcpTransportPool
packages/cli/src/acp-integration/acpAgent.ts     # QwenAgent.mcpPool construction; broadcastBudgetEvent;
                                                 # newSessionConfig wires pool into Config;
                                                 # killSession calls pool.releaseSession
packages/cli/src/serve/run-qwen-serve.ts           # pass --mcp-pool-transports + budget env to ACP child
packages/cli/src/serve/httpAcpBridge.ts          # buildWorkspaceMcpStatus reads pool;
                                                 # restartMcpServer extMethod returns RestartResult[]
packages/cli/src/serve/capabilities.ts           # advertise mcp_workspace_pool
packages/sdk/src/daemon/mcpEvents.ts             # scope?: optional field; isWorkspaceScopedBudgetEvent helper
```

---

## 19. Single-PR Delivery — Commit Breakdown (V21-1)

Per maintainer's feature-cohesive batch guidance (#4175 branching strategy 2026-05-19), F2 ships as **one PR with 6 atomic commits**. Reviewer can step through with `git log -p HEAD~6..HEAD` and review commit-by-commit.

| Commit # | Title                                                                                         | Scope                                                                                                                                                                                                                                                                                                                                                                                                                  | Touches                                                                                                                  |
| -------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 1        | `refactor(core): split McpClient.discover into pure tool/prompt list and unify connect paths` | Add `discoverAndReturn()`; extract shared `establishConnection()` used by both `McpClient.connect()` and `connectToMcpServer()` factory; legacy `discover()` becomes thin wrapper that registers (preserves standalone qwen behavior). Zero observable behavior change.                                                                                                                                                | `mcp-client.ts`, `mcp-client.test.ts`                                                                                    |
| 2        | `feat(core): McpTransportPool + SessionMcpView`                                               | Pool core: `fingerprint`, refcount, `spawnInFlight` dedupe, `sessionToEntries` reverse index, drain state machine, snapshot replay on attach, generation guard, tool+prompt dual fan-out, per-session trust copy. Mock McpClient for unit tests. No production wiring.                                                                                                                                                 | new `mcp-transport-pool.ts`, `mcp-pool-key.ts`, `mcp-pool-entry.ts`, `session-mcp-view.ts`, `mcp-pool-events.ts` + tests |
| 3        | `feat(core): cross-platform descendant pid sweep + pool health monitor`                       | `listDescendantPids` (Unix `pgrep -P` recursive, Windows PowerShell CIM); unified health monitor inside `PoolEntry` (interval check + failure count + reconnect backoff per §6.6); subprocess-spawn integration tests gated on `QWEN_INTEGRATION === '1'`.                                                                                                                                                             | new `pid-descendants.ts` + tests; `mcp-pool-entry.ts`                                                                    |
| 4        | `feat(serve): wire McpTransportPool into QwenAgent daemon mode`                               | `Config.setMcpTransportPool` + `getMcpTransportPool`; `ToolRegistry` threads pool into `McpClientManager`; `McpClientManager` optional `pool?` ctor param; `acpAgent.QwenAgent` constructs pool at init; `newSessionConfig` injection; `killSession` calls `pool.releaseSession`; SDK MCP + HTTP/SSE bypass via `createUnpooledConnection`; CLI flags `--mcp-pool-transports`, `--mcp-pool-drain-ms`, `--no-mcp-pool`. | `config.ts`, `tool-registry.ts`, `mcp-client-manager.ts`, `acpAgent.ts`, `run-qwen-serve.ts`                             |
| 5        | `feat(serve): pool-aware status + restart routes`                                             | `QwenAgent.getMcpPoolAccounting` extMethod; `httpAcpBridge.buildWorkspaceMcpStatus` pool-first + bootstrap-session fallback; `restartMcpServer` accepts `?entryIndex=` and returns `RestartResult[]`; `entryCount` + `entrySummary[].entryIndex` on cell; capability tags `mcp_workspace_pool` + `mcp_pool_restart`.                                                                                                   | `httpAcpBridge.ts`, `capabilities.ts`, SDK types                                                                         |
| 6        | `feat(serve): graduate MCP budget guardrails to workspace scope`                              | Move `tryReserveSlot`/`releaseSlotName`/hysteresis state machine from `McpClientManager` to pool; remove per-session `setMcpBudgetEventCallback` wiring in `acpAgent.newSessionConfig`; `QwenAgent.broadcastBudgetEvent` fan-out; snapshot cell `scope: 'workspace'`; SDK `scope?` additive field; `isWorkspaceScopedBudgetEvent` helper; inline doc updates.                                                          | `mcp-transport-pool.ts`, `mcp-client-manager.ts`, `acpAgent.ts`, `httpAcpBridge.ts`, SDK                                 |

**Total LOC estimate**: ~4100 production + ~1900 tests = ~6000 LOC (v2 estimate ~3850; growth absorbs V21 corrections).

**Merge target**: single PR into `daemon_mode_b_main`. Periodic batch merge to `main` per #4175 strategy.

**Self-review process before opening PR**:

1. After each commit, run `code-reviewer` agent on the commit diff; fold adopted findings into the same commit
2. For commit 2/4/6 (highest design risk), additionally run `silent-failure-hunter` + `type-design-analyzer`
3. After all 6 commits land: 3 full review passes by different agent combinations on the full PR diff
4. Run full test suite + typecheck + lint across all touched packages

Mirror PR 21's specialist pre-review pattern.

---

## 20. Capability Tags + SDK Contract Changes

### 20.1 New capability tags (advertised atomically in v0.16, V21-1)

Because F2 ships as one PR, all three tags advertise together. Pool consumers may assume **`mcp_workspace_pool` advertise ⇒ `entryCount`/`entrySummary`/`scope?` fields all present**; no per-field capability check needed.

| Tag                        | When advertised                                                                                        | Meaning                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `mcp_workspace_pool`       | When `QwenAgent.mcpPool !== undefined` (always true in daemon mode unless `--no-mcp-pool` kill switch) | `GET /workspace/mcp` reflects pool-level state; `entryCount` + `entrySummary` fields present           |
| `mcp_pool_restart`         | Always when `mcp_workspace_pool` is on                                                                 | `POST /workspace/mcp/:server/restart` accepts `?entryIndex=` and may return `entries: RestartResult[]` |
| (extends `mcp_guardrails`) | unchanged                                                                                              | Same tag, payload extended with `scope` (`'workspace'` under F2)                                       |

### 20.2 SDK additive surface

```ts
// @qwen-code/sdk — additive only
export interface DaemonMcpBudgetWarningData {
  // existing fields...
  scope?: 'workspace' | 'session'; // NEW — absent on old daemons (means 'session')
}

export interface DaemonMcpChildRefusedBatchData {
  // existing fields...
  scope?: 'workspace' | 'session';
}

export interface ServeWorkspaceMcpServerStatus {
  // existing fields...
  entryCount?: number;
  entrySummary?: Array<{
    fingerprint: string;
    refs: number;
    status: MCPServerStatus;
  }>;
}

export function isWorkspaceScopedBudgetEvent(
  e: DaemonMcpGuardrailEvent,
): boolean;
```

`EVENT_SCHEMA_VERSION` stays at `1` (additive).

---

## 21. Test Matrix

### 21.1 Pool key (F2-2)

- Same cfg → same key (env-key permutation stable, header-key permutation stable)
- env value diff 1 byte → different key
- header `Authorization` value diff → different key
- `includeTools`/`excludeTools`/`trust` mutated → SAME key (per-session filter)
- Two `new MCPServerConfig(...)` with identical content → same key (canonical hash, not identity)

### 21.2 Lifecycle (F2-2)

- 3 sessions acquire same key → 1 spawn (verify via spy on `client.connect`)
- Release sequence n,n-1,...,1 → drain timer starts only on 1→0
- 30s drain: acquire at 25s cancels timer; acquire at 35s spawns new entry
- `MAX_IDLE_MS` (5min) hard close even if drain flapping
- Spawn fails during in-flight: all awaiters get error; slot released; no entry stored

### 21.3 Concurrent acquire (F2-2)

- 5 simultaneous `acquire(sameKey)` while no entry exists → exactly 1 `spawnEntry` call, all 5 get same entry
- Spawn rejects → all 5 awaiters reject with same error; subsequent acquire re-spawns

### 21.4 Per-session isolation (F2-2)

- Session A `excludeTools: ['foo']`, Session B no exclusion → A's ToolRegistry omits foo, B has it; both from same `toolsSnapshot`
- Session A `trust: true`, Session B `trust: false` → Session A's `DiscoveredMCPTool.trust === true`, B's `false`; verify NOT shared reference (mutating one doesn't affect other)
- Session A acquires prompt-only server → A's PromptRegistry populated, ToolRegistry empty for that server

### 21.5 Tool/Prompt list change (F2-2)

- Server emits `notifications/tools/list_changed` → all subscribers' `applyTools` called with new snapshot
- Stale handler from pre-reconnect generation does NOT overwrite snapshot
- `notifications/prompts/list_changed` analog

### 21.6 Crash + reconnect (F2-2)

- Kill subprocess via `process.kill` → subscribers receive `disconnected` event
- 3 reconnect attempts (using existing `MCPHealthMonitorConfig`) → success → `reconnected` + fresh snapshot
- Exhausted retries → all subscribers receive `failed`; entry transitions to `failed` state; new acquires retry once then throw

### 21.7 Descendant pid sweep (F2-2b)

- Linux/macOS: spawn `bash -c "sleep 60 & sleep 60"` as stdio command → kill root → verify both descendants reaped (`/proc/<pid>/status` poll, or `kill(0, pid) === false`)
- Windows: spawn `cmd /c "ping -t localhost"` wrapper → kill → verify ping subprocess gone
- `pgrep` unavailable (PATH missing) → graceful degradation: log warning, just SIGTERM root, don't crash

### 21.8 Budget at workspace scope (F2-4)

- 4 sessions × `--mcp-client-budget=2` with 3 static MCP servers → workspace total = 3 (not 12); snapshot cell `scope: 'workspace'`, `liveCount: 3`
- Budget warning fires once per 75% upward crossing across whole workspace; broadcasts to all 4 sessions simultaneously
- Hysteresis re-arm: drop to 37.5% → next crossing fires again

### 21.9 Backward compat (F2-3)

- Standalone `qwen` (no daemon) → `mcpPool === undefined` → all existing `mcp-client-manager.test.ts` tests pass unchanged
- `--no-mcp-pool` daemon flag → falls back to per-session, all existing daemon e2e tests pass

### 21.10 Credential isolation (F2-3)

- Session A injects `{name: 'github', headers: {Authorization: 'Bearer tokenA'}}`, Session B `tokenB` → 2 separate processes; verify by snapshot `entryCount: 2`; verify A's tool calls go through A's transport (by header inspection in stdin/log)

### 21.11 LoadSession / resume (F2-3)

- Session close → drain starts → resume within 30s → pool entry reused (no cold start, asserted via `client.connect` spy count)
- Resume after 30s but before restore-window expiry → pool cold start; restoreState content still preserved

### 21.12 Restart route (F2-3b)

- 1 entry for name → `POST /workspace/mcp/foo/restart` returns legacy `{restarted: true, durationMs}` shape
- 2 entries for name (different fingerprints) → returns `{entries: [{fingerprint, restarted, ...}, ...]}`
- Restart while another restart in-flight → second call returns same promise (deduped)
- Restart when budget would exceed → `{restarted: false, skipped: true, reason: 'budget_would_exceed'}` per entry

### 21.13 Status route (F2-3b)

- Idle daemon (no sessions) but pool has cached entries from previous session → `GET /workspace/mcp` returns `initialized: true` with live accounting
- Bootstrap session DNE → fallback to pool-direct path; no error
- Pool query throws → falls back to bootstrap-session path; never crashes snapshot

### 21.14 SDK reducer (F2-4)

- `mcpBudgetWarningCount` increments simultaneously across all subscriber sessions when workspace event broadcasts
- `isWorkspaceScopedBudgetEvent(e)` correctly identifies scope from payload
- Old daemon (no `scope` field) → defaults to 'session' interpretation

### 21.15 Hot config reload (F2-3)

- Mid-flight settings.json change → old session keeps old entry, new session creates new entry, both coexist; old drains naturally when last old session closes
- 0 sessions after old session closes → drain timer fires → old entry GC'd → only new entry remains

### 21.16 Shutdown ordering (F2-3)

- `QwenAgent.close()` triggers in order: stop accepting → drain prompts → close sessions → `pool.drainAll` → no zombie pids in `pgrep -P <acpChildPid>` after exit

---

## 22. Open Questions

V21 locked Q1/Q3/Q4/Q6 in design defaults (single-PR delivery). Q2/Q5/Q7/Q8/Q9 remain.

| #     | Question                                                                                                          | F2 design default                                                                         | Decision needed before |
| ----- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------- |
| Q1 ✅ | SDK reducer field names — rename or keep?                                                                         | **LOCKED v2.1**: keep `mcpBudgetWarningCount` etc. with extended scope semantics in JSDoc | resolved               |
| Q2    | `mcp_workspace_pool` capability — bump `protocolVersions` ('v1' → 'v1.1'), or stay 'v1' additive?                 | **Stay 'v1' additive** (consistent with PR 14b precedent)                                 | commit 5               |
| Q3 ✅ | `--no-mcp-pool` flag — default on or opt-in?                                                                      | **LOCKED v2.1**: default on; `--no-mcp-pool` is kill switch                               | resolved               |
| Q4 ✅ | HTTP/SSE default — pool off or on?                                                                                | **LOCKED v2.1**: pool off; opt-in via `--mcp-pool-transports`                             | resolved               |
| Q5    | `POST /workspace/mcp/reload-all` — include in F2 or follow-up?                                                    | **Follow-up**                                                                             | n/a (deferred)         |
| Q6 ✅ | Lazy pool construction — worth the conditional?                                                                   | **LOCKED v2.1**: eager (always construct in `QwenAgent` ctor)                             | resolved               |
| Q7    | `restoreState` window vs pool drain — keep separate, align, or read from settings?                                | **Keep separate 30s default** + config knob `--mcp-pool-drain-ms`                         | commit 4               |
| Q8    | OAuth handling — confirm F3 deferral, document workaround?                                                        | **Deferred to F3**, document `/mcp auth <name>` workaround                                | commit 4               |
| Q9    | `entrySummary` exposure — always include, or behind verbose flag?                                                 | **Always include** (small payload, useful for ops)                                        | commit 5               |
| Q10   | Update `codeagents/qwen-code-daemon-design/02-architectural-decisions.md` decision #3 — coordinate with @wenshao? | F2 PR description links codeagents PR; two PRs reviewed independently                     | PR open                |

---

## 23. Risks

### High

- **R1 (A2 global state)**: `serverStatuses` collision on multi-entry same-name. Mitigated by aggregate-status function; remaining risk is SDK consumers reading the raw global Map (unlikely — only used via `getMCPServerStatus(name)` accessor).
- **R2 (PromptRegistry symmetry)**: forgetting prompt fan-out in any code path silently drops prompts. Mitigated by F2-2 test 21.4 third bullet + integration test asserting prompt parity vs pre-F2.
- **R3 (HTTP transport state-bleed)**: opting in HTTP pool for a server that maintains per-transport state corrupts session contexts. Mitigated by default-off + documentation; cannot detect automatically.

### Medium

- **R4 (path unification F2-1)**: `connectToMcpServer` factory and `McpClient` class have subtle behavioral diffs (e.g. capabilities advertised at construct time vs connect time). Mitigated by F2-1 being a pure refactor PR with full regression coverage before pool work begins.
- **R5 (Windows descendant pid)**: PowerShell `Get-CimInstance` may be slow (spawn cost) or blocked by AppLocker. Mitigated by 2s timeout + graceful degradation.
- **R6 (Pool event broadcast amplification)**: budget warning fanning out to 100 sessions causes 100 extNotification calls in tight loop. Mitigated by `Promise.all` parallelization + per-session catch (existing PR 14b pattern).

### Low

- **R7 (Fingerprint stability across MCPServerConfig versions)**: future fields added to `MCPServerConfig` not included in fingerprint would silently allow incorrect sharing. Mitigated by explicit canonicalization function + test that enumerates all `MCPServerConfig` fields and asserts coverage.
- **R8 (Generation counter races)**: rapid restart cycles could exhaust JS number precision (≈ 2^53 = ~285k years at 1/sec). Not a practical concern.

### Single-PR-specific (V21-14)

- **R9 (Review fatigue on ~6000 LOC single PR)**: Reviewer bandwidth becomes critical path. F3 blocked on F2 merge → blocking other contributors. Mitigation: (a) pre-review with 3 specialist agents and fold P0/P1 before opening, mirroring PR 21's pattern; (b) structure as 6 atomic commits so reviewer can step through; (c) coordinate review window with @wenshao in advance via #4175 comment.
- **R10 (`daemon_mode_b_main` merge conflict accumulation)**: F2 touches `acpAgent.ts`, `httpAcpBridge.ts`, `capabilities.ts`, `mcp-client*.ts` — all hot paths. F3 / F4 contributors landing concurrently risk conflicts during F2's 1–2 week review window. Mitigation: daily `git rebase origin/daemon_mode_b_main`; coordinate via #4175 update that F2 is in-flight + asks F3/F4 to defer hot-file changes until F2 merges.
- **R11 (CI execution time)**: ~1900 LOC of new tests including subprocess spawn + cross-platform pid sweep could push CI from 30min → 50min. Mitigation: (a) gate subprocess tests behind `process.env.QWEN_INTEGRATION === '1'`, run subset in PR CI + full set in nightly; (b) Vitest parallelism ≥ 4; (c) Windows pid sweep tests skip-gated on GHA Windows runner only.

---

## 24. Documentation Updates

| Doc                                                                            | Update                                                                                                                                                  | When                                                 |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `codeagents/qwen-code-daemon-design/02-architectural-decisions.md`             | Decision #3 "MCP server lifetime": currently "per-session"; update to "workspace-pooled with config-hash key under daemon mode; per-session standalone" | F2-3 merges (coordinate with @wenshao codeagents PR) |
| `codeagents/qwen-code-daemon-design/06-roadmap.md`                             | Wave 5 PR 23 → mark as F2 series; link to PRs                                                                                                           | F2-3 merges                                          |
| `packages/cli/src/serve/README.md` (if exists) or new `docs/serve/mcp-pool.md` | New section: pool semantics, fingerprint key, transport opt-in, restart semantics, status snapshot interpretation                                       | F2-3b                                                |
| `packages/sdk/README.md`                                                       | `scope?` field on guardrail events, `entryCount` on server status, helper `isWorkspaceScopedBudgetEvent`                                                | F2-4                                                 |
| Issue #4175 body                                                               | Update F2 entry with sub-PR table, link to design v2 (this doc)                                                                                         | Before F2-1 opens                                    |
| Issue #3803 body                                                               | Decision #3 row: update "Currently per-session" → "Workspace-pooled under daemon (F2)"                                                                  | After F2-3 merges                                    |
| `acpAgent.ts:869-936` inline comment                                           | Remove "Wave 5 PR 23" forward reference; update to "graduated by F2 to `scope: 'workspace'`"                                                            | F2-4 PR                                              |
| CHANGELOG / release notes (Wave 6 / F5)                                        | "MCP processes now shared across sessions in a workspace" headline                                                                                      | F5 release                                           |

---

## 25. PR Description Template (single-PR delivery)

```markdown
## feat(serve): shared MCP transport pool (workspace-scoped) [F2]

Single feature-cohesive PR per #4175 branching strategy (2026-05-19).
Replaces what was originally planned as Wave 5 PR 23 + sub-PRs F2-1..F2-4.

### Scope

~4100 LOC production + ~1900 LOC tests across 6 atomic commits.
Step through with `git log -p HEAD~6..HEAD` for commit-by-commit review.

### Design doc

See `docs/design/f2-mcp-transport-pool.md` (v2.1).

### Pre-review specialist agents (per PR 21 pattern)

Folded into first commit before opening:

- code-reviewer: N findings, all adopted
- silent-failure-hunter: N findings, all adopted
- type-design-analyzer: N findings, all adopted

### Closes

(none — F2 entry in #4175 stays open until PR merges into main batch)

### Related

- #3803 decision #3 update (codeagents PR <link>)
- PR 14b (#4271 merged) — budget guardrail base; F2 graduates scope to workspace
- F1 (#4319 merged) — acp-bridge package; F2 depends on injection seams

### Backward compatibility

- Standalone `qwen` (non-daemon): pool not constructed; existing behavior preserved
- Daemon `qwen serve --no-mcp-pool`: kill switch falls back to per-session
- SDK: all new fields additive (`entryCount`, `scope?`); EVENT_SCHEMA_VERSION stays at 1
- Old SDK clients: unknown `scope: 'workspace'` ignored per PR 14 contract
- Old daemons: SDK consumers can detect absence of `mcp_workspace_pool` capability and fall back

### Test plan

- [ ] Pool key: env permutation stability, header divergence, per-session filter exclusion
- [ ] Lifecycle: 3-session sharing, drain grace, concurrent acquire dedupe, spawn failure slot release
- [ ] Tools + Prompts dual fan-out, per-session trust copy, snapshot replay on attach
- [ ] Generation guard: pre-reconnect handler doesn't overwrite post-reconnect snapshot
- [ ] Crash + reconnect with stdio backoff (5s × 3) and HTTP backoff (1/2/4/8/16s × 5)
- [ ] Descendant pid sweep: Linux/macOS pgrep recursion, Windows PowerShell CIM
- [ ] Budget at workspace scope: 4 sessions × budget=2 → 3 max (not 12); fan-out to all attached
- [ ] LoadSession resume within drain window: pool entry reused, no cold start
- [ ] Hot config reload: old/new entries coexist; old drains naturally
- [ ] Restart route: `?entryIndex=` selectivity; legacy single-entry response shape preserved
- [ ] In-flight tool call during reconnect: `MCPCallInterruptedError` rejection
- [ ] Standalone qwen: all existing mcp-client-manager tests pass unchanged
```

## Summary

F2 v2.1 = single PR with 6 atomic commits (~6000 LOC), targeting `daemon_mode_b_main`. Key design pillars:

1. **`McpTransportPool`** in `packages/core` (ACP child side), workspace-scoped, refcount + 30s drain
2. **Fingerprint key** SHA-256 over canonical config including env/headers (claude-code pattern), excluding per-session filters (includeTools/trust)
3. **`SessionMcpView`** per-session tool+prompt registry projection with trust copy
4. **Snapshot replay + generation guard** for attach race and stale notifications
5. **Cross-platform descendant pid sweep** (opencode pattern + Windows port)
6. **HTTP/SSE opt-in**, SDK MCP bypass, OAuth deferred to F3
7. **Budget state machine** graduates to workspace scope; snapshot cell + push events extend additively (`scope?`)
8. **Status + restart routes** refactor: pool-first with bootstrap-session fallback; `entryCount` + `RestartResult[]`

**Open questions Q1–Q10** in §22 need maintainer decisions before respective sub-PRs open. Recommend resolving Q1–Q4 before F2-3 starts (those gate the broad direction); Q5–Q10 can resolve incrementally.
