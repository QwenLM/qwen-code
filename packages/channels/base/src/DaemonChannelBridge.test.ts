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
    prompt: vi.fn().mockImplementation(async () => ({})),
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

function turnCompleteEvent(sessionId = 'session-1'): DaemonChannelEvent {
  return {
    v: 1,
    type: 'turn_complete',
    data: { sessionId, stopReason: 'end_turn' },
  };
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
