# rc-gateway — per-subscription push rate limit (`maxPerHour`)

**Cycle 46.** Proposal: `add-webpush-notifications` (`spec.md` "Per-subscription
preferences and quiet hours" → `maxPerHour`; _Scenario: Rate limit drops
oldest_; `design.md` D4; `tasks.md` 2.4). Spreads off `add-policy-engine` after
4 consecutive policy cycles (42–45).

## Deviation from the OpenSpec design

- The proposal puts notification config in the daemon + a SQLite
  `push_subscriptions` table. We are the fork-owned gateway: subscriptions live
  in the gateway's `PushStore` (JSON), and the rate limiter is a gateway-side
  in-memory counter. No daemon edit.
- `tasks.md` 2.4 bundles **rate limit + quiet-hours digest + 5 s same-kind
  coalescing**. Quiet hours already shipped (cycle 29). This cycle does ONLY the
  `maxPerHour` rate limit (a complete, self-contained requirement with its own
  scenario + audit action). The end-of-quiet-window **digest** and the **5 s
  coalescing** are stateful-timer features deferred to their own cycles.

## What ships

1. `webpush/rateLimiter.ts` — pure in-memory `PushRateLimiter`:
   - `tryConsume(subId, maxPerHour, nowMs): { allowed, firstDrop }` — prune the
     subscription's send-instants to the last 3600 s; if `>= maxPerHour` →
     `{ allowed: false, firstDrop }` (caller drops), where `firstDrop` is true
     ONLY on the transition from under-cap to at-cap; else record `nowMs`,
     clear the dropping flag, and return `{ allowed: true, firstDrop: false }`.
     Atomic check+consume (push has no two-phase vote). Never throws.
   - `forget(subId)` — drop a subscription's window (for unsubscribe cleanup).
   - `DEFAULT_MAX_PER_HOUR = 30`.
2. `pushStore.ts` — `PushSubscriptionRecord.maxPerHour?: number` +
   `setMaxPerHour(id, value | undefined)` (mirrors `setQuietHours`).
3. `routes/push.ts` — GET serializes `maxPerHour`; PATCH validates it
   present-key (integer in [1, 240], or `null` to clear) in the existing
   validate-all-up-front-then-apply (all-or-nothing) block, applies via
   `setMaxPerHour`, and includes it in the `push_prefs_updated` trigger.
4. `auditLog.ts` — add `push_rate_limited` to the union AND the array.
5. `webpush/notifier.ts` — optional `rateLimiter?` ctor arg; a gate placed LAST
   (after working-device, just before `sender.send`): when present and
   `tryConsume(r.id, r.maxPerHour ?? DEFAULT_MAX_PER_HOUR, now.getTime())` is
   false → audit `push_rate_limited{ kind, subscriptionId }` and skip the send.
6. `server.ts` — construct one `PushRateLimiter` and pass it to `PushNotifier`.

## Decisions

1. **In-memory only, NO persistence.** The rate limit is an anti-fatigue
   comfort control, NOT security. A restart resets the hourly counter → at most
   a small burst of extra pushes after a restart = the FAIL-OPEN direction (a
   limiter bug/restart must never SUPPRESS a notification). So no WAL (unlike the
   policy QuotaStore, which persists because a quota is a security throttle).
2. **Gate runs LAST.** Only pushes that survived every other gate (scope,
   session-lock, routing-drop, prefs, quiet-hours, working-device) count toward
   the cap, matching the spec's "pushable events". Counted at the send DECISION
   (an attempt) — a subsequent 410 still counts (and removes the sub anyway).
3. **Audit the TRANSITION, not every drop** (advisor). The threat model is a
   1000-event/sec storm; a `push_rate_limited` row per dropped push would just
   move the flood into the audit log (unbounded JSONL). So `tryConsume` reports
   `firstDrop` only when a subscription crosses INTO the rate-limited state, and
   the gate audits only then. This passes the scenario as written (it asserts
   the 6th event audits and the 7th is "also dropped" — NOT that the 7th
   audits) and matches the codebase's once-per-lifetime audit patterns
   (`warnedCollisions`). The flag clears when the window next has room, so a
   later storm episode re-audits.
4. **Fail-OPEN seam.** `rateLimiter` is an OPTIONAL ctor arg → every existing
   `new PushNotifier(...)` site + test is unchanged (no limiter ⇒ no cap). Only
   `server.ts` (the real boot) wires it on.
5. **Atomic check+consume** (`tryConsume`) — no TOCTOU: push has no external
   await between deciding and sending, so unlike the policy quota there is no
   check/consume split. (The send itself is async + best-effort, but the count
   is committed at the decision.)
6. **No critical-kind bypass (spec-literal).** Quiet hours bypasses
   `policy.deny`/`session.died` (cycle 29 honored that), but the rate-limit
   requirement states NO bypass — so the cap applies uniformly. The default 30
   is generous enough that a critical event is only ever dropped in an extreme
   storm where the device is already flooded. A critical bypass is unspecified;
   left as a future refinement (noted, not built).
7. **Default 30, range [1, 240]** (spec). PATCH rejects out-of-range/non-integer
   with `400 invalid_max_per_hour`; `null` clears (→ effective default).

## Deferred (NOT this cycle)

- End-of-quiet-window **digest** push (stateful accumulation + a timer firing at
  the window end).
- **5 s same-kind coalescing** (`design.md` D6 — a short-window collapse, also
  timer-based).
- Wiring `forget` into the DELETE route (the map is bounded by live
  subscriptions with per-sub arrays pruned to ≤ `maxPerHour`; a removed sub
  leaves one decayed array until process exit — a bounded, non-growing
  remainder, not a leak. `forget` is exposed for a later cheap wire-up).
- A `maxPerHour` web-UI control (browser, verified-locally-only).

## Verification

- Unit: `rateLimiter.test.ts` (under cap → allow; at cap → drop; window slides
  → frees a slot; per-subscription isolation; `forget` resets; never throws).
- `pushStore` round-trip (set/clear/GET) + PATCH validation (valid / out-of-range
  / non-integer / null-clears / all-or-nothing with a sibling field) + the
  notifier gate (drop at cap audits `push_rate_limited` + no send; under cap
  sends; no limiter ⇒ no cap).
- typecheck/lint/build/test + e2e (notifier gate is exercised by the e2e only if
  it pushes > cap; the limiter is constructed in `server.ts`, which the e2e DOES
  mount via `createGatewayApp` — so a high cap keeps e2e green at 39/39).

## Fail-safe / invariant notes

- 100% inside `packages/rc-gateway/` (+ docs). No daemon edits.
- Commit order: rateLimiter + tests INERT → store field + route + audit action →
  notifier gate + server wiring LAST. A mid-cycle stop never caps a send.
- Audit hygiene: `push_rate_limited` detail = `{ kind, subscriptionId }` only —
  enum kind + an id, no endpoint/content.
