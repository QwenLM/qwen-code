/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type {
  ContentBlock,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from '@agentclientprotocol/sdk';
import {
  DaemonIdeConnection,
  type DaemonIdeEvent,
  type DaemonIdeSessionClient,
} from './daemonIdeConnection.js';

class EventQueue implements AsyncGenerator<DaemonIdeEvent> {
  private events: DaemonIdeEvent[] = [];
  private waiters: Array<{
    resolve: (value: IteratorResult<DaemonIdeEvent>) => void;
    reject: (error: unknown) => void;
  }> = [];
  private closed = false;
  private failure: unknown;

  async next(): Promise<IteratorResult<DaemonIdeEvent>> {
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

  async return(): Promise<IteratorResult<DaemonIdeEvent>> {
    this.close();
    return { done: true, value: undefined };
  }

  async throw(error?: unknown): Promise<IteratorResult<DaemonIdeEvent>> {
    this.close();
    throw error;
  }

  [Symbol.asyncIterator](): AsyncGenerator<DaemonIdeEvent> {
    return this;
  }

  push(event: DaemonIdeEvent): void {
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

interface FakeSession extends DaemonIdeSessionClient {
  prompt: ReturnType<typeof vi.fn>;
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
    workspaceCwd: '/tmp/workspace',
    lastEventId: undefined,
    prompt: vi.fn().mockResolvedValue({ stopReason: 'end_turn' }),
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

describe('DaemonIdeConnection', () => {
  it('connects through a daemon session factory and forwards session updates', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    const factory = vi.fn().mockResolvedValue(session);
    const connection = new DaemonIdeConnection();
    const onSessionUpdate = vi.fn();
    connection.onSessionUpdate = onSessionUpdate;

    await connection.connect({
      baseUrl: 'http://127.0.0.1:4170',
      workspaceCwd: '/tmp/workspace',
      lastEventId: 10,
      sessionFactory: factory,
    });

    const update: SessionNotification = {
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'hello' },
      },
    } as SessionNotification;
    events.push({ id: 11, v: 1, type: 'session_update', data: update });

    await waitFor(() => expect(onSessionUpdate).toHaveBeenCalledWith(update));
    expect(factory).toHaveBeenCalledWith({
      baseUrl: 'http://127.0.0.1:4170/',
      token: undefined,
      workspaceCwd: '/tmp/workspace',
      modelServiceId: undefined,
      lastEventId: 10,
    });
    expect(connection.currentSessionId).toBe('session-1');
    expect(connection.lastEventId).toBe(11);

    expect(session.events).toHaveBeenCalledWith({
      signal: expect.any(AbortSignal),
      lastEventId: 10,
      resume: true,
    });

    events.close();
    await connection.disconnect();
  });

  it('serializes concurrent connects without orphaning the first session', async () => {
    const firstEvents = new EventQueue();
    const secondEvents = new EventQueue();
    const firstSession = createFakeSession(firstEvents, 'session-1');
    const secondSession = createFakeSession(secondEvents, 'session-2');
    const factory = vi
      .fn()
      .mockResolvedValueOnce(firstSession)
      .mockResolvedValueOnce(secondSession);
    const connection = new DaemonIdeConnection();

    await Promise.all([
      connection.connect({
        baseUrl: 'http://127.0.0.1:4170',
        sessionFactory: factory,
      }),
      connection.connect({
        baseUrl: 'http://127.0.0.1:4170',
        sessionFactory: factory,
      }),
    ]);

    expect(factory).toHaveBeenCalledTimes(2);
    expect(connection.currentSessionId).toBe('session-2');
    expect(connection.isConnected).toBe(true);

    secondEvents.close();
    await connection.disconnect();
  });

  it('proceeds with a second connect after the first one fails', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events, 'session-2');
    const factory = vi
      .fn()
      .mockRejectedValueOnce(new Error('first connect failed'))
      .mockResolvedValueOnce(session);
    const connection = new DaemonIdeConnection();

    const firstConnect = connection.connect({
      baseUrl: 'http://127.0.0.1:4170',
      sessionFactory: factory,
    });
    const secondConnect = connection.connect({
      baseUrl: 'http://127.0.0.1:4170',
      sessionFactory: factory,
    });

    await expect(firstConnect).rejects.toThrow('first connect failed');
    await secondConnect;

    expect(factory).toHaveBeenCalledTimes(2);
    expect(connection.currentSessionId).toBe('session-2');
    expect(connection.isConnected).toBe(true);

    events.close();
    await connection.disconnect();
  });

  it('sends prompts through the bound daemon session', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    const connection = new DaemonIdeConnection();
    const onEndTurn = vi.fn();
    connection.onEndTurn = onEndTurn;

    await connection.connect({
      baseUrl: 'http://127.0.0.1:4170',
      sessionFactory: vi.fn().mockResolvedValue(session),
    });

    await connection.sendPrompt('summarize this');

    expect(session.prompt).toHaveBeenCalledWith(
      {
        prompt: [{ type: 'text', text: 'summarize this' }],
      },
      expect.any(AbortSignal),
    );
    expect(onEndTurn).toHaveBeenCalledWith('end_turn');

    const blocks: ContentBlock[] = [
      { type: 'text', text: 'inspect' },
      {
        type: 'resource_link',
        name: 'image.png',
        uri: 'file:///tmp/image.png',
      },
    ];
    await connection.sendPrompt(blocks);
    expect(session.prompt).toHaveBeenLastCalledWith(
      { prompt: blocks },
      expect.any(AbortSignal),
    );

    session.prompt.mockRejectedValueOnce(new Error('prompt failed'));
    await expect(connection.sendPrompt('will fail')).rejects.toThrow(
      'prompt failed',
    );
    expect(onEndTurn).toHaveBeenLastCalledWith('error');

    events.close();
    await connection.disconnect();
  });

  it('responds to daemon permission requests with the selected option id', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    const connection = new DaemonIdeConnection();
    const onPermissionRequest = vi
      .fn()
      .mockResolvedValue({ optionId: 'proceed_once' });
    connection.onPermissionRequest = onPermissionRequest;

    await connection.connect({
      baseUrl: 'http://127.0.0.1:4170',
      sessionFactory: vi.fn().mockResolvedValue(session),
    });

    const request: RequestPermissionRequest & { requestId: string } = {
      requestId: 'request-1',
      sessionId: 'session-1',
      toolCall: {
        toolCallId: 'tool-1',
        title: 'Edit file',
        kind: 'edit',
        rawInput: {},
      },
      options: [
        { optionId: 'proceed_once', kind: 'allow_once', name: 'Allow' },
        { optionId: 'reject_once', kind: 'reject_once', name: 'Reject' },
      ],
    } as unknown as RequestPermissionRequest & { requestId: string };

    events.push({
      id: 12,
      v: 1,
      type: 'permission_request',
      data: request,
    });

    await waitFor(() =>
      expect(session.respondToPermission).toHaveBeenCalledWith('request-1', {
        outcome: { outcome: 'selected', optionId: 'proceed_once' },
      } satisfies RequestPermissionResponse),
    );
    expect(onPermissionRequest).toHaveBeenCalledWith(request);

    events.close();
    await connection.disconnect();
  });

  it('cancels permission requests by default and for reject options', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    const connection = new DaemonIdeConnection();

    await connection.connect({
      baseUrl: 'http://127.0.0.1:4170',
      sessionFactory: vi.fn().mockResolvedValue(session),
    });

    const request: RequestPermissionRequest & { requestId: string } = {
      requestId: 'request-1',
      sessionId: 'session-1',
      toolCall: {
        toolCallId: 'tool-1',
        title: 'Edit file',
        kind: 'edit',
        rawInput: {},
      },
      options: [
        { optionId: 'proceed_once', kind: 'allow_once', name: 'Allow' },
        { optionId: 'reject_once', kind: 'reject_once', name: 'Reject' },
      ],
    } as unknown as RequestPermissionRequest & { requestId: string };

    events.push({ id: 1, v: 1, type: 'permission_request', data: request });
    await waitFor(() =>
      expect(session.respondToPermission).toHaveBeenCalledWith('request-1', {
        outcome: { outcome: 'cancelled' },
      } satisfies RequestPermissionResponse),
    );

    connection.onPermissionRequest = vi
      .fn()
      .mockResolvedValue({ optionId: 'reject_once' });
    events.push({
      id: 2,
      v: 1,
      type: 'permission_request',
      data: { ...request, requestId: 'request-2' },
    });
    await waitFor(() =>
      expect(session.respondToPermission).toHaveBeenCalledWith('request-2', {
        outcome: { outcome: 'cancelled' },
      } satisfies RequestPermissionResponse),
    );

    connection.onPermissionRequest = vi
      .fn()
      .mockResolvedValue({ optionId: 'stale-option' });
    events.push({
      id: 3,
      v: 1,
      type: 'permission_request',
      data: { ...request, requestId: 'request-3' },
    });
    await waitFor(() =>
      expect(session.respondToPermission).toHaveBeenCalledWith('request-3', {
        outcome: { outcome: 'cancelled' },
      } satisfies RequestPermissionResponse),
    );

    events.close();
    await connection.disconnect();
  });

  it('cancels permission requests when the handler throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const events = new EventQueue();
    const session = createFakeSession(events);
    const connection = new DaemonIdeConnection();
    connection.onPermissionRequest = vi
      .fn()
      .mockRejectedValue(new Error('permission UI failed'));

    await connection.connect({
      baseUrl: 'http://127.0.0.1:4170',
      sessionFactory: vi.fn().mockResolvedValue(session),
    });

    const request: RequestPermissionRequest & { requestId: string } = {
      requestId: 'request-throws',
      sessionId: 'session-1',
      toolCall: {
        toolCallId: 'tool-1',
        title: 'Edit file',
        kind: 'edit',
        rawInput: {},
      },
      options: [
        { optionId: 'proceed_once', kind: 'allow_once', name: 'Allow' },
        { optionId: 'reject_once', kind: 'reject_once', name: 'Reject' },
      ],
    } as unknown as RequestPermissionRequest & { requestId: string };

    events.push({ id: 4, v: 1, type: 'permission_request', data: request });

    await waitFor(() =>
      expect(session.respondToPermission).toHaveBeenCalledWith(
        'request-throws',
        {
          outcome: { outcome: 'cancelled' },
        } satisfies RequestPermissionResponse,
      ),
    );
    expect(warn).toHaveBeenCalledWith(
      '[DaemonIdeConnection] Permission handler failed:',
      'permission UI failed',
    );

    events.close();
    await connection.disconnect();
    warn.mockRestore();
  });

  it('cancels permission requests when no option id is preferred', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    const connection = new DaemonIdeConnection();
    connection.onPermissionRequest = vi.fn().mockResolvedValue({});

    await connection.connect({
      baseUrl: 'http://127.0.0.1:4170',
      sessionFactory: vi.fn().mockResolvedValue(session),
    });

    const request: RequestPermissionRequest & { requestId: string } = {
      requestId: 'request-fallback',
      sessionId: 'session-1',
      toolCall: {
        toolCallId: 'tool-1',
        title: 'Edit file',
        kind: 'edit',
        rawInput: {},
      },
      options: [
        { optionId: 'allow-by-kind', kind: 'allow_once', name: 'Allow' },
        { optionId: 'reject_once', kind: 'reject_once', name: 'Reject' },
      ],
    } as unknown as RequestPermissionRequest & { requestId: string };

    events.push({ id: 4, v: 1, type: 'permission_request', data: request });
    await waitFor(() =>
      expect(session.respondToPermission).toHaveBeenCalledWith(
        'request-fallback',
        {
          outcome: { outcome: 'cancelled' },
        } satisfies RequestPermissionResponse,
      ),
    );

    events.close();
    await connection.disconnect();
  });

  it('disconnects without waiting for an in-flight permission callback', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    const connection = new DaemonIdeConnection();
    const onPermissionRequest = vi.fn(
      () => new Promise<{ optionId: string }>(() => {}),
    );
    connection.onPermissionRequest = onPermissionRequest;

    await connection.connect({
      baseUrl: 'http://127.0.0.1:4170',
      sessionFactory: vi.fn().mockResolvedValue(session),
    });

    const request: RequestPermissionRequest & { requestId: string } = {
      requestId: 'request-hangs',
      sessionId: 'session-1',
      toolCall: {
        toolCallId: 'tool-1',
        title: 'Edit file',
        kind: 'edit',
        rawInput: {},
      },
      options: [
        { optionId: 'proceed_once', kind: 'allow_once', name: 'Allow' },
      ],
    } as unknown as RequestPermissionRequest & { requestId: string };

    events.push({ id: 5, v: 1, type: 'permission_request', data: request });
    await waitFor(() => expect(onPermissionRequest).toHaveBeenCalledOnce());

    await expect(
      Promise.race([
        connection.disconnect().then(() => 'disconnected'),
        new Promise((resolve) => setTimeout(() => resolve('timeout'), 50)),
      ]),
    ).resolves.toBe('disconnected');
    expect(session.respondToPermission).not.toHaveBeenCalled();
    expect(connection.isConnected).toBe(false);
  });

  it('forwards ask-user-question answers and cancels invalid selections', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    const connection = new DaemonIdeConnection();
    connection.onAskUserQuestion = vi.fn().mockResolvedValue({
      optionId: 'proceed_once',
      answers: { q1: 'A' },
    });

    await connection.connect({
      baseUrl: 'http://127.0.0.1:4170',
      sessionFactory: vi.fn().mockResolvedValue(session),
    });

    const request: RequestPermissionRequest & { requestId: string } = {
      requestId: 'ask-1',
      sessionId: 'session-1',
      toolCall: {
        toolCallId: 'tool-ask',
        title: 'Ask',
        kind: 'ask_user_question',
        rawInput: {
          questions: [
            {
              question: 'Pick one',
              header: 'Choice',
              options: [{ label: 'A', description: 'A' }],
              multiSelect: false,
            },
          ],
          metadata: { source: 'test' },
        },
      },
      options: [
        { optionId: 'proceed_once', kind: 'allow_once', name: 'Submit' },
        { optionId: 'cancel', kind: 'reject_once', name: 'Cancel' },
      ],
    } as unknown as RequestPermissionRequest & { requestId: string };

    events.push({ id: 3, v: 1, type: 'permission_request', data: request });
    await waitFor(() =>
      expect(session.respondToPermission).toHaveBeenCalledWith('ask-1', {
        outcome: { outcome: 'selected', optionId: 'proceed_once' },
        answers: { q1: 'A' },
      } as RequestPermissionResponse),
    );

    connection.onAskUserQuestion = vi.fn().mockResolvedValue({ optionId: '' });
    events.push({
      id: 4,
      v: 1,
      type: 'permission_request',
      data: { ...request, requestId: 'ask-2' },
    });
    await waitFor(() =>
      expect(session.respondToPermission).toHaveBeenCalledWith('ask-2', {
        outcome: { outcome: 'cancelled' },
      } satisfies RequestPermissionResponse),
    );

    connection.onAskUserQuestion = vi
      .fn()
      .mockResolvedValue({ optionId: 'stale-option' });
    events.push({
      id: 5,
      v: 1,
      type: 'permission_request',
      data: { ...request, requestId: 'ask-3' },
    });
    await waitFor(() =>
      expect(session.respondToPermission).toHaveBeenCalledWith('ask-3', {
        outcome: { outcome: 'cancelled' },
      } satisfies RequestPermissionResponse),
    );

    events.close();
    await connection.disconnect();
  });

  it('does not route non-question permission requests through ask-user-question UI', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    const connection = new DaemonIdeConnection();
    const onAskUserQuestion = vi.fn();
    const onPermissionRequest = vi
      .fn()
      .mockResolvedValue({ optionId: 'proceed_once' });
    connection.onAskUserQuestion = onAskUserQuestion;
    connection.onPermissionRequest = onPermissionRequest;

    await connection.connect({
      baseUrl: 'http://127.0.0.1:4170',
      sessionFactory: vi.fn().mockResolvedValue(session),
    });

    const request: RequestPermissionRequest & { requestId: string } = {
      requestId: 'tool-approval-1',
      sessionId: 'session-1',
      toolCall: {
        toolCallId: 'tool-edit',
        title: 'Edit',
        kind: 'edit',
        rawInput: {
          questions: [
            {
              question: 'Fake prompt',
              header: 'Fake',
              options: [{ label: 'Allow', description: 'Allow' }],
              multiSelect: false,
            },
          ],
        },
      },
      options: [
        { optionId: 'proceed_once', kind: 'allow_once', name: 'Allow' },
        { optionId: 'reject_once', kind: 'reject_once', name: 'Reject' },
      ],
    } as unknown as RequestPermissionRequest & { requestId: string };

    events.push({ id: 6, v: 1, type: 'permission_request', data: request });

    await waitFor(() =>
      expect(session.respondToPermission).toHaveBeenCalledWith(
        'tool-approval-1',
        {
          outcome: { outcome: 'selected', optionId: 'proceed_once' },
        } satisfies RequestPermissionResponse,
      ),
    );
    expect(onAskUserQuestion).not.toHaveBeenCalled();
    expect(onPermissionRequest).toHaveBeenCalledWith(request);

    events.close();
    await connection.disconnect();
  });

  it('ignores malformed permission events', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    const connection = new DaemonIdeConnection();

    await connection.connect({
      baseUrl: 'http://127.0.0.1:4170',
      sessionFactory: vi.fn().mockResolvedValue(session),
    });

    events.push({
      id: 5,
      v: 1,
      type: 'permission_request',
      data: { requestId: 'bad' },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.respondToPermission).not.toHaveBeenCalled();

    events.close();
    await connection.disconnect();
  });

  it('forwards cancel and model changes to the daemon session', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    const connection = new DaemonIdeConnection();

    await connection.connect({
      baseUrl: 'http://127.0.0.1:4170',
      sessionFactory: vi.fn().mockResolvedValue(session),
    });

    await connection.cancelSession();
    await connection.setModel('qwen3-coder-plus');

    expect(session.cancel).toHaveBeenCalledOnce();
    expect(session.setModel).toHaveBeenCalledWith('qwen3-coder-plus');

    events.close();
    await connection.disconnect();
  });

  it('surfaces session_died as a disconnect', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    const connection = new DaemonIdeConnection();
    const onDisconnected = vi.fn();
    connection.onDisconnected = onDisconnected;

    await connection.connect({
      baseUrl: 'http://127.0.0.1:4170',
      sessionFactory: vi.fn().mockResolvedValue(session),
    });

    events.push({
      id: 13,
      v: 1,
      type: 'session_died',
      data: { sessionId: 'session-1', reason: 'agent exited' },
    });

    await waitFor(() =>
      expect(onDisconnected).toHaveBeenCalledWith(null, 'agent exited'),
    );
    expect(connection.isConnected).toBe(false);

    events.close();
  });

  it('ignores stale session_died events from another session', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events, 'session-current');
    const connection = new DaemonIdeConnection();
    const onDisconnected = vi.fn();
    connection.onDisconnected = onDisconnected;

    await connection.connect({
      baseUrl: 'http://127.0.0.1:4170',
      sessionFactory: vi.fn().mockResolvedValue(session),
    });

    events.push({
      id: 14,
      v: 1,
      type: 'session_died',
      data: { sessionId: 'session-stale', reason: 'old replay' },
    });

    await waitFor(() => expect(connection.lastEventId).toBe(14));
    expect(connection.currentSessionId).toBe('session-current');
    expect(onDisconnected).not.toHaveBeenCalled();

    events.push({
      id: 15,
      v: 1,
      type: 'session_died',
      data: { reason: 'malformed replay' },
    });

    await waitFor(() => expect(connection.lastEventId).toBe(15));
    expect(connection.currentSessionId).toBe('session-current');
    expect(onDisconnected).not.toHaveBeenCalled();

    events.close();
    await connection.disconnect();
  });

  it('does not advance replay state when permission responses fail', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const events = new EventQueue();
    const session = createFakeSession(events);
    session.respondToPermission.mockRejectedValueOnce(
      new Error('permission response failed'),
    );
    const connection = new DaemonIdeConnection();
    connection.onPermissionRequest = vi
      .fn()
      .mockResolvedValue({ optionId: 'proceed_once' });

    await connection.connect({
      baseUrl: 'http://127.0.0.1:4170',
      sessionFactory: vi.fn().mockResolvedValue(session),
    });

    const request: RequestPermissionRequest & { requestId: string } = {
      requestId: 'request-fails',
      sessionId: 'session-1',
      toolCall: {
        toolCallId: 'tool-1',
        title: 'Edit file',
        kind: 'edit',
        rawInput: {},
      },
      options: [
        { optionId: 'proceed_once', kind: 'allow_once', name: 'Allow' },
      ],
    } as unknown as RequestPermissionRequest & { requestId: string };

    events.push({ id: 31, v: 1, type: 'permission_request', data: request });

    await waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        '[DaemonIdeConnection] Permission response failed:',
        'permission response failed',
      ),
    );
    expect(connection.lastEventId).toBeUndefined();

    events.close();
    await connection.disconnect();
    warn.mockRestore();
  });

  it('surfaces event stream failures and normal stream completion', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failedEvents = new EventQueue();
    failedEvents.fail(new Error('network down'));
    const failedSession = createFakeSession(failedEvents);
    const failedConnection = new DaemonIdeConnection();
    const failedDisconnected = vi.fn();
    failedConnection.onDisconnected = failedDisconnected;

    await failedConnection.connect({
      baseUrl: 'http://127.0.0.1:4170',
      sessionFactory: vi.fn().mockResolvedValue(failedSession),
    });
    await waitFor(() =>
      expect(failedDisconnected).toHaveBeenCalledWith(null, 'daemon_error'),
    );
    expect(failedConnection.isConnected).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      '[DaemonIdeConnection] Event stream failed:',
      'network down',
    );

    const endedEvents = new EventQueue();
    const endedSession = createFakeSession(endedEvents);
    const endedConnection = new DaemonIdeConnection();
    const endedDisconnected = vi.fn();
    endedConnection.onDisconnected = endedDisconnected;

    await endedConnection.connect({
      baseUrl: 'http://127.0.0.1:4170',
      sessionFactory: vi.fn().mockResolvedValue(endedSession),
    });
    endedEvents.close();
    await waitFor(() =>
      expect(endedDisconnected).toHaveBeenCalledWith(null, 'stream_ended'),
    );
    expect(endedConnection.isConnected).toBe(false);
    warn.mockRestore();
  });

  it('continues after handler failures while advancing replay state', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const events = new EventQueue();
    const session = createFakeSession(events);
    const connection = new DaemonIdeConnection();
    connection.onSessionUpdate = () => {
      throw new Error('handler failed');
    };

    await connection.connect({
      baseUrl: 'http://127.0.0.1:4170',
      sessionFactory: vi.fn().mockResolvedValue(session),
    });

    events.push({
      id: 20,
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

    await waitFor(() => expect(connection.lastEventId).toBe(20));
    expect(warn).toHaveBeenCalledWith(
      '[DaemonIdeConnection] Event handler failed:',
      {
        sessionId: 'session-1',
        eventType: 'session_update',
        eventId: 20,
        error: 'handler failed',
      },
    );

    events.close();
    await connection.disconnect();
    warn.mockRestore();
  });

  it('validates daemon base URLs before connecting', async () => {
    const connection = new DaemonIdeConnection();
    await expect(
      connection.connect({
        baseUrl: 'file:///tmp/daemon.sock',
        sessionFactory: vi.fn(),
      }),
    ).rejects.toThrow('Daemon baseUrl must use http or https scheme');

    await expect(
      connection.connect({
        baseUrl: 'http://user:pass@127.0.0.1:4170',
        sessionFactory: vi.fn(),
      }),
    ).rejects.toThrow('Daemon baseUrl must not contain credentials');

    await expect(
      connection.connect({
        baseUrl: 'http://example.com:4170',
        sessionFactory: vi.fn(),
      }),
    ).rejects.toThrow(
      'Daemon baseUrl must target a loopback address, got "example.com"',
    );
  });
});
