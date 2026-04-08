# Channels Testing Guide

How to test channel integrations end-to-end.

## Credentials

- Telegram bot: `@qwencod_test_1_bot` (远弟)
- Bot token env var: `TELEGRAM_BOT_TOKEN`
- Bot token file: `/path/to/telegram/.env`
- Telegram user ID: `<your-user-id>`
- WeChat credentials: `~/.qwen/channels/weixin/account.json`

## Before testing

**Important:** Stop any running service first. Duplicate instances cause duplicate responses.

```bash
# Stop the service if running
qwen channel stop

# Or check status first
qwen channel status

# If processes are stuck (e.g. from manual kill -9), clean up manually
pkill -9 -f "cli.js --acp"
pkill -9 -f "channel start"
rm -f ~/.qwen/channels/service.pid ~/.qwen/channels/sessions.json
```

## Sending messages via Bot API (no bot process needed)

```bash
# Source the token
export TELEGRAM_BOT_TOKEN=$(grep TELEGRAM_BOT_TOKEN /path/to/telegram/.env | cut -d= -f2)

# Send a message (replace YOUR_CHAT_ID with your Telegram user ID)
curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  -H "Content-Type: application/json" \
  -d '{"chat_id": "YOUR_CHAT_ID", "text": "Hello from the bot!"}'
```

## Starting channels

```bash
export TELEGRAM_BOT_TOKEN=$(grep TELEGRAM_BOT_TOKEN /path/to/telegram/.env | cut -d= -f2)
cd /path/to/qwen-code
npm run bundle

# Single channel
node dist/cli.js channel start my-telegram

# All channels (shared bridge)
node dist/cli.js channel start
```

Settings config: `~/.qwen/settings.json` under `channels.*`.

## Checking registered commands

```bash
curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMyCommands" | python3 -m json.tool
```

## Test scenarios

### 1. Slash commands (shared across all channels)

Start the service, then send on Telegram or WeChat:

| Command   | Expected                                                        |
| --------- | --------------------------------------------------------------- |
| `/help`   | List of all commands                                            |
| `/status` | "Session: none, Access: ..."                                    |
| `/clear`  | "No active session to clear." (or "Session cleared." if active) |
| `/reset`  | Same as `/clear` (alias)                                        |
| `/new`    | Same as `/clear` (alias)                                        |

### 2. Basic text round-trip

1. Start the bot
2. Send any text (e.g. "hello")
3. Bot should respond via the agent
4. `/status` should now show "Session: active"

### 3. Multi-turn conversation

1. Send "my name is Alice"
2. Send "what is my name?"
3. Agent should remember "Alice" from same session

### 4. Session clear

1. Have an active session (send a message first)
2. Send `/clear` (or `/reset` or `/new`)
3. Send "what is my name?"
4. Agent should NOT remember — fresh session

### 5. Tool calls (internal)

1. Send "list the files in /path/to/project"
2. Agent should use shell/ls internally and return file listing
3. Verify response contains actual file names

### 6. Markdown formatting

1. Send "write me a hello world in python with explanation"
2. Response should render with proper Telegram HTML formatting (bold, code blocks, etc.)

### 7. Multi-channel mode

1. Ensure both `my-telegram` and `my-weixin` are configured in `~/.qwen/settings.json`
2. For WeChat: run `node dist/cli.js channel configure-weixin` if token expired
3. Start all: `node dist/cli.js channel start`
4. Should show: `Starting 2 channel(s): my-weixin, my-telegram`
5. Send messages on both platforms — each should get exactly one response
6. Check `~/.qwen/channels/sessions.json` — each channel should have its own cwd

### 8. Crash recovery

1. Start multi-channel mode and send a message to create sessions
2. Find the ACP bridge PID: `ps --ppid <parent-pid> -o pid,args | grep acp`
3. Kill it: `kill -9 <acp-pid>`
4. Log should show: `Bridge crashed (1/3). Restarting in 3s...` then `Sessions restored: 2, failed: 0`
5. Send a message — should work, and session context (e.g. "what is my name?") should be preserved

### 9. Clean shutdown

1. Start channels, send a message to create sessions
2. Press Ctrl+C (or `qwen channel stop` from another terminal)
3. `~/.qwen/channels/sessions.json` should be deleted
4. `~/.qwen/channels/service.pid` should be deleted

### 10. Service management

1. Start service: `qwen channel start`
2. Check status from another terminal: `qwen channel status` — should show running, uptime, channels
3. Try starting again: `qwen channel start` — should fail with "already running" error
4. Stop from another terminal: `qwen channel stop` — should stop gracefully
5. Confirm stopped: `qwen channel status` — should show "No channel service is running."

### 11. Referenced messages (quoted replies)

1. Send a message and get a bot response
2. Reply to (quote) the bot's response with a follow-up question (e.g. "summarize that")
3. Agent should see the quoted text as context and respond accordingly
4. Test on both Telegram and WeChat

## Useful debug commands

```bash
# Check recent updates the bot received
curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?limit=5" | python3 -m json.tool

# Get bot info
curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe" | python3 -m json.tool
```
