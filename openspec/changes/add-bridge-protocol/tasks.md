# tasks — add-bridge-protocol

State machine and alignment pattern: see
`changes/add-remote-control/tasks.md`.

## Phase 0 — Foundation

**Effort:** ~0.5 day.

- [ ] **0.0 Alignment**
  - **Status:** not-started
  - **Prompt:** > Verify `add-remote-control` Phase 6 `completed`. Confirm the > scope-guard middleware from `add-remote-control` exposes a > clean extension point for adding a new scope (we should be > able to add `bridge` without rewriting existing route > declarations). If it's hard-coded to the 4 existing scopes, > note it here and revise `add-remote-control` `specs/pairing-
auth/spec.md` scope enumeration to be enum-extensible.

## Phase 1 — Scope and sub-actor header

**Effort:** ~2 days.

- [ ] **1.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify Phase 0 `completed`. Decide whether the existing
    > `tokens` schema requires migration or if it's already permissive
    > about scope values. Record the migration approach.

- [ ] **1.1 Add `bridge` scope to enumeration**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Prompt:**
    > Extend the scopes enum to include `bridge`. Update implication
    > graph: `bridge ⊃ write + approve + read`; not implied by
    > `owner`. Update `/capabilities` `supportedScopes` listing.
    > Acceptance: integration test mints a `bridge`-scope code,
    > redeems it, lists scope; pairing endpoint rejects requests for
    > `bridge` scope from non-owner callers.

- [ ] **1.2 X-RC-SubActor header parsing**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Files:** `packages/cli/src/serve/remoteControl/subActor.ts`
  - **Prompt:** > Middleware that: > > - validates the regex `^[a-z][a-z0-9_-]{0,31}:[A-Za-z0-9._:@/+=-]{1,256}$` > - permits only bridge-scope tokens to set the header > - attaches the parsed sub-actor onto the request context > Update audit writer to read sub-actor from context and write to > the new column. Acceptance: scenarios under `Requirement: X-RC-
SubActor header`.

- [ ] **1.3 Audit schema migration**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Files:** `schema/00X_audit_subactor.sql` (if audit is
    SQL-backed in your branch) and the JSONL writer.
  - **Prompt:**
    > Add `sub_actor` column / field. JSONL writer emits it when
    > non-null; old rows have null (no backfill needed). Update the
    > `audit_event` SSE frame schema in
    > `add-remote-control` wire-protocol spec if needed (open a
    > drift note).

- [ ] **1.4 Update audit listing endpoint**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Prompt:**
    > Add `?subActor=<value>` filter to `GET /rc/audit`. Index the
    > field if storage backend supports indexing. Acceptance: query
    > of 100k rows with sub-actor filter returns within 500 ms.

## Phase 2 — Bridge registration and presence

**Effort:** ~2–3 days.

- [ ] **2.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify Phase 1 `completed`. Confirm bridges can subscribe to
    > SSE today with their bridge-scope tokens and that
    > `client_joined` is emitted with the right `kind`. If it's not,
    > extend the presence builder.

- [ ] **2.1 Bridge registration routes + storage**
  - **Status:** not-started
  - **Effort:** ~1 day
  - **Files:**
    `packages/cli/src/serve/remoteControl/bridges/registration.ts`,
    `schema/00X_bridges.sql`
  - **Prompt:**
    > Implement `POST /rc/bridges` (register/upsert),
    > `GET /rc/bridges` (owner-only list with last heartbeat),
    > `PATCH /rc/bridges/:id` (update capabilities),
    > `DELETE /rc/bridges/:id` (owner or self). Idempotent on
    > (token_id, bridgeKind). Acceptance: register → list → patch →
    > deregister integration.

- [ ] **2.2 Heartbeat + auto-deregister**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Prompt:** > Implement `POST /rc/bridges/:id/heartbeat`. Background task > scans every 30 s; if `last_heartbeat_at` > 180 s old, soft- > delete and emit audit `bridge_stale_deregistered`. Acceptance: > scenarios under `Requirement: Bridge heartbeat and auto-
deregister`.

- [ ] **2.3 Presence events carry bridge kind**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Prompt:**
    > Update `client_joined` builder to include `kind: "bridge"`,
    > `displayName`, `bridgeKind` when the subscribing token has
    > bridge scope AND is registered. Web client (Phase 4 work,
    > tracked in add-remote-control) updated to display bridge
    > presence distinctly.

## Phase 3 — Rate limits, bans, hints

**Effort:** ~2 days.

- [ ] **3.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify Phase 2 `completed`. Confirm bridges can be exercised
    > against the in-memory token-bucket implementation in tests
    > without flaky timing assumptions; if not, add fake-clock
    > support in the rate-limit module.

- [ ] **3.1 Token bucket per-sub-actor and per-bridge**
  - **Status:** not-started
  - **Effort:** ~1 day
  - **Files:** `packages/cli/src/serve/remoteControl/bridges/rateLimit.ts`
  - **Prompt:** > Two-layer token bucket. Per-bridge bucket consulted first; > per-sub-actor second. On 429, emit `Retry-After` header and > audit. Acceptance: scenarios under `Requirement: Per-sub-actor
rate limiting`.

- [ ] **3.2 Sub-actor ban storage and enforcement**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Prompt:**
    > Add `bridge_bans` table; routes `POST /rc/bridges/:id/ban`,
    > `DELETE /rc/bridges/:id/ban/:subActorUrlEncoded`. Middleware
    > checks bans early in the request pipeline. Emit
    > `sub_actor_banned` SSE event to the bridge's subscription.

- [ ] **3.3 `bridgeHints` on permission requests**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Files:** `packages/cli/src/serve/remoteControl/bridges/hints.ts`
  - **Prompt:**
    > Sensitivity classifier: tool name + args inspection (simple
    > glob list, configurable via
    > `~/.qwen/rc/bridge-hints.yaml`). Default classifier ships with
    > obvious entries (force-push: high; npm test: low; everything
    > else: medium). Attach `bridgeHints` to every emitted
    > `permission_request`. Acceptance: scenario "High sensitivity
    > recommends deeplink".

## Phase 4 — Operator UX + reference skeleton

**Effort:** ~1.5 days.

- [ ] **4.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify Phase 3 `completed`. Determine if the reference
    > skeleton should live in this repo or a separate one. Decision
    > goes in `design.md` open question section.

- [ ] **4.1 `qwen rc bridges {list,deregister,ban,unban,audit}` CLI**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Prompt:**
    > Implement five subcommands per spec. Format `list` output as a
    > table with id / displayName / bridgeKind / scope / last
    > heartbeat (relative) / status.

- [ ] **4.2 Reference skeleton bridge**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Files:** `examples/bridges/skeleton/` (separate package, not
    shipped as part of the daemon)
  - **Prompt:**
    > A minimal TypeScript bridge that:
    >
    > - reads daemon URL + bridge token from env
    > - registers itself
    > - subscribes to SSE
    > - logs every event to stdout
    > - has stubs for "translate event to chat" and "post inbound
    >   message"
    >   Documented in a brief README. Acceptance: skeleton boots
    >   against a local daemon and prints events.

- [ ] **4.3 Docs**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Files:** `docs/developers/bridge-protocol.md`
  - **Prompt:**
    > Bridge-author guide: scope, sub-actor format, registration,
    > heartbeat, capability declaration, hint interpretation,
    > rate limit handling, ban events, audit visibility. Under
    > 1500 words; written so a third-party bridge author who has
    > never seen qwen-code can produce a working bridge.

- [ ] **4.4 Archive change**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Prompt:**
    > Run `openspec archive add-bridge-protocol`.

## Effort summary

| Phase     | Description                   | Estimate (days) |
| --------- | ----------------------------- | --------------- |
| 0         | Foundation                    | 0.5             |
| 1         | Scope + sub-actor header      | 2               |
| 2         | Registration + presence       | 2–3             |
| 3         | Rate limits, bans, hints      | 2               |
| 4         | Operator UX + skeleton + docs | 1.5             |
| **Total** |                               | **8–9**         |
