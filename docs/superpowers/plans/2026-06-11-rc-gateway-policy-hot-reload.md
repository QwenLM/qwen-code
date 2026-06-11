# Plan — policy hot-reload (cycle 45)

Spec: `docs/superpowers/specs/2026-06-11-rc-gateway-policy-hot-reload-design.md`

## Commit order (fail-safe: inert logic first, watcher wiring last)

### Commit 1 — `PolicyReloader` + `quotaLimitsFromPolicy` (PURE, inert)

- `policy/reloader.ts`: `PolicyReloader` (injected `schedule`/`cancel`,
  debounce, total reload run with in-flight guard, `trigger`/`stop`).
- `policy/quotas.ts`: export pure `quotaLimitsFromPolicy(policy): Map`.
- Barrel exports.
- `policy/reloader.test.ts`:
  - N rapid `trigger()` within the window → exactly ONE `load`/`apply`.
  - success → `apply` + `onReloaded(policy)` called once; `onError` not.
  - `load` rejects → `onError(err)` once, `apply`/`onReloaded` NOT called
    (old policy retained); reloader does not throw.
  - in-flight: a `trigger` during an awaited `load` → exactly one extra reload
    after it settles (last edit wins).
  - `stop()` cancels a pending timer (no reload fires).
- `policy/quotas.test.ts` (extend): `quotaLimitsFromPolicy` picks id+maxPerWindow
  (first id wins, skips id-less / no-maxPerWindow); a `QuotaStore` whose
  `limitsFor` closes over a Map reflects a later mutation of that map
  (closure-mutation contract the cli relies on).

### Commit 2 — audit actions

- `auditLog.ts`: add `policy_reloaded` + `policy_reload_failed` to the union AND
  the `AUDIT_ACTIONS` array.

### Commit 3 — wire `runServe` (glue, smoke-tested)

- `cli.ts`: replace the inline quota-limits loop with `applyQuotaLimits(policy)`
  (clear + repopulate the captured `quotaLimits` Map via `quotaLimitsFromPolicy`);
  call it at boot. Build a `PolicyReloader` (when enforcer exists);
  `fs.watch` the two policy parent dirs (guarded), basename-filter →
  `reloader.trigger()`; audit `policy_reloaded{ruleCount}` / `policy_reload_failed{reason:err.name}`;
  close watchers + `reloader.stop()` on shutdown.

## Verify

- typecheck + lint + build + test (`@qwen-code/rc-gateway`).
- e2e — unchanged, 39/39.
- Manual `fs.watch` smoke: throwaway script — real temp dir, real watcher +
  reloader, write file twice rapidly, assert exactly one reload, then a
  malformed write keeps the old policy + fires onError.

## Review + close

- opus adversarial review on the cycle diff (ignore foreign edits; point it at
  the reload error path = the safety invariant, and the limitsFor-rebuild).
- Update both memory files.
