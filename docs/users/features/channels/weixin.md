# WeChat (Weixin)

This guide covers setting up a Qwen Code channel on WeChat via the official iLink Bot API.

## Prerequisites

- A WeChat account that can scan QR codes (mobile app)
- Access to the iLink Bot platform (WeChat's official bot API)
- The WeChat ClawBot plugin enabled on that account. The login below authorizes
  the bot; the plugin is what gives you a conversation to talk to it in. See
  [Where to send messages](#where-to-send-messages) — this is the step most
  first-time setups miss.

## Setup in Web Shell

The browser UI handles the whole flow, including the QR login — no terminal and
no hand-edited settings file.

1. Open **Channel settings** and pick **WeChat** from the available platforms.
2. In the editor's credentials section, the WeChat account panel shows whether
   you are logged in. Click **Log in with QR code**.
3. Scan the rendered QR code with WeChat and confirm on your phone. The panel
   advances from "Scan the QR code" to "Scanned" to "WeChat connected", and the
   daemon stores the credential for you.
4. Fill in the channel name, workspace, and access policy, then **Save**. Leave
   the allowlist empty and approve senders under **Pending requests** instead —
   see [Who is allowed to talk to it](#who-is-allowed-to-talk-to-it).
5. Start the channel from its card.
6. Send a message in the 微信ClawBot conversation —
   [Where to send messages](#where-to-send-messages).

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

Then send it a message — see the next section for which conversation to use.

## Where to send messages

**Use the "微信ClawBot" conversation, not a direct message to a WeChat account.**

Scanning the QR code authorizes a bot for your account; it does not turn that account into a bot. After the plugin is active, a separate conversation named **微信ClawBot** appears in the chat list of the account that scanned the code. Open that conversation and send your message there. You should see a typing indicator ("...") while the agent processes, followed by the response.

Two consequences worth knowing before you test:

- **A direct message to the scanning account never reaches the channel.** It arrives in WeChat on your phone as an ordinary chat, and the channel sees nothing at all — no error, no log line, no pairing request. Every diagnostic looks healthy while nothing happens.
- **The bot is bound to the account that scanned.** Another person cannot reach it by messaging that account, and the bot cannot start a conversation on its own: you always send the first message.

If the 微信ClawBot conversation is missing, the plugin is not active yet. Per WeChat's [ClawBot documentation](https://developers.weixin.qq.com/doc/aispeech/knowledge/openapi/Clawbotrelated.html), the plugin is managed under WeChat's settings on the account that scanned the code, and it requires a recent WeChat version with OpenClaw installed on the device. Consult that page for the current version requirement and binding steps rather than a version number quoted here.

## Who is allowed to talk to it

Under the default `privatePolicy: "pairing"`, the first message from an unrecognized sender is **not passed to the agent**: the channel records a pairing request, replies with an 8-character pairing code, and drops the message itself. So a reply does arrive — just not an answer to what you asked. Approve the request, then **send another message**; approving does not replay the one that was dropped.

In the 微信ClawBot conversation you are the only sender, so the request you approve is the one your own first message created. See [DM Pairing](./overview#dm-pairing) for the full flow, including approving by code from the terminal.

`allowedUsers` pre-approves senders so they skip pairing. It matches the **platform user ID**, which looks like `oAbCd…@im.wechat` — not a WeChat name or handle. An entry that does not match is silently ignored, so a handle typed here looks configured but never takes effect.

The simplest path is to **leave `allowedUsers` empty** and approve people under **Pending requests** in the channel editor. An approval is persisted, so it survives restarts. If you do want to pre-fill the field, read the real ID from a pairing request rather than guessing it.

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

Work through these in order — the first two produce no error anywhere, so checking logs alone will not find them:

1. **Which conversation did you send to?** It must be 微信ClawBot, not a direct message to a WeChat account. See [Where to send messages](#where-to-send-messages).
2. **Did you approve a pairing request and then send a new message?** The message that triggered the request is dropped, and approving does not bring it back.
3. Verify the channel is running (`qwen channel status`, or `qwen channel start my-weixin`).
4. Check the terminal output for errors. `[weixin] Poll error` points at the upstream connection; `Session expired (errcode -14)` means you need to log in again.
5. If you pre-filled `allowedUsers`, confirm the entry is a platform user ID (`oAbCd…@im.wechat`) and not a WeChat handle. A non-matching entry is ignored without any warning.

**Telling "nothing arrived" apart from "arrived and was refused".** The channel journals inbound decisions to `<channel>-<hash>-channel-events.jsonl` under its state directory (`~/.qwen/channels/<workspace-scope>/`). If that file does not exist, no message has ever reached the channel — the cause is upstream of it, almost always the conversation you sent to. If it exists and holds `"outcome":"skipped"` with `"reason":"sender_pairing_required"`, the message arrived and is waiting for approval, and the record's `actor` field is the exact platform user ID to approve or allowlist.

### Images not working

- Make sure your channel config has a `model` that supports vision (e.g., `qwen3.5-plus`)
- Check the terminal for CDN download errors — these may indicate a network issue
