# Parallel extension loading

[English](parallel-extension-loading.md) | [简体中文](parallel-extension-loading.zh-CN.md)

## Problem statement

Extension loading scanned every extension, and every per-extension
commands/skills/agents directory, serially. On machines with many installed
extensions this dominated startup-adjacent latency: the in-process bench
(`packages/core/scripts/bench-extension-load.ts`) measured a median of
~565 ms for a full load before this work, ~228 ms after it.

## Current state

Loading is parallel at three levels, coordinated from
`packages/core/src/skills/skill-load.ts`:

- **Extensions-directory scan** — `loadExtensionsFromExtensionsDir`
  (extensionManager.ts) fans extensions out through
  `scheduleWithConcurrency` with `EXTENSION_SCAN_CONCURRENCY = 8`. This level
  opens no descriptors itself; it only schedules the per-extension loads.
- **Per-extension subresources** — commands (recursive `readdir`), skills,
  agents and workflows load concurrently inside each extension. The skill/agent/plugin
  manifest readers go through `mapWithConcurrency`, which admits each
  per-file read through one module-wide semaphore
  (`SKILL_LOAD_CONCURRENCY = 8`), so the in-flight manifest-read budget is
  shared by every gated loader no matter how the levels nest. 8 measured no
  wall-clock loss versus 64 — the default 4-thread libuv pool is the real
  bottleneck either way.
- **Settle contract** — both helpers run each batch through
  `Promise.allSettled` and rethrow the first original rejection reason after
  the batch settles, so a failing item never abandons siblings mid-flight
  and the rethrown error keeps its `code` for the fail-closed classification
  below. Results are index-slotted, so every loader returns entries in
  `readdir` order regardless of completion order (extension agents feed a
  first-wins name dedup, so order is observable).

### The no-stacking rule

A level must never hold a gate permit across nested gated work: when a
sibling fails, the orphaned permit holders stack and drain the module-wide
pool until every later load hangs (the wedge). This is why the
extensions-dir scan uses the permit-free `scheduleWithConcurrency` while
only the leaf manifest reads acquire permits. The regression test drives
repeated failing scans (a dangling symlink at the extensions root) and
asserts the pool still admits work afterwards.

### Fail-closed on resource exhaustion

Under a low `RLIMIT_NOFILE` (daemons holding pipes/sockets, containers,
system-wide ENFILE), reads fail mid-scan with `EMFILE`/`ENFILE`/`EAGAIN`/
`ENOMEM` (`isResourceExhaustion`). These errnos are rethrown — not treated
like parse failures — at every entrance that used to swallow them: the
per-entry loaders, each loader's directory enumeration (the commands
enumeration included), the per-extension manifest config read, the hooks
sidecar read, the extensions-root `readdirSync`, the install-metadata
sidecar read, `loadExtensionWorkflows` (including its candidate and
per-file stat legs), the Agent Plugins `mcp.json` read, the load path's
existence checks (manifest, context files, hooks, and the named-load
extensions-root guard — `fs.existsSync` folds every errno into `false`, so
those go through an `accessSync`-based variant that rethrows exhaustion),
and `loadExtension`'s catch-all. The refresh then rejects, the previous
cache and fingerprint baseline stay in place, and the next
`refreshCacheIfSourcesChanged` retries — instead of committing a truncated
(or empty) extension set stamped as up to date.

`Config.initialize` performs an initial and a final extension refresh. Each
uses a helper that retries resource exhaustion once and otherwise continues
with the previous complete cache (empty on a cold start) rather than aborting
initialization. If the initial refresh gives up and the final startup refresh
succeeds, hooks and skills are synchronized before initialization continues.
A synchronization failure rejects initialization. Post-startup refreshes keep
the fail-closed semantics above.

Executor refusals are kept separately from the committed runtime cache. A file
that declares an invalid `executor`/`executionBackend` records a refusal in
`extension.agentExecutorRefusals`; loaders fold those records in `readdir`
order before surfacing an error. Each refresh also collects refusals in an
attempt-local ledger. If scanning or store initialization rejects, the
rejection callback unions the selected extensions' records into the manager's
pending map while the store lock is held. Named refreshes settle all in-flight
siblings before merging and exclude records from unrequested extensions.

A rejected refresh publishes no new runtime entries, including for siblings
that finished loading. The previous cache stays intact; there are no failed-scan
tombstones for command loaders, activation mutations, or other consumers to
mistake for loaded extensions. `SubagentManager` reads pending refusals through
its existing callback and refuses a by-name fallback even on a cold cache.
The callback suppresses records for committed inactive entries, so disabled
extensions cannot block a builtin; records without a cache entry still refuse
dispatch. Re-enabling an entry exposes its retained records again. No activation
snapshot is needed on rejection.

A successful refresh retains refusals from skipped extensions and incomplete
agent discovery. A complete committed agent scan supersedes only that
extension's pending records, including on named refreshes and install/update
reloads. Uninstall removes the name; a full refresh also drops records whose
installation directory is confirmed missing. Unreadable directories and
`ENOTDIR` are not proof of removal. Pending state does not persist across
process restarts.

Only an explicit runtime refresh initializes the runtime cache, even if that
first scan fails and leaves it empty. Install/update operations can replace
entries in that cache, but never initialize it. Modes that skip extension
loading therefore stay isolated after an install; catalog reads also leave the
runtime cache untouched. A normal runtime can still recover from an initial
failed scan by installing a complete extension and superseding its refusals.

The commands walk tracks symlink targets per traversal ancestry: separate
aliases to one directory are both listed, while repeated targets on the same
path terminate a cycle. Plugin manifest path resolution propagates resource
exhaustion just like the manifest read itself.

### Outside the descriptor budget

The gate bounds admissions to the manifest callbacks only. The commands
recursive `readdir` (one libuv-threadpool traversal, no worker knob), the
sync config/hooks reads, `loadExtensionWorkflows`, and the
managed `SkillManager.loadSkillsFromDir` (skill-manager.ts) sit outside it.

## Constraints and risks

- `mapWithConcurrency`/`scheduleWithConcurrency` settle per batch, so a
  rejection waits on the slowest in-flight sibling (head-of-line
  contention). A sliding-window worker pool is the known improvement, kept
  as follow-up.
- The managed `SkillManager.loadSkillsFromDir` remains an unbounded
  `Promise.all`; gating it is out of scope for this change.

## Validation

- Gate ceiling: 40 extensions × 24 skills through a full refresh; peak
  gate admissions ≤ `SKILL_LOAD_CONCURRENCY` and > 1, no truncation.
- Wedge: repeated failing scans (dangling symlink) leave the pool
  admitting work; recovery loads every entry's content.
- Fail-closed: EMFILE injected at each entrance (skill read, agent read,
  plugin-skill read, plugin `readdir`/`statSync`, extensions-root
  `readdirSync`, install-metadata sidecar, workflow read/listing) rejects
  the refresh, keeps the previous cache, and retries after the fault
  clears; partial-survivor fixtures pin that one surviving sibling does
  not make the load resolve truncated.
- Order/refusals: completion-order inversion fixtures pin `readdir`-order
  results and the deterministic last-in-`readdir` refusal winner.
- Bench: median ~228 ms (was ~565 ms at the base).

## Acceptance criteria

- Full-load median stays at or below the ~228 ms bench figure.
- No load commits a truncated or empty extension set on resource
  exhaustion; every fail-closed entrance has a regression test that goes
  red when its rethrow is removed.
- Executor refusals gate dispatch across a failed refresh, cold start
  included, without publishing partially loaded runtime entries.
- Failed attempts union only requested names. Complete committed rescans and
  explicit removal withdraw stale records; skipped or unreadable scans retain
  them. Store initialization failures preserve the same rejection guarantees.
- Command aliases remain visible and symlink cycles terminate.

## Open questions

- Replace the batch barrier with a sliding-window worker pool (see
  Constraints).
- Expose a resettable gate-peak so the ceiling test can assert the gate
  saturates rather than merely stays under the cap.
- Bring the managed `SkillManager.loadSkillsFromDir` under the shared gate.
