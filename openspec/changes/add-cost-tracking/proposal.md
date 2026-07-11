# add-cost-tracking

## Why

`qwen-code` Stage 1 emits per-stage token counts on `session_update`
events (input tokens, output tokens, cached read tokens, model id).
These numbers stream past once on the SSE channel and are then lost:
there is no aggregation, no per-session running cost, no per-client
attribution, no historical query. An operator running paid Qwen models
has no answer to "how much did today's session cost?" short of
re-tailing JSONL transcripts and computing it by hand.

`add-remote-control` introduced per-client identity (`tokenId` →
`clientName`, `scopes`), and `add-bridge-protocol` introduced
`subActor` identity for users acting through a sidecar bridge. With
those identities now stable, we can attribute every token-emission
event to the originator and store it durably for query and rendering.

This change adds a small accounting layer: a rate table file, a
SQLite table, an aggregation endpoint, and surface in the existing
web and terminal clients. It deliberately does NOT enforce cost caps
or refuse prompts — a follow-up change can use this data to do that.

## What Changes

- **Rate table file** `~/.qwen/rc/model-rates.yaml` operator-managed,
  mapping `(modelServiceId, modelId)` to per-million-token prices
  (input, output, cached read). Ships with Qwen models pre-populated.
- **Storage.** New SQLite table `usage_events(session_id, ts,
tokens_in, tokens_out, tokens_cached, cost_cents, model_id,
attribution_token_id, sub_actor)`. Indexed for the common
  group-by queries.
- **Ingestion.** The daemon hooks the existing `session_update` event
  pipeline: whenever a frame carries a usage block, the daemon
  computes cost from the rate table, attaches the current request's
  attribution (`originatorClientId`, `subActor` if any), and writes a
  row.
- **Aggregation endpoint.** `GET /rc/usage?since=&until=&group_by=…`
  returns aggregated rows. Owner scope sees all rows; lesser scopes
  see only rows attributed to their own `tokenId` (or, for bridge
  scope, rows attributed to a `subActor` they asserted).
- **Web client.** A "Usage" panel shows today's spend, the top
  sessions by cost in the last 7 days, and a live counter in the
  session header that updates per `session_update`.
- **Terminal client.** A status-line element renders the active
  session's running cost.

## Capabilities

### New Capabilities

- `cost-tracking` — rate table file format, per-session usage
  ingestion, usage event storage, the `/rc/usage` aggregation
  endpoint, scope-based filtering of results, and the surface in
  terminal and web clients.

## User Stories

**C1. Daily total at a glance.** I open the web client. The Usage
panel shows "Today: $4.20 across 6 sessions." I click through to
see the breakdown by model.

**C2. Session-level cost while it runs.** I'm in `qwen rc` working on
a long task. The status line shows "$0.42 · 12.3k in / 4.1k out".
The number updates after each tool round-trip.

**C3. Operator audits a bridge user.** A Telegram-bridge user has
been prompting heavily. The operator runs `qwen rc usage --sub-actor
telegram:99 --since 24h` and sees their total contribution.

**C4. Adding a new model.** I configure a new OpenAI-compatible
endpoint with model `gpt-4o-mini`. I add a row to
`~/.qwen/rc/model-rates.yaml`. Within 30 s the daemon reloads and
the next session_update uses the new rates.

**C5. Read-scope user sees nothing of others.** My partner has a
read-scope token to follow along on a session. They visit the Usage
panel and see only rows their token attribution generated (which is
zero — read scope can't prompt) and a banner explaining cost data
is owner-scope by default.

## Impact

- **qwen-code repo**: new module
  `packages/cli/src/serve/remoteControl/usage/` containing the rate
  loader, the writer, the aggregator, and the `/rc/usage` route.
  SQLite schema migration adding `usage_events` table.
- **Web client**: new `Usage` panel route + a small cost header in
  the chat surface.
- **Terminal client**: extend status-line renderer with a cost
  column (gated by `remoteControl.costTracking` capability flag).
- **No external dependencies** beyond what the daemon already pulls
  in (SQLite, YAML parser). The rate table loader uses the same
  YAML parser the daemon uses elsewhere (`yaml` npm package, already
  a dependency for config files).
- **Capability advertisement**: `/capabilities` gains
  `remoteControl.costTracking: { enabled: true, rateTablePath }`.
- **Out of scope** (deliberately):
  - Real-time cost-cap enforcement (a future
    `add-cost-caps` change can deny prompts above a per-session or
    per-day budget using this data as its source).
  - Tracking cost for tool calls that hit non-LLM APIs (e.g., a tool
    that calls a paid web-search API). Only LLM tokens are counted
    here.
  - Currency conversion. Rate table is one currency (operator's
    choice); the UI renders that currency unit verbatim.
  - Reconstructing cost retroactively for sessions whose
    `session_update` frames were lost before this change shipped.
