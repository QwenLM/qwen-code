# Cycle 77 — Kind-scoped multi-snooze

Proposal: `add-notification-routing`. The cycle-15 snooze holds a SINGLE window
(`{until, scope}`); a second `POST /rc/routing/snooze` REPLACES the first. So you
cannot "snooze permission prompts for 30 min AND completions for 2 h"
independently — the design's per-kind snoozing. This cycle makes snoozes
**independent per scope**, simultaneously active.

## Deviation note

Gateway-side; the snooze lives in the gateway notifier's pre-fanout gate. No
daemon change.

## Model change (`routing/snooze.ts`)

Internal state goes from one `SnoozeState` to a `Map<scope, until>` (scope =
`'all'` or a single kind). At most a handful of entries (the closed kind set +
`'all'`), so no unbounded growth; expired entries are pruned lazily on every read
and on write.

- `snooze(durationSec, scope)` now **sets/replaces ONLY that scope's entry**,
  leaving other scopes' windows untouched (the behaviour change — previously it
  clobbered everything). Returns the `{scope, until}` it set.
- `clear(scope?)` — `scope` given → clear that one entry; omitted → clear ALL
  (back-compat with the cycle-15 `clear()`).
- `isSnoozed(kind)` — unchanged signature: true if the `'all'` entry OR the
  `kind`'s own entry is active. (The notifier calls this; no notifier change.)
- `active(): SnoozeEntry | null` — back-compat REPRESENTATIVE accessor: the
  `'all'` entry if active, else the active entry with the latest `until`, else
  null. Keeps the cycle-15 tests + the route's legacy GET fields working.
- `activeList(): SnoozeEntry[]` — NEW: every active entry (pruned, sorted),
  for the multi-aware GET.

## Persistence (back-compat migrate-read)

Write format: `{ snoozes: { [scope]: until } }`. Read accepts BOTH:

- new `parsed.snoozes` object (each scope→finite number kept), AND
- legacy `{ until: <finite>, scope: <string> }` → migrated to one entry.
  Anything else → empty. An existing `snooze.state` file from cycle 15 upgrades
  transparently. (A downgrade loses the new entries — not a supported path.)

## Route change (`routes/routing.ts`)

- `POST /snooze` — request unchanged; sets one scope; returns `{until, scope}`
  (legacy) — now accumulating rather than replacing other scopes.
- `GET /snooze` — returns the legacy `{active, until?, scope?}` (from `active()`,
  the representative) PLUS a new `snoozes: [{scope, until}]` array. The cycle-70
  UI keeps working off the legacy fields; a future cycle can render the list.
- `DELETE /snooze?scope=<s>` — clear ONE scope (audit `routing_unsnoozed
{scope}`). `DELETE /snooze` with no `scope` — clear ALL (audit
  `routing_unsnoozed`, no detail — back-compat with the cycle-70 Unsnooze). Note:
  `?scope=all` clears the GLOBAL `'all'` entry only (not every per-kind one); no
  query clears everything — a clean, documented distinction.

No new AuditAction (reuses routing_snoozed/routing_unsnoozed; detail is
free-form). Suppress-only invariant intact: more independent snoozes can only
suppress MORE pushes, never leak one or miss a prompt.

## Decisions

1. Accumulate-not-clobber is the whole feature; a user who snoozed `'all'` then
   snoozes a kind keeps the global active (delete `?scope=all` to drop it).
   Documented so it does not read as a bug.
2. `active()` stays a single representative for back-compat; multi-awareness is
   the additive `activeList()` / `snoozes[]`.
3. The cycle-70 web UI is NOT changed this cycle — it shows the representative
   snooze; surfacing the full per-kind list + per-kind unsnooze is a deferred UI
   slice. (Backend-only, fully unit/route-tested.)

## Fail-safe commit order

docs → `snooze.ts` multi-snooze store + tests (route still calls the same
compatible API: `snooze`/`active`/`clear()` all unchanged in signature; the only
observable change is accumulation, which is suppress-only) → `routes/routing.ts`
GET `snoozes[]` + DELETE `?scope` + tests.

## Verification

vitest: store — two scopes active simultaneously (isSnoozed for each + 'all'
interaction), clear(scope) drops one leaves the other, clear() drops all,
representative active() prefers 'all', persist+reopen round-trips multiple
entries + migrates a legacy single-state file, expiry prunes per-entry. route —
two POSTs accumulate (GET snoozes has both), DELETE?scope clears one, DELETE all
clears all, legacy GET fields still present. typecheck/lint/build. e2e unchanged
(snooze not in the e2e path; routing routes mounted only when a SnoozeStore is
supplied).

## Deferred

The web UI showing the full per-kind list + per-kind unsnooze; a snooze-end
digest (would need a snooze-end trigger, same class as the deferred suppression
fold); `urgencyAtLeast`/mention-scoped snoozes.
