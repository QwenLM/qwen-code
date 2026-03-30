# Channels Design

> External messaging integrations for Qwen Code — interact with an agent from Telegram, WeChat, and more.
>
> Channel-implementation status: `channels-implementation.md`. Testing: `channels-testing-guide.md`.

## Overview

A **channel** connects an external messaging platform to a Qwen Code agent. Configured in `settings.json`, managed via `qwen channel` subcommands, multi-user (each user gets an isolated ACP session).

## Architecture

```
┌──────────┐                        ┌─────────────────────────────────────┐
│ Telegram │    Platform API        │        Channel Service              │
│ User A   │◄──────────────────────►│                                     │
├──────────┤  (WebSocket/polling)   │  ┌───────────┐    ┌──────────────┐  │
│ WeChat   │◄──────────────────────►│  │ Platform   │    │  ACP Bridge  │  │
│ User B   │                        │  │ Adapter    │    │  (shared)    │  │
└──────────┘                        │  │            │    │              │  │
                                    │  │ - connect  │    │  - spawns    │  │
                                    │  │ - receive  │    │    qwen-code │  │
                                    │  │ - send     │    │  - manages   │  │
                                    │  │            │    │    sessions  │  │
                                    │  └─────┬──────┘    └──────┬───────┘  │
                                    │        │                  │          │
                                    │        ▼                  ▼          │
                                    │  ┌─────────────────────────────────┐ │
                                    │  │  SenderGate · GroupGate         │ │
                                    │  │  SessionRouter · ChannelBase    │ │
                                    │  └─────────────────────────────────┘ │
                                    └─────────────────────────────────────┘
                                                     │
                                                     │ stdio (ACP ndjson)
                                                     ▼
                                    ┌─────────────────────────────────────┐
                                    │        qwen-code --acp              │
                                    │   Session A (user andy, id: "abc")  │
                                    │   Session B (user bob,  id: "def")  │
                                    └─────────────────────────────────────┘
```

**Platform Adapter** — connects to external API, translates messages to/from Envelopes. **ACP Bridge** — spawns `qwen-code --acp`, manages sessions, emits `textChunk`/`toolCall`/`disconnected` events. **Session Router** — maps senders to ACP sessions via namespaced keys (`<channel>:<sender>`). **Sender Gate** / **Group Gate** — access control (allowlist / pairing / open) and mention gating. **Channel Base** — abstract base with Template Method pattern: plugins override `connect`, `sendMessage`, `disconnect`. **Channel Registry** — `Map<string, ChannelPlugin>` with collision detection.

### Envelope

Normalized message format all platforms convert to:

- **Identity**: `senderId`, `senderName`, `chatId`, `channelName`
- **Content**: `text`, optional `imageBase64`/`imageMimeType`, optional `referencedText`
- **Context**: `isGroup`, `isMentioned`, `isReplyToBot`, optional `threadId`

Plugin responsibilities: `senderId` must be stable/unique; `chatId` must distinguish DMs from groups; boolean flags must be accurate for gate logic; @mentions stripped from `text`.

### Message Flow

```
Inbound:  User message → Adapter → GroupGate → SenderGate → Slash commands → SessionRouter → AcpBridge → Agent
Outbound: Agent response → AcpBridge → SessionRouter → Adapter → User
```

Slash commands (`/clear`, `/help`, `/status`) are handled in ChannelBase before reaching the agent.

### Sessions

One `qwen-code --acp` process with multiple ACP sessions. Scope per channel: **`user`** (default), **`thread`**, or **`single`**. Routing keys namespaced as `<channelName>:<key>`.

### Error Handling

- **Connection failures** — logged; service continues if at least one channel connects
- **Bridge crashes** — exponential backoff (max 3 retries), `setBridge()` on all channels, session restore
- **Session serialization** — per-session promise chains prevent concurrent prompt collisions

## Plugin System

The architecture is extensible — new adapters (including third-party) can be added without modifying core. Built-in channels use the same plugin interface (dogfooding).

### Plugin Contract

A `ChannelPlugin` declares `channelType`, `displayName`, `requiredConfigFields`, and a `createChannel()` factory. Plugins implement three methods:

| Method                      | Responsibility                                    |
| --------------------------- | ------------------------------------------------- |
| `connect()`                 | Connect to platform and register message handlers |
| `sendMessage(chatId, text)` | Format and deliver agent response                 |
| `disconnect()`              | Clean up on shutdown                              |

On inbound messages, plugins build an `Envelope` and call `this.handleInbound(envelope)` — the base class handles the rest: access control, group gating, pairing, session routing, prompt serialization, slash commands, instructions injection, reply context, and crash recovery.

### Extension Points

- Custom slash commands via `registerCommand()`
- Working indicators by wrapping `handleInbound()` with typing/reaction display
- Tool call hooks via `onToolCall()`
- Media handling by attaching to Envelope before `handleInbound()`

### Discovery & Loading

External plugins are **extensions** managed by `ExtensionManager`, declared in `qwen-extension.json`:

```json
{
  "name": "my-channel-extension",
  "version": "1.0.0",
  "channels": {
    "my-platform": {
      "entry": "dist/index.js",
      "displayName": "My Platform Channel"
    }
  }
}
```

Loading sequence at `qwen channel start`: load settings → register built-ins → scan extensions → dynamic import + validate → register (reject collisions) → validate config → `createChannel()` → `connect()`.

Plugins run in-process (no sandbox), same trust model as npm dependencies.

## Configuration

```jsonc
{
  "channels": {
    "my-telegram": {
      "type": "telegram",
      "token": "$TELEGRAM_BOT_TOKEN", // env var reference
      "senderPolicy": "allowlist", // allowlist | pairing | open
      "allowedUsers": ["123456"],
      "sessionScope": "user", // user | thread | single
      "cwd": "/path/to/project",
      "model": "qwen3.5-plus",
      "instructions": "Keep responses short.",
      "groupPolicy": "disabled", // disabled | allowlist | open
      "groups": { "*": { "requireMention": true } },
    },
  },
}
```

Auth is plugin-specific: static token (Telegram), app credentials (DingTalk), QR code login (WeChat), proxy token (TMCP).

## CLI Commands

```bash
# Channels
qwen channel start [name]                     # start all or one channel
qwen channel stop                             # stop running service
qwen channel status                           # show channels, sessions, uptime
qwen channel pairing list <ch>                # pending pairing requests
qwen channel pairing approve <ch> <code>      # approve a request

# Extensions
qwen extensions install <path-or-package>     # install
qwen extensions link <local-path>             # symlink for dev
qwen extensions list                          # show installed
qwen extensions remove <name>                 # uninstall
```

## Package Structure

```
packages/channels/
├── base/                    # @qwen-code/channel-base
│   └── src/
│       ├── AcpBridge.ts     # ACP process lifecycle, session management
│       ├── SessionRouter.ts # sender ↔ session mapping, persistence
│       ├── SenderGate.ts    # allowlist / pairing / open
│       ├── GroupGate.ts     # group chat policy + mention gating
│       ├── PairingStore.ts  # pairing code generation + approval
│       ├── ChannelBase.ts   # abstract base: routing, slash commands
│       └── types.ts         # Envelope, ChannelConfig, etc.
├── telegram/                # @qwen-code/channel-telegram
├── weixin/                  # @qwen-code/channel-weixin
└── dingtalk/                # @qwen-code/channel-dingtalk
```

## What's Next

- **DingTalk: quoted bot responses** — persist outbound text keyed by `processQueryKey` (see `channels-dingtalk.md`)
- **Streaming responses** — edit messages in-place as chunks arrive
- **Structured logging** — pino; JSON by default, human-readable on TTY
- **E2E tests** — mock servers for platform APIs + mock ACP agent
- **Daemon mode** — background operation, systemd/launchd unit generation

## Known Limitations

- **Shared workspace conflicts** — multiple users editing the same `cwd` may cause file conflicts
- **Crash-recovery sessions only** — sessions persist for bridge restarts but cleared on clean shutdown
- **Sequential prompts per session** — messages queue within a session; different sessions run independently
- **Single instance** — PID file prevents duplicates; `qwen channel stop` first
- **Shared bridge model** — all channels share one ACP bridge process; if channels configure different models, only the first is used (warning shown)
