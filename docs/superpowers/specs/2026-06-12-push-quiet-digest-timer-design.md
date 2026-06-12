# Cycle 75 — End-of-quiet-window digest auto-push (webpush D4)

Proposal: `add-webpush-notifications`, design **D4**: _"Filtered events are
summarized in a single 'digest' push at the end of the quiet window if anything
was suppressed."_ The cycle-71 `PushDigest` already RECORDS per-(sub,kind) counts
of pushes suppressed during quiet hours; cycle 72 surfaced them in the owner UI;
the cycle-29 quiet-hours gate is what feeds them. The missing piece — deferred as
"the hard one" since cycle 29 — is the TIMER that flushes those counts back to the
device as one digest push the moment its quiet window ends. This cycle adds it.

## Deviation note

Gateway-side. The design frames this in the daemon's send pipeline; we run it in
the gateway notifier (which already owns the quiet-hours gate + `PushDigest`).
No daemon change.

## The load-bearing decision — POLL-based edge detection, not a per-tz timer (D1)

The obvious implementation is: per subscription, compute the next absolute instant
its local `to` time occurs in its tz and `setTimeout` to it, rescheduling on
PATCH/unsubscribe. That is exactly the fragile path: projecting a local `HH:MM`
forward across DST transitions to an absolute UTC instant is error-prone, and the
per-sub timer LIFECYCLE (cancel+reschedule on every PATCH-quietHours, cancel on
unsubscribe, clear-all on shutdown) is the most bug-prone part.

Instead: a single repeating POLL. Each tick re-evaluates `isWithinTimeOfDay`
(the cycle-22 DST-correct Intl projection already used by the quiet gate) for
every current subscription and fires the digest on the **quiet → not-quiet
transition** (edge detection). This:

- **Reuses the proven DST-correct predicate** — zero new tz/DST math.
- **Re-reads `store.listAll()` every tick** — a PATCH-quietHours or an
  unsubscribe is picked up for free on the next tick; no per-sub timer to
  cancel/reschedule. The only lifecycle wiring is start/stop of ONE interval.
- Costs at most one tick-interval of latency on the digest (default 60 s) —
  trivially acceptable for a "while you were away" summary.

## Pieces

### 1. `webpush/quietDigestWatcher.ts` — `QuietDigestWatcher` (pure)

`tick(records, now, fire)`: for each record, `quietNow =
isWithinTimeOfDay(parseTimeOfDay(r.quietHours), now)` (no/invalid window →
`false`, fail-open). If the previous tick had it quiet and now it is not → call
`fire(r.id)` once. Stores the latest state per id. **Initializes state on first
sighting → never fires spuriously at boot** (a sub already mid-quiet when the
gateway starts has `prev === undefined` on the first tick, so it only fires on a
LATER exit). Prunes state for ids no longer present (bounded). Pure/total, never
throws.

### 2. `PushDigest.summaryFor(subId): DigestSummary | null` (additive)

Per-subscription accessor (the existing `summary()` returns all). Used by the
flush to build one device's digest. Returns `null` when nothing pending.

### 3. `payload.ts` `buildDigestPayload(summary): PushPayload` (additive)

Metadata-only synthetic payload: `kind:'digest'`, `summary:"N notifications
while you were away"`, `url:'/ui/'`, `sessionId:''` (a digest is not tied to one
session). Carries ONLY counts + kind enum names — no session content, no ids.
`sw.js` already renders any `v:1` push generically (title `qwen-code`, body =
summary, no action buttons) → **NO service-worker change needed**.

### 4. `PushNotifier.flushQuietDigests(now=new Date())` (the wiring)

Holds one private `QuietDigestWatcher`. Calls `watcher.tick(listAll(), now,
fire)`; `fire(id)` captures `digest.summaryFor(id)`, **`digest.forget(id)`
(reset whether or not we send)**, and if the captured total > 0 sends
`buildDigestPayload(summary)` to that subscription via the existing best-effort
`sender.send` (which already audits `push_sent`/`push_send_failed`). Sync,
never throws (the send is fire-and-forget; the sender never throws).

### 5. `cli.ts` runServe — one unref'd interval

`setInterval(() => notifier.flushQuietDigests(), QWEN_RC_QUIET_DIGEST_MS ||
60000).unref()`, cleared in `shutdown`. Only created when a notifier exists
(mirrors the pump). This is the ONLY behaviour change in the cycle.

## Decisions

1. Poll-based edge detection over a per-tz `setTimeout` (see above).
2. Digest fires only when `summaryFor(id).total > 0` (nothing suppressed → no
   push). The transition still resets state either way.
3. Reset (`forget`) the sub's counts after each flush attempt — best-effort,
   like all push; a failed send loses that digest rather than re-sending it next
   window. (D5 below.)
4. `kind:'digest'`, no `KIND_SCOPE` entry: the counts only exist for pushes that
   already passed the scope + session-lock gates when recorded, so the sub has
   already earned them; the flush sends directly. No cross-session leak (counts
   are numbers + kind names; a share sub's digest only reflects its locked
   session, since recording happens after the session-lock gate).
5. No new audit action — the sender's existing `push_sent`/`push_send_failed`
   covers digest delivery on `/rc/events`.
6. The digest sends DIRECTLY via `sender.send`, bypassing the whole gate chain.
   Bypassing the QUIET gate is required (else the digest would suppress itself at
   the boundary). It also bypasses snooze/coalesce/rate-limit: a digest is one
   low-frequency push at a window edge, so it does NOT consume the rate-limit
   budget or coalesce, and **it fires even while "snooze all" is active** — snooze
   is a short time-bounded silence and the digest is the once-per-window summary
   the user opted into via quiet hours; this is intentional, not a leak past an
   explicit silence.
7. The `wasQuiet` map is bounded by **prune-on-tick** (ids absent from `listAll`
   are dropped), NOT by wiring the watcher into the DELETE path. A sub deleted
   between ticks lingers at most one interval — harmless. This is intentional;
   do not add DELETE→`watcher.forget` plumbing the prune already covers.

## Fail-safe commit order

docs → INERT (`QuietDigestWatcher` + `summaryFor` + `buildDigestPayload` +
unit tests, nothing calls them) → notifier `flushQuietDigests` + tests + barrel
(callable in tests, but no timer drives it yet → behaviour-identical) → cli
interval + shutdown (the single behaviour change, and it is fail-OPEN: it can
only ADD a best-effort digest push, never suppress a real one).

## Verification

vitest: watcher edge cases (boot-init no-fire, enter→no-fire, exit→fire,
stay-quiet→no-fire, invalid-window fail-open, prune-absent), `summaryFor`,
`buildDigestPayload` (privacy: no session content), notifier flush (sends on
transition with pending>0, resets counts, no send when empty, no double-fire).
typecheck/lint/build. e2e unchanged (timer only in runServe, not in the e2e's
`createGatewayApp`; the flush is in-memory/unobservable headlessly).

## Deferred

Persisting digest counts across a gateway restart (in-memory by design, fail-open
— a restart mid-quiet loses the digest); per-session digest grouping; folding
snooze/coalesced/rate-limited suppressions into the digest (cycle 76); a
configurable digest body format; coalescing a trailing "N pending" count.
