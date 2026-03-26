# Custom Channel Plugins

You can extend the channel system with custom platform adapters packaged as [extensions](../../extension/introduction). This lets you connect Qwen Code to any messaging platform, webhook, or custom transport.

## How It Works

Channel plugins are loaded at startup from active extensions. When `qwen channel start` runs, it:

1. Scans all enabled extensions for `channels` entries in their `qwen-extension.json`
2. Dynamically imports each channel's entry point
3. Registers the channel type so it can be referenced in `settings.json`
4. Creates channel instances using the plugin's factory function

The plugin provides a `ChannelPlugin` object that tells the channel system how to create your adapter. Your adapter extends `ChannelBase`, which gives you the full pipeline for free: sender gating, group policies, session routing, and the ACP bridge to the agent.

## Creating a Channel Plugin

### 1. Set up the project

Create a new directory for your extension:

```bash
mkdir my-channel-extension
cd my-channel-extension
npm init -y
```

Install the channel base package (adjust the path to your qwen-code checkout):

```bash
npm install @qwen-code/channel-base
```

### 2. Write the channel adapter

Create a class that extends `ChannelBase`. You need to implement three methods:

- **`connect()`** — Connect to your platform (WebSocket, polling, webhook, etc.)
- **`sendMessage(chatId, text)`** — Send a response back to a specific chat
- **`disconnect()`** — Clean up connections on shutdown

When your platform delivers an incoming message, build an `Envelope` and call `this.handleInbound(envelope)`. The base class handles everything else: access control, session routing, prompting the agent, and calling your `sendMessage()` with the response.

```typescript
import { ChannelBase } from '@qwen-code/channel-base';
import type {
  ChannelConfig,
  ChannelBaseOptions,
  Envelope,
  AcpBridge,
} from '@qwen-code/channel-base';

interface MyPlatformConfig extends ChannelConfig {
  apiKey: string;
  webhookUrl: string;
}

export class MyPlatformChannel extends ChannelBase {
  private client: any;

  constructor(
    name: string,
    config: MyPlatformConfig & Record<string, unknown>,
    bridge: AcpBridge,
    options?: ChannelBaseOptions,
  ) {
    super(name, config, bridge, options);
  }

  async connect(): Promise<void> {
    // Connect to your platform
    this.client = await createPlatformClient(this.config);

    // When a message arrives, push it through the pipeline
    this.client.on('message', (msg) => {
      const envelope: Envelope = {
        channelName: this.name,
        senderId: msg.userId,
        senderName: msg.userName,
        chatId: msg.chatId,
        text: msg.text,
        isGroup: msg.isGroup ?? false,
        isMentioned: msg.isMentioned ?? false,
        isReplyToBot: msg.isReplyToBot ?? false,
      };
      this.handleInbound(envelope);
    });
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    await this.client.send(chatId, text);
  }

  disconnect(): void {
    this.client?.close();
  }
}
```

### 3. Export the plugin

Create an `index.ts` (or `index.js`) that exports a `plugin` object conforming to the `ChannelPlugin` interface:

```typescript
import type { ChannelPlugin } from '@qwen-code/channel-base';
import { MyPlatformChannel } from './MyPlatformChannel.js';

export const plugin: ChannelPlugin = {
  channelType: 'my-platform',
  displayName: 'My Platform',
  requiredConfigFields: ['apiKey'],
  createChannel: (name, config, bridge, options) =>
    new MyPlatformChannel(name, config as any, bridge, options),
};
```

The fields are:

| Field                  | Required | Description                                                                |
| ---------------------- | -------- | -------------------------------------------------------------------------- |
| `channelType`          | Yes      | Unique type identifier. Must match the key in `qwen-extension.json`        |
| `displayName`          | Yes      | Human-readable name shown in CLI output                                    |
| `requiredConfigFields` | No       | Extra config fields your channel needs beyond the standard `ChannelConfig` |
| `createChannel`        | Yes      | Factory function that creates your channel adapter instance                |

### 4. Create the extension manifest

Create `qwen-extension.json` in your project root:

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

The `channels` field maps channel type names to their configuration:

| Field                  | Required | Description                                                         |
| ---------------------- | -------- | ------------------------------------------------------------------- |
| `entry`                | Yes      | Relative path to the compiled JS entry point (must export `plugin`) |
| `displayName`          | No       | Human-readable name for CLI output                                  |
| `requiredConfigFields` | No       | Extra config fields the channel requires                            |

> **Note:** The channel type key (e.g., `my-platform`) must match the `channelType` value in your exported plugin object. The system validates this at load time.

### 5. Build the extension

Compile your TypeScript to JavaScript. The entry point in `qwen-extension.json` must point to compiled JS, not TypeScript source:

```bash
npx tsc
```

### 6. Install the extension

You can install from a local path during development:

```bash
qwen extensions install /path/to/my-channel-extension
```

Or link it for development (changes are reflected immediately):

```bash
qwen extensions link /path/to/my-channel-extension
```

### 7. Configure the channel

Add a channel entry to `~/.qwen/settings.json` using your custom type:

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

All standard channel options (`senderPolicy`, `allowedUsers`, `sessionScope`, `cwd`, `instructions`, `groupPolicy`, `groups`, `model`) work with custom channels.

### 8. Start the channel

```bash
qwen channel start my-bot
```

## The Envelope

The `Envelope` is the message object you build from your platform's incoming data and pass to `handleInbound()`:

| Field            | Type    | Required | Description                                       |
| ---------------- | ------- | -------- | ------------------------------------------------- |
| `channelName`    | string  | Yes      | The channel name (use `this.name`)                |
| `senderId`       | string  | Yes      | Platform-specific user identifier                 |
| `senderName`     | string  | Yes      | Display name of the sender                        |
| `chatId`         | string  | Yes      | Platform-specific chat/conversation identifier    |
| `text`           | string  | Yes      | The message text                                  |
| `threadId`       | string  | No       | Thread identifier (for `sessionScope: "thread"`)  |
| `isGroup`        | boolean | Yes      | Whether the message is from a group chat          |
| `isMentioned`    | boolean | Yes      | Whether the bot was @mentioned                    |
| `isReplyToBot`   | boolean | Yes      | Whether the message is a reply to the bot         |
| `referencedText` | string  | No       | Text of a quoted/replied-to message (for context) |
| `imageBase64`    | string  | No       | Base64-encoded image data (for multimodal models) |
| `imageMimeType`  | string  | No       | MIME type of the image (e.g., `image/jpeg`)       |

## What You Get for Free

By extending `ChannelBase`, your channel automatically supports:

- **Sender policies** — `allowlist`, `pairing`, and `open` access control
- **Group policies** — Per-group settings with optional @mention gating
- **Session routing** — Per-user, per-thread, or single shared sessions
- **DM pairing** — Full pairing code flow for unknown users
- **Slash commands** — `/help`, `/clear`, `/status` work out of the box
- **Custom instructions** — Prepended to the first message in each session
- **Crash recovery** — Automatic restart with session preservation
- **Per-session serialization** — Messages are queued to prevent race conditions

## Example: Mock Channel Plugin

The `@qwen-code/channel-mock` package (in `packages/channels/mock/`) is a complete reference implementation. It connects to a WebSocket server and routes messages through the full pipeline:

```
Mock Client → HTTP → Mock Server → WebSocket → MockPluginChannel
    → ChannelBase → AcpBridge → qwen-code agent
    → response flows back the same path
```

See `packages/channels/mock/src/MockPluginChannel.ts` for a working example of a WebSocket-based channel adapter.
