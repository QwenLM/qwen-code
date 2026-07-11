# tasks — add-cost-tracking

State machine and alignment pattern: see
`changes/add-remote-control/tasks.md`.

## Phase 0 — Foundation

**Effort:** ~0.5 day.

- [ ] **0.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify `add-remote-control` Phase 1 and Phase 6 `completed`,
    > and `add-bridge-protocol` Phase 1 `completed` (so
    > `originatorClientId` and `sub_actor` are reliably populated on
    > emitted events). Confirm the event bus exposes a tap that lets
    > us subscribe to `session_update` frames without rewriting the
    > fan-out path. If it does not, note here and patch
    > `add-remote-control/specs/wire-protocol/spec.md` with a "tap
    > extension point" requirement.

## Phase 1 — Rate table + storage

**Effort:** ~1.5 days.

- [ ] **1.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify Phase 0 `completed`. Decide rate-table parser library
    > (must be the same YAML lib the daemon already uses). Decide
    > SQLite migration location for `usage.db` schema (separate from
    > `tokens.db`). Record both in `design.md` Decisions or Open
    > Questions.

- [ ] **1.1 Default rate table + loader**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Files:** `packages/cli/src/serve/remoteControl/usage/rateTable.ts`,
    default file shipped at `assets/default-model-rates.yaml`.
  - **Prompt:** > Implement `RateTable` class with `load(path)`, `lookup({
modelServiceId, modelId })`, file-watcher with 250 ms debounce. > On parse error, retain previous good table in memory and emit > audit `rate_table_parse_failed`. On lookup miss return > `undefined` (writer handles by storing `cost_cents: NULL` and > emitting `rate_table_miss`). Acceptance: scenarios under > `Requirement: Rate table format and reload`.

- [ ] **1.2 Schema migration for usage.db**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Files:** `packages/cli/src/serve/remoteControl/usage/schema/001_usage_events.sql`
  - **Prompt:**
    > Create migration runner targeting `~/.qwen/rc/usage.db`. Create
    > `usage_events` table per design D1 schema. Apply four indices.
    > Acceptance: migration applied idempotently on repeated daemon
    > start; manual sqlite inspection shows table and indices.

- [ ] **1.3 Ingester wired to session_update tap**
  - **Status:** not-started
  - **Effort:** ~0.75 day
  - **Files:** `packages/cli/src/serve/remoteControl/usage/ingest.ts`
  - **Prompt:**
    > Subscribe to `session_update` events. For each frame with a
    > `usage` block, compute `cost_cents` via `RateTable.lookup` and
    > insert a row including `attribution_token_id` (= originator)
    > and `sub_actor` (from request context if any). Emit
    > `usage_tick` SSE event with the session's running total
    > (coalesced 500 ms per session). Acceptance: scenarios under
    > `Requirement: Ingest priced rows from session_update`.

## Phase 2 — Aggregation endpoint

**Effort:** ~1 day.

- [ ] **2.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify Phase 1 `completed`. Confirm the four group_by axes
    > supported (`session`, `client`, `sub_actor`, `model`) match
    > the scenarios in the spec. If any of them is hard to satisfy
    > (e.g., joining bridge displayName for the `sub_actor`
    > display label), note in Open Questions and proceed with a
    > simpler `displayLabel = key` fallback.

- [ ] **2.1 `GET /rc/usage` route**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Files:** `packages/cli/src/serve/remoteControl/usage/route.ts`
  - **Prompt:** > Implement the route with the query parameters from `design.md`. > Apply scope filtering: owner = all rows; lesser scopes = > `attribution_token_id = caller`. Return both JSON and CSV > formats. Acceptance: scenarios under `Requirement: /rc/usage
aggregation endpoint` and `Requirement: Scope filtering on
/rc/usage`.

- [ ] **2.2 Capability advertisement**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Prompt:** > Add `costTracking: { enabled: true, currencyLabel,
rateTablePath }` to `/capabilities`'s `remoteControl` block. > Bump nothing — additive. Acceptance: capabilities response > contains the new block.

- [ ] **2.3 Pruning command**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Prompt:**
    > Add `qwen rc usage prune --before <iso>` command that issues a
    > DELETE on `usage_events` rows older than the given timestamp,
    > VACUUMs the database, prints the row count removed. Confirm
    > prompt unless `--yes`.

## Phase 3 — Client surfaces

**Effort:** ~1 day.

- [ ] **3.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify Phase 2 `completed`. Verify clients gate the cost
    > surface on `remoteControl.costTracking.enabled` in
    > `/capabilities` so a daemon without this change still renders
    > cleanly.

- [ ] **3.1 Web client Usage panel**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Files:** `packages/web-client/src/views/usage.ts`,
    `packages/web-client/src/components/usageHeader.ts`
  - **Prompt:**
    > New route `/ui/usage` rendering today's total and the top 10
    > sessions in the last 7 days. Add a small cost element to the
    > existing session-header component that subscribes to
    > `usage_tick` and renders the running session total. Acceptance:
    > scenarios under `Requirement: Web client renders cost`.

- [ ] **3.2 Terminal client status-line cost**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Files:** `packages/cli/src/ui/statusLine/costElement.tsx`
  - **Prompt:** > Extend the status line with a cost cell (e.g. `$0.42 · 12.3k
in / 4.1k out`). Updates on each `usage_tick`. Hidden if > `costTracking` capability not advertised.

- [ ] **3.3 `qwen rc usage` CLI subcommand**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Prompt:** > Implement `qwen rc usage [--since] [--group-by] [--sub-actor]
[--format csv|table]`. Wraps `GET /rc/usage`. Acceptance: > `qwen rc usage --sub-actor telegram:99 --since 24h` returns > the bridge user's attributed total.

- [ ] **3.4 Archive change**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Prompt:**
    > Run `openspec archive add-cost-tracking`.

## Effort summary

| Phase     | Description          | Estimate (days) |
| --------- | -------------------- | --------------- |
| 0         | Foundation           | 0.5             |
| 1         | Rate table + storage | 1.5             |
| 2         | Aggregation endpoint | 1               |
| 3         | Client surfaces      | 1               |
| **Total** |                      | **4**           |
