# WeChat (Weixin)

This guide covers setting up a Qwen Code channel on WeChat via the official iLink Bot API.

## Prerequisites

- A WeChat account that can scan QR codes (mobile app)
- Access to the iLink Bot platform (WeChat's official bot API)

## Setup in Web Shell

The browser UI handles the whole flow, including the QR login — no terminal and
no hand-edited settings file.

1. Open **Channel settings** and pick **WeChat** from the available platforms.
2. In the editor's credentials section, the WeChat account panel shows whether
   you are logged in. Click **Log in with QR code**.
3. Scan the rendered QR code with WeChat and confirm on your phone. The panel
   advances from "Scan the QR code" to "Scanned" to "WeChat connected", and the
   daemon stores the credential for you.
4. Fill in the channel name, workspace, and access policy, then **Save**.
5. Start the channel from its card.

The panel also offers **Log in again** and **Log out**. If the QR expires, click
**Refresh QR code**. When the encoder cannot render a QR, the panel shows the
login URL as a link instead.

Two things to know:

- The account is **shared by every WeChat channel on this daemon**. Logging in
  again replaces it. Channels that are already running keep the previous account
  until you restart them.
- Saving a channel does not require being logged in. You can pre-configure it,
  but starting it does require a logged-in account.

If the panel says the daemon does not support WeChat login, update the daemon or
use the terminal path below.

## Setup from the terminal

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
      "privatePolicy": "pairing",
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
- **Restrict access** — Use `privatePolicy: "pairing"` or `"allowlist"` to control who can talk to the bot. See [DM Pairing](./overview#dm-pairing) for details.

## Troubleshooting

### "WeChat account not configured"

Run `qwen channel configure-weixin` to log in via QR code first.

### "Session expired (errcode -14)"

Your WeChat login session has expired. Stop the channel and run `qwen channel configure-weixin` again.

### Bot doesn't respond

- Check the terminal output for errors
- Verify the channel is running (`qwen channel start my-weixin`)
- If using `privatePolicy: "allowlist"`, make sure your WeChat user ID is in `allowedUsers`

### Images not working

- Make sure your channel config has a `model` that supports vision (e.g., `qwen3.5-plus`)
- Check the terminal for CDN download errors — these may indicate a network issue
