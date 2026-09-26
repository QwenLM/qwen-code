# Parallel extension loading

[English](parallel-extension-loading.md) | [简体中文](parallel-extension-loading.zh-CN.md)

## Problem statement

Extension loading scanned every extension, and every per-extension
commands/skills/agents directory, serially. On machines with many installed
extensions this dominated startup-adjacent latency: the in-process bench
(`extension-manager.bench.ts`) measured a median of ~565 ms for a full load
before this work, ~228 ms after it.

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
existence checks (manifest, context files, hooks — `fs.existsSync` folds
every errno into `false`, so those go through an `accessSync`-based
variant that rethrows exhaustion), and `loadExtension`'s catch-all. The refresh then rejects, the previous
cache and fingerprint baseline stay in place, and the next
`refreshCacheIfSourcesChanged` retries — instead of committing a truncated
(or empty) extension set stamped as up to date.

At startup there is no previous cache to keep and no later refresh to
retry, so `Config.initialize` routes its extension refreshes through a
helper that retries resource exhaustion once and otherwise continues
without the extension set rather than aborting initialization; post-startup
refreshes keep the fail-closed semantics above.

One scoped exception: executor refusals recorded by a scan are preserved
even when the scan dies. A file that declares an `executor`/`executionBackend`
but fails validation is recorded in `extension.agentExecutorRefusals` so a
by-name dispatch refuses instead of falling through to a same-named
builtin. The refusals are folded into the caller's map in `readdir` order
before the exhaustion error is rethrown, and `loadExtension` records the
attempt's refusals for `refreshCacheWithSnapshot` to merge into the cache
when it rethrows: an absent extension gets a subresource-free tombstone,
an already-cached one keeps its complete entry and gains the fresh
refusals — so the refusal gates dispatch either way. The merge runs in
`readConsistent`'s rejection callback while the store lock is still held,
so a concurrent uninstall or refresh cannot commit between the failed
scan and the merge and be overwritten by it. The tombstone's `isActive`
derives from the store snapshot like the committed path's does, failing
closed when even that read is exhausted. A fail-closed tombstone is
inactive, though, and the dispatch-side refusal map reads only active
extensions — so the merge additionally records each attempt's refusals in
a manager-held pending map that `SubagentManager` unions into its
extension-level refusal map regardless of activation, and a committed full
refresh supersedes and clears those pending records.

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
  included.

## Open questions

- Replace the batch barrier with a sliding-window worker pool (see
  Constraints).
- Expose a resettable gate-peak so the ceiling test can assert the gate
  saturates rather than merely stays under the cap.
- Bring the managed `SkillManager.loadSkillsFromDir` under the shared gate.
