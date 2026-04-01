# Custom Channel Plugins

You can extend the channel system with custom platform adapters packaged as [extensions](../../extension/introduction). This lets you connect Qwen Code to any messaging platform, webhook, or custom transport.

## How It Works

Channel plugins are loaded at startup from active extensions. When `qwen channel start` runs, it:

1. Scans all enabled extensions for `channels` entries in their `qwen-extension.json`
2. Dynamically imports each channel's entry point
3. Registers the channel type so it can be referenced in `settings.json`
4. Creates channel instances using the plugin's factory function

Your custom channel gets the full shared pipeline for free: sender gating, group policies, session routing, slash commands, crash recovery, and the ACP bridge to the agent.

## Installing a Custom Channel

Install an extension that provides a channel plugin:

```bash
# From a local path (for development or private plugins)
qwen extensions install /path/to/my-channel-extension

# Or link it for development (changes are reflected immediately)
qwen extensions link /path/to/my-channel-extension
```

## Configuring a Custom Channel

Add a channel entry to `~/.qwen/settings.json` using the custom type provided by the extension:

```json
{
  "channels": {
    "my-bot": {
      "type": "my-platform",
      "apiKey": "$MY_PLATFORM_API_KEY",
      "senderPolicy": "open",
      "cwd": "/path/to/project"
    }
  }
}
```

The `type` must match a channel type registered by an installed extension. Check the extension's documentation for which plugin-specific fields are required (e.g., `apiKey`, `webhookUrl`).

All standard channel options work with custom channels:

| Option         | Description                                    |
| -------------- | ---------------------------------------------- |
| `senderPolicy` | `allowlist`, `pairing`, or `open`              |
| `allowedUsers` | Static allowlist of sender IDs                 |
| `sessionScope` | `user`, `thread`, or `single`                  |
| `cwd`          | Working directory for the agent                |
| `instructions` | Prepended to the first message of each session |
| `model`        | Model override for the channel                 |
| `groupPolicy`  | `disabled`, `allowlist`, or `open`             |
| `groups`       | Per-group settings                             |

See [Overview](./overview) for details on each option.

## Starting the Channel

```bash
# Start all channels including custom ones
qwen channel start

# Start just your custom channel
qwen channel start my-bot
```

## What You Get for Free

Custom channels automatically support everything built-in channels do:

- **Sender policies** — `allowlist`, `pairing`, and `open` access control
- **Group policies** — Per-group settings with optional @mention gating
- **Session routing** — Per-user, per-thread, or single shared sessions
- **DM pairing** — Full pairing code flow for unknown users
- **Slash commands** — `/help`, `/clear`, `/status` work out of the box
- **Custom instructions** — Prepended to the first message in each session
- **Crash recovery** — Automatic restart with session preservation
- **Per-session serialization** — Messages are queued to prevent race conditions

## Building Your Own Channel Plugin

Want to build a channel plugin for a new platform? See the [Channel Plugin Developer Guide](/developers/channel-plugins) for the `ChannelPlugin` interface, the `Envelope` format, and extension points.
