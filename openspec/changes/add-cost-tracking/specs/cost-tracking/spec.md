# cost-tracking — spec delta

## ADDED Requirements

### Requirement: Rate table format and reload

The daemon SHALL load a YAML rate table from
`~/.qwen/rc/model-rates.yaml`. The file SHALL contain a top-level
`currencyLabel` string, an optional `defaultModelServiceId` string,
and a `models` array of entries with fields `modelServiceId`,
`modelId`, `inputPerMTok`, `outputPerMTok`, and `cachedReadPerMTok`
(all per-million-token cent values). The daemon SHALL watch the file
for changes and reload with a 250 ms debounce. On parse failure the
daemon SHALL retain the previously loaded table in memory and SHALL
emit an audit event `rate_table_parse_failed`.

#### Scenario: Valid edit hot-reloads

- **GIVEN** the daemon is running with a valid rate table
- **WHEN** the operator edits the file and writes a valid new entry
- **THEN** within 500 ms the new rates are used for subsequent
  ingester writes
- **AND** no daemon restart is required

#### Scenario: Parse error keeps old table

- **GIVEN** a loaded rate table
- **WHEN** the file is overwritten with malformed YAML
- **THEN** the previously loaded table remains in effect for
  pricing
- **AND** an audit event `rate_table_parse_failed` is written with
  the parser error message

#### Scenario: Lookup miss is recorded

- **GIVEN** the rate table has no entry for `(modelServiceId,
modelId)` `("openai", "gpt-5")`
- **WHEN** a `session_update` arrives for that model
- **THEN** the ingester writes the row with `cost_cents = NULL`
- **AND** emits an audit event `rate_table_miss` with the model
  identifiers

### Requirement: Ingest priced rows from session_update

The daemon SHALL subscribe to every emitted `session_update` event
and, when the event's `data.usage` block is present, write a row to
the `usage_events` table containing the session id, server-side
timestamp (unix milliseconds), `tokens_in`, `tokens_out`,
`tokens_cached`, computed `cost_cents`, `model_service_id`,
`model_id`, `attribution_token_id` (the originating client's
`tokenId`), `sub_actor` (if a valid `X-RC-SubActor` was present on
the originating request), and `stage`.

The ingest path SHALL be additive: it MUST NOT modify, drop, or
delay the emitted SSE frame to subscribers.

#### Scenario: Priced row written

- **GIVEN** a session with originator `tkn_abc`
- **WHEN** the agent emits `session_update` with usage `{ in: 1000,
out: 500, cached: 0 }` for model `qwen3-coder-plus` at rates
  `(200, 800, 20) cents/Mtok`
- **THEN** a row is written with `cost_cents = 0.2 + 0.4 = 0.6`
- **AND** `attribution_token_id = "tkn_abc"`

#### Scenario: Bridge sub-actor recorded

- **GIVEN** a bridge token `tkn_brg` prompts on behalf of
  `X-RC-SubActor: telegram:42`
- **WHEN** the resulting `session_update` is ingested
- **THEN** the row's `attribution_token_id = "tkn_brg"`
- **AND** the row's `sub_actor = "telegram:42"`

#### Scenario: SSE fan-out unchanged

- **GIVEN** subscribers are attached to the session's event stream
- **WHEN** a `session_update` triggers a usage write
- **THEN** subscribers receive the unmodified `session_update` frame
- **AND** receive a separate `usage_tick` frame for the session's
  new running total

### Requirement: `usage_tick` SSE event

After writing a usage row, the daemon SHALL emit a `usage_tick`
event on the same session's SSE stream with payload `{ sessionId,
costCentsSessionTotal, costCentsPromptTotal, tokensInTotal,
tokensOutTotal }`. `usage_tick` emissions SHALL be coalesced to at
most one per 500 ms per session.

#### Scenario: Running total broadcast

- **GIVEN** a session with prior cumulative cost 12 cents
- **WHEN** a new row of 3 cents is written
- **THEN** subscribers receive `usage_tick` with
  `costCentsSessionTotal: 15`

#### Scenario: Coalescing under burst

- **WHEN** 10 `session_update` frames write rows within 500 ms
- **THEN** subscribers receive at most one `usage_tick` reflecting
  the latest cumulative total

### Requirement: `/rc/usage` aggregation endpoint

The daemon SHALL expose `GET /rc/usage` with query parameters
`since` (ISO-8601 or relative like `24h`), `until` (ISO-8601),
`group_by` (`session` | `client` | `sub_actor` | `model`), and
`format` (`json` | `csv`). The response SHALL return aggregated
rows with `key`, `displayLabel`, `tokensIn`, `tokensOut`,
`tokensCached`, and `costCents`.

#### Scenario: Group by session

- **GIVEN** three sessions with priced rows in the last 24h
- **WHEN** a client requests
  `/rc/usage?since=24h&group_by=session`
- **THEN** the response contains exactly three rows
- **AND** each row's `costCents` equals the sum of `cost_cents`
  for that session over the window

#### Scenario: CSV export

- **WHEN** a client requests `/rc/usage?since=24h&group_by=session&format=csv`
- **THEN** the response Content-Type is `text/csv`
- **AND** the body has the header `key,displayLabel,tokensIn,tokensOut,tokensCached,costCents`

### Requirement: Scope filtering on /rc/usage

The daemon SHALL apply scope-based filters to `/rc/usage`:

- `owner` tokens SHALL receive all rows in the window.
- `write`, `approve`, and `read` tokens SHALL receive only rows
  where `attribution_token_id` equals the caller's `tokenId`.
- `bridge` tokens SHALL receive only rows where
  `attribution_token_id` equals the caller's `tokenId`; `sub_actor`
  values SHALL be preserved in the response.

#### Scenario: Read scope sees own rows only

- **GIVEN** a read-scope token `tkn_read` and a separate write-scope
  token `tkn_write` that have generated 0 and 5 priced rows
  respectively
- **WHEN** `tkn_read` requests `/rc/usage?group_by=session`
- **THEN** the response contains zero rows

#### Scenario: Owner sees everyone

- **GIVEN** the same setup
- **WHEN** an owner-scope token requests
  `/rc/usage?group_by=session`
- **THEN** the response contains the 5 rows attributed to `tkn_write`

### Requirement: Capability advertisement

`GET /capabilities`'s `remoteControl` block SHALL include a
`costTracking` object:

```jsonc
{
  "costTracking": {
    "enabled": true,
    "currencyLabel": "USD",
    "rateTablePath": "~/.qwen/rc/model-rates.yaml",
  },
}
```

Clients SHALL render cost surfaces only when `enabled: true` is
present.

#### Scenario: Capability advertised

- **WHEN** any token GETs `/capabilities`
- **THEN** the response's `remoteControl.costTracking.enabled` is
  `true`
- **AND** `currencyLabel` matches the loaded rate table

### Requirement: Web client renders cost

The web client SHALL render:

- a `Usage` panel route showing the current day's total cost and a
  ranked list of the highest-cost sessions over the last 7 days,
- a small cost element in the session header that subscribes to
  `usage_tick` and renders the session running total.

The cost surfaces SHALL be hidden when
`remoteControl.costTracking.enabled` is absent or false.

#### Scenario: Header updates on usage_tick

- **GIVEN** the user is viewing an active session
- **WHEN** the daemon emits a `usage_tick` for that session
- **THEN** the header cost value is replaced in-place with the new
  `costCentsSessionTotal` (formatted per `currencyLabel`)
- **AND** no full re-render occurs

### Requirement: Terminal client renders cost

The `qwen rc` terminal client SHALL render a cost cell in its
status line showing the active session's running cost and the
current `tokensIn / tokensOut` running totals. The cell SHALL be
suppressed if `costTracking` is not advertised by the daemon.

#### Scenario: Status line updates on usage_tick

- **GIVEN** the user is attached to a session
- **WHEN** a `usage_tick` arrives
- **THEN** the status line cost cell re-renders with the new totals

### Requirement: Operator CLI

The CLI SHALL expose:

- `qwen rc usage [--since <duration>] [--group-by <axis>]
[--sub-actor <s>] [--format json|csv|table]` — query.
- `qwen rc usage prune --before <iso> [--yes]` — delete rows older
  than a timestamp; prompts unless `--yes`.

#### Scenario: prune deletes old rows

- **GIVEN** the usage database has 1000 rows older than 60 days
- **WHEN** the operator runs `qwen rc usage prune --before $(date
-d '60 days ago' --iso-8601) --yes`
- **THEN** the command prints `1000 rows removed`
- **AND** subsequent `qwen rc usage --since 90d` queries do not
  return those rows
