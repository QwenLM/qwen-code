# Cost tracking

The gateway prices every usage-bearing `session_update` against an operator rate
table, stores it durably, and exposes per-session / per-client / per-sub-actor /
per-model aggregates (`add-cost-tracking`).

## How it works

- **Rate table** — `~/.qwen/rc/model-rates.yaml` maps `(modelServiceId, modelId)`
  to per-million-token cent prices (`inputPerMTok`, `outputPerMTok`,
  `cachedReadPerMTok`) plus a `currencyLabel`. Built-in Qwen defaults apply when
  the file is absent; a malformed edit retains the last good table and audits
  `rate_table_parse_failed`. An unpriced model writes a row with `cost_cents = NULL`
  and audits `rate_table_miss` — visibly unpriced, never silently free.
- **Ingestion** — the always-on session-event pump (which runs whenever push OR
  cost tracking is enabled) feeds every `session_update` to the ingester. When the
  frame carries usage (`data.update._meta.usage`), a row is written to
  `~/.qwen/rc/usage.db` (`usage_events`), attributed to the prompt's originating
  client token and its bridge `sub_actor` if any. Ingestion is additive — it never
  modifies or delays the SSE frame to subscribers.
- **Storage** — SQLite via the optional native `better-sqlite3` (same isolation as
  ranked search). If that dependency is not built, cost tracking is **disabled**
  (logged at boot) and the gateway runs normally.

## Querying

```
GET /rc/usage?since=24h&until=&group_by=session|client|sub_actor|model&format=json|csv
```

`since`/`until` accept a relative duration (`24h`, `7d`, `30m`) or ISO-8601;
`since` defaults to `24h`. **Scope filtering:** an `owner` token sees all rows;
every lesser scope (`write`/`approve`/`read`/`bridge`) sees only rows attributed
to its own token id. The filter is derived from the caller's token, never a query
param, so a caller cannot widen its own view. `format=csv` returns `text/csv` with
the header `key,displayLabel,tokensIn,tokensOut,tokensCached,costCents`.

## Verification ceiling

The rate-table parsing/pricing, the store (record/aggregate/prune), the ingester,
the coalescer, the `/rc/usage` route + scope filtering, and the **full
pump→ingester→store path** (a real `SessionEventPump` against a stub daemon
emitting a real-shaped usage frame) are all unit/integration-tested. The one link
not exercised in CI: whether a live `qwen serve` emits usage exactly at
`data.update._meta.usage` — there is no model-credentialed daemon in this
environment (the rc-gateway e2e routes prompts but never runs a model turn).
`extractUsage` reads the token fields confirmed against the serve demo
(`inputTokens`/`outputTokens`/`cacheReadInputTokens`) and reads the model id
defensively; a shape mismatch would yield unpriced/zero rows, not a crash.

## Live usage_tick + capability

After writing a row the ingester pushes a coalesced `usage_tick` (≤1 per 500 ms
per session) to a per-session broadcaster; each `/rc/session/:id/events` relay
registers as a listener and injects a `{ type: "usage_tick", data: { sessionId,
costCentsSessionTotal, costCentsPromptTotal, tokensInTotal, tokensOutTotal } }`
frame onto its SSE stream — with **no `id:`** so it never advances the client's
Last-Event-ID cursor. `GET /rc/capabilities` advertises
`remoteControl.costTracking { enabled, currencyLabel, rateTablePath }` (the
gateway's `/rc`-prefixed surface, since the daemon's `/capabilities` is
un-editable under the fork boundary).

## Operator CLI

```
qwen-rc usage [--since 24h] [--group-by session|client|sub_actor|model] \
              [--sub-actor <s>] [--format json|csv|table]
qwen-rc usage prune --before <iso-8601> [--yes]
```

Both are daemon-free — they open the same `~/.qwen/rc/usage.db` the gateway writes.
`usage` defaults to a 24h / by-session / table view; `prune` deletes rows older
than `--before` (prompting unless `--yes`) and prints `<n> rows removed`.

## Rate-table hot-reload

The gateway watches `~/.qwen/rc` for `model-rates.yaml`: a valid edit swaps the
live table within a 250 ms debounce (no restart); a malformed edit retains the
previous table and audits `rate_table_parse_failed`.
