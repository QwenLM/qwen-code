# tasks — add-matrix-bridge

State machine and alignment pattern: see
`changes/add-remote-control/tasks.md`.

## Phase 0 — Foundation

**Effort:** ~0.5 day.

- [ ] **0.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify `add-bridge-protocol` Phase 4 `completed` and that
    > both `add-telegram-bridge` and `add-discord-bridge` are
    > archived (so the bridge contract has stabilised under real
    > implementations). Confirm `matrix-bot-sdk` (turt2live/matrix-
    > bot-sdk) is still maintained; if not, revisit design D2 and
    > consider `matrix-js-sdk`. Record outcome.

## Phase 1 — Skeleton bridge + Matrix login + registration

**Effort:** ~2 days.

- [ ] **1.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify Phase 0 `completed`. Stand up a local Synapse (Docker
    > `matrixdotorg/synapse`) for development testing. Register a
    > test bot user. Confirm `/login` produces a usable access
    > token.

- [ ] **1.1 Package scaffolding**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Files:** `packages/bridge-matrix/package.json`,
    `packages/bridge-matrix/tsconfig.json`,
    `packages/bridge-matrix/esbuild.config.mjs`,
    `packages/bridge-matrix/src/index.ts`
  - **Prompt:** > Create package. Dependency: `matrix-bot-sdk` (per design D2) > and its native crypto module (`@matrix-org/matrix-sdk-crypto-
nodejs` or equivalent). Acceptance: `pnpm --filter bridge-
matrix build` produces `dist/index.js`.

- [ ] **1.2 Env config loader**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Files:** `packages/bridge-matrix/src/config.ts`
  - **Prompt:**
    > Read `MATRIX_HOMESERVER_URL`, `MATRIX_USER_ID`,
    > `MATRIX_ACCESS_TOKEN`, `QWEN_DAEMON_URL`, `QWEN_BRIDGE_TOKEN`,
    > optional `QWEN_BRIDGE_PAIRING_CODE`, `QWEN_BRIDGE_STATE_DIR`,
    > `MATRIX_COMMAND_PREFIX` (default `!qwen`), `BRIDGE_LOG_LEVEL`.
    > Fail-fast on missing required vars.

- [ ] **1.3 Token bootstrap from pairing code**
  - **Status:** not-started
  - **Effort:** ~0.15 day
  - **Prompt:**
    > Same pattern: redeem `QWEN_BRIDGE_PAIRING_CODE` if no
    > `QWEN_BRIDGE_TOKEN`; persist to
    > `$QWEN_BRIDGE_STATE_DIR/token` (mode 0600).

- [ ] **1.4 Matrix client + olm crypto store**
  - **Status:** not-started
  - **Effort:** ~0.6 day
  - **Files:** `packages/bridge-matrix/src/matrixClient.ts`
  - **Prompt:**
    > Initialize `MatrixClient` from `matrix-bot-sdk` with
    > homeserver URL and access token. Configure a
    > `RustSdkCryptoStorageProvider` (or equivalent) backed by
    > `$QWEN_BRIDGE_STATE_DIR/olm/`. Verify the bot can `whoami`
    > and the returned id matches `MATRIX_USER_ID` (else fail-fast).
    > Acceptance: first boot creates the olm store; restart reuses
    > it without prompting re-key.

- [ ] **1.5 Auto-accept invites**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Files:** `packages/bridge-matrix/src/handlers/invite.ts`
  - **Prompt:**
    > On `m.room.member` event with state `invite` and target ==
    > the bot, call `joinRoom(roomId)`. Log the room id and
    > inviter. Acceptance: scenario `Bot auto-joins on invite`.

- [ ] **1.6 Bridge registration + heartbeat**
  - **Status:** not-started
  - **Effort:** ~0.3 day
  - **Files:** `packages/bridge-matrix/src/registration.ts`
  - **Prompt:** > POST `/rc/bridges` with `displayName: "Matrix-bridge",
bridgeKind: "matrix", capabilities: { supportsActions:
false, supportsMarkdown: "full", maxMessageBytes: 65536,
supportsThreads: true, supportsEdits: true }`. Heartbeat > every 30 s.

- [ ] **1.7 Healthz endpoint**
  - **Status:** not-started
  - **Effort:** ~0.15 day
  - **Prompt:**
    > Expose `GET /healthz` on port 9100 returning daemon+matrix
    > reachability and olm-store presence.

## Phase 2 — Room binding + inbound prompts

**Effort:** ~1.5 days.

- [ ] **2.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify Phase 1 `completed`. Confirm the bot can be invited
    > to and auto-join an unencrypted room. Schedule an
    > encrypted-room test for Phase 3.

- [ ] **2.1 rooms.json store**
  - **Status:** not-started
  - **Effort:** ~0.2 day
  - **Files:** `packages/bridge-matrix/src/store/rooms.ts`
  - **Prompt:**
    > Atomic JSON store at `$QWEN_BRIDGE_STATE_DIR/rooms.json`.
    > Methods: `bind(roomId, sessionId)`, `unbind(roomId)`,
    > `getByRoom`, `all`.

- [ ] **2.2 Command router**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Files:** `packages/bridge-matrix/src/handlers/commands.ts`
  - **Prompt:**
    > Listen for `m.room.message` events whose `body` starts with
    > `MATRIX_COMMAND_PREFIX` (default `!qwen`). Dispatch to
    > attach/detach/status handlers by next token. Ignore commands
    > from the bot itself.

- [ ] **2.3 !qwen attach handler**
  - **Status:** not-started
  - **Effort:** ~0.4 day
  - **Files:** `packages/bridge-matrix/src/commands/attach.ts`
  - **Prompt:** > Require sender power level ≥ 50 in the room (look up via > `m.room.power_levels`); reply "Permission denied: attach > requires power level ≥ 50" if insufficient. Otherwise call > daemon `POST /rc/bridges/:id/invite/redeem` with the token > argument. On 200, persist binding, reply "Room bound to > session `<id>`. React 👍/👎 on tool-call messages to vote." > Acceptance: scenarios under `Requirement: Room-to-session
binding via !qwen attach`.

- [ ] **2.4 !qwen detach handler**
  - **Status:** not-started
  - **Effort:** ~0.15 day
  - **Prompt:**
    > Same power level check; remove binding from rooms.json;
    > reply confirmation.

- [ ] **2.5 !qwen status handler**
  - **Status:** not-started
  - **Effort:** ~0.15 day
  - **Prompt:**
    > Reply with current binding, daemon health, bridge uptime,
    > and reaction-voting reminder.

- [ ] **2.6 Inbound message → daemon prompt**
  - **Status:** not-started
  - **Effort:** ~0.35 day
  - **Files:** `packages/bridge-matrix/src/handlers/message.ts`
  - **Prompt:**
    > For non-command `m.room.message` (msgtype `m.text`) in a
    > bound room from a non-banned sender that isn't the bot:
    > POST `/session/<sessionId>/prompt` with body `prompt:
    >
    > <body>` and `X-RC-SubActor: matrix:<sender>`. Handle 429
    > (room reply "Slow down...") and 403 sub_actor_banned
    > (silent drop + cache).

## Phase 3 — Outbound rendering, reactions, threads, E2EE

**Effort:** ~2.5 days.

- [ ] **3.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify Phase 2 `completed`. Set up an encrypted test room
    > and confirm the bot's olm store decrypts messages on
    > restart.

- [ ] **3.1 SSE consumer per bound room**
  - **Status:** not-started
  - **Effort:** ~0.4 day
  - **Files:** `packages/bridge-matrix/src/sseConsumer.ts`
  - **Prompt:**
    > Same per-binding pattern with `Last-Event-ID` cursor
    > persisted to `cursors.json`.

- [ ] **3.2 session_update streamer**
  - **Status:** not-started
  - **Effort:** ~0.4 day
  - **Files:** `packages/bridge-matrix/src/render/sessionUpdate.ts`
  - **Prompt:**
    > Buffer + flush per paragraph/code-fence boundary or 1500 ms
    > idle; cap at 16 KB practical (declared 65536). Use
    > `format: "org.matrix.custom.html"` with a CommonMark-to-HTML
    > render (markdown-it or similar). Acceptance: streaming long
    > content produces well-formed HTML with no truncated tags.

- [ ] **3.3 Threads via m.thread**
  - **Status:** not-started
  - **Effort:** ~0.4 day
  - **Files:** `packages/bridge-matrix/src/render/threads.ts`
  - **Prompt:**
    > Same trigger as Discord (≥ 6 flushes per turn) but use
    > Matrix's `m.thread` relation: subsequent messages set
    > `m.relates_to.rel_type: "m.thread"`,
    > `m.relates_to.event_id: <first-flush-eventId>`. Turn boundary
    > = `permission_resolved` or new inbound prompt.

- [ ] **3.4 permission_request rendering**
  - **Status:** not-started
  - **Effort:** ~0.4 day
  - **Files:** `packages/bridge-matrix/src/render/permissionRequest.ts`
  - **Prompt:**
    > Branch on `bridgeHints.recommendedSurface`:
    >
    > - `inline`: send a message body containing
    >   `argsSummaryShort` and the instruction "React 👍 to
    >   approve, 👎 to deny." Record requestId → eventId.
    > - `deeplink`: send body with `argsSummaryShort` plus a
    >   plaintext URL `${QWEN_DAEMON_URL}/ui/permission/<reqId>`.
    >   Do NOT prompt for reactions (sensitive content goes through
    >   the web client).

- [ ] **3.5 Reaction listener → vote**
  - **Status:** not-started
  - **Effort:** ~0.4 day
  - **Files:** `packages/bridge-matrix/src/handlers/reaction.ts`
  - **Prompt:**
    > Listen for `m.reaction` events whose `m.relates_to.event_id`
    > matches a tracked request eventId. Map `key: "👍"` →
    > approve, `key: "👎"` → deny; ignore other keys. Drop
    > reactions from banned MXIDs. POST `/permission/<reqId>` with
    > vote + `X-RC-SubActor: matrix:<reactor>`. Acceptance:
    > scenarios under `Requirement: Reaction-based voting`.

- [ ] **3.6 permission_resolved → m.replace edit**
  - **Status:** not-started
  - **Effort:** ~0.3 day
  - **Prompt:**
    > On `permission_resolved`, send an `m.room.message` with
    > `m.relates_to.rel_type: "m.replace"` and
    > `m.relates_to.event_id` pointing at the original request
    > event. New body appends "Resolved: `<vote>` by
    > `<subActor>`". Past reactions remain visible.

- [ ] **3.7 Encrypted-room verification**
  - **Status:** not-started
  - **Effort:** ~0.2 day
  - **Prompt:**
    > Exercise: bind an encrypted room, send a tool-call, react,
    > resolve. Verify the bridge decrypts, votes, and re-encrypts
    > the edit correctly. Log the room id and encryption status
    > on join.

## Phase 4 — Rate limits, bans, polish

**Effort:** ~0.75 day.

- [ ] **4.0 Alignment**
  - **Status:** not-started
  - **Prompt:** Verify Phase 3 `completed`.

- [ ] **4.1 Local ban cache**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Files:** `packages/bridge-matrix/src/store/bans.ts`
  - **Prompt:**
    > Subscribe to `sub_actor_banned` / `sub_actor_unbanned` SSE.
    > Filter inbound messages AND reactions before any daemon
    > call.

- [ ] **4.2 Matrix rate-limit handling**
  - **Status:** not-started
  - **Effort:** ~0.15 day
  - **Prompt:**
    > Rely on `matrix-bot-sdk`'s `M_LIMIT_EXCEEDED` retry-after
    > backoff. SSE consumer never blocks on Matrix send queue.

- [ ] **4.3 Log redaction**
  - **Status:** not-started
  - **Effort:** ~0.15 day
  - **Prompt:**
    > Redact `MATRIX_ACCESS_TOKEN` and `qwk_*` from all log
    > outputs.

- [ ] **4.4 Dockerfile + compose example**
  - **Status:** not-started
  - **Effort:** ~0.2 day
  - **Files:** `packages/bridge-matrix/Dockerfile`,
    `packages/bridge-matrix/docker-compose.example.yml`
  - **Prompt:**
    > Document the olm store volume mount prominently; include a
    > comment about backup.

## Phase 5 — Docs + archive

**Effort:** ~0.5 day.

- [ ] **5.0 Alignment**
  - **Status:** not-started
  - **Prompt:** Verify Phase 4 `completed`.

- [ ] **5.1 docs/bridges/matrix.md**
  - **Status:** not-started
  - **Effort:** ~0.4 day
  - **Files:** `docs/bridges/matrix.md`
  - **Prompt:**
    > Cover: Synapse user creation (manual + admin-API),
    > obtaining access token, env vars, pairing, attach flow with
    > power-level requirement, reaction voting, **E2EE
    > disclosure section** (the bridge holds room keys; backup
    > guidance), troubleshooting (key share failure, missed
    > events, federation outage), Docker quick-start. Under 1800
    > words.

- [ ] **5.2 Archive change**
  - **Status:** not-started
  - **Effort:** ~0.1 day
  - **Prompt:** `openspec archive add-matrix-bridge`.

## Effort summary

| Phase     | Description                     | Estimate (days) |
| --------- | ------------------------------- | --------------- |
| 0         | Foundation                      | 0.5             |
| 1         | Skeleton + login + registration | 2               |
| 2         | Room binding + inbound          | 1.5             |
| 3         | Outbound + reactions + E2EE     | 2.5             |
| 4         | Rate limits, bans, polish       | 0.75            |
| 5         | Docs + archive                  | 0.5             |
| **Total** |                                 | **~7.75**       |
