# QQ Bot (QQ机器人)

This guide covers setting up a Qwen Code channel on QQ via the official QQ Bot Open Platform API.

## Prerequisites

- A QQ account (mobile app for scanning the QR code)

## Setup

### QR Code Login

Start the channel — the first time it will show a QR code. Scan it with your QQ app to activate. No developer account or manual registration needed. Credentials are saved and reused automatically.

```json
{
  "channels": {
    "my-qq": {
      "type": "qq"
    }
  }
}
```

```bash
qwen channel start my-qq
# Scan the QR code in the terminal with your QQ app
```

### Manual Configuration (Developer Portal)

You can also use credentials from the [QQ Bot Open Platform](https://q.qq.com/) developer portal if you already have an app registered there:

```json
{
  "channels": {
    "my-qq": {
      "type": "qq",
      "appID": "YOUR_APP_ID",
      "appSecret": "$QQ_APP_SECRET"
    }
  }
}
```

Set the secret as an environment variable:

```bash
export QQ_APP_SECRET=<your-app-secret>
```

## Configuration

```json
{
  "channels": {
    "my-qq": {
      "type": "qq",
      "appID": "YOUR_APP_ID",
      "appSecret": "$QQ_APP_SECRET",
      "sandbox": false,
      "privatePolicy": "open",
      "sessionScope": "thread",
      "cwd": "/path/to/your/project",
      "instructions": "你是一个通过 QQ Bot 对话的 AI 助手。回复控制在 2000 字符以内。",
      "groupPolicy": "disabled",
      "groups": {
        "*": { "requireMention": true }
      }
    }
  }
}
```

> `sessionScope` defaults to `"thread"`. With `groupPolicy: "disabled"` this is a DM-only setup, where both `"thread"` and `"user"` give each direct message its own context. `"thread"` is shown here for consistency with the [Session Isolation](#session-isolation) section below — read that section's upgrade note before changing the scope on an existing channel.

### QQ-Specific Options

| Option                     | Default | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `appID`                    | —       | QQ Bot AppID from developer portal. If omitted, QR code login is used.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `appSecret`                | —       | QQ Bot AppSecret. Supports `$ENV_VAR` syntax. If omitted, QR code login is used.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `sandbox`                  | `false` | Set to `true` to use the QQ sandbox API environment (`sandbox.api.sgroup.qq.com`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `moderationTools`          | `false` | Expose the QQ group-management tools to the agent — see [Group Management Tools](#group-management-tools). Off by default; set `true` to opt in.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `moderationRecallWindowMs` | `-1`    | How long, in milliseconds, the channel keeps an inbound message that member-targeted recall can resolve. `-1` means no time limit: entries are capped per chat, and once the channel is tracking more than 256 chats the least-recently-active chat's whole ring can be evicted. `0` disables member-targeted recall entirely — no message id is reachable from the session, so only an explicit `message_id` supplied by the operator or read from the channel logs can still be passed. `N > 0` keeps an entry for N milliseconds. A non-integer or a value below `-1` warns and falls back to `-1`. |
| `groupAllPolicy`           | unset   | Receive ordinary (non-@) group messages: `"log"` to observe them only, `"keyword"` or `"all"` to let them start a turn (with `groups: {"*": {"requireMention": false}}`). Unset means the gateway delivers only @-mentions and direct messages. See [Group Chats](#group-chats).                                                                                                                                                                                                                                                                                                                       |
| `purgeLegacySessions`      | `false` | Delete legacy single-scope and user-scope session routes — see below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `fileTools`                | `false` | Expose the outbound media tools so the agent can send a local file, image, video, or voice message to the chat — see [Outbound Media](#outbound-media).                                                                                                                                                                                                                                                                                                                                                                                                                                                |

All standard channel options (see [Channel Overview](./overview#options)) are also supported:
`privatePolicy`, `allowedUsers`, `sessionScope`, `cwd`, `instructions`, `groupPolicy`, `groups`, `dispatchMode`.

## Running

```bash
# Start only the QQ channel
qwen channel start my-qq

# Or start all configured channels together
qwen channel start
```

Open QQ and send a message to your bot. You should see the response arrive in your chat.

## Group Chats

To use the bot in QQ groups:

1. Set `groupPolicy` to `"allowlist"`, `"pairing"`, or `"open"` in your channel config
2. Add the bot to a QQ group via the QQ Bot Open Platform dashboard or by having a group admin invite it
3. Group members must **@mention** the bot to trigger a response
4. If using `groupPolicy: "pairing"`, approve the group's pairing request once before responses start. Note that once a group is approved, **any member of that group** can use the bot by default (restrict with the group's `senders: "allowlist"` and `allowedUsers`); `privatePolicy` and the top-level `allowedUsers` do not gate members of an approved group.

QQ Bot API V2 only delivers group messages that @mention the bot — the bot does not see all group messages. By default, `requireMention` is `true` and should be left that way for QQ.

### Session Isolation

The QQ channel defaults to `sessionScope: "thread"`: members of the same group share a single conversation context keyed by `<channel>:<group_openid>`, while different groups are isolated from each other. Each direct message gets its own context keyed by `<channel>:<user_openid>`.

A group thread session is a **shared session**: every member of the group reads and continues the same conversation history. Commands that operate on that session (`/clear`, `/cancel`, `/who`, `/status`, `/loop`, `/btw`), permission answers (`/approve`, `/approve-always`, `/deny`), and steering an in-flight turn (a member's plain message queues behind the running turn instead of steering it) are restricted to the members listed in the channel's `operators`; `allowedUsers` and `senderPolicy` do **not** grant them. `operators` is unset by default, so out of the box a shared group session has **no** member authorized to run those commands — and a permission request raised in a group has no one who can answer it. Set `operators` to the QQ ids of the members who should be able to steer the group's session. For a group message the gate compares against that member's `member_openid` — the same id space as the group-scoped `allowedUsers` above — not the direct-message `user_openid`; a list filled with `user_openid`s matches nobody, and because the list is non-empty the startup warning stays silent, so every command above is simply refused. A `single`- or `chat_thread`-scope channel is affected the same way, because those scopes share direct-message sessions too. The `!` host-shell prefix is disabled in every QQ group chat, regardless of scope; in a direct message the same scope rule decides it — `!` runs only where the scope keeps the session private to one sender (`"thread"` or `"user"`), and is refused for a DM too under `"single"` or `"chat_thread"` and for every group message. If group members should not share history or control each other's turns, set `sessionScope: "user"` (each member gets a private session — see the upgrade note below before switching an existing channel), or restrict who can talk to the bot with the group-scoped `senders` / `allowedUsers` control — for example `groups: {"*": {"senders": "allowlist", "allowedUsers": ["<member_openid>"]}}`. The top-level `senderPolicy`, `allowedUsers` and `privatePolicy` govern direct messages only; they do not gate members of an approved group.

For full-message mode this default is already what you want — with `groupAllPolicy: "all"`, keeping `"thread"` gives you shared context within a group and isolation across groups. If you instead set `sessionScope: "user"`, full-message traffic is fragmented per sender (a separate session for every member), which is not suitable for group full-message scenarios.

The other shared scopes are not equivalents. `sessionScope: "chat_thread"` routes group messages exactly like `"thread"` (QQ supplies no thread id, so both key on `<channel>:<chatId>`), but it is treated as shared for **every** chat: each direct message becomes a shared session subject to the `operators` gate, so `/clear` in a DM is refused and a tool call raised in a DM has no one to answer it. `sessionScope: "single"` also shares direct messages, and additionally keys **every** group and every direct message to the one context `<channel>:__single__`, so group A's history is answered with group B's and with DM history — the cross-group leakage this section is about. The channel warns at startup whenever `groupAllPolicy` is `"keyword"` or `"all"` and the scope is not `"thread"`. With `multiSession` enabled the scope is pinned to `"user"`, so that warning names the two settings as mutually exclusive and tells the operator to change `groupAllPolicy` or turn `multiSession` off, instead of advising `"thread"`.

**Upgrading from an older QQ channel.** The default scope changed from `"user"` to `"thread"`. (A channel configured with `groupAllPolicy: "keyword"` or `"all"` was previously forced to `"single"` — one global session. A channel that did not pin `sessionScope` now resolves to `"thread"` unless `multiSession` is on, which resolves to `"user"` — per-sender sessions are the only shape `multiSession` supports, so it wins over the plugin default; for a channel without `multiSession` the effective change is from that global session to a per-group one. A channel that pinned `sessionScope` explicitly is no longer overridden, so an explicit `"user"` now takes effect and fragments group full-message traffic per sender — change it to `"thread"` by hand.) Legacy session routes are not deleted automatically: while `purgeLegacySessions` is off, each start counts the routes the purge covers — the single-scope-era `<channel>:__single__` key and this channel's legacy user-scope `<channel>:<senderId>:<chatId>` keys — and leaves them, and their daemon-side sessions, untouched. A `chat_thread`-era `<channel>:<chatId>:<threadId>` route is not covered: it is neither counted nor purged. To remove the covered routes, set `purgeLegacySessions` to `true` on the channel. With it enabled, every such route is released and its daemon-side session discarded, so the old conversation mappings stop existing; the purge runs on each start while the option stays on. Nothing is deleted unless the rescue copy reaches disk: immediately before the first deletion the channel appends the doomed routes to `<channel>-sessions-purged.json` in the channel state directory (for example `~/.qwen/channels/my-qq-sessions-purged.json`; characters outside `A-Za-z0-9_-` in the channel name become `_`) and if that write fails it deletes nothing and leaves the routes in place. The file is written only when a deletion actually happens — never on a start that leaves everything alone. It is a JSON list of purge records, each with its `purgedAt` timestamp, `sessionScope`, and `routes`; each route carries its `kind`, `key`, `sessionId`, `target`, and — when the router's persisted session state still records them — `cwd`, `turns`, `startedAt`, `isolation`, and `workspaceCwd`. Records are appended rather than overwritten, so an earlier purge's record survives a later one (the oldest records are dropped once the list passes 20); a file that cannot be read, or does not hold a purge-record list, is reported in the log and renamed to a sibling `<path>.corrupt-<timestamp>` file before the new record is written, so the damaged copy is kept for hand recovery and the new record is never lost. That is routing metadata only — no conversation content — so it shows you what was dropped and lets you re-create the mapping by hand: a route whose record includes `cwd` and no `isolation` resolves to that same workspace when restored; when the record also carries `isolation: "worktree"`, `cwd` is the (usually already removed) per-session worktree, so restore against the record's `workspaceCwd` and keep `isolation` so the router re-attaches it through the managed load path. When the stored state for a route has no `cwd` (the entry is missing, or predates the field), the record simply omits `cwd` rather than guessing, so restoring such a route by hand also needs the channel's workspace path. Setting `sessionScope: "user"` after a purge does **not** bring the old conversations back by itself — those routes are already gone and are not restored automatically.

See [Group Chats](./overview#group-chats) for full details on group policies and mention gating.

## Group Management Tools

With `moderationTools: true`, the channel exposes the QQ group-management API to the agent as **client MCP tools in that channel's sessions**. The tools are **off by default**: they are destructive and run with the bot's own token, so an existing deployment keeps them off until an operator opts in per channel. Once enabled, the agent calls them itself while answering — there is no slash command to type and no operator confirmation step. The platform's own rules are the only limit, plus the member-targeted recall rule below: a `member_openid` recall is allowed only when the turn's own sender is that member, or when the turn has no member sender (for example an operator-initiated turn).

| Tool                                                      | QQ endpoint                                            | Requirement                                                                                                                                                                                        |
| --------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `qq_recall_message`                                       | `DELETE /v2/groups/{id}/messages/{msg_id}`             | Group chats only, and every call must name a target (`member_openid` or `message_id`). The bot must be a group admin to recall another member's message. The bot's own messages cannot be recalled |
| `qq_get_group_info`                                       | `GET /v2/groups/{id}/info`                             | Reserved — invite-only for the bot app (`11253` otherwise)                                                                                                                                         |
| `qq_get_bot_state`                                        | `GET /v2/groups/{id}/bot_state`                        | Reserved — invite-only for the bot app                                                                                                                                                             |
| `qq_list_join_requests`                                   | `GET /v2/groups/{id}/join_request_list`                | Bot is a group admin                                                                                                                                                                               |
| `qq_review_join_request`                                  | `POST .../approval_join_request/{member_openid}`       | Bot is a group admin                                                                                                                                                                               |
| `qq_get_mute_status` / `qq_set_mute`                      | `GET`/`POST /v2/groups/{id}/restrict_chat_setting`     | Bot is a group admin; mute at most 30 days, 20 members per call                                                                                                                                    |
| `qq_list_join_approval_strategies`                        | `GET /v2/groups/join_approval_strategy`                | Bot-level, not per group                                                                                                                                                                           |
| `qq_create_join_approval_strategy`                        | `POST /v2/groups/join_approval_strategy`               | One of `group_openids` / `group_ids`; at most 20 strategies per bot                                                                                                                                |
| `qq_update_join_approval_strategy`                        | `PATCH .../join_approval_strategy/{id}`                | Group ids must use the form the strategy was created with                                                                                                                                          |
| `qq_delete_join_approval_strategy`                        | `DELETE .../join_approval_strategy/{id}`               | —                                                                                                                                                                                                  |
| `qq_execute_join_approval_strategy`                       | `POST .../join_approval_strategy/{id}/execute`         | Runs a full scan; asynchronous, about 10 minutes                                                                                                                                                   |
| `qq_set_join_approval_whitelist`                          | `POST .../join_approval_strategy/{id}/whitelist_users` | Up to 10,000 numbers per call, 100,000 per strategy                                                                                                                                                |
| `qq_list_group_members`                                   | `GET /v2/groups/{id}/members`                          | Reserved — invite-only on the platform, up to 30 members per page                                                                                                                                  |
| `qq_get_group_member`                                     | `GET /v2/groups/{id}/members/{member_openid}`          | Reserved — invite-only                                                                                                                                                                             |
| `qq_kick_member`                                          | `POST /v2/groups/{id}/batch_remove_members`            | Reserved — invite-only, up to 20 members, optional blacklist                                                                                                                                       |
| `qq_list_member_blacklist` / `qq_update_member_blacklist` | `GET`/`POST /v2/groups/{id}/member_blacklist`          | Reserved — invite-only; a member still in the group cannot be blacklisted                                                                                                                          |

"Reserved" tools are wired and callable, but the QQ open platform currently answers `11253` unless the bot app has been allowlisted, so the agent reports the platform's refusal instead of assuming success. Every tool reports the platform's error code and what it means, so the agent can tell "the bot is not a group admin" from "the message can no longer be recalled" from "this app is not allowed to call this endpoint".

For a group action to reach a member's message by name, the channel remembers the last inbound messages per chat. `moderationRecallWindowMs` bounds how long an entry is kept, and it defaults to `-1` (no time limit), so an entry stays resolvable until the per-chat cap or the 256-chat sweep evicts it; a restart drops the memory entirely, and there is nothing to recall by member until new messages arrive. It also only holds messages the gateway actually delivered: with `groupAllPolicy` unset the bot receives only @-mentions (and direct messages), so member-targeted recall can only reach an ordinary member's **non-@** message when `groupAllPolicy` is `"keyword"`, `"all"`, or `"log"`; @-mentions the gateway delivers are tracked either way. The model can only name a member by full `member_openid` when `allowMention` is enabled (the default): with `allowMention: false` the transcript carries a truncated sender name instead, so only an explicit `message_id` works. A `member_openid` recall is allowed only for the turn's own sender, or on a turn with no member sender (for example an operator-initiated turn), so one member cannot censor another's message through the bot's admin token. Every call must name a target: `member_openid` recalls that member's most recent tracked message, `message_id` recalls an explicit id. There is no implicit target, and the tool never recalls the bot's own messages — so a direct chat, where the platform recalls only those, is unsupported. A successful recall reports the message id it destroyed and drops that id from the per-chat ring, so a second member-targeted recall reaches the previous message instead of retrying a destroyed one; a failed recall keeps the entry so the same target can be retried.

Each channel instance owns its tools: one bridge can serve several channels, and a tool is only offered to sessions of the channel that registered it, so two QQ channels in one process never act on each other's chats or credentials.

## Outbound Media

With `fileTools: true`, the channel exposes four outbound tools to the agent: `qq_send_file` sends a downloadable file card, `qq_send_image` sends a PNG or JPEG as an image message, `qq_send_video` sends an MP4 as a playable video, and `qq_send_voice` sends a SILK, MP3, WAV, or OGG recording as a voice bar. The model passes an absolute local path. The switch is off by default, because the tools hand a local file to QQ under the bot's own identity.

Every tool uses the same boundary: the path must resolve inside the session's workspace or the system temporary directory — a symlink out of the workspace is resolved first and refused, a file with more than one hard link is refused, and where the platform exposes `/proc/self/fd` the opened descriptor is re-resolved so a directory swapped between the check and the open is caught — and the file must be a non-empty regular file. `qq_send_file` accepts any format up to 20 MiB, keeping the repository's outbound cap so the file stays in memory and the exposure stays bounded. The media tools cap at the platform's soft limits: an image at 20 MB, a video at 30 MB, and a voice message at 20 MB.

The media tools check the bytes, not the file name. A file whose magic bytes do not match the tool's format list is refused before any upload, and the model is told to use `qq_send_file` instead, which sends it as a file card. The same happens above a soft limit: the platform would otherwise quietly downgrade an over-limit image, video, or voice upload to a file card, and the tool would report success for a different visible outcome. Accepted formats are `png`/`jpg` for images, `mp4` for videos, and `silk`/`mp3`/`wav`/`ogg` for voice messages.

Every upload goes up through the platform's chunked path (`upload_prepare` → PUT each part → `upload_part_finish` → merge), which is the only path that fits a local file: the URL form needs a public origin the bot does not have, and the binary form stops at 5 MB. A transient `40093001` on a part is retried; `40093002` (the chat's daily file-sending limit) is reported as permanent. A rejected send is never replaced by a text message, because that would read as success while the user never received the media.

The upload is followed by a `msg_type=7` send that reuses the text path's reply anchor and `msg_seq` counter, so media sent mid-turn stays in the same reply chain as that turn's text and cannot replay a `(msg_id, msg_seq)` pair the platform dedupes. The channel anchors a reply for 5 minutes in every chat type — the platform allows 60 minutes for a direct chat, but the channel's own anchor expires first, so a long turn can fall out of the reply window and the media is then sent as an active message. When a group admin has turned active messages off and that window has closed, the tool reports the refusal instead of dropping the media.

Each channel instance owns its tools: one bridge can serve several channels, and the outbound tools are only offered to sessions of the channel that registered them.

## Markdown Support

The QQ Bot channel supports Markdown formatting (`msg_type=2`). The agent's Markdown responses are sent as-is, and QQ renders them with rich formatting (bold, italic, code blocks, links, lists).

If the QQ server rejects a Markdown message for any reason, the channel automatically retries it as plain text — so your messages always go through even if the bot's Markdown capability is restricted server-side.

This is the opposite of the WeChat channel, which strips all Markdown. You can let the agent use full Markdown with the QQ channel.

## Images, Videos, and Files

Users can send images, videos, files, and voice messages to the bot. An image is passed to the agent as vision input, so the agent sees the picture itself — screenshots, error messages, and diagrams all work — and the same file is also saved to a temporary local path for the case where the model cannot take images. A video, a file, or a voice message is saved to a temporary local path and the agent is told that path.

A media message does not need any text — an image-only, video-only, file-only, or voice-only message starts a turn, and the channel uses `(image)`, `(video)`, `(file)`, or `(voice)` as the placeholder. When the message does carry text, that text is kept as the caption.

A file is anything the platform delivers as `content_type: file` — Word documents, PDFs, spreadsheets, archives, source files. QQ reports no MIME type for a file, so the channel keeps the sender's own extension (restricted to letters and digits, falling back to `.bin` when there is none) and saves the bytes under `channel-files/<uuid>/` in the system temporary directory; the agent's read tool uses that extension to decide how to open the document.

A voice message arrives as `content_type: voice`. Alongside the original SILK URL, QQ provides `voice_wav_url` — the same audio already converted to WAV — and the channel prefers it; when the platform does not send one, the channel falls back to the original URL. The bytes are saved under `channel-files/<uuid>/` as `qq_voice.wav`, or `qq_voice.silk` when the original SILK URL was used, and the agent is told that path. The platform's ASR text is not used; the agent works from the saved audio file.

- Images are limited to 8 MB and videos, files, and voice messages to 20 MB, and at most five attachments per message are handled. Anything larger is skipped and logged to the channel's stderr.
- Downloaded files are not deleted. They stay under the system temporary directory, which the system clears on its own schedule.

Image input requires a model that accepts images. Declare the capability when the model is multimodal but not recognised by name. The field belongs on the provider entry that serves the model, because a top-level `model.generationConfig` value is ignored for provider-backed models:

```json
{
  "modelProviders": {
    "openai": [
      {
        "id": "your-model-id",
        "baseUrl": "https://example.invalid/v1",
        "generationConfig": {
          "modalities": { "image": true }
        }
      }
    ]
  }
}
```

With a text-only model the agent receives an "unsupported image" note plus the saved path instead of the picture.

Sending media back to QQ is supported through the opt-in outbound tools — see [Outbound Media](#outbound-media).

## Token Management

Access tokens expire after approximately 2 hours. The channel automatically refreshes them at 80% of their TTL (typically ~1.6 hours). If a refresh fails, it retries after 60 seconds.

Token refresh continues across WebSocket reconnects — the channel never goes offline due to an expired token as long as the AppID and AppSecret remain valid.

## Connection Resilience

- **Auto-reconnect:** On WebSocket disconnect, the channel retries with exponential backoff (up to 20 attempts, max 30 seconds between retries)
- **Session resume:** If the WebSocket drops briefly, the channel uses QQ's `RESUME` opcode to restore the session without losing in-flight messages
- **Cross-server context continuation:** Chat sessions and routing state are persisted to disk. If the daemon restarts, conversations continue from where they left off
- **Heartbeat monitoring:** HEARTBEAT_ACK timeouts are detected and force a reconnection to avoid zombie connections
- **Message deduplication:** Replayed messages after a reconnect are detected and skipped

## Tips

- **Use Markdown freely** — Unlike WeChat, QQ renders Markdown natively. Bold, code blocks, lists, and links all work.
- **Keep responses under 2000 characters** — Longer responses are automatically split into chunks. Adding a length hint to your instructions helps the agent stay concise.
- **Sandbox for testing** — Set `"sandbox": true` to use the sandbox API during development. No production messages will be affected.
- **Restrict access** — Use `privatePolicy: "allowlist"` for a fixed set of QQ users, or `"pairing"` to approve new users from the CLI. See [DM Pairing](./overview#dm-pairing) for details.

## Key Differences from Telegram

| Area             | QQ Bot                                      | Telegram                                      |
| ---------------- | ------------------------------------------- | --------------------------------------------- |
| Authentication   | QR code login or AppID/AppSecret            | Static bot token from BotFather               |
| Markdown         | Native QQ Markdown with plaintext fallback  | HTML-formatted from agent Markdown            |
| Token lifecycle  | 2h TTL, auto-refresh at 80%                 | Permanent bot token                           |
| Group messages   | Only @mention messages are delivered to bot | Bot sees all messages (with privacy mode off) |
| Typing indicator | Not available (QQ API limitation)           | "Working..." message                          |
| Sandbox mode     | Supported for testing                       | Not available                                 |

## Troubleshooting

### Bot doesn't respond

- Check the terminal output for errors
- Verify the channel is running (`qwen channel status`)
- If using `privatePolicy: "allowlist"`, make sure your QQ user ID is in `allowedUsers`
- On first start, a QR code will appear in the terminal — scan it with your QQ app

### Bot doesn't respond in groups

- Check that `groupPolicy` is set to `"allowlist"`, `"pairing"`, or `"open"` (default is `"disabled"`)
- If using `"pairing"`, verify the group's pairing request has been approved
- **You must @mention the bot** — QQ only delivers messages that tag the bot
- Verify the bot has been added to the group

### QR code login is stuck

- The QR code is displayed in the terminal. Scan it with your QQ mobile app (Me → Scan)
- If the QR code expires (typically after a few minutes), restart the channel to get a new one

### Markdown messages appear as plain text

- The QQ server may have rejected the Markdown message and the channel silently fell back to plain text. Check the terminal for `"Markdown rejected"` log messages
- This is unusual on the QQ Bot Open Platform but can happen if the bot's Markdown capability is restricted server-side

### Token expired after long downtime

- If the channel is offline for more than 2 hours, the access token will have expired. The channel fetches a fresh token on reconnect — no action needed
- If the AppSecret itself is invalid (e.g., rotated in the developer portal), update the `appSecret` field or delete `~/.qwen/channels/<name>-credentials.json` to re-trigger QR code login
