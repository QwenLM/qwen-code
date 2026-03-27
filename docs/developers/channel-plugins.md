# Channel Plugin Developer Guide

A channel plugin connects Qwen Code to a messaging platform. It's packaged as an [extension](../users/extension/introduction) and loaded at startup. For user-facing docs on installing and configuring plugins, see [Plugins](../users/features/channels/plugins).

## How It Fits Together

Your plugin sits in the Platform Adapter layer. You handle platform-specific concerns (connecting, receiving messages, sending responses). `ChannelBase` handles everything else (access control, session routing, prompt queuing, slash commands, crash recovery).

```
Your Plugin  →  builds Envelope  →  handleInbound()
ChannelBase  →  gates → commands → routing → AcpBridge.prompt()
ChannelBase  →  calls your sendMessage() with the agent's response
```

## The Plugin Object

Your extension entry point exports a `plugin` conforming to `ChannelPlugin`:

```typescript
import type { ChannelPlugin } from '@qwen-code/channel-base';
import { MyChannel } from './MyChannel.js';

export const plugin: ChannelPlugin = {
  channelType: 'my-platform', // Unique ID, used in settings.json "type" field
  displayName: 'My Platform', // Shown in CLI output
  requiredConfigFields: ['apiKey'], // Validated at startup (beyond standard ChannelConfig)
  createChannel: (name, config, bridge, options) =>
    new MyChannel(name, config, bridge, options),
};
```

## The Channel Adapter

Extend `ChannelBase` and implement three methods:

```typescript
import { ChannelBase } from '@qwen-code/channel-base';
import type { Envelope } from '@qwen-code/channel-base';

export class MyChannel extends ChannelBase {
  async connect(): Promise<void> {
    // Connect to your platform, register message handlers
    // When a message arrives:
    const envelope: Envelope = {
      channelName: this.name,
      senderId: '...', // Stable, unique platform user ID
      senderName: '...', // Display name
      chatId: '...', // Chat/conversation ID (distinct for DMs vs groups)
      text: '...', // Message text (strip @mentions)
      isGroup: false, // Accurate — used by GroupGate
      isMentioned: false, // Accurate — used by GroupGate
      isReplyToBot: false, // Accurate — used by GroupGate
    };
    this.handleInbound(envelope);
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    // Format markdown → platform format, chunk if needed, deliver
  }

  disconnect(): void {
    // Clean up connections
  }
}
```

## The Envelope

The normalized message object you build from platform data. The boolean flags drive gate logic, so they must be accurate.

| Field            | Type    | Required | Notes                                                                      |
| ---------------- | ------- | -------- | -------------------------------------------------------------------------- |
| `channelName`    | string  | Yes      | Use `this.name`                                                            |
| `senderId`       | string  | Yes      | Must be stable across messages (used for session routing + access control) |
| `senderName`     | string  | Yes      | Display name                                                               |
| `chatId`         | string  | Yes      | Must distinguish DMs from groups                                           |
| `text`           | string  | Yes      | Strip bot @mentions                                                        |
| `threadId`       | string  | No       | For `sessionScope: "thread"`                                               |
| `messageId`      | string  | No       | Platform message ID — useful for response correlation                      |
| `isGroup`        | boolean | Yes      | GroupGate relies on this                                                   |
| `isMentioned`    | boolean | Yes      | GroupGate relies on this                                                   |
| `isReplyToBot`   | boolean | Yes      | GroupGate relies on this                                                   |
| `referencedText` | string  | No       | Quoted message — prepended as context                                      |
| `imageBase64`    | string  | No       | Base64-encoded image for multimodal models                                 |
| `imageMimeType`  | string  | No       | e.g., `image/jpeg`                                                         |

For **files**: download from your platform, save to a temp directory, include the file path in `text`.

## Extension Manifest

Your `qwen-extension.json` declares the channel type. The key must match `channelType` in your plugin object:

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

## Optional Extension Points

**Custom slash commands** — register in your constructor:

```typescript
this.registerCommand('mycommand', async (envelope, args) => {
  await this.sendMessage(envelope.chatId, 'Response');
  return true; // handled, don't forward to agent
});
```

**Working indicators** — override `handleInbound()` to show platform-specific typing indicators:

```typescript
override async handleInbound(envelope: Envelope): Promise<void> {
  await this.platformClient.sendTyping(envelope.chatId); // your platform API
  try { await super.handleInbound(envelope); }
  finally { await this.platformClient.stopTyping(envelope.chatId); }
}
```

**Tool call hooks** — override `onToolCall()` to display agent activity (e.g., "Running shell command...").

**Media** — download from your platform, set `imageBase64`/`imageMimeType` on the Envelope before calling `handleInbound()`.

## Reference Implementations

- **Plugin example** (`packages/channels/plugin-example/`) — minimal WebSocket-based adapter, good starting point
- **Telegram** (`packages/channels/telegram/`) — full-featured: images, files, formatting, typing indicators
- **DingTalk** (`packages/channels/dingtalk/`) — stream-based with rich text handling
