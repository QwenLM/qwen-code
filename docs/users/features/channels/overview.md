# Channels

Channels let you interact with a Qwen Code agent from messaging platforms like Telegram, WeChat, QQ, DingTalk, WeCom, Feishu, or from code hosting platforms like GitHub, GitLab, and Gitea, instead of the terminal. You send messages from your phone or desktop chat app, and the agent responds just like it would in the CLI.

## How It Works

When you run `qwen channel start`, Qwen Code:

1. Reads channel configurations from your `settings.json`
2. Spawns a single agent process using the [Agent Client Protocol (ACP)](../../../developers/architecture.md)
3. Connects to each messaging platform and starts listening for messages
4. Routes incoming messages to the agent and sends responses back to the correct chat

All channels share one agent process with isolated sessions per user. Each channel can have its own working directory, model, and instructions.

## Quick Start

1. Set up a bot on your messaging platform (see channel-specific guides: [Telegram](./telegram), [WeChat](./weixin), [QQ Bot](./qqbot), [DingTalk](./dingtalk), [WeCom](./wecom), [Feishu](./feishu), [GitHub](./github), [GitLab](./gitlab), [Gitea](./gitea))
2. Add the channel configuration to `~/.qwen/settings.json`
3. Run `qwen channel start` to start all channels, or `qwen channel start <name>` for a single channel

Want to connect a platform that isn't built in? See [Plugins](./plugins) to add a custom adapter as an extension.

## Configuration

Channels are configured under the `channels` key in `settings.json`. Each channel has a name and a set of options:

```json
{
  "channels": {
    "my-channel": {
      "type": "telegram",
      "token": "$MY_BOT_TOKEN",
      "senderPolicy": "allowlist",
      "allowedUsers": ["123456789"],
      "sessionScope": "user",
      "cwd": "/path/to/working/directory",
      "instructions": "Optional system instructions for the agent.",
      "groupPolicy": "disabled",
      "dmPolicy": "open",
      "groups": {
        "*": { "requireMention": true }
      }
    }
  }
}
```

### Options

| Option                   | Required                        | Description                                                                                                                                                                                                            |
| ------------------------ | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`                   | Yes                             | Channel type: `telegram`, `weixin`, `qq`, `dingtalk`, `wecom`, `feishu`, `github`, `gitlab`, `gitea`, or a custom type from an extension (see [Plugins](./plugins))                                                    |
| `token`                  | Telegram, GitHub, GitLab, Gitea | Bot token (Telegram) or API token (GitHub/GitLab/Gitea). Supports `$ENV_VAR` syntax to read from environment variables. Not needed for WeChat, DingTalk, WeCom, or Feishu                                              |
| `clientId`               | DingTalk, Feishu                | DingTalk AppKey or Feishu App ID. Supports `$ENV_VAR` syntax                                                                                                                                                           |
| `clientSecret`           | DingTalk, Feishu                | DingTalk AppSecret or Feishu App Secret. Supports `$ENV_VAR` syntax                                                                                                                                                    |
| `botId`                  | WeCom                           | WeCom intelligent robot Bot ID. Supports `$ENV_VAR` syntax. See [WeCom](./wecom)                                                                                                                                       |
| `secret`                 | WeCom                           | WeCom intelligent robot Secret. Supports `$ENV_VAR` syntax. See [WeCom](./wecom)                                                                                                                                       |
| `baseUrl`                | GitHub, GitLab, Gitea           | Base URL for the API. GitHub defaults to `https://api.github.com`; GitLab defaults to `https://gitlab.com`; Gitea defaults to `https://gitea.com`. Use for GitHub Enterprise, self-hosted GitLab, or self-hosted Gitea |
| `pollInterval`           | GitHub, GitLab, Gitea           | Poll interval in milliseconds. Defaults to `60000` (60 seconds). See [Polling Channels](#polling-channels)                                                                                                             |
| `model`                  | No                              | Model to use for this channel (e.g., `qwen3.5-plus`). Overrides the default model. Useful for multimodal models that support image input                                                                               |
| `senderPolicy`           | No                              | Who can talk to the bot: `allowlist` (default), `open`, or `pairing`                                                                                                                                                   |
| `allowedUsers`           | No                              | List of user IDs allowed to use the bot (used by `allowlist` and `pairing` policies)                                                                                                                                   |
| `sessionScope`           | No                              | How sessions are scoped: `user` (default), `thread`, or `single`                                                                                                                                                       |
| `cwd`                    | No                              | Working directory for the agent. Defaults to the current directory                                                                                                                                                     |
| `instructions`           | No                              | Custom instructions prepended to the first message of each session                                                                                                                                                     |
| `groupPolicy`            | No                              | Group chat access: `disabled` (default), `allowlist`, or `open`. See [Group Chats](#group-chats)                                                                                                                       |
| `dmPolicy`               | No                              | Private/DM access: `open` (default) or `disabled` (silently drop all DMs). Useful for group-only bots                                                                                                                  |
| `groupHistoryLimit`      | No                              | Opt-in group history backfill. `0` or omitted disables it. A positive number persists that many authorized, unmentioned group messages for the next bot mention/reply.                                                 |
| `groups`                 | No                              | Per-group settings. Keys are group chat IDs or `"*"` for defaults. See [Group Chats](#group-chats)                                                                                                                     |
| `dispatchMode`           | No                              | What happens when you send a message while the bot is busy: `steer` (default), `collect`, or `followup`. See [Dispatch Modes](#dispatch-modes)                                                                         |
| `blockStreaming`         | No                              | Progressive response delivery: `on` or `off` (default). See [Block Streaming](#block-streaming)                                                                                                                        |
| `blockStreamingChunk`    | No                              | Chunk size bounds: `{ "minChars": 400, "maxChars": 1000 }`. See [Block Streaming](#block-streaming)                                                                                                                    |
| `blockStreamingCoalesce` | No                              | Idle flush: `{ "idleMs": 1500 }`. See [Block Streaming](#block-streaming)                                                                                                                                              |

### Sender Policy

Controls who can interact with the bot:

- **`allowlist`** (default) — Only users listed in `allowedUsers` can send messages. Others are silently ignored.
- **`pairing`** — Unknown senders receive a pairing code. The bot operator approves them via CLI, and they're added to a persistent allowlist. Users in `allowedUsers` skip pairing entirely. See [DM Pairing](#dm-pairing) below.
- **`open`** — Anyone can send messages. Use with caution.

### Session Scope

Controls how conversation sessions are managed:

- **`user`** (default) — One session per user. All messages from the same user share a conversation.
- **`thread`** — One session per thread/topic. Useful for group chats with threads.
- **`single`** — One shared session for all users. Everyone shares the same conversation.

### Channel Memory

Channel memory stores durable context for one chat or thread. Entries have stable
IDs, so a list response can be used for deterministic follow-up operations.

- `记住：默认使用 staging 环境` is the deterministic form and saves exactly one
  scalar entry for the current chat or thread.
- To save several separate facts in one request, use a natural phrase routed
  through the classifier. For example:
  `请记住这三条约定：使用 staging；发布前测试；优先中文回复` creates entries
  that you can manage independently. Exact duplicate facts are skipped and
  reported without creating another entry. Requests containing credential-like
  text are rejected; remove secrets and save the non-sensitive facts separately.
- `查看记忆` lists entries and their stable IDs. Use `查看第 2 页记忆` to view
  a later page, `查看记忆 <id>` to view one entry, or a natural filtered
  request such as `只看中文偏好` to list the matching entries.
- `查看刚才那条记忆`, `把关于 staging 的记忆改成默认使用 production`, and
  `忘掉刚才那条` work when the natural reference resolves to exactly one entry.
  Natural updates and removals first show the proposed change. Confirm an
  update with `确认更新记忆` or `confirm memory update`, or a removal with
  `确认删除记忆` or `confirm memory removal`, within 60 seconds. Exact-ID
  updates and removals remain immediate and do not need confirmation.
- `清空记忆` starts the clear-all confirmation flow; `确认清空记忆` completes
  it.

When a natural inspect, update, or removal request matches multiple entries,
the bot returns the candidate IDs and previews without changing memory. There
is no pending selection for an ambiguous result: retry the request with one
exact ID, such as `忘掉 m-a31f0d82c7e4`. Exact-ID operations remain the
deterministic fast path. A natural request with no match reports that no entry
matched.

Pending update, removal, and clear confirmations apply only to the sender and
chat or thread that created them. A newer clear, natural update, or natural
removal proposal replaces an older pending one for that sender and target.
Pending confirmations are discarded when the channel process restarts.

The legacy slash aliases `/remember-channel`, `/channel-memory`, and
`/forget-channel` have been removed. They are no longer channel-memory
commands.

Channel memory follows the channel access gates. Any message accepted by
`senderPolicy`, `dmPolicy`, `groupPolicy`, group settings, pairing, and mention
requirements can read, write, update, or clear memory for that chat or thread.
Accepted members of the same group share that group's target store. Use
`allowlist` or `pairing` policies when group memory should be limited to trusted
senders.

Existing legacy `CHANNEL.md` memory is migrated automatically to structured
`CHANNEL.json` storage on the first mutation. Structured memory persists across
standalone channel and daemon-managed channel restarts, and is injected when a
fresh target-scoped session starts, including after `/clear`.

Memory remains keyed to the current chat or thread. It is not injected into a
`sessionScope: single` session, because that session is shared across the whole
channel rather than scoped to one target.

Channel memory does not automatically learn facts from normal conversation or
accept `第一个` as confirmation for an ambiguous natural reference. Use a clear
remember request and an exact entry ID when a natural reference is ambiguous.

### Token Security

Bot tokens should not be stored directly in `settings.json`. Instead, use environment variable references:

```json
{
  "token": "$TELEGRAM_BOT_TOKEN"
}
```

Set the actual token in your shell environment or in a `.env` file that gets loaded before running the channel.

## DM Pairing

When `senderPolicy` is set to `"pairing"`, unknown senders go through an approval flow:

1. An unknown user sends a message to the bot
2. The bot replies with an 8-character pairing code (e.g., `VEQDDWXJ`)
3. The user shares the code with you (the bot operator)
4. You approve them via CLI:

```bash
qwen channel pairing approve my-channel VEQDDWXJ
```

Once approved, the user's ID is saved to the channel's workspace-scoped allowlist (`~/.qwen/channels/<workspace-scope>/<name>-allowlist.json`) and all future messages go through normally. Pairing state is scoped per workspace, so two workspaces using the same channel name keep separate approvals.

### Pairing CLI Commands

```bash
# List pending pairing requests
qwen channel pairing list my-channel

# Approve a request by code
qwen channel pairing approve my-channel <CODE>
```

Run these from the channel's workspace directory (or pass `--cwd <dir>`) — pairing state is stored per workspace.

### Pairing Rules

- Codes are 8 characters, uppercase, using an unambiguous alphabet (no `0`/`O`/`1`/`I`)
- Codes expire after 1 hour
- Maximum 3 pending requests per channel at a time — additional requests are ignored until one expires or is approved
- Users listed in `allowedUsers` in `settings.json` always skip pairing
- Approved users are stored per workspace in `~/.qwen/channels/<workspace-scope>/<name>-allowlist.json` — treat this file as sensitive

## Group Chats

By default, the bot only works in direct messages. To enable group chat support, set `groupPolicy` to `"allowlist"` or `"open"`.

### Group Policy

Controls whether the bot participates in group chats at all:

- **`disabled`** (default) — The bot ignores all group messages. Safest option.
- **`allowlist`** — The bot only responds in groups explicitly listed in `groups` by chat ID. The `"*"` key provides default settings but does **not** act as a wildcard allow.
- **`open`** — The bot responds in all groups it's added to. Use with caution.

### Mention Gating

In groups, the bot requires an `@mention` or a reply to one of its messages by default. This prevents the bot from responding to every message in a group chat.

Configure per-group with the `groups` setting:

```json
{
  "groups": {
    "*": { "requireMention": true },
    "-100123456": { "requireMention": false }
  }
}
```

- **`"*"`** — Default settings for all groups. Only sets config defaults, not an allowlist entry.
- **Group chat ID** — Override settings for a specific group. Overrides `"*"` defaults.
- **`requireMention`** (default: `true`) — When `true`, the bot only responds to messages that @mention it or reply to one of its messages. When `false`, the bot responds to all messages (useful for dedicated task groups).

### Group History Backfill

By default, Qwen ignores unmentioned group messages and does not store them as session turns. To let the next `@mention` include recent group context, set `groupHistoryLimit` to a positive number.

```json
{
  "channels": {
    "my-dingtalk": {
      "type": "dingtalk",
      "clientId": "$DINGTALK_CLIENT_ID",
      "clientSecret": "$DINGTALK_CLIENT_SECRET",
      "groupPolicy": "open",
      "groupHistoryLimit": 50,
      "groups": {
        "*": { "requireMention": true },
        "sensitive-group-id": {
          "requireMention": true,
          "groupHistoryLimit": 0
        }
      }
    }
  }
}
```

- Omitted or `0` disables backfill.
- Group-level `groupHistoryLimit` overrides the channel-level value.
- Only messages from authorized senders are persisted.
- Messages rejected by `groupPolicy` or group allowlist are not persisted.
- Pending group history is stored as local JSONL under `~/.qwen/channels/<channel-name>-group-history.jsonl` or `$QWEN_HOME/channels/<channel-name>-group-history.jsonl`.
- Cached messages are injected as untrusted context on the next real trigger and are not written as standalone session turns.

### How group messages are evaluated

```
1. groupPolicy — is this group allowed?           (no → ignore)
2. dmPolicy  — is this DM allowed?               (disabled → ignore)
3. requireMention — was the bot mentioned/replied to? (no → ignore)
4. senderPolicy — is this sender approved?         (no → pairing flow)
5. Route to session
```

### Telegram Setup for Groups

1. Add the bot to a group
2. **Disable privacy mode** in BotFather (`/mybots` → Bot Settings → Group Privacy → Turn Off) — otherwise the bot won't see non-command messages
3. **Remove and re-add the bot** to the group after changing privacy mode (Telegram caches this setting)

### Finding a Group Chat ID

To find a group's chat ID for the `groups` allowlist:

1. Stop the bot if it's running
2. Send a message mentioning the bot in the group
3. Use the Telegram Bot API to check queued updates:

```bash
curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates" | python3 -m json.tool
```

Look for `message.chat.id` in the response — group IDs are negative numbers (e.g., `-5170296765`).

## Media Support

Channels support sending images and files to the agent, not just text.

### Images

Send a photo to the bot and the agent will see it — useful for sharing screenshots, error messages, or diagrams. The image is sent directly to the model as a vision input.

To use image support, configure a multimodal model for the channel:

```json
{
  "channels": {
    "my-channel": {
      "type": "telegram",
      "model": "qwen3.5-plus",
      ...
    }
  }
}
```

### Files

Send a document (PDF, code file, text file, etc.) to the bot. The file is downloaded and saved to a temporary directory, and the agent is told the file path so it can read the contents using its file-reading tools.

Files work with any model — no multimodal support required.

### Platform differences

| Feature  | Telegram                                     | WeChat                           | DingTalk                                      | Feishu                                                      |
| -------- | -------------------------------------------- | -------------------------------- | --------------------------------------------- | ----------------------------------------------------------- |
| Images   | Direct download via Bot API                  | CDN download with AES decryption | downloadCode API (two-step)                   | Open API resources endpoint (authenticated GET, 50MB limit) |
| Files    | Direct download via Bot API (20MB limit)     | CDN download with AES decryption | downloadCode API (two-step)                   | Open API resources endpoint (50MB limit)                    |
| Captions | Photo/file captions included as message text | Not applicable                   | Rich text: mixed text + images in one message | Rich text (`post`): text extracted; embedded images ignored |

> QQ Bot does not process incoming media — image and sticker messages are ignored, so it has no media-handling row above. GitHub, GitLab, and Gitea channels receive issue/PR body text and comment text but do not process attached files or images.
>
> WeCom accepts text, images, mixed text plus images, files, videos, and voice messages (transcribed). Images are passed to the agent as attachments; files and videos are downloaded to temporary local paths. See [WeCom](./wecom#images-and-files) for details.

## Dispatch Modes

Controls what happens when you send a new message while the bot is still processing a previous one.

- **`steer`** (default) — The bot cancels the current request and starts working on your new message. Best for normal chat, where a follow-up usually means you want to correct or redirect the bot.
- **`collect`** — Your new messages are buffered. When the current request finishes, all buffered messages are combined into a single follow-up prompt. Good for async workflows where you want to queue up thoughts.
- **`followup`** — Each message is queued and processed as its own separate turn, in order. Useful for batch workflows where each message is independent.

```json
{
  "channels": {
    "my-channel": {
      "type": "telegram",
      "dispatchMode": "steer",
      ...
    }
  }
}
```

You can also set dispatch mode per group, overriding the channel default:

```json
{
  "groups": {
    "*": { "requireMention": true, "dispatchMode": "steer" },
    "-100123456": { "dispatchMode": "collect" }
  }
}
```

## Block Streaming

By default, the agent works for a while and then sends one large response. With block streaming enabled, the response arrives as multiple shorter messages while the agent is still working — similar to how ChatGPT or Claude show progressive output.

```json
{
  "channels": {
    "my-channel": {
      "type": "telegram",
      "blockStreaming": "on",
      "blockStreamingChunk": { "minChars": 400, "maxChars": 1000 },
      "blockStreamingCoalesce": { "idleMs": 1500 },
      ...
    }
  }
}
```

### How it works

- The agent's response is split into blocks at paragraph boundaries and sent as separate messages
- `minChars` (default 400) — don't send a block until it's at least this long, to avoid spamming tiny messages
- `maxChars` (default 1000) — if a block gets this long without a natural break, send it anyway
- `idleMs` (default 1500) — if the agent pauses (e.g., running a tool), send what's buffered so far
- When the agent finishes, any remaining text is sent immediately

Only `blockStreaming` is required. The chunk and coalesce settings are optional and have sensible defaults.

## Polling Channels

GitHub, GitLab, and Gitea channels work differently from the messaging-platform channels. Instead of receiving messages in real time through webhooks or long-poll connections, they **poll** the platform's notification API at a regular interval (default: 60 seconds) and treat each notification as an inbound message.

### How Polling Channels Work

1. The adapter polls the platform's notification/todo API on a fixed interval
2. Each notification is converted into a message envelope with a `chatId` (the repository) and a `threadId` (the issue or pull request)
3. The agent processes the notification and posts its response as a comment on the issue or pull request
4. Processed notifications are marked as read (GitHub/Gitea) or dismissed (GitLab)
5. A **poll cursor** is persisted to `~/.qwen/channels/` so the adapter resumes from where it left off after a restart

### Session Model

Polling channels use a repository-per-chat, issue-per-thread model:

- **`chatId`** — the repository path (e.g., `owner/repo`)
- **`threadId`** — the issue or pull/merge request (e.g., `issue:42`, `pr:17` for GitHub/Gitea, or `mr:17` for GitLab)
- **`sessionScope: thread`** is the natural fit — each issue or pull request gets its own session

### Proactive Responses

Polling channels support proactive sends: the agent can create new issues or post comments on existing issues/pull requests without an inbound notification. This is used for follow-up work, status updates, or review comments.

### Configuration Example

```json
{
  "channels": {
    "my-github": {
      "type": "github",
      "token": "$GITHUB_TOKEN",
      "sessionScope": "thread",
      "cwd": "/path/to/repo",
      "pollInterval": 30000
    }
  }
}
```

See the channel-specific guides for details: [GitHub](./github), [GitLab](./gitlab), [Gitea](./gitea).

## Slash Commands

Channels support slash commands. These are handled locally (no agent round-trip):

- `/help` — List available commands
- `/clear` — Clear your session and start fresh (aliases: `/reset`, `/new`)
- `/status` — Show session info and access policy

All other slash commands (e.g., `/compress`, `/summary`) are forwarded to the agent.

These commands work on all channel types (Telegram, WeChat, QQ, DingTalk, WeCom, Feishu, GitHub, GitLab, Gitea).

## Running

```bash
# Start all configured channels (shared agent process)
qwen channel start

# Start a single channel
qwen channel start my-channel

# Check if the service is running
qwen channel status

# Stop the running service
qwen channel stop
```

The bot runs in the foreground. Press `Ctrl+C` to stop, or use `qwen channel stop` from another terminal.

### Experimental Daemon-Managed Mode

You can also run configured channels under `qwen serve`:

```bash
# Start one channel under the daemon lifecycle
qwen serve --channel my-channel

# Start all configured channels
qwen serve --channel all

# Or enable channels later on a token-protected daemon
QWEN_SERVER_TOKEN=secret qwen serve
qwen channel set my-channel --token secret

# Query or stop the daemon-managed selection
qwen channel status --daemon-url http://127.0.0.1:4170 --token secret
qwen channel stop --daemon-url http://127.0.0.1:4170 --token secret
```

This mode starts workspace-grouped channel worker processes owned by `qwen serve`. Workers connect back to the daemon through the SDK and use the same channel adapters. They are separate from the daemon process, so a channel adapter crash does not crash the daemon. A daemon started without `--channel` does not load channel adapters or reserve the channel-service PID lease until the first `qwen channel set`.

`qwen serve --channel` is not the same service as `qwen channel start`. Standalone `qwen channel start` still uses the ACP-backed channel service and can run channel configs with different `cwd` values. Daemon-managed channels require every selected channel's `cwd` to resolve to a workspace registered by the daemon. In multi-workspace mode, a selection replacement keeps workers for workspaces whose ordered channel list did not change; `all` remains primary-workspace-only.

Without `--daemon-url`, `qwen channel status` and `qwen channel stop` retain standalone pidfile behavior. Their `--daemon-url` variants query or stop the daemon manager. Runtime selections are not written to settings and do not survive daemon restart. If a ready worker exits unexpectedly, the daemon continues running and reports a channel-worker warning in `/daemon/status`.

## Webhook-triggered tasks

Daemon-managed channels can also accept authenticated webhook events. Qwen receives the event as context, summarizes and decides what matters, and then delivers the final response to the configured chat target. This is not a raw notification relay.
Webhook tasks require `approvalMode: "yolo"` because they run without interactive approval. That setting applies to the whole channel, not only webhook turns, so use a dedicated webhook channel or tightly restrict normal chat senders for that channel.

Example channel config:

```json
{
  "channels": {
    "dingtalk-main": {
      "type": "dingtalk",
      "clientId": "$DINGTALK_CLIENT_ID",
      "clientSecret": "$DINGTALK_CLIENT_SECRET",
      "cwd": "/repo",
      "senderPolicy": "allowlist",
      "allowedUsers": ["12345"],
      "approvalMode": "yolo",
      "sessionScope": "user",
      "webhooks": {
        "sources": {
          "github-ci": {
            "secretEnv": "QWEN_CHANNEL_GITHUB_CI_SECRET",
            "targets": {
              "operator": {
                "chatId": "DINGTALK_USER_ID",
                "senderId": "webhook:github-ci",
                "isGroup": false
              },
              "team": {
                "chatId": "OPEN_CONVERSATION_ID",
                "senderId": "webhook:github-ci",
                "isGroup": true
              }
            }
          }
        }
      }
    }
  }
}
```

For DingTalk, set `isGroup` explicitly on every target. A direct-message target uses the DingTalk user ID as `chatId` with `isGroup: false`; a group target uses the group `openConversationId` with `isGroup: true`. Other adapters may require their own proactive target shape.

Daemon-managed DingTalk, Feishu, Telegram, and WeCom channels dynamically observe contacts from authorized inbound messages. List contacts observed in the primary workspace during the default seven-day freshness window:

```bash
curl -H "Authorization: Bearer $QWEN_SERVER_TOKEN" \
  http://127.0.0.1:4170/workspace/channel/observed-contacts
```

Use `GET /workspaces/:workspace/channel/observed-contacts` to select another registered, trusted workspace. Add `?freshWithinSeconds=N` to choose a window from one second through 365 days. The daemon advertises this API with the `workspace_channel_observed_contacts` capability.

The response returns complete platform IDs and labels. Group labels use names already present in accepted inbound messages when available: DingTalk supplies `conversationTitle`, and Telegram supplies `chat.title`. Feishu and WeCom group labels currently fall back to their complete IDs; no platform directory or group-detail API is queried. Topic labels also fall back to complete IDs. Each `lastObservedAt` is a canonical ISO 8601 UTC timestamp with millisecond precision; clients can convert it to the user's local time zone for display. Top-level `users` contains users observed in direct messages. `groups` contains observed group conversations, `groups[].users` contains users observed in each group, and `groups[].topics[].users` contains users observed in Feishu or Telegram topics:

```json
{
  "users": [
    {
      "channelName": "feishu-main",
      "label": "Example User",
      "id": "ou_complete_user_id",
      "lastObservedAt": "2026-07-17T08:00:00.000Z"
    }
  ],
  "groups": [
    {
      "channelName": "feishu-main",
      "label": "oc_complete_chat_id",
      "id": "oc_complete_chat_id",
      "lastObservedAt": "2026-07-17T08:05:00.000Z",
      "users": [
        {
          "label": "Example User",
          "id": "ou_complete_user_id",
          "lastObservedAt": "2026-07-17T08:05:00.000Z"
        }
      ],
      "topics": []
    }
  ]
}
```

These nested users are observed participants, not authoritative group membership. Only messages that pass direct/group, mention, sender, and pairing gates are recorded. Repeated observations refresh labels and timestamps; passive observation cannot detect a leave or deletion until the relationship becomes stale. Message content is never stored. The bounded registry lives under `$QWEN_HOME/channels/daemon/<workspaceHash>/observed-contacts.json`, outside the workspace checkout and partitioned per workspace. Its 500-observation limit is shared by all channels and conversations in that workspace, and observations older than 365 days are removed on the next accepted write. If the registry becomes malformed or uses an unsupported version, delete that file to reset it; accepted traffic recreates it. Webhook configuration and delivery are unchanged.

Start `qwen serve` with the channel worker enabled:

```bash
QWEN_SERVER_TOKEN="$QWEN_SERVER_TOKEN" qwen serve --require-auth --channel dingtalk-main
```

Example request:

```bash
curl -X POST "http://127.0.0.1:4170/channels/dingtalk-main/webhooks/github-ci" \
  -H "x-qwen-webhook-secret: $QWEN_CHANNEL_GITHUB_CI_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "eventType": "push",
    "targetRef": "operator",
    "title": "CI pipeline finished",
    "payload": {
      "targetRef": "refs/heads/main",
      "repository": "qwen-code",
      "status": "success"
    }
  }'
```

Webhook routes authenticate with the webhook secret header, even when `qwen serve` is running with bearer auth enabled. Do not share the daemon bearer token with webhook providers. Webhook config and `secretEnv` values are loaded when the daemon starts; restart `qwen serve` after changing webhook sources or rotating secrets. A `202 {"accepted": true}` response means the channel worker accepted ownership of the task, not that the final response has already been delivered to chat. Check daemon and channel worker logs, plus `/daemon/status`, when troubleshooting delivery failures.

### Multi-Channel Mode

When you run `qwen channel start` without a name, all channels defined in `settings.json` start together sharing a single agent process. Each channel maintains its own sessions — a Telegram user and a WeChat user get separate conversations, even though they share the same agent.

Each channel uses its own `cwd` from its config, so different channels can work on different projects simultaneously.

### Service Management

The channel service uses a PID file (`~/.qwen/channels/service.pid`) to track the running instance:

- **Duplicate prevention**: Running `qwen channel start` while a service is already running will show an error instead of starting a second instance
- **`qwen channel stop`**: Gracefully stops the running service from another terminal
- **`qwen channel status`**: Shows whether the service is running, its uptime, and session counts per channel

### Crash Recovery

If the agent process crashes unexpectedly, the channel service automatically restarts it and attempts to restore all active sessions. Users can continue their conversations without starting over.

- Sessions are persisted to `~/.qwen/channels/sessions.json` while the service is running
- On crash: the agent restarts within 3 seconds and reloads saved sessions
- After 3 consecutive crashes, the service exits with an error
- On clean shutdown (Ctrl+C or `qwen channel stop`): session data is cleared — the next start is always fresh
