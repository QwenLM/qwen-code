# WeChat (Weixin)

This guide covers setting up a Qwen Code channel on WeChat via the official iLink Bot API.

## Prerequisites

- A WeChat account that can scan QR codes (mobile app)
- Access to the iLink Bot platform (WeChat's official bot API)

## Setup

### 1. Log in via QR code

WeChat uses QR code authentication instead of a static bot token. Run the login command:

```bash
qwen channel configure-weixin
```

This will display a QR code URL. Scan it with your WeChat mobile app to authenticate. Your credentials are saved to `~/.qwen/channels/weixin/account.json`.

### 2. Configure the channel

Add the channel to `~/.qwen/settings.json`:

```json
{
  "channels": {
    "my-weixin": {
      "type": "weixin",
      "senderPolicy": "pairing",
      "allowedUsers": [],
      "sessionScope": "user",
      "cwd": "/path/to/your/project",
      "model": "qwen3.5-plus",
      "instructions": "You are a concise coding assistant responding via WeChat. Keep responses under 500 characters. Use plain text only."
    }
  }
}
```

Note: WeChat channels do not use a `token` field — credentials come from the QR login step.

### Authenticate from a daemon client

If `qwen serve` advertises the `channel_auth` capability, a browser or SDK
client can start an auth session for a configured WeChat instance, render the
daemon-provided QR SVG, poll until the session is `ready`, and explicitly
commit it. The confirmed account remains only in daemon memory until Commit;
the session expires ten minutes after it starts. Cancelling it, removing its
workspace, shutting down the daemon, or allowing it to expire discards the
uncommitted account. Commit writes the account to that exact instance's
workspace-scoped daemon state and does not start or restart the channel. See
[Authenticate QQ and WeChat from a daemon client](../../qwen-serve#authenticate-qq-and-wechat-from-a-daemon-client)
for routes, SDK helpers, ownership, and QR response security.

Daemon startup does not normally read the standalone
`~/.qwen/channels/weixin/account.json` file (or the directory selected by
`WEIXIN_STATE_DIR`). It may use that singleton legacy account read-only only
when daemon metadata proves this is the primary trusted workspace and the
workspace's complete `channels` map contains exactly one configured WeChat
instance. Selecting one WeChat instance while another is configured does not
qualify, and secondary, untrusted, or ambiguous workspaces never fall back.
Scoped state takes precedence; missing or corrupt scoped state may use the
legacy account only with that proof. The legacy file is not deleted or
rewritten. A later successful browser Commit writes the scoped account, so the
credential is copied only after a successful save. The standalone
`qwen channel configure-weixin` and no-argument account lookup remain
unchanged.

### 3. Start the channel

```bash
# Start only the WeChat channel
qwen channel start my-weixin

# Or start all configured channels together
qwen channel start
```

Open WeChat and send a message to the bot. You should see a typing indicator ("...") while the agent processes, followed by the response.

## Images and Files

You can send photos and documents to the bot, not just text.

**Photos:** Send an image (screenshot, photo, etc.) and the agent will analyze it using its vision capabilities. This requires a multimodal model — add `"model": "qwen3.5-plus"` (or another vision-capable model) to your channel config. A typing indicator shows while the image is being downloaded and processed.

**Files:** Send a PDF, code file, or any document. The bot downloads and decrypts it from WeChat's CDN, saves it locally, and the agent reads it with its file tools. This works with any model.

## Configuration Options

WeChat channels support all the standard channel options (see [Channel Overview](./overview#options)), plus:

| Option    | Description                                                                    |
| --------- | ------------------------------------------------------------------------------ |
| `baseUrl` | Override the iLink Bot API base URL (default: `https://ilinkai.weixin.qq.com`) |

## Key Differences from Telegram

- **Authentication:** QR code login instead of a static bot token. Sessions can expire — the channel will pause and log a message if this happens.
- **Formatting:** WeChat only supports plain text. Markdown in agent responses is automatically stripped.
- **Typing indicator:** WeChat has a native "..." typing indicator instead of a "Working..." text message.
- **Groups:** WeChat iLink Bot is DM-only — group chats are not supported.
- **Media encryption:** Images and files are encrypted on WeChat's CDN with AES-128-ECB. The channel handles decryption transparently.

## Tips

- **Use plain text instructions** — Since WeChat strips all markdown, add instructions like "Use plain text only" to avoid the agent producing formatted responses that look messy.
- **Keep responses short** — WeChat message bubbles work best with concise text. Adding a character limit to your instructions helps (e.g., "Keep responses under 500 characters").
- **Session expiry** — If you see "Session expired (errcode -14)" in the logs, your WeChat login has expired. Stop the channel and re-run `qwen channel configure-weixin` to log in again.
- **Restrict access** — Use `senderPolicy: "pairing"` or `"allowlist"` to control who can talk to the bot. See [DM Pairing](./overview#dm-pairing) for details.

## Troubleshooting

### "WeChat account not configured"

Run `qwen channel configure-weixin` to log in via QR code first.
For a daemon-managed instance, use its browser auth session and Commit before
starting or restarting the instance.

### "Session expired (errcode -14)"

Your WeChat login session has expired. Stop the channel and run `qwen channel configure-weixin` again.

### Bot doesn't respond

- Check the terminal output for errors
- Verify the channel is running (`qwen channel start my-weixin`)
- If using `senderPolicy: "allowlist"`, make sure your WeChat user ID is in `allowedUsers`

### Images not working

- Make sure your channel config has a `model` that supports vision (e.g., `qwen3.5-plus`)
- Check the terminal for CDN download errors — these may indicate a network issue
