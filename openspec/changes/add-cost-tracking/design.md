# Design — add-cost-tracking

## Context

Stage 1 of `qwen serve` already produces token counts. The
`session_update` event type, defined in
`add-remote-control/specs/wire-protocol/spec.md`, carries a usage
block per stage of the agent loop:

```jsonc
{
  "type": "session_update",
  "data": {
    "stage": "final" | "intermediate",
    "modelId": "qwen3-coder-plus",
    "usage": {
      "promptTokens": 1234,
      "completionTokens": 567,
      "cachedReadTokens": 0
    }
  }
}
```

The daemon today forwards this verbatim and forgets it. Clients can
display per-event numbers but cannot answer historical or aggregate
questions. This change keeps the forwarding behavior (so existing
clients are unaffected) and adds a parallel ingest path that stores a
priced row.

## Goals / Non-Goals

**Goals:**

- Persist every usage emission with attribution sufficient to answer
  "who, when, which model, how much" at the per-request granularity.
- Render running cost live in the chat surfaces without an extra
  round-trip per frame.
- Keep the rate table operator-editable and hot-reloaded.
- Scope-respect: cost data is audit-grade; only owner sees all, and
  lesser scopes see only their own attribution.

**Non-Goals:**

- Enforcement. This change neither caps nor refuses anything based on
  cost. A follow-up change (`add-cost-caps`) is anticipated.
- Re-pricing past data when the rate table changes. Each row stores
  the cost as computed at write time; editing the table affects
  future writes only.
- Cost for non-LLM tool calls.
- Multi-currency support. One operator, one currency.

## Architecture

```
qwen --acp child ─emits──▶ session_update with usage block
                                │
                                ▼
                    Daemon event bus (existing)
                                │
                ┌───────────────┴───────────────┐
                │                               │
                ▼                               ▼
       SSE fan-out (existing)        Usage ingester (new)
                                                │
                                                ▼
                                  Look up (modelServiceId, modelId)
                                  in cached rate table
                                                │
                                                ▼
                                  Compute cost_cents:
                                    in  · inRate/1M
                                  + out · outRate/1M
                                  + cached · cachedRate/1M
                                                │
                                                ▼
                                  Pull attribution from request ctx:
                                    originatorClientId (token_id)
                                    sub_actor (if present)
                                                │
                                                ▼
                                  INSERT into usage_events
                                                │
                                                ▼
                              Emit `usage_tick` SSE event (data:
                              { cost_cents_session_total })
```

The `usage_tick` event is a tiny additional frame so clients can
update their header without re-querying `/rc/usage` after every
`session_update`. It carries only the running per-session total — no
per-call detail — keeping the SSE payload small and the rendering
trivial.

## Rate table

`~/.qwen/rc/model-rates.yaml`:

```yaml
# All prices in cents per million tokens. Currency is the operator's
# choice; UI labels use the `currencyLabel` value verbatim.
currencyLabel: 'USD'
defaultModelServiceId: 'qwen-cloud'

models:
  - modelServiceId: qwen-cloud
    modelId: qwen3-coder-plus
    inputPerMTok: 200 # $2.00 / M tokens
    outputPerMTok: 800
    cachedReadPerMTok: 20

  - modelServiceId: qwen-cloud
    modelId: qwen3-coder-flash
    inputPerMTok: 30
    outputPerMTok: 120
    cachedReadPerMTok: 3

  - modelServiceId: openai
    modelId: gpt-4o-mini
    inputPerMTok: 15
    outputPerMTok: 60
    cachedReadPerMTok: 8
```

The loader:

- watches the file for changes (debounced 250 ms, same pattern as
  `add-policy-engine`'s policy file watcher)
- on parse error, keeps the previous good table in memory and emits
  an `audit_event` of type `rate_table_parse_failed`
- on a lookup miss (model not in the table), writes the row with
  `cost_cents: NULL` and emits `rate_table_miss` audit so the
  operator notices unpriced traffic

The shipped default file contains the current Qwen Cloud model rates
as of file generation; operators are expected to keep it accurate.
The daemon does NOT fetch rates from a network registry.

## Storage

`~/.qwen/rc/usage.db` (separate SQLite file from tokens.db to keep
audit/cost reads from contending with auth writes):

```sql
CREATE TABLE usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  ts INTEGER NOT NULL,                -- unix ms
  tokens_in INTEGER NOT NULL,
  tokens_out INTEGER NOT NULL,
  tokens_cached INTEGER NOT NULL DEFAULT 0,
  cost_cents REAL,                    -- NULL when rate-table miss
  model_service_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  attribution_token_id TEXT,          -- NULL for synthetic events
  sub_actor TEXT,                     -- NULL when no bridge sub-actor
  stage TEXT NOT NULL                 -- 'final' | 'intermediate' | 'idle-suggest' | ...
);

CREATE INDEX idx_usage_session_ts ON usage_events(session_id, ts);
CREATE INDEX idx_usage_ts ON usage_events(ts);
CREATE INDEX idx_usage_tokenid ON usage_events(attribution_token_id, ts);
CREATE INDEX idx_usage_subactor ON usage_events(sub_actor, ts);
```

Retention: rows are kept indefinitely by default. Operator can run
`qwen rc usage prune --before <iso>` to delete older rows.

## Endpoint

`GET /rc/usage?since=&until=&group_by=session|client|sub_actor|model&format=json`

- `since`, `until`: ISO-8601 timestamps. Default `since = 24 h ago`,
  `until = now`.
- `group_by`: required, one of the four listed values.
- `format`: `json` (default), `csv` for export.

Response:

```jsonc
{
  "currencyLabel": "USD",
  "since": "...", "until": "...",
  "groupBy": "session",
  "rows": [
    {
      "key": "<sessionId>" | "<tokenId>" | "<subActor>" | "<modelServiceId>:<modelId>",
      "displayLabel": "<human-friendly>",
      "tokensIn": 1234567,
      "tokensOut": 234567,
      "tokensCached": 12345,
      "costCents": 1850
    }
  ]
}
```

Scope filtering:

- `owner` sees all rows.
- `write` / `approve` / `read` see only rows where
  `attribution_token_id = self`.
- `bridge` sees rows where `attribution_token_id = self` (the bridge
  token), with `sub_actor` retained so it can render its own
  internal billing if it wants.

## Decisions

### D1 — Separate SQLite file vs reusing tokens.db

**Choice**: Separate `~/.qwen/rc/usage.db`.

**Alternative considered**: Add `usage_events` table to the existing
`tokens.db`.

**Why**: Usage writes are high-frequency (one per stage of every
prompt). Token reads (auth) are also frequent. Keeping them in
separate files lets us tune WAL/sync modes independently and lets us
back up / prune usage data without touching auth state.

**Cost**: Two SQLite files instead of one. Negligible.

### D2 — Store cost at write time, never recompute

**Choice**: `cost_cents` is computed and stored when the row is
inserted. Editing the rate table later does not change historical
rows.

**Alternative considered**: Store only raw token counts and compute
cost lazily at query time using the current table.

**Why**: An operator might be debugging a billing surprise and need
the cost-as-billed, not the cost-as-it-would-be-now. Also, the rate
table might disappear (file deleted) and we still want past costs to
render.

**Cost**: Rate-table corrections do not retroactively fix historical
data; operator runs `qwen rc usage reprice --since …` if they need
that. This is intentional.

### D3 — Hot-reload the rate table

**Choice**: File watcher with 250 ms debounce, atomic swap of the
in-memory table.

**Alternative considered**: Require SIGHUP or restart.

**Why**: Matches the pattern used by `add-policy-engine` and
`add-custom-slash-commands`. Operator can edit and see the next
write priced under the new rates without bouncing the daemon.

**Cost**: A 250 ms window where some writes can use stale rates after
an edit. Acceptable.

### D4 — `usage_tick` SSE event vs query on every render

**Choice**: After each usage_events write, emit a small `usage_tick`
event carrying the session's running total.

**Alternative considered**: Clients re-query `/rc/usage?session=…`
after every `session_update`.

**Why**: Per-frame queries scale poorly and add latency to UI. The
tick frame is ~80 bytes and reuses the existing SSE channel.

**Cost**: One more event type clients must ignore-or-render. Marked
`v: 1` so forward-compatibility rule applies.

### D5 — Owner-only by default, lesser scopes see own attribution

**Choice**: Cost data is treated as audit-grade. `read` / `write` /
`approve` see only rows their token created. `owner` sees all.

**Alternative considered**: Same scope split as the transcript —
anyone with `read` sees everything.

**Why**: Cost reveals activity patterns ("Bob has been making a lot
of expensive calls"); that's audit information. Lesser scopes do not
need cross-attribution visibility to do their job.

**Cost**: A read-scope partner-viewer can't see how expensive the
session has been. Acceptable — they can ask the owner.

## Threat model

| Attacker                        | Capability                             | Mitigation                                                                                 |
| ------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------ |
| read-scope token leaks          | See own attribution (zero rows)        | By construction read-scope never originates priced events; query returns empty.            |
| bridge token leaks              | See all rows attributed to that bridge | Owner revokes bridge token; sub-actor data remains in DB for forensics.                    |
| rate table tampering on host    | Inflate or deflate recorded costs      | Out of scope. Daemon trusts the host filesystem (consistent with `add-remote-control` D1). |
| Sensitive metadata in sub_actor | sub-actor ids could be PII             | sub-actor is already in audit log (see `add-bridge-protocol`); same scope rules apply.     |

## Risks

| Risk                                                  | Likelihood | Impact | Mitigation                                                              |
| ----------------------------------------------------- | ---------- | ------ | ----------------------------------------------------------------------- |
| Rate table drift from reality                         | H          | M      | Operator-owned; `rate_table_miss` audit fires on lookup gaps.           |
| `usage_tick` event volume in long sessions            | M          | L      | Coalesce: at most one tick per 500 ms per session.                      |
| usage.db grows unbounded                              | M          | M      | `qwen rc usage prune` command; documented retention recommendation.     |
| Stage rename in upstream qwen-code breaks stage field | M          | L      | Persist stage as opaque string; aggregator does not interpret it.       |
| Clock skew between agent and daemon                   | L          | L      | `ts` recorded at daemon side at write time, not from the event payload. |

## Open questions

1. **Should `usage_tick` carry a per-prompt total in addition to
   per-session?** Useful for "this single prompt cost $0.12" UX.
   Leaning yes; trivial to add since the daemon knows which prompt is
   in flight.

2. **Currency formatting on the wire.** Today we return `costCents`
   as a number; the UI formats. Operators may want fractional cents
   for very cheap models. `cost_cents` is REAL (not INTEGER) in the
   schema to allow fractional values; rendering rounds to 4 decimals.

3. **Default rate table contents.** Should the shipped file contain
   only Qwen rates, or also OpenAI/Anthropic for common operator
   configs? Leaning: Qwen + a commented-out example for one other
   provider; operators are expected to know their own rates.
