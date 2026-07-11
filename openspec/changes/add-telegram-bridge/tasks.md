# tasks — add-telegram-bridge

State machine and alignment pattern: see
`changes/add-remote-control/tasks.md`.

## Phase 0 — Foundation

**Effort:** ~0.5 day.

- [ ] **0.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify `add-bridge-protocol` Phase 4 `completed` (or that the
    > scope, sub-actor header, registration, heartbeat, rate-limit,
    > ban, and `bridgeHints` requirements are merged and live in the
    > daemon). Confirm `qwen rc pair --scope bridge` works end-to-
    > end on a local daemon. If `POST /rc/bridges/:id/invite` is not
    > yet in `add-bridge-protocol` (it was introduced as D3 of this
    > change's design), file an amendment against bridge-protocol's
    > spec delta and block this phase until the route lands. Record
    > the outcome here.

## Phase 1 — Skeleton bridge + registration

**Effort:** ~1.5 days.

- [ ] **1.0 Alignment**
  - **Status:** not-started
  - **Prompt:** > Verify Phase 0 `completed`. Choose esbuild vs tsc for the > build output; decision determines `package.json` scripts. > Confirm `examples/bridges/skeleton/` from `add-bridge-
protocol` is current and clone-friendly as a starting point.

- [ ] **1.1 Package scaffolding**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Files:** `packages/bridge-telegram/package.json`,
    `packages/bridge-telegram/tsconfig.json`,
    `packages/bridge-telegram/esbuild.config.mjs`,
    `packages/bridge-telegram/src/index.ts`
  - **Prompt:** > Create the package. Dependencies: `node-telegram-bot-api` OR > `grammy` (pick `grammy` — newer, better TS types, smaller > dep tree); justify in commit. No daemon imports — bridge talks > only over HTTP. Acceptance: `pnpm --filter bridge-telegram
build` produces a single `dist/index.js`.

- [ ] **1.2 Env config loader**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Files:** `packages/bridge-telegram/src/config.ts`
  - **Prompt:**
    > Read `TELEGRAM_BOT_TOKEN`, `QWEN_DAEMON_URL`,
    > `QWEN_BRIDGE_TOKEN`, optionally `QWEN_BRIDGE_PAIRING_CODE`,
    > `QWEN_BRIDGE_STATE_DIR` (default
    > `~/.qwen/rc/bridges/telegram`), `BRIDGE_LOG_LEVEL`. Fail-fast
    > with actionable error if a required var is unset. Acceptance:
    > unit test asserts each missing required env triggers exit code
    > 1 with a specific message.

- [ ] **1.3 Token bootstrap from pairing code**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Files:** `packages/bridge-telegram/src/bootstrap.ts`
  - **Prompt:**
    > If `QWEN_BRIDGE_TOKEN` unset and `QWEN_BRIDGE_PAIRING_CODE`
    > set, redeem the code via `POST /rc/pair/redeem`, write token
    > to `$QWEN_BRIDGE_STATE_DIR/token` mode 0600, log fingerprint
    > only (never the raw token). Subsequent boots read the file.

- [ ] **1.4 Bridge registration + heartbeat**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Files:** `packages/bridge-telegram/src/registration.ts`
  - **Prompt:** > On boot, `POST /rc/bridges` with declared capabilities: > `{ displayName: "Telegram-bridge", bridgeKind: "telegram",
capabilities: { supportsActions: true, supportsMarkdown:
"limited", maxMessageBytes: 4096, supportsThreads: false,
supportsEdits: true } }`. Loop heartbeat every 30 s. Acceptance: > daemon `GET /rc/bridges` shows the bridge as online; killing > the bridge causes `bridge_stale_deregistered` audit within > 180 s.

- [ ] **1.5 Healthz endpoint**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Prompt:** > Expose `GET /healthz` on a configurable port (default 9100) > returning `{ ok: true, daemonReachable: bool,
telegramReachable: bool, registeredId: "br_*" | null }`. For > Docker / k8s liveness probes.

## Phase 2 — Chat binding + inbound prompts

**Effort:** ~1.5 days.

- [ ] **2.0 Alignment**
  - **Status:** not-started
  - **Prompt:** > Verify Phase 1 `completed`. Confirm `POST /rc/bridges/:id/
invite` and `.../invite/redeem` routes are live in the daemon > (per Phase 0 amendment). If not, escalate.

- [ ] **2.1 chats.json storage**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Files:** `packages/bridge-telegram/src/store/chats.ts`
  - **Prompt:** > Atomic-rename JSON store at > `$QWEN_BRIDGE_STATE_DIR/chats.json`. API: `getByChatId`, > `bind(chatId, sessionId, primarySubActor)`, `unbind(chatId)`, > `all()`. Acceptance: scenarios under `Requirement: Chat-to-
session binding via /start`.

- [ ] **2.2 /start invite redemption**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Files:** `packages/bridge-telegram/src/handlers/start.ts`
  - **Prompt:** > Telegram update handler for `/start <token>`. Calls daemon > `POST /rc/bridges/:id/invite/redeem` with the token; on > success, persists chat binding and replies "Bound chat to > session `<id>`". On failure, replies with the daemon's error > text. Acceptance: scenario `Operator-issued invite binds
chat`.

- [ ] **2.3 /detach handler**
  - **Status:** not-started
  - **Effort:** ~0.1 day
  - **Prompt:**
    > Handler for `/detach`. Removes the chat from chats.json;
    > confirms with "Unbound. Use a fresh invite to re-bind."

- [ ] **2.4 Inbound message → daemon prompt**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Files:** `packages/bridge-telegram/src/handlers/message.ts`
  - **Prompt:** > For a non-command message in a bound chat: > > - Look up `(sessionId, subActor)` from chats.json AND the > message's sender id (the latter overrides primarySubActor; > per-group chats vary by sender). > - Drop the message if sender is in local ban cache. > - POST `/session/<sessionId>/prompt` with body > `{ prompt: <text> }` and `X-RC-SubActor:
telegram:<senderId>`. > - On daemon 429: reply with "slow down, try again in > `<Retry-After>` s". > - On daemon 403 `sub_actor_banned`: silently drop. > Acceptance: scenarios `Inbound prompt forwarded to daemon` > and `Sender-specific sub-actor`.

- [ ] **2.5 /status handler**
  - **Status:** not-started
  - **Effort:** ~0.15 day
  - **Prompt:**
    > Handler for `/status`: replies with current binding, daemon
    > reachability, and bridge uptime.

## Phase 3 — Outbound event rendering

**Effort:** ~2 days.

- [ ] **3.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify Phase 2 `completed`. Confirm the daemon emits
    > `bridgeHints` with all four fields on every
    > `permission_request`. If only some fields populated, file a
    > drift report against bridge-protocol spec.

- [ ] **3.1 SSE consumer per bound session**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Files:** `packages/bridge-telegram/src/sseConsumer.ts`
  - **Prompt:** > For each bound session in chats.json, open a `GET /session/
:id/events` SSE connection with `Authorization: Bearer
<bridge-token>` and `Last-Event-ID` from persisted cursor > (`$QWEN_BRIDGE_STATE_DIR/cursors.json`). On disconnect, > reconnect with backoff. Persist event id after each > successful dispatch. Acceptance: bridge restart resumes > without duplicate messages.

- [ ] **3.2 MarkdownV2 escape utility**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Files:** `packages/bridge-telegram/src/render/markdownV2.ts`
  - **Prompt:**
    > Implement the Telegram MarkdownV2 escape table verbatim.
    > Code blocks and inline code preserved unescaped; other text
    > escaped. Acceptance: property-based test with random unicode
    > strings round-trips through escape+sendMessage without 400
    > responses from Telegram (mocked).

- [ ] **3.3 session_update streamer with boundary buffering**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Files:** `packages/bridge-telegram/src/render/sessionUpdate.ts`
  - **Prompt:**
    > Buffer chunks per chat; flush on (a) paragraph break, (b)
    > code-fence close, (c) 1500 ms idle, or (d) buffer ≥ 3500
    > chars. Split messages exceeding 4096 chars at safe boundary.
    > Acceptance: streaming 50 chunks renders ≤ ~5 Telegram
    > messages with no truncated code fences.

- [ ] **3.4 permission_request renderer with inline keyboard**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Files:** `packages/bridge-telegram/src/render/permissionRequest.ts`
  - **Prompt:**
    > Branch on `bridgeHints.recommendedSurface`:
    >
    > - `inline`: send message with `argsSummaryShort` and two-
    >   button inline keyboard (Approve/Deny), callback_data
    >   `vote:approve:<reqId>` / `vote:deny:<reqId>`.
    > - `deeplink`: send `argsSummaryShort` plus one-button
    >   keyboard linking to `${QWEN_DAEMON_URL}/ui/permission/
<reqId>`.
    >   Record the resulting Telegram message id in an in-memory map
    >   keyed by `requestId` for later edit. Acceptance: scenarios
    >   under `Requirement: permission_request rendering`.

- [ ] **3.5 Callback query → vote**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Files:** `packages/bridge-telegram/src/handlers/callback.ts`
  - **Prompt:** > Parse `vote:<approve|deny>:<reqId>`. POST `/permission/
<reqId>` with vote + `X-RC-SubActor: telegram:<tapper-id>`. > Answer the callback query with green tick / red cross. > Acceptance: scenario `Telegram tap resolves permission`.

- [ ] **3.6 permission_resolved → message edit**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Prompt:** > On SSE `permission_resolved`, look up Telegram message id > from in-memory map and `editMessageReplyMarkup` to clear > buttons, then `editMessageText` to append `Resolved:
<approved|denied> by <subActor>`. If message id unknown > (post-restart), no-op.

## Phase 4 — Rate limits, bans, polish

**Effort:** ~1 day.

- [ ] **4.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify Phase 3 `completed`. Confirm the daemon emits
    > `sub_actor_banned` SSE events on the bridge's event channel
    > (not just on session channels). If only per-session, file
    > drift.

- [ ] **4.1 Local ban cache**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Files:** `packages/bridge-telegram/src/store/bans.ts`
  - **Prompt:** > Subscribe to bridge-scope SSE channel `GET /rc/bridges/:id/
events` (if available; otherwise listen on every session's > events). On `sub_actor_banned`, add to in-memory set and > persist to `bans.json`. On `sub_actor_unbanned`, remove. > Apply pre-filter in inbound message handler.

- [ ] **4.2 Telegram rate-limit backoff**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Files:** `packages/bridge-telegram/src/render/sender.ts`
  - **Prompt:**
    > Wrap all Telegram send calls in a queue with exponential
    > backoff on 429 (`retry_after` from Telegram). Cap retries at
    > 5; after that, drop and log. SSE consumer NEVER blocks on
    > Telegram queue.

- [ ] **4.3 Log redaction**
  - **Status:** not-started
  - **Effort:** ~0.15 day
  - **Prompt:**
    > All logs pass through a redactor that removes
    > `TELEGRAM_BOT_TOKEN` and any `qwk_*` string. Unit test
    > exercises this.

- [ ] **4.4 Dockerfile + docker-compose example**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Files:** `packages/bridge-telegram/Dockerfile`,
    `packages/bridge-telegram/docker-compose.example.yml`
  - **Prompt:**
    > Multi-stage Dockerfile, Alpine base, non-root user, declared
    > volume `/state` mapped to `$QWEN_BRIDGE_STATE_DIR`. Compose
    > example shows env wiring and volume mount.

## Phase 5 — CLI helper + docs + archive

**Effort:** ~0.5 day.

- [ ] **5.0 Alignment**
  - **Status:** not-started
  - **Prompt:** > Verify Phase 4 `completed`. Confirm `qwen rc bridges invite
--kind telegram --session <id>` lands in the daemon CLI (the > bridge-protocol extension noted in design D3).

- [ ] **5.1 Telegram-specific CLI flags**
  - **Status:** not-started
  - **Effort:** ~0.15 day
  - **Prompt:**
    > Add `--kind telegram` recognition to `qwen rc bridges invite`.
    > Output the `t.me/<bot>?start=<token>` URL using bot username
    > looked up from the registered bridge's metadata; if username
    > unknown, output raw token.

- [ ] **5.2 docs/bridges/telegram.md**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Files:** `docs/bridges/telegram.md`
  - **Prompt:**
    > Cover: BotFather setup, env vars, pairing flow, chat invite,
    > permission UX, sensitivity hint behaviour, rate-limit
    > messages, ban flow, token rotation (coupled), Docker quick-
    > start, troubleshooting (long-poll stall, MarkdownV2 errors).
    > Under 1500 words.

- [ ] **5.3 Archive change**
  - **Status:** not-started
  - **Effort:** ~0.1 day
  - **Prompt:**
    > Run `openspec archive add-telegram-bridge`.

## Effort summary

| Phase     | Description                 | Estimate (days) |
| --------- | --------------------------- | --------------- |
| 0         | Foundation                  | 0.5             |
| 1         | Skeleton + registration     | 1.5             |
| 2         | Chat binding + inbound      | 1.5             |
| 3         | Outbound rendering          | 2               |
| 4         | Rate limits, bans, polish   | 1               |
| 5         | CLI helper + docs + archive | 0.5             |
| **Total** |                             | **~7**          |
