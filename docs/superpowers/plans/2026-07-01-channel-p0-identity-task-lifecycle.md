# Channel P0 Identity And Task Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add channel identity/memory-scope metadata and a base task lifecycle hook for channel-resident agents.

**Architecture:** Keep the behavior inside `@qwen-code/channel-base`. Add typed metadata to `types.ts`, derive defaults in `ChannelBase`, inject a first-session boundary note alongside existing instructions, and emit lifecycle events through a protected no-op hook that adapters can override.

**Tech Stack:** TypeScript, Vitest, existing `ChannelBase` / `ChannelConfig` / `ChannelAgentBridge` infrastructure.

---

## File Structure

- Modify `packages/channels/base/src/types.ts`: add identity, memory-scope, runtime metadata, and lifecycle event types.
- Modify `packages/channels/base/src/ChannelBase.ts`: derive metadata, inject prompt boundary, expose status metadata, emit lifecycle events.
- Modify `packages/channels/base/src/ChannelBase.test.ts`: add focused tests using the existing `TestChannel` fixture.
- No changes to core memory files, daemon events, or platform adapter UI.

## Task 1: Add Channel Metadata And Lifecycle Types

**Files:**
- Modify: `packages/channels/base/src/types.ts`
- Test: `packages/channels/base/src/ChannelBase.test.ts`

- [ ] **Step 1: Write failing type-driven tests in `ChannelBase.test.ts`**

Add `taskEvents` to `TestChannel` and two tests near the existing instruction tests:

```ts
import type {
  ChannelConfig,
  ChannelTaskLifecycleEvent,
  Envelope,
} from './types.js';

class TestChannel extends ChannelBase {
  taskEvents: ChannelTaskLifecycleEvent[] = [];

  protected override onTaskLifecycle(event: ChannelTaskLifecycleEvent): void {
    this.taskEvents.push(event);
  }
}

it('derives default channel identity and memory metadata for task lifecycle events', async () => {
  const ch = createChannel();

  await ch.handleInbound(envelope({ messageId: 'm-1' }));

  expect(ch.taskEvents[0]).toMatchObject({
    type: 'started',
    channelName: 'test-chan',
    chatId: 'chat1',
    sessionId: 's-1',
    messageId: 'm-1',
    identity: {
      id: 'channel:test-chan',
      displayName: 'test-chan',
    },
    memoryScope: {
      namespace: 'channel:test-chan',
      mode: 'metadata-only',
    },
  });
});

it('uses configured channel identity and memory namespace in lifecycle metadata', async () => {
  const ch = createChannel({
    identity: {
      id: 'ops-agent',
      displayName: 'Ops Agent',
      description: 'Coordinates repository operations.',
    },
    memoryScope: {
      namespace: 'qwen-tag:ops',
      mode: 'metadata-only',
    },
  });

  await ch.handleInbound(envelope());

  expect(ch.taskEvents[0]).toMatchObject({
    identity: {
      id: 'ops-agent',
      displayName: 'Ops Agent',
      description: 'Coordinates repository operations.',
    },
    memoryScope: {
      namespace: 'qwen-tag:ops',
      mode: 'metadata-only',
    },
  });
});
```

- [ ] **Step 2: Run tests to verify type failures**

Run:

```bash
cd packages/channels/base
npx vitest run src/ChannelBase.test.ts
```

Expected: fails because `ChannelTaskLifecycleEvent`, `identity`, `memoryScope`, and `onTaskLifecycle` do not exist.

- [ ] **Step 3: Add types in `types.ts`**

Insert after `DispatchMode`:

```ts
export interface ChannelIdentityConfig {
  id?: string;
  displayName?: string;
  description?: string;
}

export interface ChannelRuntimeIdentity {
  id: string;
  displayName: string;
  description?: string;
}

export type ChannelMemoryScopeMode = 'metadata-only';

export interface ChannelMemoryScopeConfig {
  namespace?: string;
  mode?: ChannelMemoryScopeMode;
}

export interface ChannelRuntimeMemoryScope {
  namespace: string;
  mode: ChannelMemoryScopeMode;
}
```

Add to `ChannelConfig` after `instructions?: string;`:

```ts
  identity?: ChannelIdentityConfig;
  memoryScope?: ChannelMemoryScopeConfig;
```

Import `ToolCallEvent` at the top:

```ts
import type { ToolCallEvent } from './ChannelAgentBridge.js';
```

Add before `ChannelPlugin`:

```ts
interface ChannelTaskLifecycleBase {
  channelName: string;
  chatId: string;
  sessionId: string;
  messageId?: string;
  identity: ChannelRuntimeIdentity;
  memoryScope: ChannelRuntimeMemoryScope;
}

export type ChannelTaskLifecycleEvent =
  | (ChannelTaskLifecycleBase & { type: 'started' })
  | (ChannelTaskLifecycleBase & { type: 'text_chunk'; chunk: string })
  | (Omit<ChannelTaskLifecycleBase, 'messageId'> & {
      type: 'tool_call';
      toolCall: ToolCallEvent;
    })
  | (ChannelTaskLifecycleBase & {
      type: 'cancelled';
      reason: 'cancel_command' | 'clear' | 'steer';
    })
  | (ChannelTaskLifecycleBase & { type: 'completed' })
  | (ChannelTaskLifecycleBase & { type: 'failed'; error: string });
```

- [ ] **Step 4: Add minimal runtime support in `ChannelBase.ts`**

Update imports:

```ts
import type {
  ChannelConfig,
  ChannelRuntimeIdentity,
  ChannelRuntimeMemoryScope,
  ChannelTaskLifecycleEvent,
  DispatchMode,
  Envelope,
} from './types.js';
```

Add private fields after `protected name: string;`:

```ts
  private readonly identity: ChannelRuntimeIdentity;
  private readonly memoryScope: ChannelRuntimeMemoryScope;
```

Set them in the constructor after `this.proxy = options?.proxy;`:

```ts
    this.identity = this.resolveIdentity(name, config);
    this.memoryScope = this.resolveMemoryScope(name, config);
```

Add methods near other protected hooks:

```ts
  protected onTaskLifecycle(_event: ChannelTaskLifecycleEvent): void {}

  private emitTaskLifecycle(event: ChannelTaskLifecycleEvent): void {
    try {
      this.onTaskLifecycle(event);
    } catch (err) {
      process.stderr.write(
        `[${this.name}] onTaskLifecycle threw for ${event.type} session ${event.sessionId}: ${
          err instanceof Error ? err.message : err
        }\n`,
      );
    }
  }

  private resolveIdentity(
    name: string,
    config: ChannelConfig,
  ): ChannelRuntimeIdentity {
    return {
      id: config.identity?.id || `channel:${name}`,
      displayName: config.identity?.displayName || name,
      ...(config.identity?.description
        ? { description: config.identity.description }
        : {}),
    };
  }

  private resolveMemoryScope(
    name: string,
    config: ChannelConfig,
  ): ChannelRuntimeMemoryScope {
    return {
      namespace: config.memoryScope?.namespace || `channel:${name}`,
      mode: 'metadata-only',
    };
  }
```

Emit `started` after `this.activePrompts.set(sessionId, promptState);`:

```ts
      this.emitTaskLifecycle({
        type: 'started',
        channelName: this.name,
        chatId: envelope.chatId,
        sessionId,
        messageId: envelope.messageId,
        identity: this.identity,
        memoryScope: this.memoryScope,
      });
```

- [ ] **Step 5: Run test to verify Task 1 passes**

Run:

```bash
cd packages/channels/base
npx vitest run src/ChannelBase.test.ts
```

Expected: both new metadata tests pass; existing tests still pass.

## Task 2: Add Prompt Boundary And Status Visibility

**Files:**
- Modify: `packages/channels/base/src/ChannelBase.ts`
- Test: `packages/channels/base/src/ChannelBase.test.ts`

- [ ] **Step 1: Write failing prompt and status tests**

Add tests near existing instruction and command tests:

```ts
it('prepends channel boundary metadata before custom instructions once per session', async () => {
  const ch = createChannel({
    instructions: 'Be concise.',
    identity: {
      id: 'ops-agent',
      displayName: 'Ops Agent',
      description: 'Coordinates repository operations.',
    },
    memoryScope: {
      namespace: 'qwen-tag:ops',
      mode: 'metadata-only',
    },
  });

  await ch.handleInbound(envelope({ text: 'first' }));
  await ch.handleInbound(envelope({ text: 'second' }));

  const prompt = vi.mocked(bridge.prompt).mock.calls[0]![1];
  expect(prompt).toContain('Channel identity:');
  expect(prompt).toContain('- id: ops-agent');
  expect(prompt).toContain('- display name: Ops Agent');
  expect(prompt).toContain(
    '- description: Coordinates repository operations.',
  );
  expect(prompt).toContain('Memory scope:');
  expect(prompt).toContain('- namespace: qwen-tag:ops');
  expect(prompt).toContain('- mode: metadata-only');
  expect(prompt).toContain('- storage isolation: not enforced by this version.');
  expect(prompt.indexOf('Channel identity:')).toBeLessThan(
    prompt.indexOf('Be concise.'),
  );

  const secondPrompt = vi.mocked(bridge.prompt).mock.calls[1]![1];
  expect(secondPrompt).not.toContain('Channel identity:');
});

it('/who and /status include channel identity and memory metadata', async () => {
  const ch = createChannel({
    identity: { id: 'ops-agent', displayName: 'Ops Agent' },
    memoryScope: { namespace: 'qwen-tag:ops', mode: 'metadata-only' },
  });

  await ch.handleInbound(envelope({ text: '/who' }));
  await ch.handleInbound(envelope({ text: '/status' }));

  expect(ch.sent[0]!.text).toContain('Identity: Ops Agent');
  expect(ch.sent[0]!.text).toContain('Memory: qwen-tag:ops');
  expect(ch.sent[1]!.text).toContain('Identity: ops-agent');
  expect(ch.sent[1]!.text).toContain('Memory: metadata-only');
});
```

- [ ] **Step 2: Run tests to verify failures**

Run:

```bash
cd packages/channels/base
npx vitest run src/ChannelBase.test.ts
```

Expected: fails because prompt boundary and status lines are not implemented.

- [ ] **Step 3: Implement boundary formatter in `ChannelBase.ts`**

Add private method near metadata resolvers:

```ts
  private channelBoundaryPrompt(): string {
    const identityLines = [
      'Channel identity:',
      `- id: ${this.identity.id}`,
      `- display name: ${this.identity.displayName}`,
      ...(this.identity.description
        ? [`- description: ${this.identity.description}`]
        : []),
    ];
    const memoryLines = [
      'Memory scope:',
      `- namespace: ${this.memoryScope.namespace}`,
      `- mode: ${this.memoryScope.mode}`,
      '- storage isolation: not enforced by this version.',
    ];
    return [...identityLines, '', ...memoryLines].join('\n');
  }
```

Replace the existing instruction block:

```ts
    if (this.config.instructions && !this.instructedSessions.has(sessionId)) {
      promptText = `${this.config.instructions}\n\n${promptText}`;
      this.instructedSessions.add(sessionId);
    }
```

with:

```ts
    if (!this.instructedSessions.has(sessionId)) {
      const prefix = this.config.instructions
        ? `${this.channelBoundaryPrompt()}\n\n${this.config.instructions}`
        : this.channelBoundaryPrompt();
      promptText = `${prefix}\n\n${promptText}`;
      this.instructedSessions.add(sessionId);
    }
```

- [ ] **Step 4: Add status lines**

In `/who` lines, after `Channel: ${this.name}`, add:

```ts
          `Identity: ${this.identity.displayName}`,
          `Memory: ${this.memoryScope.namespace}`,
```

In `/status` lines, after `Channel: ${this.name}`, add:

```ts
        `Identity: ${this.identity.id}`,
        `Memory: ${this.memoryScope.mode}`,
```

- [ ] **Step 5: Run tests**

Run:

```bash
cd packages/channels/base
npx vitest run src/ChannelBase.test.ts
```

Expected: prompt boundary and status tests pass; existing instruction tests are updated if they expected custom instructions to be the only prefix.

## Task 3: Emit Full Task Lifecycle Events

**Files:**
- Modify: `packages/channels/base/src/ChannelBase.ts`
- Test: `packages/channels/base/src/ChannelBase.test.ts`

- [ ] **Step 1: Write failing lifecycle tests**

Add tests near existing streaming/cancel/dispatch tests:

```ts
it('emits task lifecycle for chunks, tool calls, and completion', async () => {
  vi.mocked(bridge.prompt).mockImplementation(async () => {
    (bridge as unknown as EventEmitter).emit('textChunk', 's-1', 'hello ');
    (bridge as unknown as EventEmitter).emit('toolCall', {
      sessionId: 's-1',
      toolCallId: 'tool-1',
      kind: 'shell',
      status: 'running',
    });
    return 'agent response';
  });
  const ch = createChannel();

  await ch.handleInbound(envelope({ messageId: 'm-1' }));

  expect(ch.taskEvents.map((event) => event.type)).toEqual([
    'started',
    'text_chunk',
    'tool_call',
    'completed',
  ]);
  expect(ch.taskEvents[1]).toMatchObject({
    type: 'text_chunk',
    chunk: 'hello ',
  });
  expect(ch.taskEvents[2]).toMatchObject({
    type: 'tool_call',
    toolCall: { toolCallId: 'tool-1' },
  });
});

it('emits failed lifecycle event when prompt rejects', async () => {
  vi.mocked(bridge.prompt).mockRejectedValue(new Error('boom'));
  const ch = createChannel();

  await expect(ch.handleInbound(envelope())).rejects.toThrow('boom');

  expect(ch.taskEvents.map((event) => event.type)).toEqual([
    'started',
    'failed',
  ]);
  expect(ch.taskEvents[1]).toMatchObject({
    type: 'failed',
    error: 'boom',
  });
});
```

For cancellation coverage, add focused assertions to existing `/cancel`, `/clear`, and `steer` tests instead of duplicating their setup:

```ts
expect(ch.taskEvents).toContainEqual(
  expect.objectContaining({ type: 'cancelled', reason: 'cancel_command' }),
);
expect(ch.taskEvents).toContainEqual(
  expect.objectContaining({ type: 'cancelled', reason: 'clear' }),
);
expect(ch.taskEvents).toContainEqual(
  expect.objectContaining({ type: 'cancelled', reason: 'steer' }),
);
```

- [ ] **Step 2: Run tests to verify failures**

Run:

```bash
cd packages/channels/base
npx vitest run src/ChannelBase.test.ts
```

Expected: fails because only `started` is emitted.

- [ ] **Step 3: Add helper methods for lifecycle payloads**

Add private helper:

```ts
  private lifecycleBase(
    chatId: string,
    sessionId: string,
    messageId?: string,
  ) {
    return {
      channelName: this.name,
      chatId,
      sessionId,
      ...(messageId ? { messageId } : {}),
      identity: this.identity,
      memoryScope: this.memoryScope,
    };
  }
```

Update `started` to spread `this.lifecycleBase(...)`.

- [ ] **Step 4: Emit text chunk and tool call events**

In `bridgeToolCallListener`, after `this.onToolCall(target.chatId, event);`, add:

```ts
      this.emitTaskLifecycle({
        type: 'tool_call',
        channelName: this.name,
        chatId: target.chatId,
        sessionId: event.sessionId,
        toolCall: event,
        identity: this.identity,
        memoryScope: this.memoryScope,
      });
```

In `onChunk`, after `this.onResponseChunk(...)`, add:

```ts
          this.emitTaskLifecycle({
            type: 'text_chunk',
            ...this.lifecycleBase(envelope.chatId, sessionId, envelope.messageId),
            chunk,
          });
```

- [ ] **Step 5: Emit cancellation events**

In `/cancel`, after `active.cancelled = true;`, add:

```ts
      this.emitTaskLifecycle({
        type: 'cancelled',
        ...this.lifecycleBase(active.chatId, activeSessionId, active.messageId),
        reason: 'cancel_command',
      });
```

In `/clear`, when `active` exists before waiting, add:

```ts
            this.emitTaskLifecycle({
              type: 'cancelled',
              ...this.lifecycleBase(active.chatId, id, active.messageId),
              reason: 'clear',
            });
```

In `steer`, after `active.cancelled = true;`, add:

```ts
          this.emitTaskLifecycle({
            type: 'cancelled',
            ...this.lifecycleBase(active.chatId, sessionId, active.messageId),
            reason: 'steer',
          });
```

- [ ] **Step 6: Emit completed and failed events**

In the prompt `try` block, after response delivery finishes and only when `!promptState.cancelled`, add:

```ts
          this.emitTaskLifecycle({
            type: 'completed',
            ...this.lifecycleBase(envelope.chatId, sessionId, envelope.messageId),
          });
```

Convert the `try/finally` into `try/catch/finally`:

```ts
      } catch (err) {
        this.emitTaskLifecycle({
          type: 'failed',
          ...this.lifecycleBase(envelope.chatId, sessionId, envelope.messageId),
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      } finally {
```

- [ ] **Step 7: Run lifecycle tests**

Run:

```bash
cd packages/channels/base
npx vitest run src/ChannelBase.test.ts
```

Expected: all `ChannelBase` tests pass.

## Task 4: Config Parsing, Exports, And Verification

**Files:**
- Modify: `packages/cli/src/commands/channel/config-utils.ts`
- Modify: `packages/cli/src/commands/channel/config-utils.test.ts`
- Modify: `packages/channels/base/src/index.ts`
- Test: `packages/cli/src/commands/channel/config-utils.test.ts`

- [ ] **Step 1: Write failing config parsing test**

In `config-utils.test.ts`, add to the full config parse test or a new test:

```ts
it('preserves channel identity and metadata-only memory scope config', async () => {
  const result = await parseChannelConfig('bot', {
    type: 'telegram',
    token: 'tok',
    identity: {
      id: 'ops-agent',
      displayName: 'Ops Agent',
      description: 'Coordinates repository operations.',
    },
    memoryScope: {
      namespace: 'qwen-tag:ops',
      mode: 'metadata-only',
    },
  });

  expect(result.identity).toEqual({
    id: 'ops-agent',
    displayName: 'Ops Agent',
    description: 'Coordinates repository operations.',
  });
  expect(result.memoryScope).toEqual({
    namespace: 'qwen-tag:ops',
    mode: 'metadata-only',
  });
});
```

- [ ] **Step 2: Run config test to verify failure**

Run:

```bash
cd packages/cli
npx vitest run src/commands/channel/config-utils.test.ts
```

Expected: fails if parser drops the new config fields.

- [ ] **Step 3: Preserve config fields**

In `config-utils.ts`, add to the returned config object:

```ts
    identity: rawConfig['identity'] as ChannelConfig['identity'],
    memoryScope: rawConfig['memoryScope'] as ChannelConfig['memoryScope'],
```

- [ ] **Step 4: Ensure public exports**

If `types.ts` exports the new types and `index.ts` already uses `export type { ... } from './types.js';`, add the new type names there:

```ts
  ChannelIdentityConfig,
  ChannelRuntimeIdentity,
  ChannelMemoryScopeConfig,
  ChannelRuntimeMemoryScope,
  ChannelTaskLifecycleEvent,
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
cd packages/channels/base
npx vitest run src/ChannelBase.test.ts src/SessionRouter.test.ts
cd ../../cli
npx vitest run src/commands/channel/config-utils.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 6: Run final verification**

Run from repo root:

```bash
npm run build
npm run typecheck
```

Expected: both commands pass. Existing warning-only lint output from dependency install or unrelated packages is not part of this verification.

- [ ] **Step 7: Commit implementation**

Review the diff and stage only intended files:

```bash
git diff -- packages/channels/base/src/types.ts packages/channels/base/src/ChannelBase.ts packages/channels/base/src/ChannelBase.test.ts packages/channels/base/src/index.ts packages/cli/src/commands/channel/config-utils.ts packages/cli/src/commands/channel/config-utils.test.ts
git add packages/channels/base/src/types.ts packages/channels/base/src/ChannelBase.ts packages/channels/base/src/ChannelBase.test.ts packages/channels/base/src/index.ts packages/cli/src/commands/channel/config-utils.ts packages/cli/src/commands/channel/config-utils.test.ts
git commit -m "feat(channels): add identity and task lifecycle metadata"
```

Expected: commit contains no `package-lock.json`, generated assets, or platform adapter UI changes.

