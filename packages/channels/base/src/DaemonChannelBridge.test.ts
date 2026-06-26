import { describe, expect, it, vi } from 'vitest';
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
} from '@agentclientprotocol/sdk';
import {
  DaemonChannelBridge,
  type DaemonChannelEvent,
  type DaemonChannelSessionClient,
} from './DaemonChannelBridge.js';

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
    prompt: vi.fn().mockImplementation(async () => undefined),
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

describe('DaemonChannelBridge', () => {
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
      },
      expect.any(AbortSignal),
    );

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
    await expect(bridge.prompt('session-1', 'still alive')).resolves.toBe('');
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
    await expect(firstPrompt).resolves.toBe('');
    expect(promptComplete).toHaveBeenCalledWith({
      sessionId: 'session-1',
      text: '',
      stopReason: 'end_turn',
    });

    events.close();
    bridge.stop();
  });

  it('passes image prompt blocks and aborts prompts when a session dies', async () => {
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

    await bridge.start();
    await bridge.newSession('/repo');

    const promptPromise = bridge.prompt('session-1', 'describe', {
      imageBase64: 'base64-image',
      imageMimeType: 'image/png',
    });
    await waitFor(() => expect(session.prompt).toHaveBeenCalledOnce());
    expect(session.prompt).toHaveBeenCalledWith(
      {
        prompt: [
          { type: 'image', data: 'base64-image', mimeType: 'image/png' },
          { type: 'text', text: 'describe' },
        ],
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
    expect(order).toEqual(['cancel', 'abort']);

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

  it('rejects mismatched daemon session ids while loading', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events, 'different-session');
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
});
