# rc-gateway — policy hot-reload (Phase 3.1)

**Cycle 45.** Proposal: `add-policy-engine`, Phase 3 (`tasks.md` 3.1;
`spec.md` "Policy files loaded at startup and on change" → _Scenario: Parse
error preserves previous ruleset_; `design.md` D4).

## Deviation from the OpenSpec design

- The proposal puts the watcher in the daemon
  (`packages/cli/src/serve/policy/hotReload.ts`). The HARD invariant forbids
  edits outside `packages/rc-gateway/`, and the gateway already owns the
  enforcer + the layered loader, so the watcher lives **gateway-side** in
  `packages/rc-gateway/src/policy/reloader.ts` + the `runServe` boot wiring.
- The spec's _Parse error_ scenario wants a `policy_load_error` **SSE frame to
  owner-scope subscribers**. The gateway has **NO gateway-level (non-session)
  SSE broadcast surface** (only per-session streams). Building an owner
  broadcast is a separate, larger piece (Phase 4 territory — it also carries
  the `policy_decision` frame). So this cycle delivers the durable, auditable
  record via the **audit log** (`policy_reloaded` on success,
  `policy_reload_failed` on a bad reload) and DEFERS the SSE frame. The
  safety-critical behavior — _retain the previous ruleset on a parse error_ —
  is delivered in full.

## What ships

1. `policy/reloader.ts` — a pure, injected-timer `PolicyReloader`:
   - ctor `{ load, apply, onReloaded, onError, debounceMs=250, schedule?,
cancel? }`. `load(): Promise<Policy>`; `apply(Policy): void`;
     `onReloaded(Policy): void`; `onError(unknown): void`. `schedule`/`cancel`
     default to `setTimeout`/`clearTimeout` (injected in tests).
   - `trigger()`: debounce — cancel any pending timer, schedule a reload
     `debounceMs` later. Many rapid triggers ⇒ exactly one reload.
   - reload run: `try { const p = await load(); apply(p); onReloaded(p); }
catch (e) { onError(e); }` — on ANY failure the old policy is simply not
     applied (retained). NEVER throws. An in-flight guard re-runs once if a
     trigger arrives mid-reload (so the last edit always wins).
   - `stop()`: cancel the pending timer (shutdown).
2. `quotas.ts` — pure `quotaLimitsFromPolicy(policy): Map<string, QuotaLimit>`
   (id + maxPerWindow, first id wins) — the boot path and the reload path build
   limits the SAME way (no drift).
3. `cli.ts` (`runServe`) wiring (glue):
   - `applyQuotaLimits(policy)` rebuilds the limits IN PLACE
     (`quotaLimits.clear()` + repopulate) so the `limitsFor = id =>
quotaLimits.get(id)` closure the `QuotaStore` holds reflects the new
     policy — **the documented Phase-3 staleness fix** (the closure captured
     the boot map; mutating that same map updates it without touching the
     store).
   - Build a `PolicyReloader` (only when the enforcer runs) with
     `apply = p => { enforcer.setPolicy(p); applyQuotaLimits(p); }`.
   - `fs.watch` the PARENT DIRECTORY of each policy file (user
     `~/.qwen/rc` + workspace `<cwd>/.qwen`), filtering for the `policy.yaml`
     basename, calling `reloader.trigger()`. Dir-watch (not file-watch) so an
     editor's atomic rename-replace doesn't drop the watch. Each `fs.watch` is
     guarded (a missing dir ⇒ that layer simply won't hot-reload). Watchers +
     reloader are closed on SIGINT/SIGTERM.
4. `auditLog.ts` — add `policy_reloaded` + `policy_reload_failed` to BOTH the
   `AuditAction` union AND the `AUDIT_ACTIONS` runtime array.

## Decisions

1. **Fail-safe on a bad reload = retain old + audit, NEVER crash/throw.** Boot
   still fails-closed on a malformed USER file (unchanged). But a _running_
   gateway must not die because the operator saved a half-typed edit, so a
   reload error keeps the last-good policy (design.md:74, the spec scenario).
   `PolicyReloader` is total.
2. **`policy_reload_failed` detail = a short reason TOKEN, never content.** Use
   `err.name` (e.g. `PolicyError`/`Error`) — NOT `err.message` (a schema error
   message could echo a rule fragment) and never the file text. `ruleCount` on
   success is a non-sensitive count. No new `detail` value needs an
   `AuditAction` change beyond the two new actions themselves.
3. **Quota limits rebuilt by mutating the captured Map.** The `QuotaStore`'s
   existing per-rule counters are kept across a reload; only `limitsFor`
   changes, so a rule whose `count`/`windowSec` changed is re-evaluated against
   the new window on the next `state()` (sliding window recomputes live), and a
   rule dropped from the policy becomes `untracked` (and is pruned on the next
   `compact`). No counter reset, no WAL rewrite needed.
4. **Workspace-cwd snapshot at boot.** Like cycles 36/38, the workspace cwd is
   resolved once at boot via `capabilities()`; the reload re-runs
   `loadLayeredPolicy(userPath, workspaceCwd, warn)` against that same cwd
   (one daemon ⇒ one workspace). Watching the workspace `.qwen` dir picks up
   workspace-file edits.
5. **Debounce 250 ms, clock injected.** Tests drive `schedule`/`cancel` fakes;
   no real timers, no flake.

## Deferred (NOT this cycle)

- `policy_load_error` **SSE frame** to owner subscribers (needs a new
  gateway-level owner-broadcast surface — Phase 4, shared with
  `policy_decision`).
- `qwen rc policy reload` CLI (needs a running-gateway IPC/control surface that
  does not exist).
- Windows polling fallback (design.md D4 cost note) — `fs.watch` covers
  Linux/macOS; a 2 s polling fallback is a later refinement.
- World-writable policy-file startup warning (a separate spec requirement).

## Verification

- Unit: `reloader.test.ts` (debounce-collapse, success→apply+onReloaded,
  failure→onError + apply-not-called, in-flight re-run, stop cancels) with
  injected timers; `quotaLimitsFromPolicy` + a closure-mutation contract test
  proving a live `QuotaStore` reflects a mutated limits map.
- typecheck/lint/build/test + e2e (unchanged — reloader is inert until wired;
  the watcher is boot-only, not in the e2e's `createGatewayApp` path).
- **Manual smoke of the real `fs.watch`→trigger→reload path** via a throwaway
  script (the e2e does not run `runServe`; cli.ts glue is never unit-tested) —
  confirm a real file edit triggers exactly one debounced reload on this
  platform.

## Fail-safe / invariant notes

- 100% inside `packages/rc-gateway/` (+ docs). No daemon edits.
- Commit order: reloader + quotaLimitsFromPolicy + tests INERT → audit actions →
  cli wiring LAST. A mid-cycle stop never wires a watcher → behavior identical
  to today.
- Audit hygiene: only `ruleCount` (count) + a reason token. No file content,
  no rule text.
