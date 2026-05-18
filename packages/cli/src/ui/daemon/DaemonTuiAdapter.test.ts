/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type {
  ContentBlock,
  RequestPermissionRequest,
} from '@agentclientprotocol/sdk';
import {
  createDaemonTuiReducerState,
  DaemonTuiAdapter,
  reduceDaemonEventToTuiUpdates,
  type DaemonTuiEvent,
  type DaemonTuiSessionClient,
} from './DaemonTuiAdapter.js';
import { ToolCallStatus } from '../types.js';

class EventQueue implements AsyncGenerator<DaemonTuiEvent> {
  private events: DaemonTuiEvent[] = [];
  private waiters: Array<{
    resolve: (value: IteratorResult<DaemonTuiEvent>) => void;
    reject: (error: unknown) => void;
  }> = [];
  private closed = false;
  private failure: unknown;

  async next(): Promise<IteratorResult<DaemonTuiEvent>> {
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

  async return(): Promise<IteratorResult<DaemonTuiEvent>> {
    this.close();
    return { done: true, value: undefined };
  }

  async throw(error?: unknown): Promise<IteratorResult<DaemonTuiEvent>> {
    this.close();
    throw error;
  }

  [Symbol.asyncIterator](): AsyncGenerator<DaemonTuiEvent> {
    return this;
  }

  push(event: DaemonTuiEvent): void {
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

interface FakeSession extends DaemonTuiSessionClient {
  prompt: ReturnType<typeof vi.fn>;
  events: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  setModel: ReturnType<typeof vi.fn>;
  respondToPermission: ReturnType<typeof vi.fn>;
}

function createFakeSession(events: EventQueue): FakeSession {
  return {
    sessionId: 'session-1',
    workspaceCwd: '/repo',
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

describe('reduceDaemonEventToTuiUpdates', () => {
  it('maps assistant, thought, tool, model, and disconnect daemon events', () => {
    expect(
      reduceDaemonEventToTuiUpdates({
        id: 0,
        v: 1,
        type: 'session_update',
        data: {
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'user_message_chunk',
            content: { type: 'text', text: 'hello' },
          },
        },
      }),
    ).toEqual([]);

    expect(
      reduceDaemonEventToTuiUpdates({
        id: 1,
        v: 1,
        type: 'session_update',
        data: {
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: '\u202e\x9b31mhe\rllo\x00' },
          },
        },
      }),
    ).toEqual([
      {
        type: 'history',
        item: { type: 'gemini_content', text: 'hello' },
        daemonEventId: 1,
      },
    ]);

    expect(
      reduceDaemonEventToTuiUpdates({
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
      }),
    ).toEqual([
      {
        type: 'history',
        item: { type: 'gemini_thought_content', text: 'thinking' },
        daemonEventId: 2,
      },
    ]);

    expect(
      reduceDaemonEventToTuiUpdates({
        id: 20,
        v: 1,
        type: 'session_update',
        data: {
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'plan',
            entries: [
              {
                status: '\x1b]0;bad\x07pending',
                content: '\x1b[31mfinish this\x1b[0m',
              },
            ],
          },
        },
      }),
    ).toEqual([
      {
        type: 'history',
        item: { type: 'info', text: '1. [pending] finish this' },
        daemonEventId: 20,
      },
    ]);

    const toolUpdates = reduceDaemonEventToTuiUpdates({
      id: 3,
      v: 1,
      type: 'session_update',
      data: {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tool-1',
          kind: '\x1b]0;bad\x07read_file',
          title: '\x1b[31mRead file\x1b[0m',
          status: 'completed',
          rawOutput: '\x1b[31m3 lines\x1b[0m',
        },
      },
    });
    expect(toolUpdates).toHaveLength(1);
    expect(toolUpdates[0]).toMatchObject({
      type: 'tool_group_update',
      item: {
        type: 'tool_group',
        tools: [
          {
            callId: 'tool-1',
            name: 'read_file',
            description: 'Read file',
            status: ToolCallStatus.Success,
            resultDisplay: '3 lines',
          },
        ],
      },
      daemonEventId: 3,
    });

    expect(
      reduceDaemonEventToTuiUpdates({
        id: 4,
        v: 1,
        type: 'model_switched',
        data: {
          sessionId: 'session-1',
          modelId: '\x1b]0;bad\x07qwen3-coder-plus',
        },
      }),
    ).toEqual([
      {
        type: 'model_switched',
        modelId: 'qwen3-coder-plus',
        daemonEventId: 4,
      },
      {
        type: 'history',
        item: {
          type: 'info',
          text: 'Model switched to qwen3-coder-plus',
        },
        daemonEventId: 4,
      },
    ]);

    expect(
      reduceDaemonEventToTuiUpdates({
        id: 5,
        v: 1,
        type: 'session_died',
        data: {
          sessionId: 'session-1',
          reason: '\x1b]0;bad title\x07\x1b[31magent exited\x1b[0m',
        },
      }),
    ).toEqual([
      { type: 'disconnected', reason: 'agent exited', daemonEventId: 5 },
      {
        type: 'history',
        item: {
          type: 'error',
          text: 'Daemon session disconnected: agent exited',
        },
        daemonEventId: 5,
      },
    ]);

    expect(
      reduceDaemonEventToTuiUpdates({
        id: 6,
        v: 1,
        type: 'client_evicted',
        data: { reason: 'queue_overflow' },
      }),
    ).toEqual([
      { type: 'disconnected', reason: 'queue_overflow', daemonEventId: 6 },
      {
        type: 'history',
        item: {
          type: 'error',
          text: 'Daemon session disconnected: queue_overflow',
        },
        daemonEventId: 6,
      },
    ]);

    expect(
      reduceDaemonEventToTuiUpdates({
        id: 7,
        v: 1,
        type: 'stream_error',
        data: { error: '\x1bPignored\x1b\\\x1b[31mstream failed\x1b[0m' },
      }),
    ).toEqual([
      { type: 'disconnected', reason: 'stream failed', daemonEventId: 7 },
      {
        type: 'history',
        item: {
          type: 'error',
          text: 'Daemon session disconnected: stream failed',
        },
        daemonEventId: 7,
      },
    ]);
  });

  it('accumulates tool updates and preserves structured result displays', () => {
    const state = createDaemonTuiReducerState();
    const fileDiff = {
      fileDiff: '\x1b[31m--- a\n+++ b\x1b[0m',
      fileName: '\u202ea.txt',
      originalContent: 'a\r',
      newContent: 'b\x9b31m',
    };
    const sanitizedFileDiff = {
      fileDiff: '--- a\n+++ b',
      fileName: 'a.txt',
      originalContent: 'a',
      newContent: 'b',
    };

    expect(
      reduceDaemonEventToTuiUpdates(
        {
          id: 1,
          v: 1,
          type: 'session_update',
          data: {
            sessionId: 'session-1',
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'tool-1',
              kind: 'read_file',
              title: 'Read file',
              status: 'running',
            },
          },
        },
        state,
      ),
    ).toMatchObject([
      {
        type: 'tool_group_update',
        item: {
          type: 'tool_group',
          tools: [{ callId: 'tool-1', status: ToolCallStatus.Executing }],
        },
      },
    ]);

    expect(
      reduceDaemonEventToTuiUpdates(
        {
          id: 2,
          v: 1,
          type: 'session_update',
          data: {
            sessionId: 'session-1',
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'tool-1',
              status: 'completed',
              rawOutput: fileDiff,
            },
          },
        },
        state,
      ),
    ).toMatchObject([
      {
        type: 'tool_group_update',
        item: {
          type: 'tool_group',
          tools: [
            {
              callId: 'tool-1',
              name: 'read_file',
              description: 'Read file',
              status: ToolCallStatus.Success,
              resultDisplay: sanitizedFileDiff,
            },
          ],
        },
      },
    ]);

    expect(
      reduceDaemonEventToTuiUpdates(
        {
          id: 3,
          v: 1,
          type: 'session_update',
          data: {
            sessionId: 'session-1',
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'tool-2',
              kind: 'shell',
              status: 'unexpected',
            },
          },
        },
        state,
      ),
    ).toMatchObject([
      {
        type: 'tool_group_update',
        item: {
          type: 'tool_group',
          tools: [
            { callId: 'tool-1' },
            { callId: 'tool-2', status: ToolCallStatus.Error },
          ],
        },
      },
    ]);

    expect(
      reduceDaemonEventToTuiUpdates(
        {
          id: 4,
          v: 1,
          type: 'session_update',
          data: {
            sessionId: 'session-1',
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'tool-3',
              kind: 'shell',
              status: 'failed',
              content: [{ content: { text: 'command failed' } }],
            },
          },
        },
        state,
      ),
    ).toMatchObject([
      {
        type: 'tool_group_update',
        item: {
          type: 'tool_group',
          tools: [
            { callId: 'tool-1' },
            { callId: 'tool-2' },
            {
              callId: 'tool-3',
              status: ToolCallStatus.Error,
              resultDisplay: 'command failed',
            },
          ],
        },
      },
    ]);

    for (let i = 0; i < 130; i += 1) {
      reduceDaemonEventToTuiUpdates(
        {
          id: 100 + i,
          v: 1,
          type: 'session_update',
          data: {
            sessionId: 'session-1',
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: `evict-${i}`,
              kind: 'shell',
              status: 'completed',
            },
          },
        },
        state,
      );
    }
    expect(state.toolCallsById.size).toBe(128);
    expect(state.toolCallsById.has('tool-1')).toBe(false);
    expect(state.toolCallsById.has('evict-129')).toBe(true);
  });

  it('maps permission lifecycle events without auto-voting', () => {
    const request: RequestPermissionRequest & { requestId: string } = {
      requestId: 'req-1',
      sessionId: 'session-1',
      toolCall: {
        toolCallId: 'tool-1',
        title: '\x1b[31mEdit file\x1b[0m',
        kind: 'edit',
        rawInput: {},
      },
      options: [
        {
          optionId: 'proceed_once',
          kind: 'allow_once',
          name: '\x1b]0;bad\x07Allow',
        },
      ],
    } as RequestPermissionRequest & { requestId: string };
    const sanitizedRequest = {
      ...request,
      toolCall: { ...request.toolCall, title: 'Edit file' },
      options: [
        { optionId: 'proceed_once', kind: 'allow_once', name: 'Allow' },
      ],
    };

    expect(
      reduceDaemonEventToTuiUpdates({
        id: 6,
        v: 1,
        type: 'permission_request',
        data: request,
      }),
    ).toEqual([
      {
        type: 'permission_request',
        requestId: 'req-1',
        request: sanitizedRequest,
        daemonEventId: 6,
      },
    ]);

    expect(
      reduceDaemonEventToTuiUpdates({
        id: 7,
        v: 1,
        type: 'permission_resolved',
        data: {
          requestId: 'req-1',
          outcome: { outcome: 'selected', optionId: '\x1b[31mproceed_once' },
        },
      }),
    ).toEqual([
      {
        type: 'permission_resolved',
        requestId: 'req-1',
        outcome: { outcome: 'selected', optionId: 'proceed_once' },
        daemonEventId: 7,
      },
    ]);

    expect(
      reduceDaemonEventToTuiUpdates({
        id: 8,
        v: 1,
        type: 'permission_resolved',
        data: { requestId: 'req-1', outcome: { outcome: 'selected' } },
      }),
    ).toEqual([
      {
        type: 'permission_resolved',
        requestId: 'req-1',
        outcome: undefined,
        daemonEventId: 8,
      },
    ]);

    expect(
      reduceDaemonEventToTuiUpdates({
        id: 9,
        v: 1,
        type: 'permission_request',
        data: { requestId: 'req-bad' },
      }),
    ).toEqual([]);
  });

  it('returns no UI updates for unknown daemon event types', () => {
    expect(
      reduceDaemonEventToTuiUpdates({
        id: 99,
        v: 1,
        type: 'new_daemon_event',
        data: {},
      }),
    ).toEqual([]);
    expect(
      reduceDaemonEventToTuiUpdates({
        id: 100,
        v: 1,
        type: 'new_daemon_event',
        data: {},
      }),
    ).toEqual([]);
  });
});

describe('DaemonTuiAdapter', () => {
  it('pumps daemon events into TUI updates and tracks replay state', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    Object.defineProperty(session, 'lastEventId', { value: 3 });
    const onUpdate = vi.fn();
    const adapter = new DaemonTuiAdapter({ session, onUpdate });

    adapter.start();
    events.push({
      id: 10,
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

    await waitFor(() =>
      expect(onUpdate).toHaveBeenCalledWith({
        type: 'history',
        item: { type: 'gemini_content', text: 'hello' },
        daemonEventId: 10,
      }),
    );
    expect(adapter.lastEventId).toBe(10);
    expect(session.events).toHaveBeenCalledWith({
      signal: expect.any(AbortSignal),
      lastEventId: 3,
      resume: true,
    });

    await adapter.stop();
  });

  it('emits disconnected when the event stream ends or fails', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    const onUpdate = vi.fn();
    const adapter = new DaemonTuiAdapter({ session, onUpdate });

    adapter.start();
    events.close();
    await waitFor(() =>
      expect(onUpdate).toHaveBeenCalledWith({
        type: 'disconnected',
        reason: 'event stream ended',
      }),
    );

    const failingEvents = new EventQueue();
    failingEvents.fail(new Error('\x1b[31mboom\x1b[0m'));
    const failingSession = createFakeSession(failingEvents);
    const onFailingUpdate = vi.fn();
    const failingAdapter = new DaemonTuiAdapter({
      session: failingSession,
      onUpdate: onFailingUpdate,
    });

    failingAdapter.start();
    await waitFor(() =>
      expect(onFailingUpdate).toHaveBeenCalledWith({
        type: 'disconnected',
        reason: 'boom',
      }),
    );

    const throwingEvents = new EventQueue();
    const throwingSession = createFakeSession(throwingEvents);
    const throwingAdapter = new DaemonTuiAdapter({
      session: throwingSession,
      onUpdate: () => {
        throw new Error('\x1b]0;bad\x07render failed');
      },
    });
    throwingAdapter.start();
    throwingEvents.close();
    await expect(throwingAdapter.stop()).resolves.toBeUndefined();
  });

  it('reports unsupported daemon protocol versions once and advances replay state', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    const onUpdate = vi.fn();
    const adapter = new DaemonTuiAdapter({ session, onUpdate });

    adapter.start();
    events.push({ id: 41, v: 2 as 1, type: 'future_event', data: {} });
    events.push({ id: 42, v: 2 as 1, type: 'future_event', data: {} });

    await waitFor(() => expect(adapter.lastEventId).toBe(42));
    const unsupportedUpdates = onUpdate.mock.calls.filter(
      ([update]) =>
        update.type === 'history' &&
        update.item.type === 'error' &&
        update.item.text.includes('Unsupported daemon protocol version'),
    );
    expect(unsupportedUpdates).toHaveLength(1);

    events.close();
    await adapter.stop();
  });

  it('forwards prompt, cancel, model switch, and permission votes', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    const onUpdate = vi.fn();
    const adapter = new DaemonTuiAdapter({ session, onUpdate });

    adapter.start();
    await adapter.sendPrompt('hello daemon');
    expect(session.prompt).toHaveBeenCalledWith(
      {
        prompt: [{ type: 'text', text: 'hello daemon' }],
      },
      expect.any(AbortSignal),
    );
    expect(onUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'turn_complete' }),
    );

    const blocks: ContentBlock[] = [{ type: 'text', text: 'structured' }];
    await adapter.sendPrompt(blocks);
    expect(session.prompt).toHaveBeenLastCalledWith(
      { prompt: blocks },
      expect.any(AbortSignal),
    );

    await adapter.cancel();
    await adapter.setModel('qwen3-coder-plus');
    await adapter.approvePermission('req-1', 'proceed_once');
    await adapter.rejectPermission('req-2');

    expect(session.cancel).toHaveBeenCalledOnce();
    expect(session.setModel).toHaveBeenCalledWith('qwen3-coder-plus');
    expect(session.respondToPermission).toHaveBeenNthCalledWith(1, 'req-1', {
      outcome: { outcome: 'selected', optionId: 'proceed_once' },
    });
    expect(session.respondToPermission).toHaveBeenNthCalledWith(2, 'req-2', {
      outcome: { outcome: 'cancelled' },
    });

    await adapter.stop();
  });

  it('reports prompt failures without fabricating turn completion', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    session.prompt.mockRejectedValue(new Error('\x1b[31mdaemon down\x1b[0m'));
    const onUpdate = vi.fn();
    const adapter = new DaemonTuiAdapter({ session, onUpdate });

    adapter.start();
    await expect(adapter.sendPrompt('hello daemon')).rejects.toThrow(
      'daemon down',
    );
    expect(onUpdate).toHaveBeenCalledWith({
      type: 'disconnected',
      reason: 'daemon down',
    });
    expect(onUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'turn_complete' }),
    );

    events.close();
  });

  it('requires a running event pump before sending control RPCs', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    const adapter = new DaemonTuiAdapter({ session, onUpdate: vi.fn() });

    await expect(adapter.sendPrompt('hello')).rejects.toThrow(
      'Daemon TUI adapter is not running',
    );
    await expect(adapter.cancel()).rejects.toThrow(
      'Daemon TUI adapter is not running',
    );

    events.close();
  });

  it('restarts after start is requested while stop is draining the pump', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    const onUpdate = vi.fn();
    const adapter = new DaemonTuiAdapter({ session, onUpdate });

    adapter.start();
    const stopPromise = adapter.stop();
    adapter.start();
    await stopPromise;

    await waitFor(() => expect(session.events).toHaveBeenCalledTimes(2));
    await adapter.stop();
  });

  it('forces idle when the event pump ignores abort during stop', async () => {
    vi.useFakeTimers();
    const events = new EventQueue();
    const session = createFakeSession(events);
    const hangingEvents: AsyncGenerator<DaemonTuiEvent> = {
      next: vi.fn(() => new Promise<IteratorResult<DaemonTuiEvent>>(() => {})),
      return: vi.fn(async () => ({ done: true as const, value: undefined })),
      throw: vi.fn(async (error?: unknown) => {
        throw error;
      }),
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    session.events.mockReturnValue(hangingEvents);
    const onUpdate = vi.fn();
    const adapter = new DaemonTuiAdapter({ session, onUpdate });

    adapter.start();
    const stopPromise = adapter.stop();
    adapter.start();
    await vi.advanceTimersByTimeAsync(5_000);
    await stopPromise;

    expect(session.events).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('clears accumulated tool state before each prompt', async () => {
    const events = new EventQueue();
    const session = createFakeSession(events);
    const onUpdate = vi.fn();
    const adapter = new DaemonTuiAdapter({ session, onUpdate });

    adapter.start();
    events.push({
      id: 1,
      v: 1,
      type: 'session_update',
      data: {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'old-tool',
          kind: 'shell',
          status: 'completed',
        },
      },
    });
    await waitFor(() =>
      expect(onUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'tool_group_update',
          item: expect.objectContaining({
            tools: [expect.objectContaining({ callId: 'old-tool' })],
          }),
        }),
      ),
    );

    await adapter.sendPrompt('next turn');
    events.push({
      id: 2,
      v: 1,
      type: 'session_update',
      data: {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'new-tool',
          kind: 'grep',
          status: 'running',
        },
      },
    });

    await waitFor(() => {
      const lastToolUpdate = onUpdate.mock.calls
        .map(([update]) => update)
        .filter((update) => update.type === 'tool_group_update')
        .at(-1);
      expect(lastToolUpdate).toMatchObject({
        item: {
          tools: [expect.objectContaining({ callId: 'new-tool' })],
        },
      });
      expect(lastToolUpdate?.item.tools).toHaveLength(1);
    });

    await adapter.stop();
  });

  it('reports daemon control failures without dropping the event stream', async () => {
    const cancelEvents = new EventQueue();
    const cancelSession = createFakeSession(cancelEvents);
    const cancelUpdates = vi.fn();
    const cancelAdapter = new DaemonTuiAdapter({
      session: cancelSession,
      onUpdate: cancelUpdates,
    });
    cancelAdapter.start();
    cancelSession.cancel.mockRejectedValueOnce(
      new Error('\x1b[31mcancel down\x1b[0m'),
    );
    await expect(cancelAdapter.cancel()).rejects.toThrow('cancel down');
    expect(cancelUpdates).toHaveBeenCalledWith({
      type: 'history',
      item: { type: 'error', text: 'Daemon RPC failed: cancel down' },
    });
    expect(cancelUpdates).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'disconnected' }),
    );

    const modelEvents = new EventQueue();
    const modelSession = createFakeSession(modelEvents);
    const modelUpdates = vi.fn();
    const modelAdapter = new DaemonTuiAdapter({
      session: modelSession,
      onUpdate: modelUpdates,
    });
    modelAdapter.start();
    modelSession.setModel.mockRejectedValueOnce(new Error('model down'));
    await expect(modelAdapter.setModel('qwen3-coder-plus')).rejects.toThrow(
      'model down',
    );
    expect(modelUpdates).toHaveBeenCalledWith({
      type: 'history',
      item: { type: 'error', text: 'Daemon RPC failed: model down' },
    });
    expect(modelUpdates).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'disconnected' }),
    );

    const voteEvents = new EventQueue();
    const voteSession = createFakeSession(voteEvents);
    const voteUpdates = vi.fn();
    const voteAdapter = new DaemonTuiAdapter({
      session: voteSession,
      onUpdate: voteUpdates,
    });
    voteAdapter.start();
    voteSession.respondToPermission.mockRejectedValueOnce(
      new Error('vote down'),
    );
    await expect(
      voteAdapter.approvePermission('req-1', 'proceed_once'),
    ).rejects.toThrow('vote down');
    expect(voteUpdates).toHaveBeenCalledWith({
      type: 'history',
      item: { type: 'error', text: 'Daemon RPC failed: vote down' },
    });
    expect(voteUpdates).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'disconnected' }),
    );

    cancelEvents.close();
    modelEvents.close();
    voteEvents.close();
  });
});
