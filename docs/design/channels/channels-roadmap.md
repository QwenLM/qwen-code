# Channels Roadmap

## Implemented (MVP)

- **3 built-in channels** — Telegram, WeChat, DingTalk
- **Plugin system** — `ChannelBase` SDK with `connect`/`sendMessage`/`disconnect`, extension manifest, compiled JS + `.d.ts`
- **Access control** — `allowlist`, `pairing` (8-char codes, CLI approval), `open` policies
- **Group chat** — `open`/`disabled`/`allowlist` group policy, `requireMention` per group, reply-as-mention
- **Session routing** — `user`, `thread`, `single` scopes with per-channel `cwd`, `model`, `instructions`
- **Dispatch modes** — `steer` (default: cancel + re-prompt), `collect` (buffer + coalesce), `followup` (sequential queue). Per-channel and per-group config.
- **Working indicators** — centralized `onPromptStart`/`onPromptEnd` hooks. Telegram: typing bar. WeChat: typing API. DingTalk: 👀 emoji reaction.
- **Block streaming** — progressive multi-message delivery with paragraph-aware chunking
- **Streaming hooks** — `onResponseChunk`/`onResponseComplete` for plugins to implement progressive display
- **Media support** — images (vision input), files/audio/video (saved to temp, path in prompt), `Attachment` interface on `Envelope`
- **Slash commands** — `/help`, `/clear` (`/reset`, `/new`), `/status`, custom via `registerCommand()`
- **Service management** — `qwen channel start/stop/status`, PID tracking, crash recovery (auto-restart, session persistence)
- **Token security** — `$ENV_VAR` syntax in config

## Future Work

### Safety & Group Chat

- **Per-group tool restrictions** — `tools`/`toolsBySender` deny/allow lists per group
- **Group context history** — ring buffer of recent skipped messages, prepended on @mention
- **Regex mention patterns** — fallback `mentionPatterns` for unreliable @mention metadata
- **Per-group instructions** — `instructions` field on `GroupConfig` for per-group personas
- **`/activation` command** — runtime toggle for `requireMention`, persisted to disk

### Operational Tooling

- **`qwen channel doctor`** — config validation, env vars, bot tokens, network checks
- **`qwen channel status --probe`** — real connectivity checks per channel

### Platform Expansion

- **Discord** — Bot API + Gateway, servers/channels/DMs/threads
- **Slack** — Bolt SDK, Socket Mode, workspaces/channels/DMs/threads

### Multi-Agent

- **Multi-agent routing** — multiple agents with bindings per channel/group/user
- **Broadcast groups** — multiple agents respond to the same message

### Plugin Ecosystem

- **Community plugin template** — `create-qwen-channel` scaffolding tool
- **Plugin registry/discovery** — `qwen extensions search`, version compatibility

## Reference: OpenClaw Comparison

See [channels-comparison.md](channels-comparison.md) for the detailed feature comparison between OpenClaw and Qwen-Code channels.
