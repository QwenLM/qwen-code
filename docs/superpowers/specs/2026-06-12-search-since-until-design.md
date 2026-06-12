# Cycle 79 — Search `since`/`until` time-range filter

Proposal: `add-cross-session-search`. The on-demand JSONL search supports query
operators + kind + sessionId + limit, but not a time range. The proposal's spec
lists a `since` filter ("sessions from the last week"). This adds optional
`since`/`until` bounds.

## Deviation note

Gateway-side on-demand scan; no daemon change. (The FTS5 index that would make a
time range an index lookup stays deferred — this filters during the existing
scan.)

## Mechanism

Each transcript record already carries an ISO `timestamp` (the scanner reads it
for `hit.ts` and the recency sort). Add an optional bound check in the scan loop:

`routes/search.ts` parses `?since` / `?until` (ISO-8601) → ms via `Date.parse`;
a present-but-unparseable value → `400 invalid_since` / `invalid_until` (mirrors
the existing `invalid_kind`). The validated ms bounds pass through
`searchTranscriptsDetailed` opts (`since?: number`, `until?: number`).

In the scan loop, after the sessionId/type filters and before the (more
expensive) text match:

```
if (sinceMs !== undefined || untilMs !== undefined) {
  const t = Date.parse(rec.timestamp ?? '');
  if (Number.isNaN(t)) continue;                 // no usable ts → not in range
  if (sinceMs !== undefined && t < sinceMs) continue;
  if (untilMs !== undefined && t > untilMs) continue;
}
```

## Decisions

1. Bounds are **inclusive** (`t >= since`, `t <= until`) — the natural reading of
   "since 09:00 until 17:00". `since` and `until` are independent (either, both,
   or neither).
2. A record with a missing/unparseable `timestamp` is **excluded** when a time
   filter is active (it cannot be placed in the range). With NO time filter,
   behaviour is byte-identical to today (the block is skipped entirely).
3. Bounds parsed + validated at the ROUTE (`Date.parse`), passed as ms to the
   scanner — the scanner takes numbers, the route owns the 400s. `Date.parse`
   accepts ISO-8601 (and more); a caller sends ISO. No path is built from
   since/until (pure numeric compare), so no traversal surface.
4. Additive: no new audit fields (the existing `search_performed {kind,
resultCount}` is unchanged — a time window is not sensitive, but it is also
   not needed in the audit).

## Fail-safe commit order

docs → scanner `since`/`until` opts + the filter + scanner tests (INERT: no
caller passes the bounds yet → every existing scan is byte-identical) → route
parsing + 400s + wiring + route tests.

## Verification

vitest: scanner — `since` excludes older records, `until` excludes newer, both
together window correctly, a timestamp-less record is excluded under a filter and
INCLUDED with no filter, no-bounds is identical to before. route — `?since`
valid narrows results, `?until` valid, invalid `?since`/`?until` → 400 with the
right code, no-bounds unchanged. typecheck/lint/build. e2e unchanged 45 (the
existing search e2e sends no since/until → no filter → identical; the e2e script
is not edited).

## Deferred

`relative` time syntax (e.g. `7d`) — caller computes the ISO bound; FTS5 indexed
range; surfacing the window in the audit; a `before`/`after` alias.
