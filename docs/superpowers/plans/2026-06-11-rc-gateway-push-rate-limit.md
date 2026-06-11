# Plan — per-subscription push rate limit (cycle 46)

Spec: `docs/superpowers/specs/2026-06-11-rc-gateway-push-rate-limit-design.md`

## Commit order (fail-safe: pure limiter first, gate last)

### Commit 1 — `PushRateLimiter` (PURE, inert)

- `webpush/rateLimiter.ts`: `PushRateLimiter.tryConsume(subId, maxPerHour,
nowMs)`, `forget(subId)`, `DEFAULT_MAX_PER_HOUR = 30`.
- Barrel export.
- `webpush/rateLimiter.test.ts`: under cap allows; at cap drops; aged instant
  frees a slot; per-sub isolation; forget resets; maxPerHour:1 edge; never
  throws.

### Commit 2 — store field + route + audit action

- `pushStore.ts`: `maxPerHour?: number` + `setMaxPerHour(id, value|undefined)`.
- `auditLog.ts`: add `push_rate_limited` to union + array.
- `routes/push.ts`: GET (owner-all + own) serialize `maxPerHour`; PATCH
  validates `maxPerHour` present-key (Number.isInteger, 1..240, or null) up
  front with prefs/quiet (all-or-nothing), applies via `setMaxPerHour`, folds
  into the `push_prefs_updated` trigger. 400 `invalid_max_per_hour` on bad.
- Tests: `pushStore` round-trip; `routes/push` PATCH valid/out-of-range/
  non-integer/null-clears/all-or-nothing-with-bad-sibling, GET shows it.

### Commit 3 — notifier gate + server wiring (LAST)

- `webpush/notifier.ts`: optional `rateLimiter?` 8th ctor arg; gate before
  `sender.send` (after working-device) → drop + audit `push_rate_limited` at cap.
- `server.ts`: `new PushRateLimiter()` → pass to `PushNotifier`.
- Tests: `notifier` — at-cap drop audits + no send; under-cap sends; no-limiter
  no-cap (back-compat).

## Verify

- typecheck + lint + build + test (`@qwen-code/rc-gateway`).
- e2e — 39/39 (default cap 30 ≫ e2e push volume).

## Review + close

- opus review (ignore foreign edits; point it at the gate placement + the
  fail-OPEN direction + audit hygiene).
- Update both memory files.
