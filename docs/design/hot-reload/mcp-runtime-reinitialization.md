# MCP Runtime Hot-Reload Design: settings-driven incremental reconnect (Issue #3696 Sub-task 3)

> Note: sub-task 3's original scope is "MCP/LSP" runtime reconnect; this MR ships **MCP only**. LSP keeps just a sketch + TODO in Part C, deferred to a later MR.

## Context

Issue #3696 is the umbrella tracking issue for the hot-reload system. Sub-task 1
(`SettingsWatcher` file-change detection) is merged, but **has no subscriber yet**—
`gemini.tsx:784` starts the watcher, and the [Sub-task 1 design](./settings-change-detection.md)
explicitly left listener wiring to sub-tasks 2–6. Today, adding/removing/editing an MCP server
in `settings.json` (or installing an extension) requires restarting the whole session, losing
conversation context.

This MR focuses on **MCP** and delivers two things: (a) a runtime entry point that pushes
reloaded settings into the live `Config`; (b) MCP incremental reconnect driven by
`SettingsWatcher`. LSP runtime reconnect belongs to this sub-task but is not implemented here,
leaving only a Part C TODO.

**Core observation**: the "reconnect by diff" incremental reconcile already exists in the code
(single-session `discoverAllMcpToolsIncremental`, shared-pool `runDiscoverAllMcpToolsViaPool`,
touching only changed servers by their `connectionIdOf` fingerprint). The only gap is that
`Config` cannot update its settings snapshot after startup (`addMcpServers()` throws,
`config.ts:3200`). Adding that runtime entry point is **Part A**; triggering it from the watcher
is **Part B**—that is the entirety of this MR. Two firm trade-offs: reuse the existing
incremental reconcile rather than the full-wipe `restartMcpServers()` (which causes a "0 tools"
gap); and the shared-pool path must add the `isMcpServerPendingApproval` approval gate to match
the single-session path (Part A item 4). See "Architecture" below for the component overview and
"Design" for the step-by-step flow and details.

---

## Architecture

In one line: **wire the already-existing incremental reconcile onto settings file changes**, and
fill in the trust boundary and UI feedback along the way. The change splits by responsibility
across the CLI / Core packages, decoupled through `Config` methods and one UI event:

```text
                    CLI package                                  Core package
 ┌──────────────────────────────────────────┐       ┌────────────────────────────────────┐
 │ SettingsWatcher  (sub-task 1, merged)      │       │ Config                              │
 │   └─[Part B] hot-reload.ts                  │ calls │   └─[Part A] reinitializeMcpServers │
 │       when to fire · recompute gating · gate│ ────▶ │       setMcpServers + incr. reconcile│
 │                                             │       │         (McpClientManager pool/single)│
 │   └─[Part D] useMcpApproval · approval modal │ ◀──── │   └─[Part A④] pool-path pending gate │
 │       mid-session pending → re-prompt        │ event │                                     │
 │   └─[Part E] /mcp status view                │       └────────────────────────────────────┘
 │       show "skipped due to approval" reason  │
 └──────────────────────────────────────────┘
```

- **Layering principle**: core must not understand `settings.json` / watcher semantics.
  "When to fire" belongs to the CLI (Part B), "how to update + reconcile" belongs to Core
  (Part A), consistent with sub-task 1; Part B is Part A's sole consumer, interacting only
  through `Config` methods.
- **Main path**: settings change → Part B rebuilds the desired list + gating lists, debounced
  gate → calls Part A → Core incremental reconcile (including the pool-path approval gate) →
  emits `mcp-client-update` to refresh status indicators.
- **Approval branch**: if reconcile leaves a gated server `pending`, Part D triggers the approval
  modal via the `McpPendingApprovalChanged` event; the skip reason is surfaced by Part E in the
  `/mcp` view.
- **Hard prerequisite**: the three schema keys `mcpServers` / `mcp.allowed` / `mcp.excluded` must
  be flipped to hot-reloadable, otherwise the watcher's restart-required suppression gate swallows
  MCP-only edits and the whole chain is inert (see the ⚠️ note at the start of "Design").

| Part  | Responsibility                                                                                                                                 | Layer      | Status          |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | --------------- |
| **A** | `Config` runtime-updatable MCP config + incremental reconcile + pool-path approval gate                                                        | Core       | this MR         |
| **B** | subscribe watcher, recompute gating, debounced gate, call Part A                                                                               | CLI        | this MR         |
| **C** | LSP reinitialize                                                                                                                               | Core       | TODO (later MR) |
| **D** | mid-session pending triggers the approval modal (and fixes missed prompt #6)                                                                   | CLI        | follow-up       |
| **E** | `/mcp` shows the "skipped due to approval" reason                                                                                              | CLI        | follow-up       |
| **F** | admission semantics: CLI allow-list is an upper bound, `mcp.allowed: []` = deny-all, and tool-not-found explains _why_ a server is unavailable | CLI + Core | follow-up       |

"Design" below gives the step-by-step data flow from disk file to live connection, plus each
part's implementation details.

---

## Design

The diagram below is the full data flow of one settings change from "disk file" to "connection
takes effect" (`[CLI]` = Part B, `[Core]` = Part A, `[sub-task 1]` = the merged watcher):

```text
① User edits .qwen/settings.json (add/remove/edit mcpServers, or mcp.excluded / mcp.allowed)
       │
       ▼
② [sub-task 1] SettingsWatcher detects the file change
       │   · 300ms debounce: coalesce consecutive saves
       │   · whole-file semantic diff: notify only if content really changed (self-write / pure formatting → no notify)
       ▼
③ [CLI · Part B] the callback registered by registerMcpHotReload fires (any settings change reaches it)
       │
       ├─ a. assembleMcpServers(settings.merged.mcpServers, cwd, topTier)
       │        → merge by priority into the full server list `next` (incl. .mcp.json / --mcp-config / session)
       ├─ b. recompute the connection-gating lists nextGating = { excluded, allowed, pending }
       └─ c. gate: mcpServersEqual(old, next) AND mcpGatingEqual(old, nextGating) both "unchanged"
                → early return (ignore theme / skills and other MCP-irrelevant edits)
       │ (continue only if mcpServers OR the mcp gating lists changed ↓)
       ▼
④ [CLI→Core] push the gating lists into config first (discovery reads them during reconcile):
       config.setExcludedMcpServers / setAllowedMcpServers / setPendingMcpServers
       │
       ▼
⑤ [Core · Part A] config.reinitializeMcpServers(next)
       │   (wrapped by a "reconcile in progress" guard to avoid racing with /reload)
       ├─ a. setMcpServers(next): replace the settings-layer snapshot (extension / runtime layers untouched)
       └─ b. discoverAllMcpToolsIncremental: reconciliation-style incremental reconcile
                · compute each server's connectionIdOf fingerprint, compare "desired" vs "online"
                · added → connect; removed → disconnect + drop tools/prompts;
                  fingerprint changed → disconnect + drop old tools/prompts, then reconnect with new config; unchanged → keep
                · skip disabled / pending / untrusted dir; emit mcp-client-update
       │
       ▼
⑥ [CLI · Part B] UI wrap-up: mcp-client-update refreshes the MCP status indicators;
       (optional) MCP prompts changed → reloadCommands(); set needsRefresh (sub-task 6)
```

> **Trigger timing**: `registerMcpHotReload` runs only once at startup (attach the listener,
> return a disposer); the callback it registers is what fires **on every settings change** via the
> watcher (i.e. from step ③ onward)—that is when reconcile actually runs.

> ⚠️ **Hard prerequisite: three MCP schema keys must be flipped to hot-reloadable (the hidden
> switch in step ②).** The watcher has a "restart-required suppression gate": if **all** keys
> touched by a change are `requiresRestart: true`, it **emits no event**. But `mcpServers` /
> `mcp.allowed` / `mcp.excluded` were all `true`—so an MCP-only edit never fires the callback and
> Part B is inert. This MR **must** flip these **three leaves** to `false`; the parent node `mcp`
> and the startup-only `mcp.serverCommand` stay `true` (matching uses `isRestartRequiredKey`
> longest-prefix match + `flattenSchema`, leaf wins). All three are `showInDialog: false`, so the
> flip does not change the settings dialog's restart prompt; the blast radius is the watcher path only.

The following describes Part A (Core capabilities), Part B (CLI wiring), Part C (LSP, TODO only in
this MR) in turn.

### Part A — Core: make Config runtime-updatable for MCP config and trigger incremental reconcile

**File: `packages/core/src/config/config.ts`**

1. Add a post-init setter that updates the settings snapshot reconcile reads:

   ```ts
   /**
    * Runtime (hot-reload) replacement of the settings-layer MCP server map.
    * Unlike addMcpServers(), it bypasses the `initialized` guard and is a REPLACE
    * (not a merge), so removals take effect. The runtime overlay
    * (addRuntimeMcpServer) and extension contributions are unaffected—getMcpServers()
    * still layers on top of it.
    */
   setMcpServers(servers: Record<string, MCPServerConfig> | undefined): void {
     this.mcpServers = servers;
   }
   ```

   `getMcpServers()` (`:3128`) already layers extensions + `runtimeMcpServers` on top of
   `this.mcpServers`, so replacing only the settings layer is safe for runtime/extension entries.

2. **Connection-gating lists**: the three name lists that decide whether each MCP server may
   connect—`excluded` (blocked), `allowed` (if set, only these connect), `pending` (gated source,
   needs user approval before connecting). These are separate from `mcpServers` (server config):
   the former governs "**whether** to connect", the latter "**which servers and how**". Add setters
   for these three lists that `getMcpServers()` / discovery consult: `setExcludedMcpServers()`
   exists (`:3167`); add `setAllowedMcpServers()` (the field is currently `readonly` and used as a
   filter inside `getMcpServers()`) plus a setter for the pending-approval set.

3. Add a lightweight orchestration method: update config first, then drive the existing
   incremental reconcile, wrapped by a shared "reconcile in progress" guard so `/reload`
   (sub-task 5) and the watcher don't race:

   ```ts
   /**
    * Apply a new settings-layer MCP map and incrementally reconcile live connections
    * (connect added, disconnect removed, restart changed; keep unchanged untouched).
    * Calling before initialize() is a safe no-op.
    */
   async reinitializeMcpServers(servers: Record<string, MCPServerConfig> | undefined): Promise<void> {
     this.setMcpServers(servers);
     const registry = this.getToolRegistry();
     await registry.getMcpClientManager().discoverAllMcpToolsIncremental(this);
   }
   ```

   `discoverAllMcpToolsIncremental` already checks `isTrustedFolder()`, handles disabled/SDK
   servers, and emits `mcp-client-update` to refresh the UI status indicators. Removed server →
   release + drop tools/prompts; fingerprint changed → release + re-acquire; unchanged → keep.

4. **Add the pending-approval check to the shared-pool path** (trust boundary, mandatory in this
   MR): the single-session path skips servers pending approval, but when a shared pool exists
   `discoverAllMcpToolsIncremental` delegates to `runDiscoverAllMcpToolsViaPool`, and **the pool
   path only skips disabled / SDK, not `isMcpServerPendingApproval`** (around
   `mcp-client-manager.ts:1461`). Without this fix, in daemon / shared-pool mode a hot-reload that
   adds/edits a gated `.mcp.json` / workspace server would acquire a pool connection and spawn the
   process **before** the user approves, bypassing the #4615 approval gate. Fix: add the
   `isMcpServerPendingApproval` check in the pool path **before building `desiredIds` and before
   acquire**, making its admission semantics match the single-session path.

### Part B — CLI: subscribe SettingsWatcher → MCP reconcile

**New file: `packages/cli/src/config/hot-reload.ts`**, wired after
`settingsWatcher.startWatching()` (`:785`) in `gemini.tsx`.

```ts
export function registerMcpHotReload(
  watcher: SettingsWatcher,
  settings: LoadedSettings,
  config: Config,
  topTierMcpServers: Record<string, MCPServerConfig> | undefined,
): () => void {
  return watcher.addChangeListener(async (events) => {
    // Rebuild exactly the way Config boot did—including top-tier (CLI/session) sources.
    const next = assembleMcpServers(
      settings.merged.mcpServers,
      config.getTargetDir(),
      topTierMcpServers,
    );
    // Recompute the gating lists (excluded/allowed/pending)—[settings at hot-reload time win],
    // see the "admission stance" decision below; pending is always recomputed per the #4615 gate.
    const nextGating = {
      excluded: recomputeExcluded(settings, next),
      allowed: recomputeAllowed(settings, next),
      pending: recomputePending(settings, next),
    };
    // gate: reconcile only if mcpServers OR the mcp gating lists changed;
    // if both unchanged, early-return (ignore theme / skills and other MCP-irrelevant edits).
    const serversChanged = !mcpServersEqual(
      config.getSettingsMcpServers(),
      next,
    );
    const gatingChanged = !mcpGatingEqual(config.getMcpGating(), nextGating);
    if (!serversChanged && !gatingChanged) return;
    // Push the gating lists into config before reconcile (discovery inside reinitializeMcpServers reads them).
    config.setExcludedMcpServers(nextGating.excluded);
    config.setAllowedMcpServers(nextGating.allowed);
    config.setPendingMcpServers(nextGating.pending);
    await config.reinitializeMcpServers(next);
    // Notify UI: MCP prompts changed → reloadCommands(); set needsRefresh (sub-task 6).
  });
}
```

> **Admission stance decision (deliberate)**: hot-reload makes **current settings win _within_ the
> startup `--allowed-mcp-server-names` bound** — a runtime edit to `mcp.allowed` / `mcp.excluded` in
> `settings.json` takes effect immediately, but **only narrows admission, never widens it beyond the
> launch flag** (see Part F for the upper-bound rule and the `mcp.allowed: []` semantics). If no
> `--allowed-mcp-server-names` flag was passed, settings fully drive admission. **The pending-approval
> gate (#4615) never yields** regardless: a gated server must always be approved first (Part A item 4).
>
> > _History_: an earlier revision let a runtime settings edit widen admission beyond the startup
> > flag (treating the flag as a mere name-filter convenience). Adversarial review flagged that as a
> > silent loosening of a launch-time boundary; Part F (item K) reverses it — the flag is now an
> > immutable upper bound.

Reuse existing helpers—**do not** reimplement the merge logic:

- `assembleMcpServers(settings.mcpServers, cwd, topTierMcpServers)`—
  `packages/cli/src/config/mcpServers.ts:27` (matching the Config boot call at
  `packages/cli/src/config/config.ts:1812`).
- `SettingsWatcher.addChangeListener` returns an unsubscribe function (`settingsWatcher.ts:253`).
- `config.getSettingsMcpServers()` (`:3124`) as the pre-image for the `mcpServers` diff;
  `config.getMcpGating()` as the pre-image for the gating-list diff (a small new getter returning
  `{ excluded, allowed, pending }`, paired with Part A's setters).

The gate uses two small pure functions to narrow the trigger surface (avoid theme / skills and
other irrelevant edits triggering redundant reconcile, consistent with the watcher's own semantic
diff), both **reusing `fast-deep-equal`** (the cli package must promote it from a transitive to a
direct dependency):

- `mcpServersEqual(a, b)`: object key order irrelevant (eliminates false positives from server /
  field ordering), array order sensitive (`args` and other command-argument order has meaning);
  `undefined` ≡ `{}`.
- `mcpGatingEqual(a, b)`: `excluded` / `allowed` / `pending` compared as **sets** (sort copies
  first); `undefined` ≡ `[]`. It is precisely what lets "edit only `mcp.excluded` / `mcp.allowed`,
  leave `mcpServers` untouched" still trigger reconcile—closing the gap where diffing only
  `mcpServers` would miss gating changes.

UI wrap-up refreshes the status indicators via the existing `mcp-client-update` event, setting
`needsRefresh` when needed (sub-task 6). The floor for this sub-task: config-level reconcile
completes + the existing emit refreshes status.

### Part C — LSP reinitialize (not implemented in this MR, TODO)

LSP config comes from `.lsp.json` + extension config (**not** `settings.json`), so it is **not
auto-triggered by SettingsWatcher**; its runtime reconnect should be driven manually by the later
`/reload` command (sub-task 5). `NativeLspService` (gated by `--experimental-lsp`) already has
lifecycle methods `discoverAndPrepare` / `start` / `stop`, enough to implement a `reinitialize()`
primitive exposed to `/reload` via `LspClient.reinitialize?()` + `Config.reinitializeLsp()`,
without major changes.

> **TODO (next MR)**: implement `NativeLspService.reinitialize()` and its exposure via
> `Config.reinitializeLsp()`, with a detailed design in that MR's doc (including that
> `discoverAndPrepare()` first calls `clearServerHandles()`, preventing an incremental diff, so v1
> uses stop-all → start-all, etc.). **This MR contains no LSP code changes.**

### Part D — Follow-up: hot-reload triggers the runtime approval modal for gated servers (ties into #4615)

> This section was added after Parts A/B landed, while debugging "changed a gated server's URL but
> it doesn't reconnect". It fixes the break where "hot-reload marks a gated server pending but the
> UI shows no approval modal", and incidentally fixes a missed prompt caused by the decision logic
> (issue #6 below).

#### Background: the approval modal was computed only once at startup

A gated-source server (`project`'s `.mcp.json` and `workspace`'s `.qwen/settings.json`, see
`isGatedMcpScope`) has its user approval **bound to the config hash** (`mcpApprovals.ts`'s
`getState`: no record, or a record whose hash differs from the current config → `pending`). So if a
hot-reload changes a gated server's config (even just `httpUrl`), its hash change invalidates the
old approval and it becomes `pending` again.

The Part A/B chain handles this **correctly**: `recomputeMcpGating` puts it in `pending`,
`setPendingMcpServers` pushes it to discovery, and reconcile skips it (no connect, state
`disconnected`). But **the UI shows no approval modal**—the root cause is that `useMcpApproval`
(the hook driving the approval modal) computes its queue only **on mount** via
`useEffect(…, [config])`, and the `config` reference is stable across the session → the effect
never re-runs. That is:

- core marks the server pending (discovery skips it) ✓
- the UI's approval queue never recomputes → **no modal** ✗ (the user only sees `disconnected`, with no way to approve)

The two paths are **disconnected** at runtime.

#### Fix: connect core→UI via an event, hand the decision to the UI

1. **Add event** `AppEvent.McpPendingApprovalChanged` (`packages/cli/src/utils/events.ts`). Since
   `appEvents` is in the CLI layer and `hot-reload.ts` is too, the listener can emit directly, with
   **no core change**.

2. **`hot-reload.ts` emits after reconcile** (placed after `await reinitializeMcpServers`, so
   `config.getMcpServers()` already reflects the new map; emit regardless of reconcile
   success/failure—a server left pending still needs a user decision).

3. **`useMcpApproval` extracts `computePending()`**: compute once on mount (existing behavior)
   **plus** recompute the queue after subscribing to `McpPendingApprovalChanged` → a non-empty
   queue shows the modal. `computePending` recomputes from authoritative sources (the live server
   map + the persisted approval file), so already-approved / already-rejected servers are not
   re-prompted.

#### Key design: drive emit by "strict pending", not a name set-difference (issue #6 / A1 decision)

Note the two predicates are **deliberately different**, which is the heart of this section:

| Function                        | Predicate                                      | Use                                                   |
| ------------------------------- | ---------------------------------------------- | ----------------------------------------------------- |
| `getPendingGatedMcpServers`     | `state !== 'approved'` (**includes rejected**) | feeds discovery: rejected must keep being **skipped** |
| `getPromptableMcpServers` (new) | `state === 'pending'` (**excludes rejected**)  | feeds the modal: rejected is **no longer nagged**     |

The initial emit decision used "the name set-difference of `nextGating.pending` vs last time" to
decide whether to show the modal, which had a missed prompt (review issue #6):

- a **rejected** server stays in the `pending` list because of `!== 'approved'`;
- the user then **re-edits that same server's config** (hash changes → it genuinely becomes
  `pending` again and should be re-asked), but its name was "already in" the list → the
  set-difference is empty → **no event → missed prompt**.

A1 fix: use `getPromptableMcpServers(next, cwd)` (strict `=== 'pending'`) to decide emit, handing
the truth of the decision to `computePending`. Effect:

- after reject, **edit the same server's config** (hash changes) → `pending` again → **re-prompt** ✓ (fixes #6)
- after reject, an **unrelated** edit (hash unchanged) → still `rejected` → not promptable → **no prompt** ✓
- already `approved` → no prompt; a new undecided gated server → prompt ✓

#### reject semantics (confirmed after review)

`handleMcpApprovalSelect(REJECT)`: persists `rejected` (bound to the current hash), does **not**
call `reconnect`, does **not** touch `config.pendingMcpServers` → discovery keeps skipping → the
server stays `disconnected`. No need to actively tear down the old connection: emit happens after
the `reinitializeMcpServers` await, so by the time the modal appears reconcile has already torn it
down. After a session restart `computePending` reads `rejected` → not enqueued, stays disconnected,
consistent behavior.

#### Data-flow addendum (continues after ⑥ in the chapter's overview diagram)

```text
⑥' [CLI · Part D] after reconcile, if a strictly pending gated server exists:
        hot-reload → appEvents.emit(McpPendingApprovalChanged)
        → useMcpApproval.computePending() recomputes the queue → shows the approval modal
        → user approves: approveMcpServerForSession + discoverToolsForServer (connect with new config)
          user rejects: persist rejected, stay disconnected
```

#### Key files (Part D)

| File                                          | Change                                                                                                                     |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `packages/cli/src/utils/events.ts`            | add `AppEvent.McpPendingApprovalChanged`                                                                                   |
| `packages/cli/src/config/mcpApprovals.ts`     | add `getPromptableMcpServers()` (strict `=== 'pending'`, distinct from the rejected-inclusive `getPendingGatedMcpServers`) |
| `packages/cli/src/config/hot-reload.ts`       | after reconcile, decide via `getPromptableMcpServers`; if non-empty, `appEvents.emit(McpPendingApprovalChanged)`           |
| `packages/cli/src/ui/hooks/useMcpApproval.ts` | extract `computePending()`; compute once on mount + recompute on the event                                                 |

#### Verification (Part D)

- `hot-reload.test.ts`: a gated server newly pending → emit; non-gated change → no emit;
  **reject→edit config → emit again** (the old name set-difference would be 0 times, locking down
  the #6 regression); reject→unrelated edit → no emit.
- `mcpApprovals.test.ts`: the `getPromptableMcpServers` suite—no decision prompts, rejected does
  not prompt (vs `getPendingGatedMcpServers` still skipping), re-prompt after hash change, approved
  does not prompt.
- `useMcpApproval.test.ts`: a mid-session event makes a new gated server show the modal; an
  already-approved one is not re-prompted.

#### Known issue / retrospective TODO (NOT handled here)

1. **`getTargetDir()` vs `getWorkingDir()` key mismatch (risk B)**: gating recompute
   (`recomputeMcpGating` → `getPendingGatedMcpServers`) uses `config.getTargetDir()` as the
   projectRoot, while `useMcpApproval` reads/writes approval using `config.getWorkingDir()`. They
   are usually equal; once they diverge (custom cwd, or symlink realpath differences), approval is
   written under the cwd-key while gating queries the targetDir-key → **after approve, gating still
   skips and never connects**. A pre-existing issue, not introduced by Part D. Recommend unifying on
   one root (lean toward `getWorkingDir()`, i.e. the approval write side), or first add an assertion
   that they are equal at runtime.

### Part E — Follow-up: show in `/mcp` why a gated server was skipped for approval

> This section was added after Part D landed, while debugging "after rejecting a gated server then
> deleting and re-adding it identically, `/mcp` shows Disconnected with no hint". Conclusion first:
> **this is not a record-lifecycle bug; the only defect is that the skip reason is invisible**, so
> we only add visibility and touch no approval-storage / reconcile logic.

#### Why "no longer prompting" is as-designed

An approval record is bound to **(projectRoot, serverName, hash)** and is **independent of whether
the server is currently present in config**—nothing deletes a record when a server disappears from
config. Hence:

- **approved already persists across remove/re-add**: approve (hash H) → delete → re-add
  identically (still hash H) → `getState` returns `approved` → silent reconnect. An intentional
  convenience.
- **rejected matching that settled rejection on the same "identical re-add" is symmetric and
  consistent**: a settled rejection stays in effect while the config hash is unchanged; the only
  way to re-surface it is to **edit the config (change the hash)** (i.e. Part D's
  `getPromptableMcpServers` strict-pending re-prompt path).

> Therefore we **deliberately do not introduce "forget the record on removal"**: that would let
> presence transitions mutate persistent decisions, violating the principle that decisions change
> only via hash or explicit action, and creating an approved / rejected asymmetry.

#### The actual defect and fix (visibility only)

`/mcp` (`ServerListStep` / `ServerDetailStep`) rendered a bare `Disconnected`, making "I rejected
it / awaiting approval" indistinguishable from "a genuine connection failure", so the user did not
know the recovery path (edit config to change the hash → re-prompt). Fix: add
`approvalState?: 'pending' | 'rejected'` to `MCPServerDisplayInfo`, computed in
`MCPManagementDialog.fetchServerData` using `loadMcpApprovals` + `isGatedMcpScope`, keyed by
**`config.getWorkingDir()`** (left empty for non-gated / approved); the list / detail views, using
the existing `needsAuth` override pattern, show the reason first
(`rejected → "rejected — edit config to re-approve"`, `pending → "needs approval"`, warning
yellow), and exclude these non-error approval-skips from the footer "see error logs" hint.

> Keying on the write side's `getWorkingDir()` here is exactly the direction recommended by Part D's
> "Known issue 1 (risk B)"—read and write approval with the same root. `hot-reload.ts`'s existing
> gating query still uses `getTargetDir()` (they are equal today); this section does not change its
> behavior. It **does not touch** `mcpApprovals.ts` storage, the `hot-reload.ts` removal/reconnect
> path, and adds no approval action.

#### Key files (Part E)

| File                                                            | Change                                                                                   |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `packages/cli/src/ui/components/mcp/types.ts`                   | `MCPServerDisplayInfo` adds `approvalState?: 'pending' \| 'rejected'`                    |
| `packages/cli/src/ui/components/mcp/MCPManagementDialog.tsx`    | `fetchServerData` computes `approvalState`, keyed by `getWorkingDir()`                   |
| `packages/cli/src/ui/components/mcp/steps/ServerListStep.tsx`   | render the approval reason; exclude approval-skips from the footer "see error logs" hint |
| `packages/cli/src/ui/components/mcp/steps/ServerDetailStep.tsx` | render the approval reason (consistent with the list)                                    |

#### Verification (Part E)

- `ServerListStep.test.tsx`: gated `rejected` → shows the re-approve hint text; `pending` → "needs
  approval"; an approval-skip does **not** show the "see error logs" hint, while a genuinely failed
  connection **still** does.
- Manual: reject a workspace server → `/mcp` shows the reason (not a bare Disconnected) → edit its
  config to change the hash → the Part D modal reappears (the existing recovery path, unchanged here).

### Part F — Follow-up: admission semantics (CLI upper bound, deny-all, unavailable reasons)

> Added after a third adversarial-review pass on Parts A/B. Three related admission refinements,
> grouped because they share the "which servers may connect, and how do we explain when one can't"
> surface. Items labelled K / H / B after their review threads.

#### K — the startup `--allowed-mcp-server-names` flag is an immutable upper bound

Reverses the earlier "settings always win" stance (see the Part B note). At boot, `loadCliConfig`
gives the flag precedence over `settings.mcp.allowed`; but the hot-reload recompute read `allowed`
from settings only, so any settings change silently dropped a launch-time name restriction —
loosening, in-session, a boundary an operator set precisely to constrain which local MCP commands
may run.

Fix: capture the **flag value alone** as an immutable bound on `Config`
(`cliAllowedMcpServerNames` param → `getCliAllowedMcpServerNames()`; distinct from the mutable
`allowedMcpServers` that hot-reload overwrites). `recomputeMcpGating` then caps the settings-derived
allow-list to it:

- flag passed + settings has `mcp.allowed` → **intersection** (settings may narrow within the bound);
- flag passed + no settings `mcp.allowed` → the **flag in full**;
- no flag → settings fully drive admission (unchanged).

So a runtime edit can only ever narrow MCP admission below the launch flag, never widen past it.
`mcp.excluded` still narrows further at discovery time, consistent with "only stricter, never looser".

#### H — `mcp.allowed: []` is deny-all, consistently across boot and hot-reload

Boot treats an empty allow-list as deny-all (`getMcpServers()` filters whenever `allowedMcpServers`
is truthy, and `[]` is truthy). The hot-reload recompute used to collapse `[]` → `undefined`
("allow all") — so editing `mcp.allowed` to `[]` expecting deny-all left every server reachable. Fix:
`recomputeMcpGating` preserves `[]` (only an **absent** key yields `undefined`), and `mcpGatingEqual`
distinguishes absent (allow-all) from `[]` (deny-all) for `allowed` — otherwise the change would
compare equal and never reconcile. `excluded` / `pending` keep `undefined ≡ []` (both "no entries").

#### B — tool-not-found explains _why_ a server is unavailable

`getMcpToolUnavailableMessage` previously distinguished only "removed this session" vs "not
configured". With admission gating it now classifies the owning server via a single core API,
`Config.getMcpServerUnavailableReason(name)`, covering every gate:

| reason             | meaning                                       | recovery the message suggests                     |
| ------------------ | --------------------------------------------- | ------------------------------------------------- |
| `removed`          | deleted from the merged config this session   | re-add it to settings                             |
| `not_allowed`      | filtered out by `mcp.allowed` / the CLI bound | add it to `mcp.allowed`                           |
| `excluded`         | listed in `mcp.excluded`                      | remove it from `mcp.excluded`                     |
| `pending_approval` | gated server awaiting approval (#4615)        | approve it (run `/mcp`)                           |
| _(none)_           | configured & admitted                         | genuine "tool not found" (disconnected / renamed) |

Two supporting changes: a private `getMergedMcpServers()` (the merge **without** the allow-list
filter) so "configured" can be told apart from "filtered out"; and removal tracking now diffs that
**gating-independent merged map**, which means a server filtered by a narrowed allow-list is no
longer mis-reported as `removed` (it's `not_allowed`). That also lets the
`prevEffectiveServerNames` snapshot param added for the earlier allow-list-narrowing fix be dropped
— the merged-map diff is unaffected by the gating setters the caller applies just before reconcile.

#### Key files (Part F)

| File                                                  | Change                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/cli/src/config/config.ts` (`loadCliConfig`) | pass the `--allowed-mcp-server-names` flag value alone as `cliAllowedMcpServerNames`                                                                                                                                                                                                                                      |
| `packages/core/src/config/config.ts`                  | `cliAllowedMcpServerNames` field + `getCliAllowedMcpServerNames()` (K); `getMergedMcpServers()` (unfiltered) + `getMcpServerNames()`; `McpServerUnavailableReason` + `getMcpServerUnavailableReason()` (B); removal tracking diffs the merged map and `reinitializeMcpServers` drops the `prevEffectiveServerNames` param |
| `packages/cli/src/config/hot-reload.ts`               | `recomputeMcpGating` caps `allowed` to the boot bound (K) and preserves `[]` (H); `mcpGatingEqual` makes `allowed` absent ≠ `[]` (H)                                                                                                                                                                                      |
| `packages/core/src/core/coreToolScheduler.ts`         | `getMcpToolUnavailableMessage` routes per `getMcpServerUnavailableReason` (B)                                                                                                                                                                                                                                             |

#### Verification (Part F)

- `hot-reload.test.ts`: **K** — with a startup flag and no settings allow-list, applies the flag in
  full; a settings allow-list is capped to the flag (cannot widen) and may narrow within it; without
  the flag, settings win unbounded. **H** — `mcp.allowed: []` is pushed through as deny-all;
  `mcpGatingEqual` treats `allowed` absent vs `[]` as different (but `excluded` undefined ≡ `[]`).
- `config.test.ts`: `getMcpServerUnavailableReason` returns `not_allowed` / `excluded` /
  `pending_approval` / `removed` for each gate, and `undefined` for a configured-admitted or
  never-configured server.
- `coreToolScheduler.test.ts`: the tool-not-found message names the right server and recovery action
  per reason.

---

## Out of scope (other sub-tasks)

- **The entire LSP runtime reconnect** (`NativeLspService.reinitialize()` +
  `Config.reinitializeLsp()` + wiring)—deferred to a later MR, see Part C's TODO.
- The `/reload` slash command (#5)—calls `config.reinitializeMcpServers(currentSettings)` (the LSP
  part wires up once its primitive lands in a later MR) + skill/command reload.
- `clearAllCaches()` (#4) and the `needsRefresh` UI notification (#6).

## Key files

| File                                            | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/config/config.ts`            | `setMcpServers()`, `setAllowedMcpServers()` + pending setter, `getMcpGating()` (returns `{ excluded, allowed, pending }`), `reinitializeMcpServers()` (with a reconcile-in-progress guard)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `packages/core/src/tools/mcp-client-manager.ts` | ① add `removePromptsByServer()` to `removeServer()` and `removeRuntimeMcpServer()`; ② in the shared-pool path `runDiscoverAllMcpToolsViaPool` (`:1461`), add the `isMcpServerPendingApproval` check before building `desiredIds` / before acquire (matching single-session admission); ③ **add fingerprint diff to the single-session path**: a new `connectionFingerprints` map; `discoverAllMcpToolsIncremental` also triggers disconnect+reconnect for a server that is "connected but its `connectionIdOf` fingerprint changed" (aligned with the pool path's `desiredIds`), clearing the map on every teardown path; ④ **clear old tools/prompts before reconnect**: when `discoverMcpToolsForServerInternal` replaces an existing client, `removeMcpToolsByServer` + `removePromptsByServer` before re-discovery—because `disconnect()` doesn't touch the registry and `discover()` only appends/overwrites by name, otherwise tools dropped/renamed by a config change would linger bound to a closed client (and linger on discovery failure too), matching the existing cleanup in `removeServer` / `addRuntimeMcpServer` |
| `packages/cli/src/config/settingsSchema.ts`     | **prerequisite**: flip the three keys `mcpServers` (`:274`), `mcp.allowed`, `mcp.excluded` from `requiresRestart: true` to `false`, so the watcher no longer suppresses MCP-only edits; the parent `mcp` and `mcp.serverCommand` stay `true` (see the "Hard prerequisite" note above)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `packages/cli/src/config/hot-reload.ts` _(new)_ | `registerMcpHotReload()`: rebuild via `assembleMcpServers(..., topTierMcpServers)`; recompute the gating lists from current settings (see "admission stance decision"); gate via `mcpServersEqual` + `mcpGatingEqual` (built on `fast-deep-equal`); debounce + coalesce-and-recheck                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `packages/cli/package.json`                     | promote `fast-deep-equal` from a transitive to a **direct** dependency                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `packages/cli/src/gemini.tsx`                   | call `registerMcpHotReload` after `:785`; register the disposer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Tests _(alongside the schema flip)_             | `settingsSchema.test.ts` pins the three MCP keys' `requiresRestart` values (incl. `mcp` / `mcp.serverCommand` staying `true`); `settingsWatcher.test.ts` adds two positive regressions ("edit only `mcpServers` / only `mcp.excluded` → still notify"); `settingsUtils.test.ts` uses its **own mock schema**, unrelated to the real flip, no change needed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

> LSP-related files (`NativeLspService.ts` / `NativeLspClient.ts` / `lsp/types.ts`) are unchanged in this MR, see the Part C TODO.

## Verification

### A. Core capability unit tests (core, `config.test.ts` / `mcp-client-manager.test.ts`)

1. `setMcpServers` is a **replace (not merge)** and takes effect post-init (no longer throws via
   the `initialized` guard).
2. `reinitializeMcpServers` calls `setMcpServers` first then `discoverAllMcpToolsIncremental`;
   calling before `initialize()` is a **safe no-op** (no throw, no connect).
3. Assert `removeServer()` / `removeRuntimeMcpServer()` now call `removePromptsByServer()` (prompt
   leak regression guard). Reuse `mcp-client-manager.test.ts` fixtures (which already import
   `connectionIdOf`).
   3b. **Single-session fingerprint diff**: a mock client whose `getStatus()` is always
   `CONNECTED`, run `discoverAllMcpToolsIncremental` three times—first connect records the
   fingerprint; same config rerun does **not** churn (`connect` still 1×); changing `args` in place
   (fingerprint changes) → disconnect+reconnect (`disconnect` 1×, `connect` 2×). Guards that the
   single-session path no longer misses "connected but config changed" as a no-op (aligned with the
   shared pool's `desiredIds`). Also assert this run calls `removeMcpToolsByServer` +
   `removePromptsByServer` for that server before re-discovery—guarding "clear old tools/prompts
   before reconnect", preventing tools dropped/renamed by a config change from lingering.

### A'. watcher↔schema integration guard (cli, `settingsSchema.test.ts` / `settingsWatcher.test.ts`)

> These two are **high**-severity integration breaks: an MCP-only edit gets swallowed by the
> watcher's restart-required suppression gate, so the Part B callback never fires. There **must** be
> real watcher-layer coverage; directly calling the callback in `hot-reload.test.ts` cannot catch
> this failure.

3c. **schema pinning** (`settingsSchema.test.ts`): `mcpServers` / `mcp.allowed` / `mcp.excluded`
have `requiresRestart` `false`; the parent `mcp` and `mcp.serverCommand` are `true`. Prevents
someone from flipping MCP keys back to restart-required and silently killing the whole hot-reload.
3d. **real watcher no longer suppresses** (`settingsWatcher.test.ts`, with a real `SettingsWatcher`

- mock fs): editing only `mcpServers` / only `mcp.excluded` each triggers **one**
  `SettingsChangeEvent` (it would be suppressed before the flip). This is the end-to-end regression
  guard that the sub-task 3 listener can actually fire.

### B. Subscriber gate-branch unit tests (cli, `hot-reload.test.ts`)

Fake a `SettingsWatcher`, covering every gate branch:

4. **`mcpServers` changes** → call `reinitializeMcpServers` with the **assembled** map (incl. top-tier).
5. **edit only `mcp.excluded` (or `mcp.allowed` / pending), leave `mcpServers` untouched** →
   **still** triggers reconcile, and before reconcile already called `setExcludedMcpServers` /
   `setAllowedMcpServers` / `setPendingMcpServers`. This verifies the `mcpGatingEqual` branch—the
   fixed gap: diffing only `mcpServers` would miss this change.
6. **neither `mcpServers` nor the `mcp` gating lists changed** (e.g. theme / skills edit) → **does
   not** call `reinitializeMcpServers` (verifies the early return when both gates are "unchanged").
7. **two changes fired during an in-flight reconcile** → coalesce-and-recheck runs once more
   (re-entrancy).
8. **debounce**: multiple consecutive saves (< 300ms) trigger reconcile **once** (aligned with the
   watcher's 300ms debounce).

### C. gate-helper pure-function unit tests (cli, `hot-reload.test.ts`)

9. `mcpServersEqual`: different key order, same values → `true`; nested config fields (`args` /
   `env` / `headers`) change → `false`; `undefined` vs `{}` → `true`; add/remove a server →
   `false`; `args` array order change → `false` (command-argument order has meaning).
10. `mcpGatingEqual`: the three lists compare "order-independent" (`['a','b']` vs `['b','a']` →
    `true`); add/remove an item in any list → `false`; `undefined` vs `[]` → `true`.

### D. Trust-boundary edge cases (cli + core)

> Both are **high**-severity trust-boundary points. Item 11 verifies the admission bound (Part F
> item K — settings narrow within, never widen beyond, the startup flag); item 12 corresponds to
> Part A item 4 (pool-path pending check).

11. **Hot-reload admission narrows within — but never widens beyond — the startup flag** (the Part F
    item K bound; supersedes the earlier "settings can widen" stance). Start with
    `--allowed-mcp-server-names=a,b`; then a settings change sets `mcp.allowed` to `[a, b, c]`.
    **Assert**: after reconcile `c` is **still excluded** (capped to the launch bound) while `a` is
    admitted; a settings edit narrowing to `[a]` takes effect; with no startup flag, the settings
    allow-list wins unbounded. (See Part F → Verification for the full matrix.)
    _Guards_: `recomputeMcpGating` intersects the settings allow-list with
    `getCliAllowedMcpServerNames()` and never widens past it.

12. **The pending-approval gate is not bypassed in shared-pool mode** (high risk: connecting a gated
    server before approval). In daemon / shared-pool mode (`runDiscoverAllMcpToolsViaPool`), let a
    settings hot-reload add/edit a server pending approval (`.mcp.json` / workspace). **Assert**:
    before the user approves, it does **not** acquire a pool connection or spawn the process; a
    rejected gated server stays disconnected. Compared to the single-session path which already skips
    pending, this test guards the pool path.
    _Guards_: Part A item 4—the pool path's `isMcpServerPendingApproval` check before building
    `desiredIds` / before acquire.

### E. reconcile edge cases (recommended coverage, verifying "incremental, not full-wipe")

13. **empty ↔ non-empty**: from 0 servers to 1 (the first), from 1 to 0 (the last) both reconcile
    correctly, leaving no residual connection / tools / prompts.
14. **a fingerprint change touches only that one server**: changing a server's `command` / `url` /
    `env` / `headers` → only it disconnects+reconnects, **all other connections kept** (verifies no
    full-wipe, no "0 tools" gap).
15. **untrusted dir**: when `isTrustedFolder()` is false, hot-reload is a no-op (establishes no
    connection).
16. **`mcp.excluded` toggle**: adding an online server to excluded → it disconnects + tools/prompts
    cleared; removing it from excluded → it reconnects.
