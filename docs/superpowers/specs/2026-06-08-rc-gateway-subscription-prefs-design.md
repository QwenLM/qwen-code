# Remote-Control Gateway — Notification Routing Part 2: Per-Subscription Prefs (Design)

**Date:** 2026-06-08
**Status:** Proposed (cycle 16)
**Scope:** Each push subscription can declare which notification **kinds** it wants;
the notifier delivers a kind to a subscription only if its prefs allow it. Proposal
story R7 / the per-subscription `prefs` filter. Builds on cycles 8 (PushStore), 9
(notifier), 15 (snooze).

## Deviation / context

Same gateway placement as cycle 15 (the filter lives in the notifier fan-out). The
proposal stores prefs per subscription in the daemon's token DB; we store them on
our gateway-owned `PushSubscriptionRecord`. Zero upstream edits.

## Decisions

1. **`prefs?: string[]` on the subscription record.** A list of kinds the
   subscription wants (e.g. `['permission.required','policy.deny']`).
   **Absent/undefined `prefs` → receive ALL kinds** (back-compat: existing
   subscriptions and freshly-enrolled ones keep getting everything until the owner
   tunes them). An **empty array `[]`** means "receive nothing" (explicit opt-out).
2. **Per-subscription filter in the notifier fan-out** (after the scope check, per
   subscription): deliver `payload.kind` to a record iff `record.prefs ===
undefined || record.prefs.includes(payload.kind)`. Scope-gating (cycle 9) and
   snooze (cycle 15, event-global) still apply and run first.
3. **`PATCH /rc/push/subscriptions/:id { prefs }`** sets prefs. Authorization
   mirrors DELETE: the caller must own the subscription OR have `owner`; a non-owner
   patching another token's id → `404` (hide existence). `prefs` must be an array of
   strings (else `400 invalid_prefs`); `null`/omitted clears prefs back to
   "receive all" (sets `undefined`).
4. **`GET /rc/push/subscriptions`** includes `prefs` in each returned record.
5. **Audit `push_prefs_updated { subscriptionId }`** (never endpoint).

## Components

### PushStore (`src/pushStore.ts`)

- Add `prefs?: string[]` to `PushSubscriptionRecord`.
- `setPrefs(id: string, prefs: string[] | undefined): Promise<boolean>` — find by
  id; set/delete `prefs`; await persist; return false if id absent. (When `prefs`
  is `undefined`, remove the field so the record reads "receive all".)

### Notifier (`src/webpush/notifier.ts`)

- In `notify`'s fan-out, after the existing scope check and before `sender.send`:
  `if (record.prefs !== undefined && !record.prefs.includes(payload.kind))
continue;` (skip — no audit; matches the cycle-9 "scope skip is silent" posture).

### Push routes (`src/routes/push.ts`)

- `GET /subscriptions` (own and `?all=true`): include `prefs` in each mapped entry.
- New `PATCH /subscriptions/:id` body `{ prefs?: string[] | null }`:
  - `const rec = store.get(id)`; if `!rec` → 404. If `rec.tokenId !==
req.rcClient.id && !scopes.includes(OWNER)` → 404.
  - Validate: if `body.prefs` is present and not (`null` or an array of strings) →
    `400 invalid_prefs`.
  - `await store.setPrefs(id, Array.isArray(body.prefs) ? body.prefs : undefined)`;
    audit `push_prefs_updated {subscriptionId: id}`; `200 { id, prefs }`.

### Audit (`src/auditLog.ts`)

Add `'push_prefs_updated'` to the union + `AUDIT_ACTIONS`.

## Testing strategy (TDD)

**`pushStore.test.ts` (extend):** `setPrefs(id,['a'])` → record.prefs `['a']`;
`setPrefs(id, undefined)` → prefs removed; `setPrefs('missing',...)` → false;
persists across reopen.

**`notifier.test.ts` (extend):** two subs under an `approve` token, one with
`prefs:['task.completed']`, one with no prefs; a `permission.required` event →
the no-prefs sub gets a send, the `['task.completed']` sub does NOT; a sub with
`prefs:[]` gets nothing.

**`routes/push.test.ts` (extend):** PATCH own sub `{prefs:['x']}` → 200, GET shows
prefs; PATCH `{prefs:null}` → clears; PATCH another token's id as non-owner → 404;
as owner → 200; PATCH `{prefs:'x'}` (not array) → 400; audit push_prefs_updated.

**`server.test.ts` (extend):** subscribe then PATCH prefs via the real router → 200.

**e2e:** subscribe → PATCH {prefs:['task.completed']} → 200 → GET shows prefs.

## File boundary

All within `packages/rc-gateway/`. Modified: `src/pushStore.ts` (+test),
`src/webpush/notifier.ts` (+test), `src/routes/push.ts` (+test), `src/auditLog.ts`
(1 action), `src/server.test.ts`, `scripts/rc-gateway-e2e.mjs`. Zero upstream edits.

## Follow-on

Cycle 17: working-device detection (track per-token POST activity on session
routes; `suppressIfWorkingDevice`). Later: mention patterns; the `routing.yaml`
rule file + evaluator (mirroring the policy loader); the `routing_decision` SSE
frame + viewer surface; `qwen rc snooze/routing` CLI.
