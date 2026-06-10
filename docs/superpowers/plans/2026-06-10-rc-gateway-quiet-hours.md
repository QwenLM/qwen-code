# Cycle 29 — Per-subscription quiet hours — plan (TDD)

Fail-safe two-commit order: land the store field + setter inert (nothing
reads/writes it), then wire the notifier gate + PATCH route last.

## Commit 1 — store (inert)

`src/pushStore.ts`:

- Add `quietHours?: { from: string; to: string; timezone: string }` to
  `PushSubscriptionRecord`.
- Add `setQuietHours(id, qh: {from,to,timezone} | undefined): Promise<boolean>`
  mirroring `setPrefs`: `undefined` → `delete rec.quietHours`; else store a
  fresh `{from, to, timezone}` copy. Persist. Return false if id absent.

`src/pushStore.test.ts`:

- setQuietHours sets a window, get() reflects a copied object.
- setQuietHours(undefined) clears the field.
- setQuietHours on an unknown id → false, no write.

Commit: `feat(rc-gateway): pushStore quietHours field + setter (inert)`

## Commit 2 — notifier gate + route (wire)

`src/webpush/notifier.ts`:

- Import `parseTimeOfDay`, `isWithinTimeOfDay` from `../policy/conditions.js`.
- `notify(event, ctx, now: Date = new Date())`.
- In the per-subscription map, AFTER the prefs check and BEFORE the
  working-device check:
  ```
  if (r.quietHours) {
    const p = parseTimeOfDay(r.quietHours);
    if (p && isWithinTimeOfDay(p, now)) {
      audit push_suppressed { kind, reason:'quiet_hours', subscriptionId:r.id }
      return; // skip this subscription
    }
  }
  ```
  (parse null → fall through = send; fail-open.)

`src/routes/push.ts`:

- Import `parseTimeOfDay` from `../policy/conditions.js`.
- PATCH `/subscriptions/:id`: keep the 404 existence/ownership check first.
  Then, inside a `try { … } catch { if (!res.headersSent) res.status(500)… }`:
  - `if ('prefs' in body)`: validate as today (array-of-strings or null →
    else 400 invalid_prefs); `setPrefs(next)`.
  - `if ('quietHours' in body)`: `null` → `setQuietHours(undefined)`; else
    `parseTimeOfDay(qh)` → null → 400 invalid_quiet_hours; else
    `setQuietHours({from,to,timezone})` (raw strings from body).
  - Audit `push_prefs_updated { subscriptionId }` once if either field was
    touched. Respond `200 { id, prefs, quietHours }` reflecting the record.
- GET `/subscriptions` (own + ?all): include `quietHours: r.quietHours`.

`src/webpush/notifier.test.ts`:

- quiet-hours window covering `now` → suppress + audit reason quiet_hours.
- `now` outside the window → send.
- wrap-midnight window (23:00–07:00) suppresses a 02:00 now.
- malformed stored quietHours (shouldn't happen post-validation) → send
  (fail-open).
- no quietHours → send (back-compat).

`src/routes/push.test.ts`:

- PATCH quietHours sets it; GET shows it.
- PATCH quietHours:null clears it.
- PATCH {quietHours:{…}} leaves existing prefs intact (field independence).
- PATCH {prefs:[…]} leaves existing quietHours intact.
- PATCH malformed quietHours (bad HH:MM / bad tz / non-object) → 400
  invalid_quiet_hours.
- PATCH another token's id as non-owner with a quietHours body → 404
  (existence hidden before validation).

Commit: `feat(rc-gateway): per-subscription quiet hours suppress push in-window`

## Then

advisor → opus review on the diff → fix → full verify (typecheck/lint/
build/test + e2e) → push → update both memory files.
