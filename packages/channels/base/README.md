# @qwen-code/channel-base

Base infrastructure for building Qwen Code channel adapters. Provides the abstract base class, access control, session routing, and the ACP bridge that communicates with the agent.

If you're building a channel plugin, this is your only dependency.

## Install

```bash
npm install @qwen-code/channel-base
```

## Quick start

Subclass `ChannelBase` and implement three methods:

```typescript
import { ChannelBase } from '@qwen-code/channel-base';
import type {
  ChannelConfig,
  Envelope,
  AcpBridge,
} from '@qwen-code/channel-base';

class MyChannel extends ChannelBase {
  async connect(): Promise<void> {
    // Connect to platform API, register message handlers.
    // When a message arrives, build an Envelope and call:
    //   this.handleInbound(envelope)
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    // Deliver the agent's response to the platform.
  }

  disconnect(): void {
    // Clean up connections on shutdown.
  }
}
```

Export a `ChannelPlugin` object so the extension loader can discover it:

```typescript
import type { ChannelPlugin } from '@qwen-code/channel-base';

export const plugin: ChannelPlugin = {
  channelType: 'my-platform',
  displayName: 'My Platform',
  requiredConfigFields: ['apiKey'],
  createChannel: (name, config, bridge, options) =>
    new MyChannel(name, config, bridge, options),
};
```

For a complete working example, see [`@qwen-code/channel-plugin-example`](../plugin-example/).

## Architecture

```
Inbound:  Platform message
            → Envelope (with attachments)
            → GroupGate (group policy + mention gating)
            → SenderGate (allowlist / pairing / open)
            → Slash commands (/clear, /help, /status)
            → SessionRouter (resolve or create ACP session)
            → Resolve attachments (images → bridge, files → prompt text)
            → AcpBridge.prompt() → agent

Outbound: Agent response
            → BlockStreamer (if enabled: split into blocks at paragraph boundaries)
            → sendMessage() → platform
```

Everything between `handleInbound()` and `sendMessage()` is handled by the base class — your adapter only deals with platform I/O.

## Exports

### Classes

| Class           | Purpose                                                          |
| --------------- | ---------------------------------------------------------------- |
| `ChannelBase`   | Abstract base class — extend this to build a channel adapter     |
| `AcpBridge`     | Spawns and communicates with the `qwen-code --acp` agent process |
| `BlockStreamer` | Progressive multi-message delivery for block streaming           |
| `SessionRouter` | Maps senders to ACP sessions with configurable scoping           |
| `SenderGate`    | DM access control (allowlist / pairing / open)                   |
| `GroupGate`     | Group chat policy and @mention gating                            |
| `PairingStore`  | Pairing code generation, approval, and allowlist persistence     |

### Types

| Type            | Description                                    |
| --------------- | ---------------------------------------------- |
| `Attachment`    | Structured file/image/audio/video attachment   |
| `ChannelConfig` | Channel configuration from `settings.json`     |
| `ChannelPlugin` | Plugin factory interface (what you export)     |
| `Envelope`      | Normalized inbound message format              |
| `SenderPolicy`  | `'allowlist' \| 'pairing' \| 'open'`           |
| `GroupPolicy`   | `'disabled' \| 'allowlist' \| 'open'`          |
| `SessionScope`  | `'user' \| 'thread' \| 'single'`               |
| `GroupConfig`   | Per-group settings (e.g. `requireMention`)     |
| `SessionTarget` | Maps a session back to its channel/sender/chat |

## API reference

### ChannelBase

```typescript
constructor(name: string, config: ChannelConfig, bridge: AcpBridge, options?: ChannelBaseOptions)
```

**Abstract methods** (you must implement):

| Method          | Signature                                                                    |
| --------------- | ---------------------------------------------------------------------------- |
| `connect()`     | `() => Promise<void>` — Connect to the platform and start receiving messages |
| `sendMessage()` | `(chatId: string, text: string) => Promise<void>` — Deliver agent response   |
| `disconnect()`  | `() => void` — Clean up on shutdown                                          |

**Provided methods:**

| Method                                            | Description                                                                                                                       |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `handleInbound(envelope)`                         | Route an inbound message through the full pipeline (gate checks, commands, session, prompt). Call this from your message handler. |
| `setBridge(bridge)`                               | Replace the ACP bridge after crash recovery                                                                                       |
| `registerCommand(name, handler)`                  | Register a custom slash command (e.g. `/mycommand`)                                                                               |
| `onToolCall(chatId, event)`                       | Hook called on agent tool invocations — override to show indicators                                                               |
| `onResponseChunk(chatId, chunk, sessionId)`       | Hook called per streaming text chunk — override for progressive display (default: no-op)                                          |
| `onResponseComplete(chatId, fullText, sessionId)` | Hook called when full response is ready — override to customize delivery (default: `sendMessage()`)                               |

**Block streaming:** When `blockStreaming: "on"` is set in the channel config, the base class automatically splits the agent's streaming response into multiple messages at paragraph boundaries. See [Block Streaming](#block-streaming) below.

**Built-in slash commands:** `/clear` (`/reset`, `/new`), `/help`, `/status`

### AcpBridge

Manages the `qwen-code --acp` child process and ACP sessions.

```typescript
constructor(options: { cliEntryPath: string; cwd: string; model?: string })
```

| Method                              | Description                                                                                                       |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `start()`                           | Spawn the agent process                                                                                           |
| `stop()`                            | Kill the agent process                                                                                            |
| `newSession(cwd)`                   | Create a new ACP session, returns `sessionId`                                                                     |
| `loadSession(sessionId, cwd)`       | Restore an existing session                                                                                       |
| `prompt(sessionId, text, options?)` | Send a message to the agent, returns the full response text. Supports optional `imageBase64` and `imageMimeType`. |
| `isConnected`                       | Whether the agent process is alive                                                                                |

**Events** (EventEmitter):

| Event          | Payload                  | Description              |
| -------------- | ------------------------ | ------------------------ |
| `textChunk`    | `(sessionId, chunk)`     | Streaming response chunk |
| `toolCall`     | `(event: ToolCallEvent)` | Agent invoked a tool     |
| `disconnected` | `(code, signal)`         | Agent process exited     |

### SessionRouter

Maps senders to ACP sessions based on the configured scope.

```typescript
constructor(bridge: AcpBridge, defaultCwd: string, scope?: SessionScope, persistPath?: string)
```

**Routing keys by scope:**

| Scope            | Key format                | Effect                                    |
| ---------------- | ------------------------- | ----------------------------------------- |
| `user` (default) | `channel:senderId:chatId` | Each user gets their own session per chat |
| `thread`         | `channel:threadId`        | One session per thread                    |
| `single`         | `channel:__single__`      | One shared session for the entire channel |

| Method                                                    | Description                                                 |
| --------------------------------------------------------- | ----------------------------------------------------------- |
| `resolve(channelName, senderId, chatId, threadId?, cwd?)` | Get or create a session for the given sender                |
| `removeSession(channelName, senderId, chatId?)`           | Remove session(s) — used by `/clear`                        |
| `restoreSessions()`                                       | Reload sessions from disk after bridge restart              |
| `clearAll()`                                              | Clear all sessions and delete persist file (clean shutdown) |

### SenderGate

```typescript
constructor(policy: SenderPolicy, allowedUsers?: string[], pairingStore?: PairingStore)
```

| Method                         | Description                                                  |
| ------------------------------ | ------------------------------------------------------------ |
| `check(senderId, senderName?)` | Returns `{ allowed: boolean, pairingCode?: string \| null }` |

**Policy behavior:**

| Policy      | Behavior                                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------- |
| `open`      | Everyone allowed                                                                                          |
| `allowlist` | Only `allowedUsers` allowed                                                                               |
| `pairing`   | Check allowlist, then approved pairings, then generate a pairing code (8-char, 1hr expiry, max 3 pending) |

### GroupGate

```typescript
constructor(policy?: GroupPolicy, groups?: Record<string, GroupConfig>)
```

| Method            | Description                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------------- |
| `check(envelope)` | Returns `{ allowed: boolean, reason?: 'disabled' \| 'not_allowlisted' \| 'mention_required' }` |

**Policy behavior:**

| Policy      | Behavior                                 |
| ----------- | ---------------------------------------- |
| `disabled`  | All group messages rejected              |
| `allowlist` | Only groups listed in config are allowed |
| `open`      | All groups allowed                       |

When `requireMention` is `true` (default), group messages are only processed if the bot is @mentioned or the message is a reply to the bot.

### PairingStore

```typescript
constructor(channelName: string)
```

Persists pairing state to `~/.qwen/channels/{channelName}-pairing.json` and `{channelName}-allowlist.json`.

| Method                                | Description                                                                                               |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `createRequest(senderId, senderName)` | Generate an 8-char pairing code (or return existing). Returns `null` if 3 pending requests already exist. |
| `approve(code)`                       | Approve a pairing request, adds sender to allowlist. Returns the request or `null`.                       |
| `isApproved(senderId)`                | Check if sender is in the approved allowlist                                                              |
| `listPending()`                       | Get active (non-expired) pending requests                                                                 |

## Envelope

The normalized message format your adapter must construct:

```typescript
interface Envelope {
  channelName: string; // your channel instance name
  senderId: string; // stable, unique sender ID
  senderName: string; // display name
  chatId: string; // distinguishes DMs from groups
  text: string; // message text (@mentions stripped)
  messageId?: string; // platform message ID
  threadId?: string; // for thread-scoped sessions
  isGroup: boolean; // true for group chats
  isMentioned: boolean; // true if bot was @mentioned
  isReplyToBot: boolean; // true if replying to bot's message
  referencedText?: string; // quoted message text
  imageBase64?: string; // base64-encoded image (legacy — prefer attachments)
  imageMimeType?: string; // e.g. 'image/jpeg' (legacy — prefer attachments)
  attachments?: Attachment[]; // structured file/image/audio/video attachments
}

interface Attachment {
  type: 'image' | 'file' | 'audio' | 'video';
  data?: string; // base64-encoded data (images, small files)
  filePath?: string; // absolute path to local file (large files)
  mimeType: string; // e.g. 'application/pdf', 'image/jpeg'
  fileName?: string; // original file name from the platform
}
```

`handleInbound()` automatically resolves attachments: images with `data` are sent to the model as vision input, files with `filePath` get their path appended to the prompt text so the agent can read them with its tools.

## Block Streaming

When `blockStreaming: "on"` is set in a channel's config, the agent's response is delivered as multiple separate messages instead of one large wall of text. The `BlockStreamer` accumulates streaming chunks and emits completed blocks based on paragraph boundaries and size heuristics.

**Config fields** (on `ChannelConfig`):

| Field                    | Type                     | Default         | Description                                                                 |
| ------------------------ | ------------------------ | --------------- | --------------------------------------------------------------------------- |
| `blockStreaming`         | `'on' \| 'off'`          | `'off'`         | Enable/disable block streaming                                              |
| `blockStreamingChunk`    | `{ minChars, maxChars }` | `{ 400, 1000 }` | `minChars`: don't emit until this size. `maxChars`: force-emit at this size |
| `blockStreamingCoalesce` | `{ idleMs }`             | `{ 1500 }`      | Emit buffered text after this many ms of silence from the agent             |

**How it works:**

1. Text accumulates as the agent streams its response
2. When the buffer reaches `minChars` and hits a paragraph break (`\n\n`), that block is sent as a separate message
3. If the buffer reaches `maxChars` without a paragraph break, it force-splits at the best break point (newline > space)
4. If the agent goes quiet for `idleMs`, the buffer is flushed (as long as it's past `minChars`)
5. When the agent finishes, any remaining text is sent immediately regardless of `minChars`

Block streaming and `onResponseChunk` work independently — plugins can override `onResponseChunk` for their own purposes while block streaming handles delivery.

## Further reading

- [Channel Plugin Developer Guide](../../docs/developers/channel-plugins.md)
- [`@qwen-code/channel-plugin-example`](../plugin-example/) — working reference implementation
