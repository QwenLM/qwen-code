# Channel P0 Identity And Task Lifecycle Design

## Goal

Implement the first P0 foundation for channel-resident multiplayer agents:
channel-scoped identity and memory-boundary metadata, plus a shared task
lifecycle hook in `@qwen-code/channel-base`.

This intentionally does not add a Slack adapter, daemon event stream, adapter UI
changes, proactive scheduling, cross-channel context, or real core-memory path
isolation.

## Background

`qwen channel` already supports messaging adapters, shared sessions, sender
attribution, dispatch modes, streaming chunks, tool-call callbacks, cancellation,
and platform-specific progress surfaces such as Feishu cards. The missing P0
product layer is a stable way to say "this channel has its own resident agent
identity" and "this prompt turn has a lifecycle adapters can observe."

Issue #6103 tracks this focused slice. It builds on the broader qwen tag roadmap
in #5887, but keeps this PR small enough to review and ship independently.

## Scope

In scope:

- Add optional channel identity metadata to `ChannelConfig`.
- Add optional memory-scope metadata to `ChannelConfig`.
- Derive safe defaults when the new config is omitted.
- Inject a concise channel boundary note into the first prompt for each agent
  session, together with existing channel instructions.
- Add a protected `onTaskLifecycle(event)` hook on `ChannelBase`.
- Emit lifecycle events from the shared channel flow for prompt start, text
  chunks, tool calls, cancellation, completion, and errors.
- Add focused package-local tests in `packages/channels/base`.

Out of scope:

- Core memory storage changes or file-path namespace isolation.
- Daemon/SSE event publication.
- Feishu, DingTalk, Telegram, WeChat, or QQ UI changes.
- New platform adapters.
- Token budgets, tool ACLs, or cross-channel context sharing.

## Design

### Channel Identity

Add a small optional config object:

```ts
export interface ChannelIdentityConfig {
  id?: string;
  displayName?: string;
  description?: string;
}
```

`ChannelConfig` gains `identity?: ChannelIdentityConfig`.

At runtime, `ChannelBase` derives:

- `id`: `config.identity.id` or `channel:<name>`
- `displayName`: `config.identity.displayName` or `<name>`
- `description`: `config.identity.description`, if present

The runtime identity is metadata only. It does not change session routing,
access control, or platform adapter behavior.

### Memory Scope Metadata

Add:

```ts
export type ChannelMemoryScopeMode = 'metadata-only';

export interface ChannelMemoryScopeConfig {
  namespace?: string;
  mode?: ChannelMemoryScopeMode;
}
```

`ChannelConfig` gains `memoryScope?: ChannelMemoryScopeConfig`.

At runtime, `ChannelBase` derives:

- `namespace`: `config.memoryScope.namespace` or `channel:<name>`
- `mode`: always `'metadata-only'` for this PR

This is deliberately not a real core-memory namespace. It is an explicit,
inspectable boundary marker and prompt instruction so later work can wire the
same namespace into core memory paths without changing channel config shape.

### Prompt Boundary Injection

`ChannelBase` already prepends `config.instructions` once per session. When a
channel opts into channel-specific prompt context via `instructions`, `identity`,
or `memoryScope`, extend that first-message injection to include a generated
boundary note before custom instructions:

```text
Channel identity:
- id: channel:ops
- display name: Ops Bot
- description: Helps the ops group coordinate repository maintenance.

Memory scope:
- namespace: qwen-tag:ops
- mode: metadata-only
- storage isolation: not enforced by this version.
```

The exact wording should be concise and stable enough for tests, but avoid
over-promising isolation. If no description exists, omit that line.

This note is injected once per agent session, like existing instructions. When
the bridge reports a session death, the existing `instructedSessions` cleanup
continues to allow reinjection for the next session.

For compatibility, channels with no `instructions`, `identity`, or `memoryScope`
configuration keep the existing raw prompt shape. Runtime identity and memory
metadata are still derived for lifecycle events and status commands.

### Status Visibility

Extend `/who` and `/status` with identity and memory metadata:

- `/who` should include identity display name and memory namespace.
- `/status` should include the identity id and memory mode.

Keep the output short. Do not expose absolute paths or hidden configuration.

### Task Lifecycle Hook

Add a discriminated union:

```ts
export type ChannelTaskLifecycleEvent =
  | {
      type: 'started';
      channelName: string;
      chatId: string;
      sessionId: string;
      messageId?: string;
      identity: ChannelRuntimeIdentity;
      memoryScope: ChannelRuntimeMemoryScope;
    }
  | {
      type: 'text_chunk';
      channelName: string;
      chatId: string;
      sessionId: string;
      messageId?: string;
      chunk: string;
      identity: ChannelRuntimeIdentity;
      memoryScope: ChannelRuntimeMemoryScope;
    }
  | {
      type: 'tool_call';
      channelName: string;
      chatId: string;
      sessionId: string;
      toolCall: ToolCallEvent;
      identity: ChannelRuntimeIdentity;
      memoryScope: ChannelRuntimeMemoryScope;
    }
  | {
      type: 'cancelled';
      channelName: string;
      chatId: string;
      sessionId: string;
      messageId?: string;
      reason: 'cancel_command' | 'clear' | 'steer';
      identity: ChannelRuntimeIdentity;
      memoryScope: ChannelRuntimeMemoryScope;
    }
  | {
      type: 'completed';
      channelName: string;
      chatId: string;
      sessionId: string;
      messageId?: string;
      identity: ChannelRuntimeIdentity;
      memoryScope: ChannelRuntimeMemoryScope;
    }
  | {
      type: 'failed';
      channelName: string;
      chatId: string;
      sessionId: string;
      messageId?: string;
      error: string;
      identity: ChannelRuntimeIdentity;
      memoryScope: ChannelRuntimeMemoryScope;
    };
```

`ChannelBase` adds:

```ts
protected onTaskLifecycle(_event: ChannelTaskLifecycleEvent): void {}
```

Default behavior is no-op. Adapters can opt in later without changing the
prompt execution path.

### Lifecycle Emission Points

Emit from shared `ChannelBase` flow:

- `started`: immediately after `activePrompts.set()` and before
  `onPromptStart()`.
- `text_chunk`: when the prompt's `textChunk` listener accepts a non-cancelled
  chunk.
- `tool_call`: in the existing bridge tool-call listener after resolving the
  session target.
- `cancelled`: when `/cancel` succeeds, when `/clear` cancels or evicts an
  active prompt, and when `steer` marks the active turn cancelled.
- `completed`: after `bridge.prompt()` resolves and before or after
  `onResponseComplete()`, as long as the turn was not cancelled.
- `failed`: when `bridge.prompt()` or response delivery throws.

Lifecycle hook failures should be caught and logged to stderr. A platform
adapter's lifecycle UI must not break prompt execution or cleanup.

## Error Handling

- Invalid identity or memory fields are not fatal in this PR; config parsing
  should preserve the existing permissive shape and only accept string fields
  where explicit parsing already exists.
- Lifecycle hook exceptions are swallowed after a stderr diagnostic.
- Memory scope mode is constrained to `'metadata-only'`; omitted or unknown
  config should resolve to `'metadata-only'` rather than enabling behavior that
  does not exist.

## Tests

Focused tests in `packages/channels/base/src/ChannelBase.test.ts` should cover:

- Default identity and memory metadata are derived from channel name.
- Custom identity and memory namespace are included in the first prompt.
- Boundary metadata is injected once per session and re-injected after
  `sessionDied`.
- `/who` and `/status` include the new metadata without leaking cwd.
- `onTaskLifecycle` sees `started`, `text_chunk`, `tool_call`, `completed`.
- `onTaskLifecycle` sees `cancelled` for `/cancel`, `/clear`, and `steer`.
- `onTaskLifecycle` sees `failed` when `bridge.prompt()` rejects.
- A throwing lifecycle hook does not reject `handleInbound()`.

Use package-local commands:

```bash
cd packages/channels/base
npx vitest run src/ChannelBase.test.ts
```

Final verification before PR:

```bash
npm run build
npm run typecheck
```

## Open Decisions

None for this PR. Real core-memory namespace enforcement, daemon publication,
adapter UI, tool/data ACLs, budgets, and proactive follow-up are explicitly
future work.
