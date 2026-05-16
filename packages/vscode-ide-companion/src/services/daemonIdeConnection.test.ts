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
  private waiters: Array<(value: IteratorResult<DaemonIdeEvent>) => void> = [];
  private closed = false;

  async next(): Promise<IteratorResult<DaemonIdeEvent>> {
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

interface FakeSession extends DaemonIdeSessionClient {
  prompt: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  setModel: ReturnType<typeof vi.fn>;
  respondToPermission: ReturnType<typeof vi.fn>;
}

function createFakeSession(events: EventQueue): FakeSession {
  return {
    sessionId: 'session-1',
    workspaceCwd: '/tmp/workspace',
    lastEventId: undefined,
    prompt: vi.fn().mockResolvedValue({ stopReason: 'end_turn' }),
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
      baseUrl: 'http://127.0.0.1:4170',
      token: undefined,
      workspaceCwd: '/tmp/workspace',
      modelServiceId: undefined,
      lastEventId: 10,
    });
    expect(connection.currentSessionId).toBe('session-1');
    expect(connection.lastEventId).toBe(11);

    events.close();
    connection.disconnect();
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

    expect(session.prompt).toHaveBeenCalledWith({
      prompt: [{ type: 'text', text: 'summarize this' }],
    });
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
    expect(session.prompt).toHaveBeenLastCalledWith({ prompt: blocks });

    events.close();
    connection.disconnect();
  });

  it('responds to daemon permission requests with the selected option id', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    const connection = new DaemonIdeConnection();
    const onPermissionRequest = vi.fn().mockResolvedValue('proceed_once');
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
    } as RequestPermissionRequest & { requestId: string };

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
    connection.disconnect();
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
    connection.disconnect();
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
});
