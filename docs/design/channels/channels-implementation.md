# Channels

Qwen Code supports three messaging channels — Telegram, WeChat, and DingTalk. All adapters extend the shared channel architecture (`ChannelBase`, `AcpBridge`, `SessionRouter`) in `packages/channels/base/src/`. Each channel can be started individually or all together with `node dist/cli.js channel start`.

---

## Telegram

Source: `packages/channels/telegram/src/TelegramAdapter.ts`, built on the Telegraf library.

The adapter supports plain text messaging, slash commands, a working indicator ("typing" chat action), DM pairing, and group chat (supergroups with @mention gating). Image receiving works via `bot.on('photo')` → `getFileLink` → download → base64, with captions passed as envelope text. File/document receiving saves downloaded files to `/tmp/channel-files/` and includes the path in the envelope so the agent can read them via `read-file` (works with any model, no multimodal required). Referenced messages include the quoted text as context in the prompt. Output is formatted as Telegram HTML (converted from markdown). Authentication uses a static bot token. Session persistence and pairing state are stored under `~/.qwen/channels/`.

```jsonc
// ~/.qwen/settings.json
{
  "channels": {
    "my-telegram": {
      "type": "telegram",
      "token": "$TELEGRAM_BOT_TOKEN",
      "senderPolicy": "pairing",
      "allowedUsers": [],
      "sessionScope": "user",
      "instructions": "Keep responses concise.",
    },
  },
}
```

```bash
source /home/andy/projects/telegram/.env
npm run bundle && node dist/cli.js channel start my-telegram
```

**Future work:** Streaming responses via in-place `editMessageText` (throttled at ~2s to respect rate limits, best-effort fallback to single message). Slash command polish — register with BotFather via `setMyCommands()`, fix `/help` timing, add `/status` command.

---

## WeChat (Weixin)

Source: `packages/channels/weixin/src/`, ported from the cc-weixin project. Uses the iLink Bot API at `ilinkai.weixin.qq.com`.

The adapter supports plain text messaging via a custom long-poll loop (`/ilink/bot/getupdates`, cursor-based), with `context_token` caching per user for reply context. Authentication uses QR code login (`qwen channel configure-weixin`), producing a bearer token stored in `~/.qwen/channels/weixin/account.json`. A typing indicator fires before each ACP prompt using the `sendTyping` API (ticket obtained from `getConfig`). Image and file/PDF receiving works through CDN download with AES-128-ECB decryption — images are forwarded as base64 content blocks, files are saved to `/tmp/channel-files/` and referenced by path. Referenced messages (user replies) include quoted text as context in the prompt. Formatting is plain text only (all markdown is stripped). The adapter handles session expiry (`errcode -14`) with automatic reconnection, uses backoff after consecutive errors, and persists the polling cursor to `~/.qwen/channels/weixin/cursor.txt` for crash recovery.

```jsonc
// ~/.qwen/settings.json
{
  "channels": {
    "my-weixin": {
      "type": "weixin",
      "senderPolicy": "pairing",
      "allowedUsers": [],
      "sessionScope": "user",
      "instructions": "Keep responses concise, plain text only.",
      "baseUrl": "https://ilinkai.weixin.qq.com", // optional override
    },
  },
}
```

Credentials are stored separately in `~/.qwen/channels/weixin/account.json`, created by `qwen channel configure-weixin`.

```bash
# First time: login via QR code
node dist/cli.js channel configure-weixin

# Start
npm run bundle && node dist/cli.js channel start my-weixin
```

**Future work:** Media send (upload to WeChat CDN with AES encryption). Voice/video receive. Streaming responses via `message_state: GENERATING` → `FINISH` (pending client-side investigation). Multi-account support. Message chunking for long responses.

---

## DingTalk (钉钉)

Source: `packages/channels/dingtalk/src/`, using Stream mode (WebSocket, no public IP required). Referenced from openclaw-channel-dingtalk.

The adapter connects via the `dingtalk-stream` SDK, which handles WebSocket connection, reconnection, heartbeats, and callback ACKs (DingTalk retries unACKed messages). Authentication reuses the SDK's built-in token (`client.getConfig().access_token`) from AppKey + AppSecret. Responses are sent back through a per-message `sessionWebhook` URL — a temporary, conversation-scoped endpoint that supports text, markdown, images, and files. Both DM and group chat are supported, with group messages gated by `@mention` detection (`isInAtList`). A 👀 emoji reaction serves as a working indicator while the agent processes (posted via the emotion API and recalled on completion). Output is formatted as DingTalk markdown, with tables converted to plain text, messages split at ~3800 characters, and code fences maintained across chunks. Image, file, audio, and video receiving works through a two-step download flow (`downloadCode` → `downloadUrl` → buffer); images are forwarded as base64, files saved to `/tmp/channel-files/`. Quoted message context is extracted from `text.repliedMsg` and `quoteMessage`, with bot-reply detection via `chatbotUserId`.

```jsonc
// ~/.qwen/settings.json
{
  "channels": {
    "my-dingtalk": {
      "type": "dingtalk",
      "clientId": "$DINGTALK_CLIENT_ID",
      "clientSecret": "$DINGTALK_CLIENT_SECRET",
      "senderPolicy": "open",
      "sessionScope": "user",
      "cwd": "/path/to/project",
      "instructions": "Keep responses concise. Use DingTalk markdown.",
      "groupPolicy": "open",
      "groups": {
        "*": { "requireMention": true },
      },
    },
  },
}
```

```bash
export DINGTALK_CLIENT_ID=<your-app-key>
export DINGTALK_CLIENT_SECRET=<your-app-secret>
npm run bundle && node dist/cli.js channel start my-dingtalk
```

**Future work:** Quoted bot responses (persisting outbound messages keyed by `processQueryKey` for lookup on reply). AI Card streaming via `/v1.0/card/instances` and `/v1.0/card/streaming` with graceful markdown fallback.
