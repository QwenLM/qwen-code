import { describe, expect, it, vi } from 'vitest';
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
} from '@agentclientprotocol/sdk';
import {
  DaemonChannelBridge,
  type DaemonChannelEvent,
  type DaemonChannelLoopMcpHost,
  type DaemonChannelSessionClient,
} from './DaemonChannelBridge.js';
import {
  CHANNEL_PROMPT_AUTHORIZATION_META_KEY,
  CHANNEL_PROMPT_META_KEY,
  type ChannelPromptImage,
} from './ChannelAgentBridge.js';

class EventQueue implements AsyncGenerator<DaemonChannelEvent> {
  private events: DaemonChannelEvent[] = [];
  private waiters: Array<{
    resolve: (value: IteratorResult<DaemonChannelEvent>) => void;
    reject: (error: unknown) => void;
  }> = [];
  private closed = false;
  private failure: unknown;

  async next(): Promise<IteratorResult<DaemonChannelEvent>> {
    if (this.failure) {
      throw this.failure;
    }
    const event = this.events.shift();
    if (event) {
      return { done: false, value: event };
    }
    if (this.closed) {
      return { done: true, value: undefined };
    }
    return await new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  async return(): Promise<IteratorResult<DaemonChannelEvent>> {
    this.close();
    return { done: true, value: undefined };
  }

  async throw(error?: unknown): Promise<IteratorResult<DaemonChannelEvent>> {
    this.close();
    throw error;
  }

  [Symbol.asyncIterator](): AsyncGenerator<DaemonChannelEvent> {
    return this;
  }

  push(event: DaemonChannelEvent): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ done: false, value: event });
      return;
    }
    this.events.push(event);
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }

  fail(error: unknown): void {
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(error);
    }
  }
}

interface FakeSession extends DaemonChannelSessionClient {
  prompt: ReturnType<typeof vi.fn>;
  uploadAttachment: ReturnType<typeof vi.fn>;
  removeAttachment: ReturnType<typeof vi.fn>;
  events: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  setModel: ReturnType<typeof vi.fn>;
  respondToPermission: ReturnType<typeof vi.fn>;
}

function createFakeSession(
  events: EventQueue,
  sessionId = 'session-1',
): FakeSession {
  return {
    sessionId,
    workspaceCwd: '/repo',
    lastEventId: undefined,
    prompt: vi.fn().mockImplementation(async () => ({})),
    uploadAttachment: vi.fn(),
    removeAttachment: vi.fn().mockResolvedValue(true),
    events: vi.fn((opts?: { signal?: AbortSignal }) => {
      opts?.signal?.addEventListener('abort', () => events.close(), {
        once: true,
      });
      return events;
    }),
    cancel: vi.fn().mockResolvedValue(undefined),
    setModel: vi.fn().mockResolvedValue({}),
    respondToPermission: vi.fn().mockResolvedValue(true),
  };
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let i = 0; i < 20; i += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  throw lastError;
}

async function drainMicrotasks(): Promise<void> {
  for (let index = 0; index < 20; index++) {
    await Promise.resolve();
  }
}

function turnCompleteEvent(sessionId = 'session-1'): DaemonChannelEvent {
  return {
    v: 1,
    type: 'turn_complete',
    data: { sessionId, stopReason: 'end_turn' },
  };
}

describe('DaemonChannelBridge', () => {
  it('deletes an internal session through its owning workspace', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    const deleteSessionData = vi.fn().mockResolvedValue(undefined);
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi.fn().mockResolvedValue(session),
      deleteSessionData,
    });

    await bridge.start();
    await bridge.newSession('/repo');
    await bridge.deleteSessionData?.('session-1');

    expect(deleteSessionData).toHaveBeenCalledWith('session-1');
    expect(bridge.listSessions()).toEqual([]);
    events.close();
    bridge.stop();
  });

  it('deletes session data after the live binding has already died', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    const deleteSessionData = vi.fn().mockResolvedValue(undefined);
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi.fn().mockResolvedValue(session),
      deleteSessionData,
    });

    await bridge.start();
    await bridge.newSession('/repo');
    events.push({
      v: 1,
      type: 'session_died',
      data: { sessionId: 'session-1', reason: 'child_exit' },
    });
    await waitFor(() => expect(bridge.listSessions()).toEqual([]));

    await bridge.deleteSessionData?.('session-1');

    expect(deleteSessionData).toHaveBeenCalledWith('session-1');
    events.close();
    bridge.stop();
  });

  it('keeps the live binding when permanent deletion fails', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    const deleteSessionData = vi.fn().mockRejectedValue(new Error('locked'));
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi.fn().mockResolvedValue(session),
      deleteSessionData,
    });

    await bridge.start();
    await bridge.newSession('/repo');
    await expect(bridge.deleteSessionData?.('session-1')).rejects.toThrow(
      'locked',
    );

    expect(bridge.listSessions()).toHaveLength(1);
    events.close();
    bridge.stop();
  });

  it('registers the loop MCP server for the exact daemon session', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    const handlers = new Map<
      string,
      (
        message: Record<string, unknown>,
      ) => Promise<Record<string, unknown> | undefined>
    >();
    const host: DaemonChannelLoopMcpHost = {
      register: vi.fn(async (sessionId, handler) => {
        handlers.set(sessionId, handler);
      }),
      unregister: vi.fn(async (sessionId) => {
        handlers.delete(sessionId);
      }),
    };
    const create = vi.fn(async () => ({ text: 'created' }));
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi.fn().mockResolvedValue(session),
      channelLoopMcpHost: host,
    });
    bridge.registerChannelLoopToolHandler({
      create,
      list: vi.fn(async () => ({ text: 'listed' })),
      cancel: vi.fn(async () => ({ text: 'cancelled' })),
    });

    await bridge.start();
    await bridge.newSession('/repo');

    expect(host.register).toHaveBeenCalledWith(
      'session-1',
      expect.any(Function),
    );
    await expect(
      handlers.get('session-1')?.({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'channel_loop_create',
          arguments: { cron: '*/5 * * * *', prompt: 'check status' },
        },
      }),
    ).resolves.toMatchObject({
      id: 1,
      result: { content: [{ type: 'text', text: 'created' }] },
    });
    expect(create).toHaveBeenCalledWith('session-1', {
      cron: '*/5 * * * *',
      prompt: 'check status',
    });

    await bridge.discardSession('session-1');
    await waitFor(() =>
      expect(host.unregister).toHaveBeenCalledWith('session-1'),
    );
    expect(handlers.has('session-1')).toBe(false);
    bridge.stop();
  });

  it.each(['new', 'load'] as const)(
    'does not attach loop tools to an opted-out %s session',
    async (operation) => {
      const events = new EventQueue();
      const session = createFakeSession(events);
      const host: DaemonChannelLoopMcpHost = {
        register: vi.fn().mockResolvedValue(undefined),
        unregister: vi.fn().mockResolvedValue(undefined),
      };
      const bridge = new DaemonChannelBridge({
        cwd: '/repo',
        sessionFactory: vi.fn().mockResolvedValue(session),
        channelLoopMcpHost: host,
      });
      bridge.registerChannelLoopToolHandler({
        create: vi.fn(async () => ({ text: 'created' })),
        list: vi.fn(async () => ({ text: 'listed' })),
        cancel: vi.fn(async () => ({ text: 'cancelled' })),
      });

      await bridge.start();
      if (operation === 'new') {
        await bridge.newSession('/repo', { enableChannelLoops: false });
      } else {
        await bridge.loadSession('session-1', '/repo', {
          enableChannelLoops: false,
        });
      }

      expect(host.register).not.toHaveBeenCalled();
      events.close();
      bridge.stop();
    },
  );

  it.each(['new', 'load'] as const)(
    'keeps an opted-out %s session excluded when the loop handler registers later',
    async (operation) => {
      const events = new EventQueue();
      const session = createFakeSession(events);
      const host: DaemonChannelLoopMcpHost = {
        register: vi.fn().mockResolvedValue(undefined),
        unregister: vi.fn().mockResolvedValue(undefined),
      };
      const bridge = new DaemonChannelBridge({
        cwd: '/repo',
        sessionFactory: vi.fn().mockResolvedValue(session),
        channelLoopMcpHost: host,
      });

      await bridge.start();
      if (operation === 'new') {
        await bridge.newSession('/repo', { enableChannelLoops: false });
      } else {
        await bridge.loadSession('session-1', '/repo', {
          enableChannelLoops: false,
        });
      }
      bridge.registerChannelLoopToolHandler({
        create: vi.fn(async () => ({ text: 'created' })),
        list: vi.fn(async () => ({ text: 'listed' })),
        cancel: vi.fn(async () => ({ text: 'cancelled' })),
      });
      await Promise.resolve();

      expect(host.register).not.toHaveBeenCalled();
      events.close();
      bridge.stop();
    },
  );

  it('revokes loop tools when an enabled session is replaced by an opted-out binding', async () => {
    const firstEvents = new EventQueue();
    const secondEvents = new EventQueue();
    const firstSession = createFakeSession(firstEvents);
    const secondSession = createFakeSession(secondEvents);
    let registeredHandler!:
      | ((
          message: Record<string, unknown>,
        ) => Promise<Record<string, unknown> | undefined>)
      | undefined;
    const host: DaemonChannelLoopMcpHost = {
      register: vi.fn(async (_sessionId, handler) => {
        registeredHandler = handler;
      }),
      unregister: vi.fn().mockResolvedValue(undefined),
    };
    const create = vi.fn(async () => ({ text: 'created' }));
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi
        .fn()
        .mockResolvedValueOnce(firstSession)
        .mockResolvedValueOnce(secondSession),
      channelLoopMcpHost: host,
    });
    bridge.registerChannelLoopToolHandler({
      create,
      list: vi.fn(async () => ({ text: 'listed' })),
      cancel: vi.fn(async () => ({ text: 'cancelled' })),
    });

    await bridge.start();
    await bridge.newSession('/repo');
    const staleHandler = registeredHandler!;
    await bridge.loadSession('session-1', '/repo', {
      enableChannelLoops: false,
    });

    await waitFor(() =>
      expect(host.unregister).toHaveBeenCalledWith('session-1'),
    );
    await expect(
      staleHandler({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'channel_loop_create',
          arguments: { cron: '*/5 * * * *', prompt: 'check status' },
        },
      }),
    ).resolves.toMatchObject({ id: 1, error: expect.any(Object) });
    expect(create).not.toHaveBeenCalled();
    secondEvents.close();
    bridge.stop();
  });

  it('fails loop tools closed when an in-flight registration is replaced by an opted-out binding', async () => {
    const firstEvents = new EventQueue();
    const secondEvents = new EventQueue();
    const firstSession = createFakeSession(firstEvents);
    const secondSession = createFakeSession(secondEvents);
    let finishRegistration!: () => void;
    const registration = new Promise<void>((resolve) => {
      finishRegistration = resolve;
    });
    let registeredHandler!:
      | ((
          message: Record<string, unknown>,
        ) => Promise<Record<string, unknown> | undefined>)
      | undefined;
    const host: DaemonChannelLoopMcpHost = {
      register: vi.fn((_sessionId, handler) => {
        registeredHandler = handler;
        return registration;
      }),
      unregister: vi.fn().mockResolvedValue(undefined),
    };
    const create = vi.fn(async () => ({ text: 'created' }));
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi
        .fn()
        .mockResolvedValueOnce(firstSession)
        .mockResolvedValueOnce(secondSession),
      channelLoopMcpHost: host,
    });
    bridge.registerChannelLoopToolHandler({
      create,
      list: vi.fn(async () => ({ text: 'listed' })),
      cancel: vi.fn(async () => ({ text: 'cancelled' })),
    });

    await bridge.start();
    const enabled = bridge.newSession('/repo');
    await waitFor(() => expect(host.register).toHaveBeenCalledTimes(1));
    await bridge.loadSession('session-1', '/repo', {
      enableChannelLoops: false,
    });
    await expect(
      registeredHandler!({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'channel_loop_create',
          arguments: { cron: '*/5 * * * *', prompt: 'check status' },
        },
      }),
    ).resolves.toMatchObject({ id: 1, error: expect.any(Object) });
    expect(create).not.toHaveBeenCalled();

    finishRegistration();
    await enabled;
    await waitFor(() =>
      expect(host.unregister).toHaveBeenCalledWith('session-1'),
    );
    secondEvents.close();
    bridge.stop();
  });

  it('re-registers loop tools after a pending opt-out unregister is superseded', async () => {
    const firstEvents = new EventQueue();
    const secondEvents = new EventQueue();
    const thirdEvents = new EventQueue();
    const firstSession = createFakeSession(firstEvents);
    const secondSession = createFakeSession(secondEvents);
    const thirdSession = createFakeSession(thirdEvents);
    let finishUnregister!: () => void;
    const unregister = new Promise<void>((resolve) => {
      finishUnregister = resolve;
    });
    let registeredHandler:
      | ((
          message: Record<string, unknown>,
        ) => Promise<Record<string, unknown> | undefined>)
      | undefined;
    const host: DaemonChannelLoopMcpHost = {
      register: vi.fn(async (_sessionId, handler) => {
        registeredHandler = handler;
      }),
      unregister: vi.fn(() => unregister),
    };
    const create = vi.fn(async () => ({ text: 'created' }));
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi
        .fn()
        .mockResolvedValueOnce(firstSession)
        .mockResolvedValueOnce(secondSession)
        .mockResolvedValueOnce(thirdSession),
      channelLoopMcpHost: host,
    });
    bridge.registerChannelLoopToolHandler({
      create,
      list: vi.fn(async () => ({ text: 'listed' })),
      cancel: vi.fn(async () => ({ text: 'cancelled' })),
    });

    await bridge.start();
    await bridge.newSession('/repo');
    await bridge.loadSession('session-1', '/repo', {
      enableChannelLoops: false,
    });
    await waitFor(() => expect(host.unregister).toHaveBeenCalledTimes(1));

    const enabled = bridge.loadSession('session-1', '/repo');
    expect(host.register).toHaveBeenCalledTimes(1);
    finishUnregister();
    await enabled;

    expect(host.register).toHaveBeenCalledTimes(2);
    await expect(
      registeredHandler!({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'channel_loop_create',
          arguments: { cron: '*/5 * * * *', prompt: 'check status' },
        },
      }),
    ).resolves.toMatchObject({
      id: 1,
      result: { content: [{ type: 'text', text: 'created' }] },
    });
    expect(create).toHaveBeenCalledTimes(1);
    thirdEvents.close();
    bridge.stop();
  });

  it('keeps failed loop unregistration eligible for retry', async () => {
    const firstEvents = new EventQueue();
    const secondEvents = new EventQueue();
    const firstSession = createFakeSession(firstEvents);
    const secondSession = createFakeSession(secondEvents);
    const host: DaemonChannelLoopMcpHost = {
      register: vi.fn().mockResolvedValue(undefined),
      unregister: vi
        .fn()
        .mockRejectedValueOnce(new Error('host busy'))
        .mockResolvedValue(undefined),
    };
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi
        .fn()
        .mockResolvedValueOnce(firstSession)
        .mockResolvedValueOnce(secondSession),
      channelLoopMcpHost: host,
    });
    bridge.registerChannelLoopToolHandler({
      create: vi.fn(async () => ({ text: 'created' })),
      list: vi.fn(async () => ({ text: 'listed' })),
      cancel: vi.fn(async () => ({ text: 'cancelled' })),
    });

    await bridge.start();
    await bridge.newSession('/repo');
    await bridge.loadSession('session-1', '/repo', {
      enableChannelLoops: false,
    });
    await waitFor(() => expect(host.unregister).toHaveBeenCalledTimes(1));

    await bridge.discardSession('session-1');
    await waitFor(() => expect(host.unregister).toHaveBeenCalledTimes(2));
    secondEvents.close();
    bridge.stop();
  });

  it('binds a daemon session and collects assistant chunks during prompt', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    let resolvePrompt: () => void = () => {};
    session.prompt.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePrompt = () => resolve({ stopReason: 'end_turn' });
          events.push({
            id: 1,
            v: 1,
            type: 'session_update',
            data: {
              sessionId: 'session-1',
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'hello' },
              },
            },
          });
        }),
    );
    const factory = vi.fn().mockResolvedValue(session);
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: factory,
    });
    const promptComplete = vi.fn();
    bridge.on('promptComplete', promptComplete);

    await bridge.start();
    const sessionId = await bridge.newSession('/repo');
    const promptPromise = bridge.prompt(sessionId, 'summarize');
    await waitFor(() => expect(session.prompt).toHaveBeenCalledOnce());
    resolvePrompt();
    events.push(turnCompleteEvent());

    await expect(promptPromise).resolves.toBe('hello');
    expect(promptComplete).toHaveBeenCalledWith({
      sessionId: 'session-1',
      text: 'hello',
      stopReason: 'end_turn',
    });
    expect(factory).toHaveBeenCalledWith({
      workspaceCwd: '/repo',
      modelServiceId: undefined,
      sessionScope: 'thread',
    });
    expect(session.prompt).toHaveBeenCalledWith(
      {
        prompt: [{ type: 'text', text: 'summarize' }],
        _meta: { [CHANNEL_PROMPT_META_KEY]: true },
      },
      expect.any(AbortSignal),
    );

    events.close();
    bridge.stop();
  });

  it('passes approval mode to the session factory', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    const factory = vi.fn().mockResolvedValue(session);
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: factory,
    });

    await bridge.start();
    await bridge.newSession('/repo', { approvalMode: 'yolo' });
    await bridge.loadSession('session-1', '/repo', { approvalMode: 'yolo' });

    expect(factory).toHaveBeenNthCalledWith(1, {
      workspaceCwd: '/repo',
      modelServiceId: undefined,
      sessionScope: 'thread',
      approvalMode: 'yolo',
    });
    expect(factory).toHaveBeenNthCalledWith(2, {
      workspaceCwd: '/repo',
      modelServiceId: undefined,
      sessionId: 'session-1',
      sessionScope: 'thread',
      approvalMode: 'yolo',
    });

    events.close();
    bridge.stop();
  });

  it('forwards source metadata to the session factory for new and loaded sessions', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    const factory = vi.fn().mockResolvedValue(session);
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: factory,
    });

    await bridge.start();
    await bridge.newSession('/repo', {
      sourceType: 'channel',
      sourceId: 'feishu-main',
    });
    await bridge.loadSession('session-1', '/repo', {
      sourceType: 'channel',
      sourceId: 'feishu-main',
    });

    expect(factory).toHaveBeenNthCalledWith(1, {
      workspaceCwd: '/repo',
      modelServiceId: undefined,
      sessionScope: 'thread',
      sourceType: 'channel',
      sourceId: 'feishu-main',
    });
    expect(factory).toHaveBeenNthCalledWith(2, {
      workspaceCwd: '/repo',
      modelServiceId: undefined,
      sessionId: 'session-1',
      sessionScope: 'thread',
      sourceType: 'channel',
      sourceId: 'feishu-main',
    });

    events.close();
    bridge.stop();
  });

  it('drains daemon chunks queued with prompt completion', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    session.prompt.mockImplementation(async () => {
      setTimeout(() => {
        events.push({
          id: 1,
          v: 1,
          type: 'session_update',
          data: {
            sessionId: 'session-1',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'late chunk' },
            },
          },
        });
        events.push(turnCompleteEvent());
      }, 0);
      return { stopReason: 'end_turn' };
    });
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi.fn().mockResolvedValue(session),
    });

    await bridge.start();
    await bridge.newSession('/repo');

    await expect(bridge.prompt('session-1', 'summarize')).resolves.toBe(
      'late chunk',
    );

    events.close();
    bridge.stop();
  });

  it('returns only the final turn text after daemon tool calls', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    session.prompt.mockImplementation(async () => {
      events.push({
        id: 1,
        v: 1,
        type: 'session_update',
        data: {
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Let me search. ' },
          },
        },
      });
      events.push({
        id: 2,
        v: 1,
        type: 'session_update',
        data: {
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'call-1',
            kind: 'search',
            title: 'Search',
            status: 'pending',
          },
        },
      });
      events.push({
        id: 3,
        v: 1,
        type: 'session_update',
        data: {
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Final answer.' },
          },
        },
      });
      events.push(turnCompleteEvent());
      return { stopReason: 'end_turn' };
    });
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi.fn().mockResolvedValue(session),
    });

    await bridge.start();
    await bridge.newSession('/repo');

    await expect(bridge.prompt('session-1', 'summarize')).resolves.toBe(
      'Final answer.',
    );

    events.close();
    bridge.stop();
  });

  it('drops kind-less in_progress heartbeats without flagging the session as malformed', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    session.prompt.mockImplementation(async () => {
      events.push({
        id: 1,
        v: 1,
        type: 'session_update',
        data: {
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'call-1',
            status: 'in_progress',
            _meta: {
              toolName: 'run_shell_command',
              shellProgress: { type: 'shell_progress', elapsedMs: 10_000 },
            },
          },
        },
      });
      events.push({
        id: 2,
        v: 1,
        type: 'session_update',
        data: {
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Done.' },
          },
        },
      });
      events.push(turnCompleteEvent());
      return { stopReason: 'end_turn' };
    });
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi.fn().mockResolvedValue(session),
    });
    const errors: Error[] = [];
    const toolCalls: unknown[] = [];
    bridge.on('error', (err) => errors.push(err));
    bridge.on('toolCall', (event) => toolCalls.push(event));

    await bridge.start();
    await bridge.newSession('/repo');

    await expect(bridge.prompt('session-1', 'run it')).resolves.toBe('Done.');
    expect(errors).toHaveLength(0);
    expect(toolCalls).toHaveLength(0);

    events.close();
    bridge.stop();
  });

  it('flags a kind-less in_progress frame WITHOUT shellProgress as malformed', async () => {
    // The heartbeat drop is scoped to frames carrying _meta.shellProgress, so
    // a genuinely malformed kind-less tool_call still reaches emitProtocolError
    // instead of being silently swallowed.
    const events = new EventQueue();
    const session = createFakeSession(events);
    session.prompt.mockImplementation(async () => {
      events.push({
        id: 1,
        v: 1,
        type: 'session_update',
        data: {
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'call-1',
            status: 'in_progress',
            _meta: { toolName: 'run_shell_command' },
          },
        },
      });
      events.push({
        id: 2,
        v: 1,
        type: 'session_update',
        data: {
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Done.' },
          },
        },
      });
      events.push(turnCompleteEvent());
      return { stopReason: 'end_turn' };
    });
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi.fn().mockResolvedValue(session),
    });
    const errors: Error[] = [];
    bridge.on('error', (err) => errors.push(err));

    await bridge.start();
    await bridge.newSession('/repo');

    await expect(bridge.prompt('session-1', 'run it')).resolves.toBe('Done.');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toContain('Malformed');

    events.close();
    bridge.stop();
  });

  it('excludes nested subagent text from the daemon response', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    session.prompt.mockImplementation(async () => {
      events.push({
        id: 1,
        v: 1,
        type: 'session_update',
        data: {
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Nested research report.' },
            _meta: {
              parentToolCallId: 'agent-call-1',
              subagentType: 'Explore',
            },
          },
        },
      });
      events.push({
        id: 2,
        v: 1,
        type: 'session_update',
        data: {
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Final answer.' },
          },
        },
      });
      events.push(turnCompleteEvent());
      return { stopReason: 'end_turn' };
    });
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi.fn().mockResolvedValue(session),
    });

    await bridge.start();
    await bridge.newSession('/repo');

    await expect(bridge.prompt('session-1', 'summarize')).resolves.toBe(
      'Final answer.',
    );

    events.close();
    bridge.stop();
  });

  it('excludes discrete background notifications from the daemon response', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    session.prompt.mockImplementation(async () => {
      events.push({
        id: 1,
        v: 1,
        type: 'session_update',
        data: {
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Final answer.' },
          },
        },
      });
      events.push({
        id: 2,
        v: 1,
        type: 'session_update',
        data: {
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: 'Background agent "Explore" completed.',
            },
            _meta: {
              source: 'background_notification',
              qwenDiscreteMessage: true,
            },
          },
        },
      });
      events.push(turnCompleteEvent());
      return { stopReason: 'end_turn' };
    });
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi.fn().mockResolvedValue(session),
    });

    await bridge.start();
    await bridge.newSession('/repo');

    await expect(bridge.prompt('session-1', 'summarize')).resolves.toBe(
      'Final answer.',
    );

    events.close();
    bridge.stop();
  });

  it('emits the completed background response without appending it to the active turn', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    session.prompt.mockImplementation(async () => {
      events.push({
        id: 1,
        v: 1,
        type: 'session_update',
        data: {
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Initial answer.' },
          },
        },
      });
      events.push(turnCompleteEvent());
      return { stopReason: 'end_turn' };
    });
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi.fn().mockResolvedValue(session),
    });
    const backgroundResponses: Array<[string, string]> = [];
    bridge.on('backgroundResponse', (sessionId, text) => {
      backgroundResponses.push([sessionId, text]);
    });

    await bridge.start();
    await bridge.newSession('/repo');
    await expect(bridge.prompt('session-1', 'investigate')).resolves.toBe(
      'Initial answer.',
    );

    events.push({
      id: 2,
      v: 1,
      type: 'session_update',
      data: {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Background final answer.' },
          _meta: {
            source: 'background_notification_response',
            qwenDiscreteMessage: true,
          },
        },
      },
    });

    await vi.waitFor(() => {
      expect(backgroundResponses).toEqual([
        ['session-1', 'Background final answer.'],
      ]);
    });

    events.close();
    bridge.stop();
  });

  it('emits discrete vision bridge notices as text chunks', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi.fn().mockResolvedValue(session),
    });
    const textChunks: Array<[string, string]> = [];
    bridge.on('textChunk', (sessionId, text) => {
      textChunks.push([sessionId, text]);
    });

    await bridge.start();
    await bridge.newSession('/repo');
    events.push({
      id: 1,
      v: 1,
      type: 'session_update',
      data: {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Vision bridge cancelled.' },
          _meta: {
            source: 'vision_bridge_notice',
            qwenDiscreteMessage: true,
          },
        },
      },
    });

    await vi.waitFor(() => {
      expect(textChunks).toEqual([['session-1', 'Vision bridge cancelled.']]);
    });

    events.close();
    bridge.stop();
  });

  it('ignores a rewritten background response to avoid duplicate delivery', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    session.prompt.mockImplementation(async () => {
      events.push(turnCompleteEvent());
      return { stopReason: 'end_turn' };
    });
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi.fn().mockResolvedValue(session),
    });
    const backgroundResponses: Array<[string, string]> = [];
    bridge.on('backgroundResponse', (sessionId, text) => {
      backgroundResponses.push([sessionId, text]);
    });

    await bridge.start();
    await bridge.newSession('/repo');
    await bridge.prompt('session-1', 'investigate');

    events.push({
      id: 2,
      v: 1,
      type: 'session_update',
      data: {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Background final answer.' },
          _meta: {
            source: 'background_notification_response',
            qwenDiscreteMessage: true,
            rewritten: true,
          },
        },
      },
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(backgroundResponses).toEqual([]);

    events.close();
    bridge.stop();
  });

  it('returns only the final slash-command output from the daemon', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    session.prompt.mockImplementation(async () => {
      events.push({
        id: 1,
        v: 1,
        type: 'session_update',
        data: {
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Compressing context...' },
            _meta: { source: 'slash_command' },
          },
        },
      });
      events.push({
        id: 2,
        v: 1,
        type: 'session_update',
        data: {
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Context compressed.' },
            _meta: { source: 'slash_command' },
          },
        },
      });
      events.push(turnCompleteEvent());
      return { stopReason: 'end_turn' };
    });
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi.fn().mockResolvedValue(session),
    });

    await bridge.start();
    await bridge.newSession('/repo');

    await expect(bridge.prompt('session-1', 'summarize')).resolves.toBe(
      'Context compressed.',
    );

    events.close();
    bridge.stop();
  });

  it('prefers daemon model text over slash-command output', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    session.prompt.mockImplementation(async () => {
      events.push({
        id: 1,
        v: 1,
        type: 'session_update',
        data: {
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Slash output' },
            _meta: { source: 'slash_command' },
          },
        },
      });
      events.push({
        id: 2,
        v: 1,
        type: 'session_update',
        data: {
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Model text' },
          },
        },
      });
      events.push(turnCompleteEvent());
      return { stopReason: 'end_turn' };
    });
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi.fn().mockResolvedValue(session),
    });

    await bridge.start();
    await bridge.newSession('/repo');

    await expect(bridge.prompt('session-1', 'summarize')).resolves.toBe(
      'Model text',
    );

    events.close();
    bridge.stop();
  });

  it('drops slash-command updates from another daemon session', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    session.prompt.mockImplementation(async () => {
      events.push({
        id: 1,
        v: 1,
        type: 'session_update',
        data: {
          sessionId: 'session-2',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Other session output' },
            _meta: { source: 'slash_command' },
          },
        },
      });
      events.push(turnCompleteEvent());
      return { stopReason: 'end_turn' };
    });
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi.fn().mockResolvedValue(session),
    });

    await bridge.start();
    await bridge.newSession('/repo');

    await expect(bridge.prompt('session-1', 'summarize')).resolves.toBe('');

    events.close();
    bridge.stop();
  });

  it('ignores emitted slash-command output for another prompt session', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    session.prompt.mockImplementation(async () => {
      bridge.emit('slashCommandOutput', 'session-2', 'Other session output');
      return { stopReason: 'end_turn' };
    });
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi.fn().mockResolvedValue(session),
    });

    await bridge.start();
    await bridge.newSession('/repo');

    await expect(bridge.prompt('session-1', 'summarize')).resolves.toBe('');

    events.close();
    bridge.stop();
  });

  it('returns only the final turn text after daemon auto-approved tool calls', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    session.prompt.mockImplementation(async () => {
      events.push({
        id: 1,
        v: 1,
        type: 'session_update',
        data: {
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Let me inspect. ' },
          },
        },
      });
      events.push({
        id: 2,
        v: 1,
        type: 'session_update',
        data: {
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'call-1',
            kind: 'read',
            title: 'Read',
            status: 'in_progress',
          },
        },
      });
      events.push({
        id: 3,
        v: 1,
        type: 'session_update',
        data: {
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Final answer.' },
          },
        },
      });
      events.push(turnCompleteEvent());
      return { stopReason: 'end_turn' };
    });
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi.fn().mockResolvedValue(session),
    });

    await bridge.start();
    await bridge.newSession('/repo');

    await expect(bridge.prompt('session-1', 'summarize')).resolves.toBe(
      'Final answer.',
    );

    events.close();
    bridge.stop();
  });

  it('treats daemon permission requests as turn boundaries', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    const permissionRequest: RequestPermissionRequest & { requestId: string } =
      {
        requestId: 'req-1',
        sessionId: 'session-1',
        toolCall: {
          toolCallId: 'tool-1',
          kind: 'shell',
          title: 'Run command',
        },
        options: [
          { optionId: 'proceed_once', kind: 'allow_once', name: 'Allow' },
        ],
      } as RequestPermissionRequest & { requestId: string };
    session.prompt.mockImplementation(async () => {
      events.push({
        id: 1,
        v: 1,
        type: 'session_update',
        data: {
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'I need permission. ' },
          },
        },
      });
      events.push({
        id: 2,
        v: 1,
        type: 'permission_request',
        data: permissionRequest,
      });
      events.push({
        id: 3,
        v: 1,
        type: 'session_update',
        data: {
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Final answer.' },
          },
        },
      });
      events.push(turnCompleteEvent());
      return { stopReason: 'end_turn' };
    });
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi.fn().mockResolvedValue(session),
    });
    bridge.on('permissionRequest', (event) => {
      void bridge.respondToPermission(event.requestId, {
        outcome: { outcome: 'selected', optionId: 'proceed_once' },
      });
    });

    await bridge.start();
    await bridge.newSession('/repo');

    await expect(bridge.prompt('session-1', 'summarize')).resolves.toBe(
      'Final answer.',
    );

    events.close();
    bridge.stop();
  });

  it('treats daemon plan updates as turn boundaries', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    session.prompt.mockImplementation(async () => {
      events.push({
        id: 1,
        v: 1,
        type: 'session_update',
        data: {
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Updating todos. ' },
          },
        },
      });
      events.push({
        id: 2,
        v: 1,
        type: 'session_update',
        data: {
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'plan',
            entries: [{ content: 'Task', status: 'pending' }],
          },
        },
      });
      events.push({
        id: 3,
        v: 1,
        type: 'session_update',
        data: {
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Done.' },
          },
        },
      });
      events.push(turnCompleteEvent());
      return { stopReason: 'end_turn' };
    });
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi.fn().mockResolvedValue(session),
    });

    await bridge.start();
    await bridge.newSession('/repo');

    await expect(bridge.prompt('session-1', 'summarize')).resolves.toBe(
      'Done.',
    );

    events.close();
    bridge.stop();
  });

  it('rejects prompt and emits protocol error on turn_error', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    session.prompt.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          setTimeout(() => {
            events.push({
              v: 1,
              type: 'turn_error',
              data: {
                sessionId: 'session-1',
                message: 'model_overloaded',
                code: 'overloaded',
              },
            });
            reject(new Error('model_overloaded'));
          }, 0);
        }),
    );
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi.fn().mockResolvedValue(session),
    });
    const errors = vi.fn();
    bridge.on('error', errors);

    await bridge.start();
    await bridge.newSession('/repo');

    await expect(bridge.prompt('session-1', 'summarize')).rejects.toThrow(
      'model_overloaded',
    );
    expect(errors).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('turn error'),
      }),
    );

    events.close();
    bridge.stop();
  });

  it('resolves the turn barrier when a session is cancelled during prompt drain', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    let resolvePrompt: () => void = () => {};
    session.prompt.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePrompt = () => resolve({ stopReason: 'end_turn' });
        }),
    );
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi.fn().mockResolvedValue(session),
    });

    await bridge.start();
    await bridge.newSession('/repo');

    const promptPromise = bridge.prompt('session-1', 'hello');
    await waitFor(() => expect(session.prompt).toHaveBeenCalledOnce());
    resolvePrompt();
    await bridge.cancelSession('session-1');
    await expect(promptPromise).resolves.toBe('');

    events.close();
    bridge.stop();
  });

  it('emits tool, thought, model, commands, and session lifecycle events', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi.fn().mockResolvedValue(session),
    });
    const thoughtChunk = vi.fn();
    const toolCall = vi.fn();
    const modelSwitched = vi.fn();
    const modelSwitchFailed = vi.fn();
    const sessionDied = vi.fn();

    bridge.on('thoughtChunk', thoughtChunk);
    bridge.on('toolCall', toolCall);
    bridge.on('modelSwitched', modelSwitched);
    bridge.on('modelSwitchFailed', modelSwitchFailed);
    bridge.on('sessionDied', sessionDied);

    await bridge.start();
    await bridge.newSession('/repo');

    events.push({
      id: 2,
      v: 1,
      type: 'session_update',
      data: {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: 'thinking' },
        },
      },
    });
    events.push({
      id: 3,
      v: 1,
      type: 'session_update',
      data: {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tool-1',
          kind: 'read_file',
          title: 'Read file',
          status: 'completed',
          rawInput: { path: 'README.md' },
        },
      },
    });
    events.push({
      id: 4,
      v: 1,
      type: 'session_update',
      data: {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: [
            { name: '/help', description: 'Show help', input: null },
            null,
            { description: 'Missing name', input: null },
          ],
        },
      },
    });
    await waitFor(() =>
      expect(bridge.getAvailableCommands('session-1')).toEqual([
        { name: '/help', description: 'Show help', input: null },
      ]),
    );
    expect(bridge.availableCommands).toEqual([
      { name: '/help', description: 'Show help', input: null },
    ]);

    events.push({
      id: 5,
      v: 1,
      type: 'model_switched',
      data: { sessionId: 'session-1', modelId: 'qwen3-coder-plus' },
    });
    events.push({
      id: 6,
      v: 1,
      type: 'model_switch_failed',
      data: {
        sessionId: 'session-1',
        requestedModelId: 'missing-model',
        error: 'not configured',
      },
    });
    events.push({
      id: 7,
      v: 1,
      type: 'session_died',
      data: { sessionId: 'session-1', reason: 'agent exited' },
    });

    await waitFor(() =>
      expect(thoughtChunk).toHaveBeenCalledWith('session-1', 'thinking'),
    );
    expect(toolCall).toHaveBeenCalledWith({
      sessionId: 'session-1',
      toolCallId: 'tool-1',
      kind: 'read_file',
      title: 'Read file',
      status: 'completed',
      rawInput: { path: 'README.md' },
    });
    await waitFor(() =>
      expect(modelSwitched).toHaveBeenCalledWith({
        sessionId: 'session-1',
        modelId: 'qwen3-coder-plus',
      }),
    );
    await waitFor(() =>
      expect(modelSwitchFailed).toHaveBeenCalledWith({
        sessionId: 'session-1',
        requestedModelId: 'missing-model',
        error: 'not configured',
      }),
    );
    await waitFor(() =>
      expect(sessionDied).toHaveBeenCalledWith({
        sessionId: 'session-1',
        reason: 'agent exited',
      }),
    );
    expect(bridge.getAvailableCommands('session-1')).toEqual([]);

    events.close();
  });

  it('keeps available commands scoped per daemon session', async () => {
    const firstEvents = new EventQueue();
    const secondEvents = new EventQueue();
    const firstSession = createFakeSession(firstEvents, 'session-1');
    const secondSession = createFakeSession(secondEvents, 'session-2');
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi
        .fn()
        .mockResolvedValueOnce(firstSession)
        .mockResolvedValueOnce(secondSession),
    });

    await bridge.start();
    await bridge.newSession('/repo');
    await bridge.newSession('/repo');

    firstEvents.push({
      id: 1,
      v: 1,
      type: 'session_update',
      data: {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: [
            { name: '/one', description: 'First', input: null },
          ],
        },
      },
    });
    secondEvents.push({
      id: 2,
      v: 1,
      type: 'session_update',
      data: {
        sessionId: 'session-2',
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: [
            { name: '/two', description: 'Second', input: null },
          ],
        },
      },
    });

    await waitFor(() =>
      expect(bridge.getAvailableCommands('session-2')).toEqual([
        { name: '/two', description: 'Second', input: null },
      ]),
    );
    expect(bridge.getAvailableCommands('session-1')).toEqual([
      { name: '/one', description: 'First', input: null },
    ]);
    expect(bridge.availableCommands).toEqual([
      { name: '/two', description: 'Second', input: null },
    ]);

    secondEvents.push({
      id: 3,
      v: 1,
      type: 'session_died',
      data: { reason: 'gone' },
    });
    await waitFor(() =>
      expect(bridge.getAvailableCommands('session-2')).toEqual([]),
    );
    expect(bridge.availableCommands).toEqual([
      { name: '/one', description: 'First', input: null },
    ]);

    firstEvents.close();
    secondEvents.close();
    bridge.stop();
  });

  it('surfaces command aliases (altNames) carried in the wire snapshot', async () => {
    // The producer carries aliases in _meta.altNames (ACP's extension point); a
    // top-level altNames is also accepted for forward-compat. Both must be lifted
    // onto the stored command so attribution can recognize an aliased command.
    const events = new EventQueue();
    const session = createFakeSession(events);
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi.fn().mockResolvedValue(session),
    });

    await bridge.start();
    await bridge.newSession('/repo');

    events.push({
      id: 1,
      v: 1,
      type: 'session_update',
      data: {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: [
            {
              name: '/compress',
              description: 'Compress context',
              input: null,
              _meta: { altNames: ['summarize'] },
            },
            {
              name: '/auth',
              description: 'Authenticate',
              input: null,
              altNames: ['login', 'connect'],
            },
            { name: '/help', description: 'Show help', input: null },
          ],
        },
      },
    });

    await waitFor(() => {
      const commands = bridge.getAvailableCommands('session-1');
      expect(commands).toHaveLength(3);
      expect(commands[0]).toMatchObject({
        name: '/compress',
        altNames: ['summarize'],
      });
      expect(commands[1]).toMatchObject({
        name: '/auth',
        altNames: ['login', 'connect'],
      });
      // A command with no aliases stays alias-free (the field is omitted).
      expect(commands[2].altNames).toBeUndefined();
    });

    events.close();
    bridge.stop();
  });

  it('drops a command whose altNames is a malformed (non-array) wire value', async () => {
    // isAvailableCommand validates altNames' SHAPE (not just `name`): a malformed
    // payload — e.g. `altNames: 5` — would otherwise survive onto the command and
    // throw at the downstream `altNames.some(...)` recognition site. The malformed
    // entry is rejected; valid commands in the same snapshot are unaffected.
    const events = new EventQueue();
    const session = createFakeSession(events);
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi.fn().mockResolvedValue(session),
    });

    await bridge.start();
    await bridge.newSession('/repo');

    events.push({
      id: 1,
      v: 1,
      type: 'session_update',
      data: {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: [
            { name: '/bad', description: 'malformed', altNames: 5 },
            { name: '/help', description: 'Show help', input: null },
          ],
        },
      },
    });

    await waitFor(() => {
      const commands = bridge.getAvailableCommands('session-1');
      // Only the well-formed command survives; the malformed one is filtered out.
      expect(commands).toHaveLength(1);
      expect(commands[0]!.name).toBe('/help');
    });

    events.close();
    bridge.stop();
  });

  it('routes permission responses back through the owning daemon session', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi.fn().mockResolvedValue(session),
    });
    const permissionRequest = vi.fn();
    bridge.on('permissionRequest', permissionRequest);

    await bridge.start();
    await bridge.newSession('/repo');

    const request: RequestPermissionRequest & { requestId: string } = {
      requestId: 'req-1',
      sessionId: 'session-1',
      toolCall: {
        toolCallId: 'tool-1',
        kind: 'edit',
        title: 'Edit file',
        rawInput: {},
      },
      options: [
        { optionId: 'proceed_once', kind: 'allow_once', name: 'Allow' },
      ],
    } as RequestPermissionRequest & { requestId: string };
    events.push({
      id: 6,
      v: 1,
      type: 'permission_request',
      data: request,
    });

    await waitFor(() =>
      expect(permissionRequest).toHaveBeenCalledWith({
        requestId: 'req-1',
        sessionId: 'session-1',
        request,
      }),
    );

    const response: RequestPermissionResponse = {
      outcome: { outcome: 'selected', optionId: 'proceed_once' },
    };
    await expect(bridge.respondToPermission('req-1', response)).resolves.toBe(
      true,
    );
    expect(session.respondToPermission).toHaveBeenCalledWith('req-1', response);
    await expect(bridge.respondToPermission('req-1', response)).resolves.toBe(
      false,
    );

    const resolved = vi.fn();
    bridge.on('permissionResolved', resolved);
    events.push({
      id: 7,
      v: 1,
      type: 'permission_resolved',
      data: { requestId: 'req-1', outcome: response.outcome },
    });
    await waitFor(() =>
      expect(resolved).toHaveBeenCalledWith({
        requestId: 'req-1',
        outcome: response.outcome,
      }),
    );
    await expect(bridge.respondToPermission('req-1', response)).resolves.toBe(
      false,
    );

    events.push({
      id: 8,
      v: 1,
      type: 'permission_request',
      data: request,
    });
    await waitFor(() => expect(permissionRequest).toHaveBeenCalledTimes(2));
    let staleResponse: Promise<boolean> | undefined;
    bridge.once('sessionDied', () => {
      staleResponse = bridge.respondToPermission('req-1', response);
    });
    events.push({
      id: 9,
      v: 1,
      type: 'session_died',
      data: { reason: 'gone' },
    });
    await waitFor(() => expect(staleResponse).toBeDefined());
    await expect(staleResponse).resolves.toBe(false);

    events.close();
    bridge.stop();
  });

  it('rejects malformed permission resolution outcomes', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi.fn().mockResolvedValue(session),
    });
    const permissionRequest = vi.fn();
    const permissionResolved = vi.fn();
    const errors = vi.fn();
    bridge.on('permissionRequest', permissionRequest);
    bridge.on('permissionResolved', permissionResolved);
    bridge.on('error', errors);

    await bridge.start();
    await bridge.newSession('/repo');

    events.push({
      id: 10,
      v: 1,
      type: 'permission_request',
      data: {
        requestId: 'req-bad-outcome',
        toolCall: {
          toolCallId: 'tool-1',
          kind: 'edit',
          title: 'Edit file',
          rawInput: {},
        },
        options: [
          { optionId: 'proceed_once', kind: 'allow_once', name: 'Allow' },
        ],
      },
    });
    await waitFor(() => expect(permissionRequest).toHaveBeenCalledOnce());

    events.push({
      id: 11,
      v: 1,
      type: 'permission_resolved',
      data: {
        requestId: 'req-bad-outcome',
        outcome: { outcome: 'selected' },
      },
    });

    await waitFor(() =>
      expect(errors).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Malformed daemon permission_resolved outcome',
        }),
      ),
    );
    expect(permissionResolved).not.toHaveBeenCalled();

    events.close();
    bridge.stop();
  });

  it('ignores permission resolution events from non-owning sessions', async () => {
    const firstEvents = new EventQueue();
    const secondEvents = new EventQueue();
    const firstSession = createFakeSession(firstEvents, 'session-1');
    const secondSession = createFakeSession(secondEvents, 'session-2');
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi
        .fn()
        .mockResolvedValueOnce(firstSession)
        .mockResolvedValueOnce(secondSession),
    });
    const permissionResolved = vi.fn();
    const permissionRequest = vi.fn();
    const errors = vi.fn();
    bridge.on('permissionRequest', permissionRequest);
    bridge.on('permissionResolved', permissionResolved);
    bridge.on('error', errors);

    await bridge.start();
    await bridge.newSession('/repo');
    await bridge.newSession('/repo');

    firstEvents.push({
      id: 1,
      v: 1,
      type: 'permission_request',
      data: {
        requestId: 'req-1',
        toolCall: {
          toolCallId: 'tool-1',
          kind: 'edit',
          title: 'Edit file',
          rawInput: {},
        },
        options: [
          { optionId: 'proceed_once', kind: 'allow_once', name: 'Allow' },
        ],
      },
    });
    await waitFor(() => expect(permissionRequest).toHaveBeenCalledOnce());
    await expect(
      bridge.respondToPermission('req-1', {
        outcome: { outcome: 'selected', optionId: 'proceed_once' },
      }),
    ).resolves.toBe(true);

    secondEvents.push({
      id: 2,
      v: 1,
      type: 'permission_resolved',
      data: { requestId: 'req-1', outcome: { outcome: 'selected' } },
    });

    await waitFor(() =>
      expect(errors).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('non-owning session session-2'),
        }),
      ),
    );
    expect(permissionResolved).not.toHaveBeenCalled();
    expect(firstSession.respondToPermission).toHaveBeenCalledWith('req-1', {
      outcome: { outcome: 'selected', optionId: 'proceed_once' },
    });
    expect(secondSession.respondToPermission).not.toHaveBeenCalled();
    await expect(
      bridge.respondToPermission('req-1', {
        outcome: { outcome: 'selected', optionId: 'proceed_once' },
      }),
    ).resolves.toBe(false);

    firstEvents.close();
    secondEvents.close();
    bridge.stop();
  });

  it('replaces duplicate daemon sessions and clears stale ownership state', async () => {
    const firstEvents = new EventQueue();
    const secondEvents = new EventQueue();
    const firstSession = createFakeSession(firstEvents, 'session-1');
    firstSession.events.mockImplementation(() => firstEvents);
    const secondSession = createFakeSession(secondEvents, 'session-1');
    secondSession.prompt.mockResolvedValue({ stopReason: 'end_turn' });
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi
        .fn()
        .mockResolvedValueOnce(firstSession)
        .mockResolvedValueOnce(secondSession),
    });
    const sessionDied = vi.fn();
    const permissionRequest = vi.fn();
    bridge.on('sessionDied', sessionDied);
    bridge.on('permissionRequest', permissionRequest);

    await bridge.start();
    await bridge.newSession('/repo');

    firstEvents.push({
      id: 1,
      v: 1,
      type: 'permission_request',
      data: {
        requestId: 'req-1',
        toolCall: {
          toolCallId: 'tool-1',
          kind: 'edit',
          title: 'Edit file',
          rawInput: {},
        },
        options: [
          { optionId: 'proceed_once', kind: 'allow_once', name: 'Allow' },
        ],
      },
    });
    await waitFor(() => expect(permissionRequest).toHaveBeenCalledOnce());
    await expect(
      bridge.respondToPermission('req-1', {
        outcome: { outcome: 'selected', optionId: 'proceed_once' },
      }),
    ).resolves.toBe(true);

    await expect(bridge.newSession('/repo')).resolves.toBe('session-1');

    await waitFor(() =>
      expect(sessionDied).toHaveBeenCalledWith({
        sessionId: 'session-1',
        reason: 'session_replaced',
      }),
    );
    await waitFor(() => expect(firstSession.cancel).toHaveBeenCalledOnce());
    await expect(
      bridge.respondToPermission('req-1', {
        outcome: { outcome: 'selected', optionId: 'proceed_once' },
      }),
    ).resolves.toBe(false);

    firstEvents.push({
      id: 2,
      v: 1,
      type: 'session_died',
      data: { reason: 'old pump finished late' },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sessionDied).toHaveBeenCalledTimes(1);
    const promptPromise = bridge.prompt('session-1', 'still alive');
    secondEvents.push(turnCompleteEvent());
    await expect(promptPromise).resolves.toBe('');
    expect(secondSession.prompt).toHaveBeenCalledOnce();

    firstEvents.close();
    secondEvents.close();
    bridge.stop();
  });

  it('rejects unknown sessions and concurrent prompts for one session', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    let resolvePrompt: () => void = () => {};
    session.prompt.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePrompt = () => resolve({ stopReason: 'end_turn' });
        }),
    );
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi.fn().mockResolvedValue(session),
    });
    const promptComplete = vi.fn();
    bridge.on('promptComplete', promptComplete);

    await bridge.start();
    await bridge.newSession('/repo');

    await expect(bridge.cancelSession('missing')).rejects.toThrow(
      'No daemon session bound for missing',
    );
    await expect(bridge.prompt('missing', 'hello')).rejects.toThrow(
      'No daemon session bound for missing',
    );
    await expect(
      bridge.setSessionModel('missing', 'qwen3-coder-plus'),
    ).rejects.toThrow('No daemon session bound for missing');

    const firstPrompt = bridge.prompt('session-1', 'first');
    await waitFor(() => expect(session.prompt).toHaveBeenCalledOnce());
    await expect(bridge.prompt('session-1', 'second')).rejects.toThrow(
      'Prompt already in flight for daemon session session-1',
    );
    resolvePrompt();
    events.push(turnCompleteEvent());
    await expect(firstPrompt).resolves.toBe('');
    expect(promptComplete).toHaveBeenCalledWith({
      sessionId: 'session-1',
      text: '',
      stopReason: 'end_turn',
    });

    events.close();
    bridge.stop();
  });

  it('stores channel images so the daemon can replay them to Web Shell', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    session.uploadAttachment
      .mockResolvedValueOnce({
        type: 'image',
        attachmentId: 'image.png',
        mimeType: 'image/png',
        size: 12,
      })
      .mockResolvedValueOnce({
        type: 'image',
        attachmentId: 'image-2.jpeg',
        mimeType: 'image/jpeg',
        size: 13,
      });
    session.prompt.mockImplementation(
      (_req: unknown, signal?: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true },
          );
        }),
    );
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi.fn().mockResolvedValue(session),
      sessionAttachments: true,
    });

    await bridge.start();
    await bridge.newSession('/repo');

    const promptPromise = bridge.prompt('session-1', 'describe', {
      images: [
        { data: 'AQID', mimeType: 'image/png' },
        { data: 'BAUG', mimeType: 'image/jpeg' },
      ],
    });
    await waitFor(() => expect(session.prompt).toHaveBeenCalledOnce());
    expect(session.uploadAttachment).toHaveBeenNthCalledWith(
      1,
      expect.any(Blob),
      'image.png',
      'image/png',
      expect.any(AbortSignal),
    );
    expect(session.uploadAttachment).toHaveBeenNthCalledWith(
      2,
      expect.any(Blob),
      'image-2.jpeg',
      'image/jpeg',
      expect.any(AbortSignal),
    );
    const firstBlob = session.uploadAttachment.mock.calls[0]![0] as Blob;
    const secondBlob = session.uploadAttachment.mock.calls[1]![0] as Blob;
    expect(Buffer.from(await firstBlob.arrayBuffer())).toEqual(
      Buffer.from([1, 2, 3]),
    );
    expect(Buffer.from(await secondBlob.arrayBuffer())).toEqual(
      Buffer.from([4, 5, 6]),
    );
    expect(session.prompt).toHaveBeenCalledWith(
      {
        prompt: [
          {
            type: 'image',
            attachmentId: 'image.png',
            mimeType: 'image/png',
            size: 12,
          },
          {
            type: 'image',
            attachmentId: 'image-2.jpeg',
            mimeType: 'image/jpeg',
            size: 13,
          },
          { type: 'text', text: 'describe' },
        ],
        _meta: { [CHANNEL_PROMPT_META_KEY]: true },
      },
      expect.any(AbortSignal),
    );

    events.push({
      id: 10,
      v: 1,
      type: 'session_died',
      data: { reason: 'agent exited' },
    });
    await expect(promptPromise).rejects.toThrow('aborted');

    events.close();
    bridge.stop();
  });

  it('releases prompt state when a channel image upload fails', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    session.uploadAttachment
      .mockRejectedValueOnce(new Error('upload failed'))
      .mockResolvedValueOnce({
        type: 'image',
        attachmentId: 'image.png',
        mimeType: 'image/png',
        size: 12,
      });
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi.fn().mockResolvedValue(session),
      sessionAttachments: true,
    });

    await bridge.start();
    await bridge.newSession('/repo');

    await expect(
      bridge.prompt('session-1', 'first', {
        images: [{ data: 'first-image', mimeType: 'image/png' }],
      }),
    ).rejects.toThrow('upload failed');
    expect(bridge.listSessions()).toEqual([
      {
        sessionId: 'session-1',
        workspaceCwd: '/repo',
        hasActivePrompt: false,
      },
    ]);
    await expect(
      bridge.prompt('session-1', 'second', {
        images: [{ data: 'second-image', mimeType: 'image/png' }],
      }),
    ).resolves.toBe('');

    events.close();
    bridge.stop();
  });

  it('removes uploaded channel images when a later upload fails', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    session.uploadAttachment
      .mockResolvedValueOnce({
        type: 'image',
        attachmentId: 'image.png',
        mimeType: 'image/png',
        size: 12,
      })
      .mockRejectedValueOnce(new Error('second upload failed'));
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi.fn().mockResolvedValue(session),
      sessionAttachments: true,
    });

    await bridge.start();
    await bridge.newSession('/repo');

    await expect(
      bridge.prompt('session-1', 'describe', {
        images: [
          { data: 'first-image', mimeType: 'image/png' },
          { data: 'second-image', mimeType: 'image/jpeg' },
        ],
      }),
    ).rejects.toThrow('second upload failed');
    expect(session.removeAttachment).toHaveBeenCalledWith('image.png');

    events.close();
    bridge.stop();
  });

  it('releases prompt state before a failed upload rollback settles', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    session.uploadAttachment
      .mockResolvedValueOnce({
        type: 'image',
        attachmentId: 'image.png',
        mimeType: 'image/png',
        size: 12,
      })
      .mockRejectedValueOnce(new Error('second upload failed'));
    let resolveRemoval: (removed: boolean) => void = () => {};
    session.removeAttachment.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        resolveRemoval = resolve;
      }),
    );
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi.fn().mockResolvedValue(session),
      sessionAttachments: true,
    });

    await bridge.start();
    await bridge.newSession('/repo');

    const promptPromise = bridge.prompt('session-1', 'describe', {
      images: [
        { data: 'first-image', mimeType: 'image/png' },
        { data: 'second-image', mimeType: 'image/jpeg' },
      ],
    });
    await waitFor(() =>
      expect(session.removeAttachment).toHaveBeenCalledOnce(),
    );
    expect(bridge.listSessions()[0]?.hasActivePrompt).toBe(false);
    resolveRemoval(true);
    await expect(promptPromise).rejects.toThrow('second upload failed');

    events.close();
    bridge.stop();
  });

  it('normalizes channel image MIME types before uploading', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    session.uploadAttachment.mockResolvedValueOnce({
      type: 'image',
      attachmentId: 'image.png',
      mimeType: 'image/png',
      size: 12,
    });
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi.fn().mockResolvedValue(session),
      sessionAttachments: true,
    });

    await bridge.start();
    await bridge.newSession('/repo');

    await bridge.prompt('session-1', 'describe', {
      images: [{ data: 'base64-image', mimeType: 'IMAGE/PNG; charset=binary' }],
    });
    expect(session.uploadAttachment).toHaveBeenCalledWith(
      expect.any(Blob),
      'image.png',
      'image/png',
      expect.any(AbortSignal),
    );

    events.close();
    bridge.stop();
  });

  it('normalizes the image/jpg alias before uploading', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    session.uploadAttachment
      .mockResolvedValueOnce({
        type: 'image',
        attachmentId: 'image.png',
        mimeType: 'image/png',
        size: 12,
      })
      .mockResolvedValueOnce({
        type: 'image',
        attachmentId: 'image-2.jpeg',
        mimeType: 'image/jpeg',
        size: 13,
      });
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi.fn().mockResolvedValue(session),
      sessionAttachments: true,
    });

    await bridge.start();
    await bridge.newSession('/repo');

    await bridge.prompt('session-1', 'describe', {
      images: [
        { data: 'AQID', mimeType: 'image/png' },
        { data: 'BAUG', mimeType: 'Image/JPG' },
      ],
    });
    expect(session.uploadAttachment).toHaveBeenNthCalledWith(
      2,
      expect.any(Blob),
      'image-2.jpeg',
      'image/jpeg',
      expect.any(AbortSignal),
    );
    expect(session.prompt).toHaveBeenCalledWith(
      {
        prompt: [
          {
            type: 'image',
            attachmentId: 'image.png',
            mimeType: 'image/png',
            size: 12,
          },
          {
            type: 'image',
            attachmentId: 'image-2.jpeg',
            mimeType: 'image/jpeg',
            size: 13,
          },
          { type: 'text', text: 'describe' },
        ],
        _meta: { [CHANNEL_PROMPT_META_KEY]: true },
      },
      expect.any(AbortSignal),
    );

    events.close();
    bridge.stop();
  });

  it('skips channel images with unrecognized MIME subtypes instead of failing the turn', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    session.uploadAttachment.mockResolvedValueOnce({
      type: 'image',
      attachmentId: 'image.png',
      mimeType: 'image/png',
      size: 12,
    });
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi.fn().mockResolvedValue(session),
      sessionAttachments: true,
    });

    await bridge.start();
    await bridge.newSession('/repo');

    let skippedWarning = '';
    try {
      await bridge.prompt('session-1', 'describe', {
        images: [
          { data: 'AQID', mimeType: 'image/png' },
          { data: 'BAUG', mimeType: 'image/tiff' },
        ],
      });
      skippedWarning = stderr.mock.calls.join('');
    } finally {
      stderr.mockRestore();
    }
    expect(session.uploadAttachment).toHaveBeenCalledOnce();
    expect(skippedWarning).toContain('image/tiff');
    expect(skippedWarning).toContain('for session session-1');
    expect(session.prompt).toHaveBeenCalledWith(
      {
        prompt: [
          {
            type: 'image',
            attachmentId: 'image.png',
            mimeType: 'image/png',
            size: 12,
          },
          { type: 'text', text: 'describe' },
        ],
        _meta: { [CHANNEL_PROMPT_META_KEY]: true },
      },
      expect.any(AbortSignal),
    );

    events.close();
    bridge.stop();
  });

  it('skips channel images above the daemon attachment size limit instead of failing the turn', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    session.uploadAttachment.mockResolvedValueOnce({
      type: 'image',
      attachmentId: 'image.png',
      mimeType: 'image/png',
      size: 12,
    });
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi.fn().mockResolvedValue(session),
      sessionAttachments: true,
    });

    await bridge.start();
    await bridge.newSession('/repo');

    let skippedWarning = '';
    try {
      await bridge.prompt('session-1', 'describe', {
        images: [
          { data: 'AQID', mimeType: 'image/png' },
          {
            data: Buffer.alloc(8 * 1024 * 1024 + 1, 1).toString('base64'),
            mimeType: 'image/jpeg',
          },
        ],
      });
      skippedWarning = stderr.mock.calls.join('');
    } finally {
      stderr.mockRestore();
    }
    expect(session.uploadAttachment).toHaveBeenCalledOnce();
    expect(skippedWarning).toContain('image/jpeg');
    expect(skippedWarning).toContain('for session session-1');
    expect(session.prompt).toHaveBeenCalledWith(
      {
        prompt: [
          {
            type: 'image',
            attachmentId: 'image.png',
            mimeType: 'image/png',
            size: 12,
          },
          { type: 'text', text: 'describe' },
        ],
        _meta: { [CHANNEL_PROMPT_META_KEY]: true },
      },
      expect.any(AbortSignal),
    );

    events.close();
    bridge.stop();
  });

  it('skips channel images that decode to zero bytes instead of failing the turn', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    session.uploadAttachment.mockResolvedValueOnce({
      type: 'image',
      attachmentId: 'image.png',
      mimeType: 'image/png',
      size: 12,
    });
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi.fn().mockResolvedValue(session),
      sessionAttachments: true,
    });

    await bridge.start();
    await bridge.newSession('/repo');

    let skippedWarning = '';
    try {
      await bridge.prompt('session-1', 'describe', {
        images: [
          { data: 'AQID', mimeType: 'image/png' },
          // Invalid base64 decodes to zero bytes; the daemon attachment
          // store rejects empty images with 400, which would fail the
          // whole turn.
          { data: 'A', mimeType: 'image/jpeg' },
        ],
      });
      skippedWarning = stderr.mock.calls.join('');
    } finally {
      stderr.mockRestore();
    }
    expect(session.uploadAttachment).toHaveBeenCalledOnce();
    expect(skippedWarning).toContain('image/jpeg');
    expect(skippedWarning).toContain('for session session-1');
    expect(session.prompt).toHaveBeenCalledWith(
      {
        prompt: [
          {
            type: 'image',
            attachmentId: 'image.png',
            mimeType: 'image/png',
            size: 12,
          },
          { type: 'text', text: 'describe' },
        ],
        _meta: { [CHANNEL_PROMPT_META_KEY]: true },
      },
      expect.any(AbortSignal),
    );

    events.close();
    bridge.stop();
  });

  it('uploads a channel image at exactly the daemon attachment size limit', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    session.uploadAttachment.mockResolvedValueOnce({
      type: 'image',
      attachmentId: 'image.png',
      mimeType: 'image/png',
      size: 8 * 1024 * 1024,
    });
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi.fn().mockResolvedValue(session),
      sessionAttachments: true,
    });

    await bridge.start();
    await bridge.newSession('/repo');

    await bridge.prompt('session-1', 'describe', {
      images: [
        {
          data: Buffer.alloc(8 * 1024 * 1024, 1).toString('base64'),
          mimeType: 'image/png',
        },
      ],
    });
    expect(session.uploadAttachment).toHaveBeenCalledOnce();

    events.close();
    bridge.stop();
  });

  it('rejects oversized channel images from the base64 length without decoding them', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const bufferFrom = vi.spyOn(Buffer, 'from');
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi.fn().mockResolvedValue(session),
      sessionAttachments: true,
    });

    await bridge.start();
    await bridge.newSession('/repo');

    const oversized = Buffer.alloc(8 * 1024 * 1024 + 1, 1).toString('base64');
    bufferFrom.mockClear();
    let decodedOversized = false;
    try {
      await bridge.prompt('session-1', 'describe', {
        images: [{ data: oversized, mimeType: 'image/jpeg' }],
      });
      decodedOversized = bufferFrom.mock.calls.some(
        (call) => call[0] === oversized,
      );
    } finally {
      stderr.mockRestore();
      bufferFrom.mockRestore();
    }
    expect(session.uploadAttachment).not.toHaveBeenCalled();
    expect(decodedOversized).toBe(false);

    events.close();
    bridge.stop();
  });

  it('skips malformed-padded channel images that decode past the size limit', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    session.uploadAttachment.mockRejectedValue(
      new Error('daemon 413: Request body too large (max 8 MiB)'),
    );
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi.fn().mockResolvedValue(session),
      sessionAttachments: true,
    });

    await bridge.start();
    await bridge.newSession('/repo');

    // Node's lenient base64 decoder ignores trailing padding that does not
    // complete a quantum, so both inputs decode to the 8 MiB limit plus one
    // byte even though a padding-counting length estimate stays at the limit.
    const malformedOnePad = 'A'.repeat(11184812) + '=';
    const malformedTwoPad = 'A'.repeat(11184812) + '==';
    let skippedWarning = '';
    try {
      await bridge.prompt('session-1', 'describe', {
        images: [
          { data: malformedOnePad, mimeType: 'image/png' },
          { data: malformedTwoPad, mimeType: 'image/jpeg' },
        ],
      });
      skippedWarning = stderr.mock.calls.join('');
    } finally {
      stderr.mockRestore();
    }
    expect(session.uploadAttachment).not.toHaveBeenCalled();
    expect(skippedWarning).toContain('above the daemon attachment size limit');
    expect(session.prompt).toHaveBeenCalledWith(
      {
        prompt: [{ type: 'text', text: 'describe' }],
        _meta: { [CHANNEL_PROMPT_META_KEY]: true },
      },
      expect.any(AbortSignal),
    );

    events.close();
    bridge.stop();
  });

  it('keeps prompt images inline when the daemon lacks session attachments', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi.fn().mockResolvedValue(session),
    });

    await bridge.start();
    await bridge.newSession('/repo');

    await bridge.prompt('session-1', 'describe', {
      images: [
        { data: 'AQID', mimeType: 'image/png' },
        { data: 'BAUG', mimeType: 'image/jpeg' },
      ],
    });
    expect(session.uploadAttachment).not.toHaveBeenCalled();
    expect(session.prompt).toHaveBeenCalledWith(
      {
        prompt: [
          { type: 'image', data: 'AQID', mimeType: 'image/png' },
          { type: 'image', data: 'BAUG', mimeType: 'image/jpeg' },
          { type: 'text', text: 'describe' },
        ],
        _meta: { [CHANNEL_PROMPT_META_KEY]: true },
      },
      expect.any(AbortSignal),
    );

    events.close();
    bridge.stop();
  });

  it('keeps legacy session clients compatible when attachment methods are absent', async () => {
    const events = new EventQueue();
    const prompt = vi.fn().mockResolvedValue({});
    const legacySession = {
      sessionId: 'session-1',
      workspaceCwd: '/repo',
      lastEventId: undefined,
      prompt,
      events: vi.fn(() => events),
      cancel: vi.fn().mockResolvedValue(undefined),
      setModel: vi.fn().mockResolvedValue({}),
      respondToPermission: vi.fn().mockResolvedValue(true),
    };
    const sessionFactory = async (): Promise<DaemonChannelSessionClient> =>
      legacySession;
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory,
      sessionAttachments: true,
    });

    await bridge.start();
    await bridge.newSession('/repo');

    await bridge.prompt('session-1', 'describe', {
      images: [{ data: 'AQID', mimeType: 'image/png' }],
    });
    expect(prompt).toHaveBeenCalledWith(
      {
        prompt: [
          { type: 'image', data: 'AQID', mimeType: 'image/png' },
          { type: 'text', text: 'describe' },
        ],
        _meta: { [CHANNEL_PROMPT_META_KEY]: true },
      },
      expect.any(AbortSignal),
    );

    events.close();
    bridge.stop();
  });

  it('bounds the inline image payload for daemons without session attachments', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi.fn().mockResolvedValue(session),
    });

    await bridge.start();
    await bridge.newSession('/repo');

    // Three of these inflate to ~14 MiB of base64, past the daemon's
    // 10mb prompt-body limit, so only the first fits the inline budget.
    const large = Buffer.alloc(3.5 * 1024 * 1024, 1).toString('base64');
    let skippedWarning = '';
    try {
      await bridge.prompt('session-1', 'describe', {
        images: [
          { data: large, mimeType: 'image/png' },
          { data: large, mimeType: 'image/jpeg' },
          { data: large, mimeType: 'image/webp' },
        ],
      });
      skippedWarning = stderr.mock.calls.join('');
    } finally {
      stderr.mockRestore();
    }
    expect(session.uploadAttachment).not.toHaveBeenCalled();
    expect(skippedWarning).toContain('image/jpeg');
    expect(skippedWarning).toContain('for session session-1');
    const promptCall = session.prompt.mock.calls[0]?.[0] as {
      prompt: Array<Record<string, unknown>>;
    };
    expect(
      promptCall.prompt.filter((block) => block['type'] === 'image'),
    ).toEqual([{ type: 'image', data: large, mimeType: 'image/png' }]);
    expect(promptCall.prompt).toContainEqual({
      type: 'text',
      text: 'describe',
    });

    events.close();
    bridge.stop();
  });

  it('names the inline budget when skipping oversized inline channel images', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi.fn().mockResolvedValue(session),
    });

    await bridge.start();
    await bridge.newSession('/repo');

    // A daemon without session_attachments has no attachment store, so the
    // skip line must name the inline budget, not the store's size limit.
    const oversized = Buffer.alloc(8 * 1024 * 1024 + 1, 1).toString('base64');
    let skippedWarning = '';
    try {
      await bridge.prompt('session-1', 'describe', {
        images: [{ data: oversized, mimeType: 'image/jpeg' }],
      });
      skippedWarning = stderr.mock.calls.join('');
    } finally {
      stderr.mockRestore();
    }
    expect(skippedWarning).toContain('above the inline image budget');
    expect(skippedWarning).not.toContain(
      'above the daemon attachment size limit',
    );
    expect(session.prompt).toHaveBeenCalledWith(
      {
        prompt: [{ type: 'text', text: 'describe' }],
        _meta: { [CHANNEL_PROMPT_META_KEY]: true },
      },
      expect.any(AbortSignal),
    );

    events.close();
    bridge.stop();
  });

  it('skips inline channel images that decode to nothing', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi.fn().mockResolvedValue(session),
    });

    await bridge.start();
    await bridge.newSession('/repo');

    let skippedWarning = '';
    try {
      await bridge.prompt('session-1', 'describe', {
        images: [{ data: 'A', mimeType: 'image/png' }],
      });
      skippedWarning = stderr.mock.calls.join('');
    } finally {
      stderr.mockRestore();
    }
    expect(skippedWarning).toContain('image/png');
    expect(session.prompt).toHaveBeenCalledWith(
      {
        prompt: [{ type: 'text', text: 'describe' }],
        _meta: { [CHANNEL_PROMPT_META_KEY]: true },
      },
      expect.any(AbortSignal),
    );

    events.close();
    bridge.stop();
  });

  it('uploads a legacy-only prompt image pair', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    session.uploadAttachment.mockResolvedValueOnce({
      type: 'image',
      attachmentId: 'image.png',
      mimeType: 'image/png',
      size: 12,
    });
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi.fn().mockResolvedValue(session),
      sessionAttachments: true,
    });

    await bridge.start();
    await bridge.newSession('/repo');

    await bridge.prompt('session-1', 'describe', {
      imageBase64: 'AQID',
      imageMimeType: 'image/png',
    });
    expect(session.uploadAttachment).toHaveBeenCalledWith(
      expect.any(Blob),
      'image.png',
      'image/png',
      expect.any(AbortSignal),
    );

    events.close();
    bridge.stop();
  });

  it('uploads the legacy pair when images is empty', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    session.uploadAttachment.mockResolvedValueOnce({
      type: 'image',
      attachmentId: 'image.png',
      mimeType: 'image/png',
      size: 12,
    });
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi.fn().mockResolvedValue(session),
      sessionAttachments: true,
    });

    await bridge.start();
    await bridge.newSession('/repo');

    await bridge.prompt('session-1', 'describe', {
      images: [],
      imageBase64: 'AQID',
      imageMimeType: 'image/png',
    });
    expect(session.uploadAttachment).toHaveBeenCalledWith(
      expect.any(Blob),
      'image.png',
      'image/png',
      expect.any(AbortSignal),
    );

    events.close();
    bridge.stop();
  });

  it('drops malformed prompt image entries instead of failing the turn', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    session.uploadAttachment.mockResolvedValueOnce({
      type: 'image',
      attachmentId: 'image.png',
      mimeType: 'image/png',
      size: 12,
    });
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi.fn().mockResolvedValue(session),
      sessionAttachments: true,
    });

    await bridge.start();
    await bridge.newSession('/repo');

    await bridge.prompt('session-1', 'describe', {
      images: [
        { data: 'AQID', mimeType: 'image/png' },
        // Extension adapters are out-of-contract input: entries can lack
        // fields the type declares required, be empty, or be null.
        { data: 'BAUG' } as ChannelPromptImage,
        { mimeType: 'image/jpeg' } as ChannelPromptImage,
        { data: '', mimeType: 'image/webp' },
        { data: 'BAUG', mimeType: '' },
        null as unknown as ChannelPromptImage,
      ],
    });
    expect(session.uploadAttachment).toHaveBeenCalledOnce();
    expect(session.prompt).toHaveBeenCalledWith(
      {
        prompt: [
          {
            type: 'image',
            attachmentId: 'image.png',
            mimeType: 'image/png',
            size: 12,
          },
          { type: 'text', text: 'describe' },
        ],
        _meta: { [CHANNEL_PROMPT_META_KEY]: true },
      },
      expect.any(AbortSignal),
    );

    events.close();
    bridge.stop();
  });

  it('skips channel images whose MIME type is not an image type', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    session.uploadAttachment.mockResolvedValueOnce({
      type: 'image',
      attachmentId: 'image.png',
      mimeType: 'image/png',
      size: 12,
    });
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi.fn().mockResolvedValue(session),
      sessionAttachments: true,
    });

    await bridge.start();
    await bridge.newSession('/repo');

    let skippedWarning = '';
    try {
      await bridge.prompt('session-1', 'describe', {
        images: [
          { data: 'AQID', mimeType: 'image/png' },
          { data: 'BAUG', mimeType: 'audio/png' },
        ],
      });
      skippedWarning = stderr.mock.calls.join('');
    } finally {
      stderr.mockRestore();
    }
    expect(session.uploadAttachment).toHaveBeenCalledOnce();
    expect(skippedWarning).toContain('audio/png');
    expect(session.prompt).toHaveBeenCalledWith(
      {
        prompt: [
          {
            type: 'image',
            attachmentId: 'image.png',
            mimeType: 'image/png',
            size: 12,
          },
          { type: 'text', text: 'describe' },
        ],
        _meta: { [CHANNEL_PROMPT_META_KEY]: true },
      },
      expect.any(AbortSignal),
    );

    events.close();
    bridge.stop();
  });

  it('uploads channel images concurrently and keeps prompt order', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    let releaseFirst: ((value: Record<string, unknown>) => void) | undefined;
    session.uploadAttachment
      .mockImplementationOnce(
        () =>
          new Promise<Record<string, unknown>>((resolve) => {
            releaseFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({
        type: 'image',
        attachmentId: 'image-2.jpeg',
        mimeType: 'image/jpeg',
        size: 13,
      });
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi.fn().mockResolvedValue(session),
      sessionAttachments: true,
    });

    await bridge.start();
    await bridge.newSession('/repo');

    const promptPromise = bridge.prompt('session-1', 'describe', {
      images: [
        { data: 'AQID', mimeType: 'image/png' },
        { data: 'BAUG', mimeType: 'image/jpeg' },
      ],
    });
    // Sequential uploads would not start the second one while the first is
    // still pending.
    await waitFor(() =>
      expect(session.uploadAttachment).toHaveBeenCalledTimes(2),
    );
    releaseFirst?.({
      type: 'image',
      attachmentId: 'image.png',
      mimeType: 'image/png',
      size: 12,
    });
    await promptPromise;
    expect(session.prompt).toHaveBeenCalledWith(
      {
        prompt: [
          {
            type: 'image',
            attachmentId: 'image.png',
            mimeType: 'image/png',
            size: 12,
          },
          {
            type: 'image',
            attachmentId: 'image-2.jpeg',
            mimeType: 'image/jpeg',
            size: 13,
          },
          { type: 'text', text: 'describe' },
        ],
        _meta: { [CHANNEL_PROMPT_META_KEY]: true },
      },
      expect.any(AbortSignal),
    );

    events.close();
    bridge.stop();
  });

  it('removes uploaded channel images when cancelled before prompt admission', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    let finishUpload!: (value: Record<string, unknown>) => void;
    session.uploadAttachment.mockImplementationOnce(
      () =>
        new Promise<Record<string, unknown>>((resolve) => {
          finishUpload = resolve;
        }),
    );
    session.prompt.mockImplementationOnce(async (_request, signal) => {
      signal?.throwIfAborted();
      return {};
    });
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi.fn().mockResolvedValue(session),
      sessionAttachments: true,
    });

    await bridge.start();
    await bridge.newSession('/repo');

    const promptPromise = bridge.prompt('session-1', 'describe', {
      images: [{ data: 'AQID', mimeType: 'image/png' }],
    });
    await waitFor(() =>
      expect(session.uploadAttachment).toHaveBeenCalledOnce(),
    );
    finishUpload({
      type: 'image',
      attachmentId: 'image.png',
      mimeType: 'image/png',
      size: 3,
    });
    await bridge.cancelSession('session-1');

    await expect(promptPromise).rejects.toThrow('aborted');
    expect(session.prompt).not.toHaveBeenCalled();
    expect(session.removeAttachment).toHaveBeenCalledOnce();
    expect(session.removeAttachment).toHaveBeenCalledWith('image.png');

    events.close();
    bridge.stop();
  });

  it('removes uploaded channel images when the daemon rejects prompt admission', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    session.uploadAttachment
      .mockResolvedValueOnce({
        type: 'image',
        attachmentId: 'image.png',
        mimeType: 'image/png',
        size: 12,
      })
      .mockResolvedValueOnce({
        type: 'image',
        attachmentId: 'image-2.jpeg',
        mimeType: 'image/jpeg',
        size: 13,
      });
    session.prompt.mockRejectedValueOnce(
      Object.assign(new Error('daemon 400: prompt admission denied'), {
        name: 'DaemonHttpError',
        status: 400,
      }),
    );
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi.fn().mockResolvedValue(session),
      sessionAttachments: true,
    });

    await bridge.start();
    await bridge.newSession('/repo');

    await expect(
      bridge.prompt('session-1', 'describe', {
        images: [
          { data: 'AQID', mimeType: 'image/png' },
          { data: 'BAUG', mimeType: 'image/jpeg' },
        ],
      }),
    ).rejects.toThrow('prompt admission denied');
    expect(session.removeAttachment).toHaveBeenCalledTimes(2);
    expect(session.removeAttachment).toHaveBeenCalledWith('image.png');
    expect(session.removeAttachment).toHaveBeenCalledWith('image-2.jpeg');

    events.close();
    bridge.stop();
  });

  it('removes uploaded channel images when the local prompt queue is full', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    session.uploadAttachment.mockResolvedValueOnce({
      type: 'image',
      attachmentId: 'image.png',
      mimeType: 'image/png',
      size: 12,
    });
    session.prompt.mockRejectedValueOnce(
      Object.assign(new Error('Pending prompts full: "session-1" (1/1)'), {
        name: 'DaemonPendingPromptLimitError',
      }),
    );
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi.fn().mockResolvedValue(session),
      sessionAttachments: true,
    });

    await bridge.start();
    await bridge.newSession('/repo');

    await expect(
      bridge.prompt('session-1', 'describe', {
        images: [{ data: 'AQID', mimeType: 'image/png' }],
      }),
    ).rejects.toThrow('Pending prompts full');
    expect(session.removeAttachment).toHaveBeenCalledWith('image.png');

    events.close();
    bridge.stop();
  });

  it('keeps uploaded channel images when an admitted turn errors', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    session.uploadAttachment.mockResolvedValueOnce({
      type: 'image',
      attachmentId: 'image.png',
      mimeType: 'image/png',
      size: 12,
    });
    session.prompt.mockRejectedValueOnce(
      Object.assign(new Error('model_overloaded'), {
        name: 'DaemonHttpError',
        status: 500,
        _daemonTurnError: true,
      }),
    );
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi.fn().mockResolvedValue(session),
      sessionAttachments: true,
    });

    await bridge.start();
    await bridge.newSession('/repo');

    await expect(
      bridge.prompt('session-1', 'describe', {
        images: [{ data: 'AQID', mimeType: 'image/png' }],
      }),
    ).rejects.toThrow('model_overloaded');
    expect(session.removeAttachment).not.toHaveBeenCalled();

    events.close();
    bridge.stop();
  });

  it('keeps uploaded channel images when the prompt fails with an unrecognized error', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    session.uploadAttachment.mockResolvedValueOnce({
      type: 'image',
      attachmentId: 'image.png',
      mimeType: 'image/png',
      size: 12,
    });
    session.prompt.mockRejectedValueOnce(new Error('connection reset'));
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi.fn().mockResolvedValue(session),
      sessionAttachments: true,
    });

    await bridge.start();
    await bridge.newSession('/repo');

    await expect(
      bridge.prompt('session-1', 'describe', {
        images: [{ data: 'AQID', mimeType: 'image/png' }],
      }),
    ).rejects.toThrow('connection reset');
    expect(session.removeAttachment).not.toHaveBeenCalled();

    events.close();
    bridge.stop();
  });

  it('logs failed attachment removals while rolling back uploads', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    session.uploadAttachment
      .mockResolvedValueOnce({
        type: 'image',
        attachmentId: 'image.png',
        mimeType: 'image/png',
        size: 12,
      })
      .mockRejectedValueOnce(new Error('second upload failed'));
    session.removeAttachment.mockRejectedValueOnce(new Error('daemon gone'));
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi.fn().mockResolvedValue(session),
      sessionAttachments: true,
    });

    await bridge.start();
    await bridge.newSession('/repo');

    let rollbackLog = '';
    try {
      await expect(
        bridge.prompt('session-1', 'describe', {
          images: [
            { data: 'AQID', mimeType: 'image/png' },
            { data: 'BAUG', mimeType: 'image/jpeg' },
          ],
        }),
      ).rejects.toThrow('second upload failed');
      rollbackLog = stderr.mock.calls.join('');
    } finally {
      stderr.mockRestore();
    }
    expect(session.removeAttachment).toHaveBeenCalledWith('image.png');
    expect(rollbackLog).toContain('daemon gone');
    expect(rollbackLog).toContain('image.png');
    expect(rollbackLog).toContain('session-1');

    events.close();
    bridge.stop();
  });

  it('removes uploaded channel images when cancelled before prompt admission', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    let resolveUpload: (attachment: Record<string, unknown>) => void = () => {};
    const upload = new Promise<Record<string, unknown>>((resolve) => {
      resolveUpload = resolve;
    });
    session.uploadAttachment.mockReturnValueOnce(upload);
    let promptAdmissions = 0;
    session.prompt.mockImplementation(
      async (_req: unknown, signal?: AbortSignal) => {
        // Mirrors DaemonSessionClient.prompt: an already-aborted signal is
        // rejected before any admission request reaches the daemon.
        signal?.throwIfAborted();
        promptAdmissions += 1;
        return {};
      },
    );
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi.fn().mockResolvedValue(session),
      sessionAttachments: true,
    });

    await bridge.start();
    await bridge.newSession('/repo');

    const promptPromise = bridge.prompt('session-1', 'describe', {
      images: [{ data: 'AQID', mimeType: 'image/png' }],
    });
    await waitFor(() =>
      expect(session.uploadAttachment).toHaveBeenCalledOnce(),
    );
    // Attached after the bridge's own reaction on the upload promise, so
    // the cancellation runs once the upload fulfills but before the bridge
    // resumes into session.prompt.
    void upload.then(() => bridge.cancelSession('session-1'));
    resolveUpload({
      type: 'image',
      attachmentId: 'image.png',
      mimeType: 'image/png',
      size: 12,
    });

    await expect(promptPromise).rejects.toMatchObject({ name: 'AbortError' });
    expect(promptAdmissions).toBe(0);
    expect(session.removeAttachment).toHaveBeenCalledOnce();
    expect(session.removeAttachment).toHaveBeenCalledWith('image.png');

    events.close();
    bridge.stop();
  });

  it('forwards a distinct user-facing prompt text in daemon metadata', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi.fn().mockResolvedValue(session),
      promptAuthorization: 'worker-token',
    });

    await bridge.start();
    await bridge.newSession('/repo');

    const promptPromise = bridge.prompt(
      'session-1',
      'internal context\n\nhello',
      {
        displayText: 'hello',
      },
    );
    await waitFor(() => expect(session.prompt).toHaveBeenCalledOnce());
    expect(session.prompt).toHaveBeenCalledWith(
      {
        prompt: [{ type: 'text', text: 'internal context\n\nhello' }],
        _meta: {
          [CHANNEL_PROMPT_META_KEY]: true,
          [CHANNEL_PROMPT_AUTHORIZATION_META_KEY]: 'worker-token',
          'qwen.daemon.promptDisplayText': 'hello',
        },
      },
      expect.any(AbortSignal),
    );

    events.push(turnCompleteEvent());
    await promptPromise;
    events.close();
    bridge.stop();
  });

  it('presents the prompt authorization even without a display text', async () => {
    // The daemon validates the token for the channel-turn classification
    // too; a channel prompt without display text still needs it to keep
    // its classification (and the loop-rejection opt-out that rides it).
    const events = new EventQueue();
    const session = createFakeSession(events);
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi.fn().mockResolvedValue(session),
      promptAuthorization: 'worker-token',
    });

    await bridge.start();
    await bridge.newSession('/repo');

    const promptPromise = bridge.prompt('session-1', 'hello');
    await waitFor(() => expect(session.prompt).toHaveBeenCalledOnce());
    expect(session.prompt).toHaveBeenCalledWith(
      {
        prompt: [{ type: 'text', text: 'hello' }],
        _meta: {
          [CHANNEL_PROMPT_META_KEY]: true,
          [CHANNEL_PROMPT_AUTHORIZATION_META_KEY]: 'worker-token',
        },
      },
      expect.any(AbortSignal),
    );

    events.push(turnCompleteEvent());
    await promptPromise;
    events.close();
    bridge.stop();
  });

  it('aborts in-flight prompts when the bridge stops', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    session.prompt.mockImplementation(
      (_req: unknown, signal?: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true },
          );
        }),
    );
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi.fn().mockResolvedValue(session),
    });
    const sessionDied = vi.fn();
    bridge.on('sessionDied', sessionDied);

    await bridge.start();
    await bridge.newSession('/repo');
    const promptPromise = bridge.prompt('session-1', 'hello');
    await waitFor(() => expect(session.prompt).toHaveBeenCalledOnce());

    bridge.stop();
    await expect(promptPromise).rejects.toThrow('aborted');
    expect(session.cancel).toHaveBeenCalledOnce();
    expect(sessionDied).toHaveBeenCalledWith({
      sessionId: 'session-1',
      reason: 'bridge_stopped',
    });
  });

  it('aborts in-flight prompts when cancelling a session', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    const order: string[] = [];
    session.cancel.mockImplementation(async () => {
      order.push('cancel');
    });
    session.prompt.mockImplementation(
      (_req: unknown, signal?: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => {
              order.push('abort');
              reject(new DOMException('aborted', 'AbortError'));
            },
            { once: true },
          );
        }),
    );
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi.fn().mockResolvedValue(session),
    });

    await bridge.start();
    await bridge.newSession('/repo');
    const promptPromise = bridge.prompt('session-1', 'hello');
    await waitFor(() => expect(session.prompt).toHaveBeenCalledOnce());

    await bridge.cancelSession('session-1');

    await expect(promptPromise).rejects.toThrow('aborted');
    expect(session.cancel).toHaveBeenCalledOnce();
    expect(order).toEqual(['abort', 'cancel']);

    events.close();
    bridge.stop();
  });

  it('clears permission ownership when daemon permission responses fail', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi.fn().mockResolvedValue(session),
    });
    const permissionRequest = vi.fn();
    bridge.on('permissionRequest', permissionRequest);

    await bridge.start();
    await bridge.newSession('/repo');

    events.push({
      id: 1,
      v: 1,
      type: 'permission_request',
      data: {
        requestId: 'req-fail',
        toolCall: {
          toolCallId: 'tool-1',
          kind: 'edit',
          title: 'Edit file',
          rawInput: {},
        },
        options: [
          { optionId: 'proceed_once', kind: 'allow_once', name: 'Allow' },
        ],
      },
    });
    await waitFor(() => expect(permissionRequest).toHaveBeenCalledOnce());

    session.respondToPermission.mockRejectedValueOnce(
      new Error('permission failed'),
    );
    const response: RequestPermissionResponse = {
      outcome: { outcome: 'selected', optionId: 'proceed_once' },
    };
    await expect(
      bridge.respondToPermission('req-fail', response),
    ).rejects.toThrow('permission failed');
    await expect(
      bridge.respondToPermission('req-fail', response),
    ).resolves.toBe(false);

    events.close();
    bridge.stop();
  });

  it('treats terminal stream frames and completion as session death', async () => {
    const failedEvents = new EventQueue();
    failedEvents.fail(new Error('network down'));
    const failedSession = createFakeSession(failedEvents);
    const failedBridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi.fn().mockResolvedValue(failedSession),
    });
    const failedDied = vi.fn();
    failedBridge.on('sessionDied', failedDied);

    await failedBridge.start();
    await failedBridge.newSession('/repo');
    await waitFor(() =>
      expect(failedDied).toHaveBeenCalledWith({
        sessionId: 'session-1',
        reason: 'network down',
      }),
    );
    expect(failedBridge.lastDaemonError).toMatchObject({
      message: 'network down',
    });
    await expect(failedBridge.prompt('session-1', 'hello')).rejects.toThrow(
      'No daemon session bound for session-1',
    );

    const endedEvents = new EventQueue();
    const endedSession = createFakeSession(endedEvents);
    const endedBridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi.fn().mockResolvedValue(endedSession),
    });
    const endedDied = vi.fn();
    endedBridge.on('sessionDied', endedDied);

    await endedBridge.start();
    await endedBridge.newSession('/repo');
    endedEvents.close();
    await waitFor(() =>
      expect(endedDied).toHaveBeenCalledWith({
        sessionId: 'session-1',
        reason: 'stream_ended',
      }),
    );

    const terminalEvents = new EventQueue();
    const terminalSession = createFakeSession(terminalEvents);
    const terminalBridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi.fn().mockResolvedValue(terminalSession),
    });
    const terminalDied = vi.fn();
    terminalBridge.on('sessionDied', terminalDied);

    await terminalBridge.start();
    await terminalBridge.newSession('/repo');
    terminalEvents.push({
      id: 20,
      v: 1,
      type: 'stream_error',
      data: { error: 'subscriber limit reached' },
    });
    await waitFor(() =>
      expect(terminalDied).toHaveBeenCalledWith({
        sessionId: 'session-1',
        reason: 'subscriber limit reached',
      }),
    );
    await expect(terminalBridge.prompt('session-1', 'hello')).rejects.toThrow(
      'No daemon session bound for session-1',
    );

    const evictedEvents = new EventQueue();
    const evictedSession = createFakeSession(evictedEvents);
    const evictedBridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi.fn().mockResolvedValue(evictedSession),
    });
    const evictedDied = vi.fn();
    evictedBridge.on('sessionDied', evictedDied);

    await evictedBridge.start();
    await evictedBridge.newSession('/repo');
    evictedEvents.push({
      id: 21,
      v: 1,
      type: 'client_evicted',
      data: { reason: 'queue_overflow' },
    });
    await waitFor(() =>
      expect(evictedDied).toHaveBeenCalledWith({
        sessionId: 'session-1',
        reason: 'queue_overflow',
      }),
    );
  });

  it('loads an existing daemon session and forwards cancel/model changes', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events, 'existing-session');
    const factory = vi.fn().mockResolvedValue(session);
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      modelServiceId: 'default',
      sessionScope: 'user',
      sessionFactory: factory,
    });

    await bridge.start();
    await expect(bridge.loadSession('existing-session', '/repo')).resolves.toBe(
      'existing-session',
    );
    await bridge.cancelSession('existing-session');
    await bridge.setSessionModel('existing-session', 'qwen3-coder-plus');

    expect(factory).toHaveBeenCalledWith({
      workspaceCwd: '/repo',
      modelServiceId: 'default',
      sessionId: 'existing-session',
      sessionScope: 'user',
    });
    expect(session.cancel).toHaveBeenCalledOnce();
    expect(session.setModel).toHaveBeenCalledWith('qwen3-coder-plus');

    events.close();
    bridge.stop();
  });

  it('rejects and detaches a new session factory result that arrives after stop', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    session.detach = vi.fn().mockResolvedValue(undefined);
    let finishFactory!: (session: FakeSession) => void;
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi.fn(
        () =>
          new Promise<DaemonChannelSessionClient>((resolve) => {
            finishFactory = resolve;
          }),
      ),
    });

    await bridge.start();
    const creating = bridge.newSession('/repo');
    await Promise.resolve();
    bridge.stop();
    finishFactory(session);

    await expect(creating).rejects.toThrow('stopped');
    expect(session.detach).toHaveBeenCalledOnce();
    expect(session.cancel).not.toHaveBeenCalled();
    expect(bridge.listSessions()).toEqual([]);
  });

  it('rejects and detaches a load factory result that arrives after stop', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events, 'existing-session');
    session.detach = vi.fn().mockResolvedValue(undefined);
    let finishFactory!: (session: FakeSession) => void;
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi.fn(
        () =>
          new Promise<DaemonChannelSessionClient>((resolve) => {
            finishFactory = resolve;
          }),
      ),
    });

    await bridge.start();
    const loading = bridge.loadSession('existing-session', '/repo');
    await Promise.resolve();
    bridge.stop();
    finishFactory(session);

    await expect(loading).rejects.toThrow('stopped');
    expect(session.detach).toHaveBeenCalledOnce();
    expect(session.cancel).not.toHaveBeenCalled();
    expect(bridge.listSessions()).toEqual([]);
  });

  it.each(['unavailable', 'rejected'] as const)(
    'falls back to cancel when detach is %s for a stale factory result',
    async (detachState) => {
      const events = new EventQueue();
      const session = createFakeSession(events, 'stale-session');
      if (detachState === 'rejected') {
        session.detach = vi.fn().mockRejectedValue(new Error('detach failed'));
      }
      let finishFactory!: (session: FakeSession) => void;
      const bridge = new DaemonChannelBridge({
        cwd: '/repo',
        sessionFactory: vi.fn(
          () =>
            new Promise<DaemonChannelSessionClient>((resolve) => {
              finishFactory = resolve;
            }),
        ),
      });

      await bridge.start();
      const creating = bridge.newSession('/repo');
      await Promise.resolve();
      bridge.stop();
      finishFactory(session);

      await expect(creating).rejects.toThrow('stopped');
      if (session.detach) {
        expect(session.detach).toHaveBeenCalledOnce();
      }
      expect(session.cancel).toHaveBeenCalledOnce();
      expect(bridge.listSessions()).toEqual([]);
    },
  );

  it.each([
    ['new', 'detach'],
    ['load', 'cancel'],
  ] as const)(
    'rejects stale %s without waiting for hanging %s',
    async (operation, cleanup) => {
      const events = new EventQueue();
      const sessionId =
        operation === 'new' ? 'new-session' : 'existing-session';
      const session = createFakeSession(events, sessionId);
      const neverSettles = vi.fn(() => new Promise<void>(() => undefined));
      if (cleanup === 'detach') {
        session.detach = neverSettles;
      } else {
        session.cancel = neverSettles;
      }
      let finishFactory!: (session: FakeSession) => void;
      const bridge = new DaemonChannelBridge({
        cwd: '/repo',
        sessionFactory: vi.fn(
          () =>
            new Promise<DaemonChannelSessionClient>((resolve) => {
              finishFactory = resolve;
            }),
        ),
      });
      const sessionDied = vi.fn();
      bridge.on('sessionDied', sessionDied);

      await bridge.start();
      const pending =
        operation === 'new'
          ? bridge.newSession('/repo')
          : bridge.loadSession(sessionId, '/repo');
      let rejection: unknown;
      void pending.catch((error: unknown) => {
        rejection = error;
      });
      await Promise.resolve();
      bridge.stop();
      finishFactory(session);
      await drainMicrotasks();

      expect(rejection).toEqual(
        expect.objectContaining({
          message: 'Daemon channel bridge stopped during session creation',
        }),
      );
      expect(neverSettles).toHaveBeenCalledOnce();
      expect(bridge.listSessions()).toEqual([]);
      expect(sessionDied).not.toHaveBeenCalled();
    },
  );

  it.each(['new', 'load'] as const)(
    'does not attach a %s factory result after a queued stop',
    async (operation) => {
      const events = new EventQueue();
      const sessionId =
        operation === 'new' ? 'new-session' : 'existing-session';
      const session = createFakeSession(events, sessionId);
      let finishFactory!: (session: FakeSession) => void;
      const bridge = new DaemonChannelBridge({
        cwd: '/repo',
        sessionFactory: vi.fn(
          () =>
            new Promise<DaemonChannelSessionClient>((resolve) => {
              finishFactory = resolve;
            }),
        ),
      });

      await bridge.start();
      const creating =
        operation === 'new'
          ? bridge.newSession('/repo')
          : bridge.loadSession(sessionId, '/repo');
      await Promise.resolve();
      finishFactory(session);
      queueMicrotask(() => bridge.stop());

      await expect(creating).resolves.toBe(sessionId);
      expect(session.cancel).toHaveBeenCalledOnce();
      expect(bridge.listSessions()).toEqual([]);
    },
  );

  it('keeps a pre-stop factory result stale after restart', async () => {
    const staleEvents = new EventQueue();
    const staleSession = createFakeSession(staleEvents, 'stale-session');
    staleSession.detach = vi.fn().mockResolvedValue(undefined);
    const currentEvents = new EventQueue();
    const currentSession = createFakeSession(currentEvents, 'current-session');
    let finishStaleFactory!: (session: FakeSession) => void;
    const factory = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<DaemonChannelSessionClient>((resolve) => {
            finishStaleFactory = resolve;
          }),
      )
      .mockResolvedValueOnce(currentSession);
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: factory,
    });

    await bridge.start();
    const staleCreation = bridge.newSession('/repo');
    await Promise.resolve();
    bridge.stop();
    await bridge.start();
    finishStaleFactory(staleSession);

    await expect(staleCreation).rejects.toThrow('stopped');
    await expect(bridge.newSession('/repo')).resolves.toBe('current-session');
    expect(staleSession.detach).toHaveBeenCalledOnce();
    expect(staleSession.cancel).not.toHaveBeenCalled();
    expect(bridge.listSessions()).toEqual([
      {
        sessionId: 'current-session',
        workspaceCwd: '/repo',
        hasActivePrompt: false,
      },
    ]);

    currentEvents.close();
    bridge.stop();
  });

  it('conditionally discards only the binding owned by the expected token', async () => {
    const firstEvents = new EventQueue();
    const secondEvents = new EventQueue();
    const firstSession = createFakeSession(firstEvents, 'shared-session');
    const secondSession = createFakeSession(secondEvents, 'shared-session');
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi
        .fn()
        .mockResolvedValueOnce(firstSession)
        .mockResolvedValueOnce(secondSession),
    });
    const bindingBridge = bridge as unknown as {
      newSession(
        cwd: string,
        options: undefined,
        bindingToken: object,
      ): Promise<string>;
      discardSession(sessionId: string, expectedToken: object): Promise<void>;
    };
    const firstToken = {};
    const secondToken = {};

    await bridge.start();
    await bindingBridge.newSession('/repo', undefined, firstToken);
    await bindingBridge.newSession('/repo', undefined, secondToken);
    await bindingBridge.discardSession('shared-session', firstToken);

    expect(bridge.listSessions()).toEqual([
      {
        sessionId: 'shared-session',
        workspaceCwd: '/repo',
        hasActivePrompt: false,
      },
    ]);
    expect(secondSession.cancel).not.toHaveBeenCalled();

    await bindingBridge.discardSession('shared-session', secondToken);
    expect(bridge.listSessions()).toEqual([]);
    expect(secondSession.cancel).toHaveBeenCalledOnce();
    expect(
      (
        bridge as unknown as {
          sessionBindingTokens: Map<string, object | undefined>;
        }
      ).sessionBindingTokens.size,
    ).toBe(0);
  });

  it('rejects mismatched daemon session ids while loading', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events, 'different-session');
    session.detach = vi.fn().mockResolvedValue(undefined);
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi.fn().mockResolvedValue(session),
    });

    await bridge.start();
    await expect(
      bridge.loadSession('existing-session', '/repo'),
    ).rejects.toThrow(
      'Daemon returned session different-session while loading existing-session',
    );
    await expect(bridge.prompt('different-session', 'hello')).rejects.toThrow(
      'No daemon session bound for different-session',
    );
    expect(session.detach).toHaveBeenCalledOnce();

    events.close();
    bridge.stop();
  });

  it('surfaces malformed daemon events through the error channel', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi.fn().mockResolvedValue(session),
    });
    const errors = vi.fn();
    bridge.on('error', errors);

    await bridge.start();
    await bridge.newSession('/repo');

    events.push({
      id: 1,
      v: 1,
      type: 'permission_request',
      data: { requestId: 'req-1' },
    });
    events.push({
      id: 2,
      v: 1,
      type: 'session_update',
      data: {
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: 'not-an-array',
        },
      },
    });
    events.push({
      id: 3,
      v: 1,
      type: 'model_switched',
      data: {},
    });
    events.push({
      id: 4,
      v: 1,
      type: 'session_update',
      data: {
        update: {
          sessionUpdate: 'tool_call_update',
          status: 'running',
        },
      },
    });

    await waitFor(() => expect(errors).toHaveBeenCalledTimes(4));
    expect(errors).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        message: 'Malformed daemon permission_request event',
      }),
    );
    expect(errors).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        message: 'Malformed daemon available_commands_update event',
      }),
    );
    expect(errors).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        message: 'Malformed daemon model_switched event',
      }),
    );
    expect(errors).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({
        message: 'Malformed daemon tool_call_update event',
      }),
    );
    expect(bridge.lastDaemonError).toMatchObject({
      message: 'Malformed daemon tool_call_update event',
    });

    events.close();
    bridge.stop();
  });

  it('listSessions returns empty array when no sessions are attached', async () => {
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi.fn(),
    });
    await bridge.start();

    expect(bridge.listSessions()).toEqual([]);

    bridge.stop();
  });

  it('listSessions returns attached sessions with hasActivePrompt status', async () => {
    const firstEvents = new EventQueue();
    const secondEvents = new EventQueue();
    const firstSession = createFakeSession(firstEvents, 'session-1');
    const secondSession = createFakeSession(secondEvents, 'session-2');
    let resolvePrompt: () => void = () => {};
    firstSession.prompt.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePrompt = () => resolve({ stopReason: 'end_turn' });
        }),
    );
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi
        .fn()
        .mockResolvedValueOnce(firstSession)
        .mockResolvedValueOnce(secondSession),
    });
    await bridge.start();

    await bridge.newSession('/repo');
    await bridge.newSession('/repo');

    const sessions = bridge.listSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions).toEqual(
      expect.arrayContaining([
        {
          sessionId: 'session-1',
          workspaceCwd: '/repo',
          hasActivePrompt: false,
        },
        {
          sessionId: 'session-2',
          workspaceCwd: '/repo',
          hasActivePrompt: false,
        },
      ]),
    );

    const promptPromise = bridge.prompt('session-1', 'hello');
    await waitFor(() => expect(firstSession.prompt).toHaveBeenCalledOnce());

    const during = bridge.listSessions();
    expect(
      during.find((s) => s.sessionId === 'session-1')?.hasActivePrompt,
    ).toBe(true);
    expect(
      during.find((s) => s.sessionId === 'session-2')?.hasActivePrompt,
    ).toBe(false);

    resolvePrompt();
    await promptPromise;

    expect(
      bridge.listSessions().find((s) => s.sessionId === 'session-1')
        ?.hasActivePrompt,
    ).toBe(false);

    firstEvents.close();
    secondEvents.close();
    bridge.stop();
  });

  it('listSessions excludes dropped sessions', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi.fn().mockResolvedValue(session),
    });
    await bridge.start();

    await bridge.newSession('/repo');
    expect(bridge.listSessions()).toHaveLength(1);

    events.push({
      id: 1,
      v: 1,
      type: 'session_died',
      data: { reason: 'gone' },
    });
    await waitFor(() => expect(bridge.listSessions()).toEqual([]));

    events.close();
    bridge.stop();
  });

  it('releases a session client when the daemon reports it dead', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    const detach = vi.fn().mockResolvedValue(undefined);
    session.detach = detach;
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi.fn().mockResolvedValue(session),
    });
    await bridge.start();

    await bridge.newSession('/repo');
    events.push({
      id: 1,
      v: 1,
      type: 'session_died',
      data: { reason: 'gone' },
    });

    await waitFor(() => expect(detach).toHaveBeenCalledOnce());

    events.close();
    bridge.stop();
  });

  it('listSessions shows hasActivePrompt false after cancelSession', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    let resolvePrompt: () => void = () => {};
    session.prompt.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePrompt = () => resolve({ stopReason: 'cancelled' });
        }),
    );
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi.fn().mockResolvedValue(session),
    });
    await bridge.start();
    await bridge.newSession('/repo');

    const promptPromise = bridge.prompt('session-1', 'hello');
    await waitFor(() => expect(session.prompt).toHaveBeenCalledOnce());
    expect(
      bridge.listSessions().find((s) => s.sessionId === 'session-1')
        ?.hasActivePrompt,
    ).toBe(true);

    await bridge.cancelSession('session-1');
    resolvePrompt();
    await promptPromise;

    expect(
      bridge.listSessions().find((s) => s.sessionId === 'session-1')
        ?.hasActivePrompt,
    ).toBe(false);

    events.close();
    bridge.stop();
  });

  it('listSessions returns empty after bridge stop', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi.fn().mockResolvedValue(session),
    });
    await bridge.start();
    await bridge.newSession('/repo');
    expect(bridge.listSessions()).toHaveLength(1);

    bridge.stop();

    expect(bridge.listSessions()).toEqual([]);
    events.close();
  });

  it('listSessions reflects session replacement with same ID', async () => {
    const firstEvents = new EventQueue();
    const secondEvents = new EventQueue();
    const firstSession = createFakeSession(firstEvents, 'session-1');
    const secondSession = createFakeSession(secondEvents, 'session-1');
    (secondSession as { workspaceCwd: string }).workspaceCwd = '/other';
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi
        .fn()
        .mockResolvedValueOnce(firstSession)
        .mockResolvedValueOnce(secondSession),
    });
    await bridge.start();
    await bridge.newSession('/repo');
    expect(bridge.listSessions()).toEqual([
      { sessionId: 'session-1', workspaceCwd: '/repo', hasActivePrompt: false },
    ]);

    await bridge.newSession('/other');
    const sessions = bridge.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toEqual({
      sessionId: 'session-1',
      workspaceCwd: '/other',
      hasActivePrompt: false,
    });

    firstEvents.close();
    secondEvents.close();
    bridge.stop();
  });
});
