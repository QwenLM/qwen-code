# @qwen-code/channel-base

Base infrastructure for building Qwen Code channel adapters. Provides the abstract base class, access control, session routing, and the adapter-facing bridge interface used to communicate with the agent.

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
  ChannelAgentBridge,
  ChannelBaseOptions,
  ChannelConfig,
  Envelope,
} from '@qwen-code/channel-base';

class MyChannel extends ChannelBase {
  constructor(
    name: string,
    config: ChannelConfig,
    bridge: ChannelAgentBridge,
    options?: ChannelBaseOptions,
  ) {
    super(name, config, bridge, options);
  }

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

Migration note for existing TypeScript plugins: if your adapter constructor or factory explicitly types `bridge` as `AcpBridge`, change that annotation to `ChannelAgentBridge` and keep using only the methods exposed by that contract. JavaScript plugins are unaffected at runtime, and standalone `qwen channel start` still passes the current `AcpBridge` implementation.

## Runtime modes

Channel adapters can run in two host modes:

- `qwen channel start [name]` is the standalone service. It uses `AcpBridge` over a `qwen-code --acp` child process and remains the default channel command.
- `qwen serve --channel <name>` and `qwen serve --channel all` are experimental daemon-managed modes. Named channels are grouped by owning workspace and `qwen serve` starts one out-of-process worker per owning runtime. Each worker connects back to the daemon through the SDK, and adapters receive a `DaemonChannelBridge`-backed `ChannelAgentBridge` facade. `--channel all` stays primary-only.

In daemon-managed mode, every named channel's `cwd` must resolve to exactly one registered, trusted workspace. Its worker receives that runtime's cwd and environment overlay; an ambiguous or untrusted selection fails instead of using primary. The optional `btw` and `shellCommand` methods are exposed to adapters only when the daemon advertises the `session_btw` and `session_shell_command` capabilities, respectively.

## Architecture

```
Inbound:  Platform message
            → Envelope (with attachments)
            → GroupGate (group policy + mention gating)
            → SenderGate (allowlist / pairing / open)
            → Slash commands (/clear, /help, /status)
            → SessionRouter (resolve or create agent session)
            → Resolve attachments (images → bridge, files → prompt text)
            → ChannelAgentBridge.prompt() → agent

Outbound: Agent response
            → BlockStreamer (if enabled: split into blocks at paragraph boundaries)
            → sendMessage() → platform
```

Everything between `handleInbound()` and `sendMessage()` is handled by the base class — your adapter only deals with platform I/O.

## Exports

### Classes

| Class           | Purpose                                                                              |
| --------------- | ------------------------------------------------------------------------------------ |
| `ChannelBase`   | Abstract base class — extend this to build a channel adapter                         |
| `AcpBridge`     | Current standalone `qwen channel start` bridge implementation over `qwen-code --acp` |
| `BlockStreamer` | Progressive multi-message delivery for block streaming                               |
| `SessionRouter` | Maps senders to agent sessions with configurable scoping                             |
| `SenderGate`    | DM access control (allowlist / pairing / open)                                       |
| `GroupGate`     | Group chat policy and @mention gating                                                |
| `PairingStore`  | Pairing code generation, approval, and allowlist persistence                         |

### Types

| Type                 | Description                                                              |
| -------------------- | ------------------------------------------------------------------------ |
| `Attachment`         | Structured file/image/audio/video attachment                             |
| `AvailableCommand`   | Agent command advertised through the bridge                              |
| `ChannelAgentBridge` | Adapter-facing bridge contract used by `ChannelBase` and `SessionRouter` |
| `ChannelConfig`      | Channel configuration from `settings.json`                               |
| `ChannelPlugin`      | Plugin factory interface (what you export)                               |
| `Envelope`           | Normalized inbound message format                                        |
| `SenderPolicy`       | `'allowlist' \| 'pairing' \| 'open'`                                     |
| `GroupPolicy`        | `'disabled' \| 'allowlist' \| 'pairing' \| 'open'`                       |
| `SessionScope`       | `'user' \| 'chat_thread' \| 'single'`; legacy `'thread'` is deprecated   |
| `GroupConfig`        | Per-group settings (e.g. `requireMention`)                               |
| `SessionTarget`      | Maps a session back to its channel/sender/chat                           |
| `ToolCallEvent`      | Agent tool-call event delivered to adapters                              |

## API reference

### ChannelBase

```typescript
constructor(name: string, config: ChannelConfig, bridge: ChannelAgentBridge, options?: ChannelBaseOptions)
```

**Abstract methods** (you must implement):

| Method          | Signature                                                                    |
| --------------- | ---------------------------------------------------------------------------- |
| `connect()`     | `() => Promise<void>` — Connect to the platform and start receiving messages |
| `sendMessage()` | `(chatId: string, text: string) => Promise<void>` — Deliver agent response   |
| `disconnect()`  | `() => void` — Clean up on shutdown                                          |

**Provided methods:**

| Method                                                     | Description                                                                                                                                           |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `handleInbound(envelope)`                                  | Route an inbound message through the full pipeline (gate checks, commands, session, prompt). Call this from your message handler.                     |
| `setBridge(bridge)`                                        | Replace the agent bridge after crash recovery                                                                                                         |
| `registerCommand(name, handler)`                           | Register a custom slash command (e.g. `/mycommand`)                                                                                                   |
| `onToolCall(chatId, event)`                                | Hook called on agent tool invocations — override to show indicators                                                                                   |
| `onResponseChunk(chatId, chunk, sessionId, segment)`       | Hook called per streaming text chunk — override for progressive display while preserving immutable `segment.sourceLabel` attribution (default: no-op) |
| `onResponseComplete(chatId, fullText, sessionId, segment)` | Hook called when full response is ready — override to customize delivery (default: attributes delivery with `segment.sourceLabel` in named-task mode) |

**Block streaming:** When `blockStreaming: "on"` is set in the channel config, the base class automatically splits the agent's streaming response into multiple messages at paragraph boundaries. See [Block Streaming](#block-streaming) below.

**Built-in slash commands:** `/clear` (`/reset`, `/new`), `/help`, `/status`

**ChannelBaseOptions:**

| Option                 | Description                                                                                                                                                |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `router`               | Optional `SessionRouter`. Omit for the default standalone router.                                                                                          |
| `proxy`                | Optional proxy URL made available to adapters.                                                                                                             |
| `registerBridgeEvents` | Set only when the adapter owns a supplied router and `ChannelBase` should consume bridge events directly. Leave unset for routers supplied by the gateway. |

### ChannelAgentBridge

`ChannelAgentBridge` is the adapter-facing contract. Channel adapters, channel plugins, `ChannelBase`, and `SessionRouter` should depend on this type instead of a concrete bridge implementation.

`btw` and `shellCommand` are optional. Adapters should check for each before enabling the feature it backs — a BTW side question, or `!cmd`-style shell execution — because daemon-managed hosts expose them only when the connected daemon advertises the matching capability (`session_btw`, `session_shell_command`).

```typescript
interface ChannelAgentBridge {
  readonly availableCommands: AvailableCommand[];
  on(eventName: 'toolCall', listener: (event: ToolCallEvent) => void): unknown;
  on(
    eventName: 'textChunk',
    listener: (sessionId: string, chunk: string) => void,
  ): unknown;
  on(
    eventName: 'sessionDied',
    listener: (event: { sessionId: string; reason?: string }) => void,
  ): unknown;
  off(eventName: 'toolCall', listener: (event: ToolCallEvent) => void): unknown;
  off(
    eventName: 'textChunk',
    listener: (sessionId: string, chunk: string) => void,
  ): unknown;
  off(
    eventName: 'sessionDied',
    listener: (event: { sessionId: string; reason?: string }) => void,
  ): unknown;
  newSession(cwd: string): Promise<string>;
  loadSession(sessionId: string, cwd: string): Promise<string>;
  prompt(
    sessionId: string,
    text: string,
    options?: {
      images?: Array<{ data: string; mimeType: string }>; // ordered, preferred
      imageBase64?: string; // legacy fallback (first image only)
      imageMimeType?: string; // legacy fallback (first image only)
    },
  ): Promise<string>;
  btw?(
    sessionId: string,
    question: string,
    signal?: AbortSignal,
  ): Promise<ChannelBtwResult>;
  cancelSession(sessionId: string): Promise<void>;
  shellCommand?(
    sessionId: string,
    command: string,
    signal?: AbortSignal,
  ): Promise<{ exitCode: number | null; output: string; aborted: boolean }>;
}
```

`prompt` carries images through `options.images` — an ordered array of `{ data, mimeType }` entries delivered to the model in array order. The legacy `imageBase64`/`imageMimeType` pair is a fallback that carries only the first image. Built-in bridges normalize MIME types before use: lowercased, parameters stripped (`image/png; charset=binary` → `image/png`), and the `image/jpg` alias mapped to `image/jpeg`. Daemon-backed bridges upload images to the daemon attachment store and restrict them to its supported subtypes (`image/bmp`, `image/gif`, `image/jpeg`, `image/png`, `image/webp`) and its per-item admission rule (non-empty and at most 8 MiB once decoded); daemons without attachment support take the same images inline in the prompt body, kept under an aggregate base64 budget. Images outside those limits are skipped with a log line instead of failing the turn, while `AcpBridge` delivers any normalized `image/*` inline.

### AcpBridge

`AcpBridge` is the current implementation used by standalone `qwen channel start`. It manages the `qwen-code --acp` child process and implements `ChannelAgentBridge`.

```typescript
constructor(options: { cliEntryPath: string; cwd: string; model?: string })
```

| Method                              | Description                                                                                                                                                                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `start()`                           | Spawn the agent process                                                                                                                                                                                                        |
| `stop()`                            | Kill the agent process                                                                                                                                                                                                         |
| `newSession(cwd)`                   | Create a new ACP session, returns `sessionId`                                                                                                                                                                                  |
| `loadSession(sessionId, cwd)`       | Restore an existing session                                                                                                                                                                                                    |
| `prompt(sessionId, text, options?)` | Send a message to the agent, returns the full response text. Supports an ordered `images` array (`{ data, mimeType }` per image, preferred), falling back to the legacy `imageBase64`/`imageMimeType` pair for a single image. |
| `isConnected`                       | Whether the agent process is alive                                                                                                                                                                                             |

**Events** (EventEmitter):

| Event          | Payload                  | Description              |
| -------------- | ------------------------ | ------------------------ |
| `textChunk`    | `(sessionId, chunk)`     | Streaming response chunk |
| `toolCall`     | `(event: ToolCallEvent)` | Agent invoked a tool     |
| `disconnected` | `(code, signal)`         | Agent process exited     |

### SessionRouter

Maps senders to agent sessions based on the configured scope.

```typescript
constructor(bridge: ChannelAgentBridge, defaultCwd: string, scope?: SessionScope, persistPath?: string)
```

**Routing keys by scope:**

| Scope            | Key format                | Effect                                    |
| ---------------- | ------------------------- | ----------------------------------------- |
| `user` (default) | `channel:senderId:chatId` | Each user gets their own session per chat |
| `thread`         | `channel:threadId`        | One session per thread                    |
| `single`         | `channel:__single__`      | One shared session for the entire channel |

| Method                                                     | Description                                                 |
| ---------------------------------------------------------- | ----------------------------------------------------------- |
| `resolve(channelName, senderId, chatId, threadId?, cwd?)`  | Get or create a session for the given sender                |
| `removeSession(channelName, senderId, chatId?, threadId?)` | Remove session(s) — used by `/clear`                        |
| `removeSessionId(sessionId)`                               | Remove all routing state for a bridge session ID            |
| `restoreSessions()`                                        | Reload sessions from disk after bridge restart              |
| `clearAll()`                                               | Clear all sessions and delete persist file (clean shutdown) |

### SenderGate

```typescript
constructor(policy: SenderPolicy, allowedUsers?: string[], pairingStore?: PairingStore)
```

| Method                         | Description                                                          |
| ------------------------------ | -------------------------------------------------------------------- |
| `check(senderId, senderName?)` | Returns `{ allowed: boolean, pairing?: CreatePairingRequestResult }` |

**Policy behavior:**

| Policy      | Behavior                                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------- |
| `open`      | Everyone allowed                                                                                          |
| `allowlist` | Only `allowedUsers` allowed                                                                               |
| `pairing`   | Check allowlist, then approved pairings, then generate a pairing code (8-char, 1hr expiry, max 3 pending) |

### GroupGate

```typescript
constructor(policy?: GroupPolicy, groups?: Record<string, GroupConfig>, pairingStore?: PairingStore)
```

| Method                      | Description                                                                                                                                                                                                                            |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `check(envelope, options?)` | Returns the group policy decision and an optional pairing result. Under `pairing`, a mention/reply from an unapproved group creates (or reuses) a pending pairing request; pass `{ createPairingRequest: false }` for read-only probes |

**Policy behavior:**

| Policy      | Behavior                                 |
| ----------- | ---------------------------------------- |
| `disabled`  | All group messages rejected              |
| `allowlist` | Only groups listed in config are allowed |
| `pairing`   | A group must be approved once by chat ID |
| `open`      | All groups allowed                       |

When `requireMention` is `true` (default), group messages are only processed if the bot is @mentioned or the message is a reply to the bot.

### PairingStore

```typescript
constructor(channelName: string, workspaceCwd?: string)
```

Persists pending pairing state to `{channelName}-pairing.json`, user approvals to `{channelName}-allowlist.json`, and group approvals to `{channelName}-groups.json`. With `workspaceCwd` (what `ChannelBase` passes — the channel's `cwd`), the files live under the workspace-scoped directory `~/.qwen/channels/<workspace-scope>/` so two workspaces reusing the same channel name never share pairing requests or allowlist entries. Without it, the legacy global `~/.qwen/channels/` layout is used. The first time a given (workspace, channel) pair is constructed, existing legacy global files are copied in once (grandfathering) so already-approved senders stay approved; a per-channel `<channel>.migrated` sentinel in the scope directory marks that decision, after which legacy files are never consulted again for that channel. Channel names are URI-encoded in file names, so a name containing path separators cannot escape the scope directory. `revoke(senderId)` removes the sender only from this store's allowlist and never mutates the legacy global baseline.

| Method                                | Description                                                                                                                                                                                                       |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createRequest(senderId, senderName)` | Generate an 8-char pairing code (or return the existing one). Returns `{ rejected: 'sender_pending' }` if the sender already holds a request, or `{ rejected: 'cap_reached' }` if 3 requests are already pending. |
| `createGroupRequest(...)`             | Generate a request keyed by stable group ID and record its initiating sender.                                                                                                                                     |
| `approve(code)`                       | Approve a user or group request and update its corresponding allowlist.                                                                                                                                           |
| `isApproved(senderId)`                | Check if sender is in the approved allowlist                                                                                                                                                                      |
| `isGroupApproved(groupId)`            | Check if a group is approved                                                                                                                                                                                      |
| `listPending()`                       | Get active (non-expired) pending requests                                                                                                                                                                         |
| `getAllowlist()`                      | Get approved sender IDs                                                                                                                                                                                           |
| `getGroupAllowlist()`                 | Get approved group IDs                                                                                                                                                                                            |
| `revoke(senderId)`                    | Remove an approved sender. Returns whether the sender was present.                                                                                                                                                |
| `revokeGroup(groupId)`                | Remove an approved group. Returns whether the group was present.                                                                                                                                                  |

## Envelope

The normalized message format your adapter must construct:

```typescript
interface Envelope {
  channelName: string; // your channel instance name
  senderId: string; // stable, unique sender ID
  senderName: string; // display name
  chatId: string; // distinguishes DMs from groups
  chatName?: string; // inbound group display name, when provided
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

- [Channel Plugin Developer Guide](../../../docs/developers/channel-plugins.md)
- [`@qwen-code/channel-plugin-example`](../plugin-example/) — working reference implementation
