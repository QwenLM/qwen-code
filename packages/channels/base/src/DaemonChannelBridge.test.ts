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
  private waiters: Array<(value: IteratorResult<DaemonChannelEvent>) => void> =
    [];
  private closed = false;

  async next(): Promise<IteratorResult<DaemonChannelEvent>> {
    const event = this.events.shift();
    if (event) {
      return { done: false, value: event };
    }
    if (this.closed) {
      return { done: true, value: undefined };
    }
    return await new Promise((resolve) => {
      this.waiters.push(resolve);
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
      waiter({ done: false, value: event });
      return;
    }
    this.events.push(event);
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ done: true, value: undefined });
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
    events: vi.fn(() => events),
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

    await bridge.start();
    const sessionId = await bridge.newSession('/repo');
    const promptPromise = bridge.prompt(sessionId, 'summarize');
    await waitFor(() => expect(session.prompt).toHaveBeenCalledOnce());
    resolvePrompt();

    await expect(promptPromise).resolves.toBe('hello');
    expect(factory).toHaveBeenCalledWith({
      workspaceCwd: '/repo',
      modelServiceId: undefined,
    });
    expect(session.prompt).toHaveBeenCalledWith({
      prompt: [{ type: 'text', text: 'summarize' }],
    });

    events.close();
    bridge.stop();
  });

  it('emits tool, thought, model, and session lifecycle events', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      sessionFactory: vi.fn().mockResolvedValue(session),
    });
    const thoughtChunk = vi.fn();
    const toolCall = vi.fn();
    const modelSwitched = vi.fn();
    const sessionDied = vi.fn();

    bridge.on('thoughtChunk', thoughtChunk);
    bridge.on('toolCall', toolCall);
    bridge.on('modelSwitched', modelSwitched);
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
      type: 'model_switched',
      data: { sessionId: 'session-1', modelId: 'qwen3-coder-plus' },
    });
    events.push({
      id: 5,
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
    expect(modelSwitched).toHaveBeenCalledWith({
      sessionId: 'session-1',
      modelId: 'qwen3-coder-plus',
    });
    expect(sessionDied).toHaveBeenCalledWith({
      sessionId: 'session-1',
      reason: 'agent exited',
    });

    events.close();
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

    events.close();
    bridge.stop();
  });

  it('loads an existing daemon session and forwards cancel/model changes', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events, 'existing-session');
    const factory = vi.fn().mockResolvedValue(session);
    const bridge = new DaemonChannelBridge({
      cwd: '/repo',
      modelServiceId: 'default',
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
    });
    expect(session.cancel).toHaveBeenCalledOnce();
    expect(session.setModel).toHaveBeenCalledWith('qwen3-coder-plus');

    events.close();
    bridge.stop();
  });
});
