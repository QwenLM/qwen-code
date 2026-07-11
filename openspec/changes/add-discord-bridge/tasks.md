# tasks — add-discord-bridge

State machine and alignment pattern: see
`changes/add-remote-control/tasks.md`.

## Phase 0 — Foundation

**Effort:** ~0.5 day.

- [ ] **0.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify `add-bridge-protocol` Phase 4 `completed` AND
    > `add-telegram-bridge` Phase 5 `completed` (so the invite
    > route extension is live and at least one bridge has shaken
    > out the bridge-protocol contract). If `add-telegram-bridge`
    > exposed bugs in the daemon, those must be fixed before
    > starting this change. If `discord.js` v14 is no longer the
    > current major, reassess the library decision (design D2) and
    > record drift.

## Phase 1 — Skeleton bridge + registration

**Effort:** ~1.5 days.

- [ ] **1.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify Phase 0 `completed`. Confirm the daemon's bridge-
    > protocol invite route accepts the `kind: "discord"` value
    > (it should be opaque, but verify).

- [ ] **1.1 Package scaffolding**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Files:** `packages/bridge-discord/package.json`,
    `packages/bridge-discord/tsconfig.json`,
    `packages/bridge-discord/esbuild.config.mjs`,
    `packages/bridge-discord/src/index.ts`
  - **Prompt:**
    > Create the package. Dependency: `discord.js` v14+ (per
    > design D2). Acceptance: `pnpm --filter bridge-discord build`
    > produces `dist/index.js`.

- [ ] **1.2 Env config loader**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Files:** `packages/bridge-discord/src/config.ts`
  - **Prompt:**
    > Read `DISCORD_BOT_TOKEN`, `DISCORD_APPLICATION_ID`,
    > `QWEN_DAEMON_URL`, `QWEN_BRIDGE_TOKEN`, optional
    > `DISCORD_GUILD_ID`, `QWEN_BRIDGE_PAIRING_CODE`,
    > `QWEN_BRIDGE_STATE_DIR`, `BRIDGE_LOG_LEVEL`. Fail-fast on
    > missing required vars.

- [ ] **1.3 Token bootstrap from pairing code**
  - **Status:** not-started
  - **Effort:** ~0.15 day
  - **Prompt:**
    > Same pattern as Telegram: if `QWEN_BRIDGE_TOKEN` unset and
    > `QWEN_BRIDGE_PAIRING_CODE` set, redeem and persist to
    > `$QWEN_BRIDGE_STATE_DIR/token` (mode 0600).

- [ ] **1.4 Gateway client**
  - **Status:** not-started
  - **Effort:** ~0.4 day
  - **Files:** `packages/bridge-discord/src/gateway.ts`
  - **Prompt:**
    > Initialize a `discord.js` Client with intents `Guilds`,
    > `GuildMessages`, `MessageContent`, `DirectMessages` (DMs may
    > be added later). Login with bot token. On `READY` log the bot
    > tag. On `error` log and let `discord.js` handle reconnect.
    > Acceptance: bridge connects and stays connected through a
    > forced network blip.

- [ ] **1.5 Bridge registration + heartbeat**
  - **Status:** not-started
  - **Effort:** ~0.3 day
  - **Files:** `packages/bridge-discord/src/registration.ts`
  - **Prompt:** > POST `/rc/bridges` with `displayName: "Discord-bridge",
bridgeKind: "discord", capabilities: { supportsActions:
true, supportsMarkdown: "limited", maxMessageBytes: 2000,
supportsThreads: true, supportsEdits: true }`. Heartbeat > every 30 s.

- [ ] **1.6 Healthz endpoint + invite URL print**
  - **Status:** not-started
  - **Effort:** ~0.15 day
  - **Prompt:** > Expose `GET /healthz` (port 9100 default). On first boot > print the OAuth2 invite URL: > `https://discord.com/api/oauth2/authorize?client_id=
<APP_ID>&permissions=274877943808&scope=bot+applications.
commands` so the operator can add the bot to a guild.

## Phase 2 — Slash commands + channel binding

**Effort:** ~1.5 days.

- [ ] **2.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify Phase 1 `completed`. Decide guild-scoped vs global
    > slash-command registration default — recommend guild-scoped
    > when `DISCORD_GUILD_ID` is set, global otherwise.

- [ ] **2.1 Slash command registration**
  - **Status:** not-started
  - **Effort:** ~0.3 day
  - **Files:** `packages/bridge-discord/src/commands/register.ts`
  - **Prompt:**
    > On boot, register three commands via Discord REST:
    >
    > - `/qwen attach <invite:string>` — bind this channel
    > - `/qwen detach` — unbind
    > - `/qwen status` — show binding + health
    >   Guild-scoped if `DISCORD_GUILD_ID` set; else global.
    >   Acceptance: commands appear in the Discord client within 30s
    >   of bot startup (guild-scoped).

- [ ] **2.2 channels.json store**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Files:** `packages/bridge-discord/src/store/channels.ts`
  - **Prompt:**
    > Atomic JSON store at
    > `$QWEN_BRIDGE_STATE_DIR/channels.json`. Methods: `bind`,
    > `unbind`, `getByChannel`, `all`. Acceptance: scenarios under
    > `Requirement: Channel-to-session binding via /qwen attach`.

- [ ] **2.3 /qwen attach handler**
  - **Status:** not-started
  - **Effort:** ~0.4 day
  - **Files:** `packages/bridge-discord/src/commands/attach.ts`
  - **Prompt:**
    > On `ChatInputCommandInteraction` for `/qwen attach`:
    >
    > - Defer reply ephemeral.
    > - POST `/rc/bridges/:id/invite/redeem` with the token arg.
    > - On 200, persist binding and reply "Channel bound to
    >   session `<id>`".
    > - On error, reply with daemon error text.

- [ ] **2.4 /qwen detach handler**
  - **Status:** not-started
  - **Effort:** ~0.15 day
  - **Prompt:**
    > Remove binding for the invoking channel; reply ephemerally.

- [ ] **2.5 /qwen status handler**
  - **Status:** not-started
  - **Effort:** ~0.2 day
  - **Prompt:**
    > Reply with current binding (if any), daemon reachability,
    > bridge uptime, and short usage tip ("Type in chat to send
    > prompts; use the Approve/Deny buttons on tool calls.").

- [ ] **2.6 Inbound message → daemon prompt**
  - **Status:** not-started
  - **Effort:** ~0.3 day
  - **Files:** `packages/bridge-discord/src/handlers/message.ts`
  - **Prompt:** > On `MESSAGE_CREATE` for a bound channel, where author is not > the bot itself and not in the ban cache: > > - POST `/session/<sessionId>/prompt` with `prompt:
<content>` and `X-RC-SubActor: discord:<author.id>`. > - On 429: send ephemeral reply ("slow down..."). > - On 403 sub_actor_banned: add to local ban cache, drop.

## Phase 3 — Outbound rendering, components, threads

**Effort:** ~2.5 days.

- [ ] **3.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify Phase 2 `completed`. Confirm `bridgeHints` arrives on
    > every `permission_request` SSE frame from the daemon.

- [ ] **3.1 SSE consumer per bound channel**
  - **Status:** not-started
  - **Effort:** ~0.4 day
  - **Files:** `packages/bridge-discord/src/sseConsumer.ts`
  - **Prompt:**
    > Same pattern as Telegram's: per-binding subscription,
    > `Last-Event-ID` cursor persisted to
    > `$QWEN_BRIDGE_STATE_DIR/cursors.json`, backoff reconnect.

- [ ] **3.2 session_update streamer with 2000-char cap**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Files:** `packages/bridge-discord/src/render/sessionUpdate.ts`
  - **Prompt:**
    > Buffer + flush on paragraph/codefence boundary, 1500 ms
    > idle, or buffer ≥ 1800 chars. Split at safe boundary for
    > messages exceeding 2000 chars.

- [ ] **3.3 Thread manager**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Files:** `packages/bridge-discord/src/render/threads.ts`
  - **Prompt:** > Track per-(channel, turn) flush count. On the 7th flush, > create a public thread on the first message of the turn via > `Channel.threads.create({ startMessage, name: "qwen agent
turn", autoArchiveDuration: 60 })`. Redirect subsequent > flushes of the turn to the thread. Turn boundary defined by > a `permission_resolved` SSE event OR the next inbound user > prompt. Acceptance: scenario `Long stream spawns thread`.

- [ ] **3.4 permission_request renderer with components**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Files:** `packages/bridge-discord/src/render/permissionRequest.ts`
  - **Prompt:** > Branch on `bridgeHints.recommendedSurface`: > > - `inline`: send a `MessageCreate` with `content:
argsSummaryShort`, components = one ActionRow with two > buttons (Approve = Success style, Deny = Danger style, > custom_id `vote:<dir>:<reqId>`). > - `deeplink`: send with one link-style button to the web > client URL. > Record (requestId → messageId) in in-memory map for edit on > resolve.

- [ ] **3.5 Button interaction handler → vote**
  - **Status:** not-started
  - **Effort:** ~0.3 day
  - **Files:** `packages/bridge-discord/src/handlers/component.ts`
  - **Prompt:** > On `MessageComponentInteraction`: > > - Parse `customId` `vote:<dir>:<reqId>`. > - Defer reply ephemeral. > - POST `/permission/<reqId>` with vote + `X-RC-SubActor:
discord:<member.user.id>`. > - Edit reply: "You voted `<dir>`". > - On daemon error, edit reply with the error text. > Acceptance: scenario `Approve click resolves permission`.

- [ ] **3.6 permission_resolved → message edit**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Prompt:**
    > Look up messageId, edit the message: keep content; set each
    > component's `disabled: true`; append "Resolved: `<vote>` by
    > `<subActor>`".

## Phase 4 — Rate limits, bans, polish

**Effort:** ~0.75 day.

- [ ] **4.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify Phase 3 `completed`.

- [ ] **4.1 Local ban cache**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Files:** `packages/bridge-discord/src/store/bans.ts`
  - **Prompt:**
    > Subscribe to `sub_actor_banned` / `sub_actor_unbanned` SSE
    > events; maintain in-memory set + `bans.json`. Filter inbound
    > messages AND component interactions. Banned-user interactions
    > are acknowledged (deferred ephemeral reply) but never relayed
    > to the daemon — Discord requires interaction ACK within 3 s.

- [ ] **4.2 Discord REST rate-limit handling**
  - **Status:** not-started
  - **Effort:** ~0.2 day
  - **Prompt:**
    > Rely on `discord.js`'s built-in rate-limit handling; verify
    > that no manual queueing is needed by exercising rapid sends.
    > Log warnings when `discord.js` rate-limit emitters fire.

- [ ] **4.3 Log redaction**
  - **Status:** not-started
  - **Effort:** ~0.15 day
  - **Prompt:**
    > Redact `DISCORD_BOT_TOKEN` and `qwk_*` from all log lines.

- [ ] **4.4 Dockerfile + compose example**
  - **Status:** not-started
  - **Effort:** ~0.15 day
  - **Files:** `packages/bridge-discord/Dockerfile`,
    `packages/bridge-discord/docker-compose.example.yml`

## Phase 5 — CLI helper, docs, archive

**Effort:** ~0.5 day.

- [ ] **5.0 Alignment**
  - **Status:** not-started
  - **Prompt:** > Verify Phase 4 `completed`. Confirm `qwen rc bridges invite
--kind discord` produces a usable invite token (just an > opaque token; no Discord-specific URL needed since users > paste it into `/qwen attach`).

- [ ] **5.1 docs/bridges/discord.md**
  - **Status:** not-started
  - **Effort:** ~0.3 day
  - **Files:** `docs/bridges/discord.md`
  - **Prompt:**
    > Cover: Developer Portal setup, OAuth2 invite URL,
    > permissions, scopes, env vars, slash commands, attach flow,
    > permission UX, thread behaviour, ban flow, token rotation,
    > Docker quick-start, troubleshooting (gateway disconnect,
    > slash-command propagation, 2000-char limit). Under 1500
    > words.

- [ ] **5.2 Archive change**
  - **Status:** not-started
  - **Effort:** ~0.1 day
  - **Prompt:**
    > `openspec archive add-discord-bridge`.

## Effort summary

| Phase     | Description                  | Estimate (days) |
| --------- | ---------------------------- | --------------- |
| 0         | Foundation                   | 0.5             |
| 1         | Skeleton + registration      | 1.5             |
| 2         | Slash commands + binding     | 1.5             |
| 3         | Outbound rendering + threads | 2.5             |
| 4         | Rate limits, bans, polish    | 0.75            |
| 5         | Docs + archive               | 0.5             |
| **Total** |                              | **~7.25**       |
