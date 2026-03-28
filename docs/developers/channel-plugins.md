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

| Field            | Type         | Required | Notes                                                                      |
| ---------------- | ------------ | -------- | -------------------------------------------------------------------------- |
| `channelName`    | string       | Yes      | Use `this.name`                                                            |
| `senderId`       | string       | Yes      | Must be stable across messages (used for session routing + access control) |
| `senderName`     | string       | Yes      | Display name                                                               |
| `chatId`         | string       | Yes      | Must distinguish DMs from groups                                           |
| `text`           | string       | Yes      | Strip bot @mentions                                                        |
| `threadId`       | string       | No       | For `sessionScope: "thread"`                                               |
| `messageId`      | string       | No       | Platform message ID — useful for response correlation                      |
| `isGroup`        | boolean      | Yes      | GroupGate relies on this                                                   |
| `isMentioned`    | boolean      | Yes      | GroupGate relies on this                                                   |
| `isReplyToBot`   | boolean      | Yes      | GroupGate relies on this                                                   |
| `referencedText` | string       | No       | Quoted message — prepended as context                                      |
| `imageBase64`    | string       | No       | Base64-encoded image (legacy — prefer `attachments`)                       |
| `imageMimeType`  | string       | No       | e.g., `image/jpeg` (legacy — prefer `attachments`)                         |
| `attachments`    | Attachment[] | No       | Structured media attachments (see below)                                   |

### Attachments

Use the `attachments` array for images, files, audio, and video. `handleInbound()` resolves them automatically: images with base64 `data` are sent to the model as vision input, files with a `filePath` get their path appended to the prompt so the agent can read them.

```typescript
interface Attachment {
  type: 'image' | 'file' | 'audio' | 'video';
  data?: string; // base64-encoded data (images, small files)
  filePath?: string; // absolute path to local file (large files saved to disk)
  mimeType: string; // e.g. 'application/pdf', 'image/jpeg'
  fileName?: string; // original file name from the platform
}
```

Example — handling a file upload in your adapter:

```typescript
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const buf = await downloadFromPlatform(fileId);
const dir = join(tmpdir(), 'channel-files');
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
const filePath = join(dir, fileName);
writeFileSync(filePath, buf);

envelope.attachments = [
  {
    type: 'file',
    filePath,
    mimeType: 'application/pdf',
    fileName,
  },
];
```

The legacy `imageBase64`/`imageMimeType` fields still work for backwards compatibility but `attachments` is preferred for new code.

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

**Working indicators** — override `onPromptStart()` and `onPromptEnd()` to show platform-specific typing indicators. These hooks fire only when a prompt actually begins processing — not for buffered messages (collect mode) or gated/blocked messages:

```typescript
protected override onPromptStart(chatId: string, sessionId: string, messageId?: string): void {
  this.platformClient.sendTyping(chatId); // your platform API
}

protected override onPromptEnd(chatId: string, sessionId: string, messageId?: string): void {
  this.platformClient.stopTyping(chatId);
}
```

**Tool call hooks** — override `onToolCall()` to display agent activity (e.g., "Running shell command...").

**Streaming hooks** — override `onResponseChunk(chatId, chunk, sessionId)` for per-chunk progressive display (e.g., editing a message in-place). Override `onResponseComplete(chatId, fullText, sessionId)` to customize final delivery.

**Block streaming** — set `blockStreaming: "on"` in the channel config. The base class automatically splits responses into multiple messages at paragraph boundaries. No plugin code needed — it works alongside `onResponseChunk`.

**Media** — populate `envelope.attachments` with images/files. See [Attachments](#attachments) above.

## Reference Implementations

- **Plugin example** (`packages/channels/plugin-example/`) — minimal WebSocket-based adapter, good starting point
- **Telegram** (`packages/channels/telegram/`) — full-featured: images, files, formatting, typing indicators
- **DingTalk** (`packages/channels/dingtalk/`) — stream-based with rich text handling
