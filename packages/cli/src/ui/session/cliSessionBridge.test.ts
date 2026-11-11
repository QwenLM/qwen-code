/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { createSessionMessageChannel } from '../../session/sessionMessageChannel.js';
import {
  CoreToolCallStatus,
  StreamingState,
  type HistoryItemWithoutId,
  type IndividualToolCallDisplay,
} from '../types.js';
import {
  createCliSessionBridge,
  type CliSessionBridge,
  type CliSessionDisplayInitialState,
  type CliSessionDisplayChange,
} from './cliSessionBridge.js';

const thinking = '**Checking cwd**\nInspecting';
const thought = { subject: 'Checking cwd', description: 'Inspecting' };
const approval: IndividualToolCallDisplay = {
  callId: 'call-1',
  correlationId: 'approval-1',
  name: 'Read',
  description: 'Read file',
  status: CoreToolCallStatus.AwaitingApproval,
  resultDisplay: undefined,
  confirmationDetails: undefined,
};

function initial(
  overrides: Partial<CliSessionDisplayInitialState> = {},
): CliSessionDisplayInitialState {
  return {
    pendingAssistantText: '',
    pendingApprovalTools: [],
    workerStatus: 'idle',
    pendingDisplayHistory: null,
    historyAvailable: false,
    ...overrides,
  };
}

function createSession(overrides: Partial<CliSessionDisplayInitialState> = {}) {
  const history: HistoryItemWithoutId[] = [];
  const addHistoryItem = vi.fn((item: HistoryItemWithoutId) => {
    history.push(item);
  });
  const session = createCliSessionBridge({
    initialState: initial(overrides),
    addHistoryItem,
  });
  return { session, history, addHistoryItem };
}

function delta(
  session: CliSessionBridge,
  type: 'thinking_delta' | 'text_delta',
  text: string,
) {
  session.apply({ type: 'assistant_stream_delta', delta: { type, text } });
}

function pending(session: CliSessionBridge, items: HistoryItemWithoutId[]) {
  session.apply({
    type: 'display_history',
    change: { type: 'pending', items },
  });
}

describe('createCliSessionBridge', () => {
  it('keeps a live approval when the display tool lacks its request id', () => {
    const nativeTool = { ...approval, correlationId: undefined };
    const { session } = createSession({ pendingApprovalTools: [approval] });
    pending(session, [{ type: 'tool_group', tools: [nativeTool] }]);
    expect(session.getSnapshot().pendingHistoryItems).toEqual([
      { type: 'tool_group', tools: [nativeTool] },
      { type: 'tool_group', tools: [approval] },
    ]);
  });
  it.each([false, true])(
    'preserves streaming display and writes thinking only without source history (%s)',
    (hasDisplayHistory) => {
      const channel = createSessionMessageChannel({
        pendingAssistantText: '',
        activityStatus: 'idle',
      });
      const history = vi.fn();
      const session = createCliSessionBridge({
        initialState: initial(),
        addHistoryItem: history,
        port: {
          observe: channel.observe,
          submitMessage: vi.fn(),
          interrupt: vi.fn(),
        },
      });
      const stop = session.observeSession();
      const source = { delivery: 'live' as const, hasDisplayHistory };
      channel.applyEvent({
        type: 'assistant_stream',
        delta: { type: 'thinking_delta', text: thinking },
        source,
      });
      expect(session.getSnapshot().thought).toEqual(thought);
      channel.applyEvent({
        type: 'assistant_stream',
        delta: { type: 'text_delta', text: 'answer' },
        source,
      });
      expect(session.getSnapshot().pendingAssistantText).toBe('answer');
      expect(history.mock.calls).toEqual(
        hasDisplayHistory ? [] : [[{ type: 'thinking', thought }]],
      );
      stop();
      session.dispose();
    },
  );
  it('reads restored display without appending formal history', () => {
    const { session, history } = createSession({
      pendingAssistantText: ' restored ',
    });
    expect(session.getSnapshot()).toMatchObject({
      pendingAssistantText: ' restored ',
      thought: null,
      pendingHistoryItems: [{ type: 'gemini', text: ' restored ' }],
      pendingApprovalCount: 0,
      workerStatus: 'idle',
      activeModelQueue: null,
    });
    expect(session.getSnapshot()).toBe(session.getSnapshot());
    expect(history).toEqual([]);
  });

  it('retains snapshot identity and sends no notification for unchanged display', () => {
    const { session } = createSession();
    const listener = vi.fn();
    session.subscribe(listener);
    const before = session.getSnapshot();
    delta(session, 'text_delta', '');
    session.apply({ type: 'worker_status', status: 'idle' });
    session.apply({ type: 'approval_tools', update: (items) => items });
    session.prepareHistory({});
    expect(session.getSnapshot()).toBe(before);
    expect(listener).not.toHaveBeenCalled();
  });

  it('publishes a complete snapshot after each stream update', () => {
    const { session, history } = createSession();
    const snapshots: Array<ReturnType<CliSessionBridge['getSnapshot']>> = [];
    session.subscribe(() => snapshots.push(session.getSnapshot()));
    delta(session, 'thinking_delta', '**Checking');
    delta(session, 'thinking_delta', ' cwd**\nInspecting');
    delta(session, 'text_delta', 'Hello');
    expect(snapshots).toHaveLength(3);
    expect(snapshots[1].thought).toEqual(thought);
    expect(snapshots[2]).toMatchObject({
      thought: null,
      pendingAssistantText: 'Hello',
      pendingHistoryItems: [{ type: 'gemini', text: 'Hello' }],
    });
    expect(history).toEqual([{ type: 'thinking', thought }]);
    // Already published snapshots do not change after a later stream update.
    expect(snapshots[0].pendingAssistantText).toBe('');
  });

  it('shares thinking deduplication across streaming and full assistant messages', () => {
    const { session, history } = createSession();
    delta(session, 'thinking_delta', thinking);
    delta(session, 'text_delta', 'stream');
    session.apply({
      type: 'assistant_message',
      thinkingTexts: [thinking],
      text: ' final ',
    });
    session.apply({ type: 'assistant_received', terminal: true });
    expect(history).toEqual([
      { type: 'thinking', thought },
      { type: 'gemini', text: ' final ' },
    ]);
    expect(session.getSnapshot().pendingHistoryItems).toEqual([]);
    expect(session.getStreamingState(session.getSnapshot())).toBe(
      StreamingState.Idle,
    );
  });

  it('forwards user messages and tool results to the single supplied history writer', () => {
    const { session, history } = createSession();
    session.apply({
      type: 'user_message',
      content: { text: 'question', images: [] },
    });
    session.apply({
      type: 'tool_results',
      results: [
        {
          toolUse: { id: 'ok', name: 'mcp__demo__lookup', input: undefined },
          toolResult: { content: 'yes', isError: false },
        },
        {
          toolUse: { id: 'bad', name: 'mcp__demo__lookup', input: undefined },
          toolResult: { content: 'no', isError: true },
        },
      ],
    });
    expect(history).toEqual([
      { type: 'user', text: 'question' },
      expect.objectContaining({
        type: 'tool_group',
        tools: [
          expect.objectContaining({
            callId: 'ok',
            status: CoreToolCallStatus.Success,
          }),
          expect.objectContaining({
            callId: 'bad',
            status: CoreToolCallStatus.Error,
          }),
        ],
      }),
    ]);
    expect(session.getSnapshot()).not.toHaveProperty('history');
  });

  it('preserves the per-operation history writer for optimistic input and send failures', () => {
    const { session, addHistoryItem } = createSession();
    const latestWriter = vi.fn();
    session.apply(
      { type: 'user_message', content: { text: 'new input', images: [] } },
      latestWriter,
    );
    session.apply({ type: 'request_error', text: 'send failed' }, latestWriter);
    session.apply({
      type: 'assistant_message',
      thinkingTexts: [],
      text: 'inbound',
    });
    expect(latestWriter.mock.calls).toEqual([
      [{ type: 'user', text: 'new input' }],
      [{ type: 'error', text: 'send failed' }],
    ]);
    expect(addHistoryItem.mock.calls).toEqual([
      [{ type: 'gemini', text: 'inbound' }],
    ]);
  });

  it('prioritizes pending display items, extracts the first model queue and adds missing approvals', () => {
    const queue = { status: 'queued' as const, progress: 10 };
    const { session } = createSession({
      pendingAssistantText: 'hidden body',
      pendingApprovalTools: [approval],
      pendingDisplayHistory: [
        { type: 'model_queue', modelQueue: queue },
        { type: 'model_queue', modelQueue: { status: 'ready', progress: 100 } },
        { type: 'gemini', text: 'overlay' },
      ],
    });
    expect(session.getSnapshot().activeModelQueue).toBe(queue);
    expect(session.getSnapshot().pendingHistoryItems).toEqual([
      { type: 'gemini', text: 'overlay' },
      { type: 'tool_group', tools: [approval] },
    ]);
    expect(session.getStreamingState(session.getSnapshot())).toBe(
      StreamingState.WaitingForConfirmation,
    );
    pending(session, [{ type: 'tool_group', tools: [approval] }]);
    expect(session.getSnapshot().pendingHistoryItems).toHaveLength(1);
    pending(session, []);
    expect(session.getSnapshot().pendingHistoryItems).toEqual([
      { type: 'tool_group', tools: [approval] },
    ]);
  });

  it('deep-copies pending snapshots while keeping formal-history item identity', () => {
    const { session, history } = createSession();
    const item: HistoryItemWithoutId = {
      type: 'thinking',
      thought: { ...thought },
    };
    pending(session, [item]);
    item.thought.description = 'changed';
    expect(session.getSnapshot().pendingHistoryItems[0]).toMatchObject({
      thought,
    });
    session.apply({
      type: 'display_history',
      change: { type: 'append', item },
    });
    expect(history[0]).toBe(item);
  });

  it('keeps initial history snapshots, append order and replay fallback semantics', () => {
    const { session, history } = createSession({
      pendingAssistantText: 'body',
    });
    const first: HistoryItemWithoutId = { type: 'gemini', text: 'first' };
    session.apply({
      type: 'display_history',
      change: { type: 'snapshot', items: [first] },
    });
    session.apply({
      type: 'display_history',
      change: {
        type: 'snapshot',
        items: [{ type: 'gemini', text: 'ignored' }],
      },
    });
    session.apply({
      type: 'display_history',
      change: { type: 'append', item: { type: 'info', text: 'next' } },
    });
    pending(session, [{ type: 'gemini', text: 'overlay' }]);
    expect(session.prepareHistory({})).toBe(true);
    expect(
      session.prepareHistory({
        allowDurableDisplayFallback: true,
        preferDisplayEvents: true,
      }),
    ).toBe(false);
    expect(session.getSnapshot().pendingHistoryItems).toEqual([
      { type: 'gemini', text: 'body' },
    ]);
    expect(session.prepareHistory({})).toBe(true);
    expect(history).toEqual([first, { type: 'info', text: 'next' }]);
  });

  it('marks a history snapshot available after writes and an append before its write', () => {
    const observed: boolean[] = [];
    const session: CliSessionBridge = createCliSessionBridge({
      initialState: initial(),
      addHistoryItem: () => observed.push(session.prepareHistory({})),
    });
    session.apply({
      type: 'display_history',
      change: { type: 'snapshot', items: [{ type: 'gemini', text: 'first' }] },
    });
    session.apply({
      type: 'display_history',
      change: { type: 'append', item: { type: 'info', text: 'next' } },
    });
    expect(observed).toEqual([false, true]);
  });

  it('preserves history availability when a history writer fails', () => {
    const session = createCliSessionBridge({
      initialState: initial(),
      addHistoryItem: () => {
        throw new Error('write failed');
      },
    });
    const item: HistoryItemWithoutId = { type: 'gemini', text: 'x' };
    expect(() =>
      session.apply({
        type: 'display_history',
        change: { type: 'snapshot', items: [item] },
      }),
    ).toThrow('write failed');
    expect(session.prepareHistory({})).toBe(false);
    expect(() =>
      session.apply({
        type: 'display_history',
        change: { type: 'append', item },
      }),
    ).toThrow('write failed');
    expect(session.prepareHistory({})).toBe(true);
  });

  it.each([
    {
      change: { type: 'error', text: 'failed' },
      body: '',
      currentThought: null,
      overlay: true,
      approvals: true,
    },
    {
      change: {
        type: 'interruption',
        message: 'stopped',
        permissionOnly: true,
      },
      body: 'body',
      currentThought: thought,
      overlay: true,
      approvals: false,
    },
    {
      change: {
        type: 'interruption',
        message: 'stopped',
        permissionOnly: false,
      },
      body: '',
      currentThought: null,
      overlay: false,
      approvals: true,
    },
  ] satisfies Array<{
    change: CliSessionDisplayChange;
    body: string;
    currentThought: typeof thought | null;
    overlay: boolean;
    approvals: boolean;
  }>)(
    'preserves the cleanup scope for $change',
    ({ change, body, currentThought, overlay, approvals }) => {
      const { session, history } = createSession({
        pendingAssistantText: 'body',
        pendingApprovalTools: [approval],
        workerStatus: 'running',
      });
      delta(session, 'thinking_delta', thinking);
      pending(session, [{ type: 'gemini', text: 'overlay' }]);
      session.apply(change);
      expect(session.getSnapshot().pendingAssistantText).toBe(body);
      expect(session.getSnapshot().thought).toEqual(currentThought);
      expect(session.getSnapshot().pendingHistoryItems).toEqual([
        ...(overlay ? [{ type: 'gemini', text: 'overlay' }] : []),
        ...(approvals ? [{ type: 'tool_group', tools: [approval] }] : []),
      ]);
      // Pending display marked formal history available, so interruption adds no notice.
      expect(history).toEqual(
        change.type === 'error' ? [{ type: 'error', text: 'failed' }] : [],
      );
    },
  );

  it('adds interruption notices only when formal display history is unavailable', () => {
    const { session, history } = createSession();
    session.apply({
      type: 'interruption',
      permissionOnly: false,
      message: 'stopped',
    });
    expect(history).toEqual([{ type: 'info', text: 'stopped' }]);
  });

  it('keeps request errors display-only without cleaning an active message', () => {
    const { session, history } = createSession({
      pendingAssistantText: 'body',
      pendingApprovalTools: [approval],
    });
    delta(session, 'thinking_delta', thinking);
    const before = session.getSnapshot();
    session.apply({ type: 'request_error', text: 'send failed' });
    expect(session.getSnapshot()).toBe(before);
    expect(history).toEqual([{ type: 'error', text: 'send failed' }]);
  });

  it('distinguishes an idle state snapshot from the idle display cleanup entry', () => {
    const { session } = createSession({
      pendingAssistantText: 'body',
      workerStatus: 'running',
    });
    delta(session, 'thinking_delta', thinking);
    pending(session, [{ type: 'gemini', text: 'overlay' }]);
    session.apply({ type: 'worker_status', status: 'idle' });
    expect(session.getSnapshot().pendingAssistantText).toBe('body');
    expect(session.getSnapshot().thought).toEqual(thought);
    session.apply({ type: 'worker_idle' });
    expect(session.getSnapshot()).toMatchObject({
      pendingAssistantText: '',
      thought: null,
      pendingHistoryItems: [],
    });
  });

  it('clears only body and approvals on disconnect and preserves pending thinking', () => {
    const { session, history } = createSession({
      pendingAssistantText: 'body',
      pendingApprovalTools: [approval],
    });
    delta(session, 'thinking_delta', thinking);
    pending(session, [{ type: 'gemini', text: 'overlay' }]);
    session.apply({ type: 'disconnected' });
    expect(session.getSnapshot()).toMatchObject({
      pendingAssistantText: '',
      thought,
      pendingHistoryItems: [{ type: 'gemini', text: 'overlay' }],
    });
    delta(session, 'text_delta', 'later');
    expect(history).toEqual([{ type: 'thinking', thought }]);
  });

  it.each([
    { type: 'user_received' },
    { type: 'submission_started' },
  ] satisfies CliSessionDisplayChange[])(
    'resets thinking deduplication at $type',
    (change) => {
      const { session, history } = createSession();
      delta(session, 'thinking_delta', thinking);
      delta(session, 'text_delta', 'body');
      session.apply(change);
      session.apply({
        type: 'assistant_message',
        thinkingTexts: [thinking],
        text: '',
      });
      expect(history.filter((item) => item.type === 'thinking')).toHaveLength(
        2,
      );
    },
  );

  it.each([
    { type: 'assistant_received', terminal: false },
    { type: 'worker_idle' },
    { type: 'error', text: 'failed' },
    { type: 'interruption', permissionOnly: false, message: 'stopped' },
  ] satisfies CliSessionDisplayChange[])(
    'retains deduplication but discards pending thinking at $type',
    (change) => {
      const { session, history } = createSession();
      delta(session, 'thinking_delta', thinking);
      delta(session, 'text_delta', 'body');
      delta(session, 'thinking_delta', '**Unfinished**\nPending');
      session.apply(change);
      delta(session, 'text_delta', 'next');
      session.apply({
        type: 'assistant_message',
        thinkingTexts: [thinking],
        text: '',
      });
      expect(history.filter((item) => item.type === 'thinking')).toEqual([
        { type: 'thinking', thought },
      ]);
    },
  );

  it('restores display and resets raw thinking without clearing the existing current thought', () => {
    const { session, history } = createSession();
    delta(session, 'thinking_delta', thinking);
    delta(session, 'text_delta', 'old body');
    delta(session, 'thinking_delta', '**Unfinished**\nPending');
    const currentThought = session.getSnapshot().thought;
    session.initialize(initial({ pendingAssistantText: 'new body' }));
    expect(session.getSnapshot().pendingAssistantText).toBe('new body');
    expect(session.getSnapshot().thought).toBe(currentThought);
    delta(session, 'text_delta', 'more');
    session.apply({
      type: 'assistant_message',
      thinkingTexts: [thinking],
      text: '',
    });
    expect(history.filter((item) => item.type === 'thinking')).toEqual([
      { type: 'thinking', thought },
      { type: 'thinking', thought },
    ]);
  });

  it('keeps submission completion silent and computes from the supplied render inputs', () => {
    const { session } = createSession();
    session.apply({ type: 'submission_started' });
    const running = session.getSnapshot();
    session.apply({ type: 'worker_status', status: 'idle' });
    const idle = session.getSnapshot();
    expect(session.getStreamingState(idle)).toBe(StreamingState.Responding);
    const listener = vi.fn();
    session.subscribe(listener);
    session.apply({ type: 'submission_finished' });
    expect(session.getSnapshot()).toBe(idle);
    expect(listener).not.toHaveBeenCalled();
    expect(session.getIsResponding()).toBe(false);
    expect(session.getStreamingState(idle)).toBe(StreamingState.Idle);
    // A caller still rendering the prior inputs must not read the live worker status.
    expect(session.getStreamingState(running)).toBe(StreamingState.Responding);
  });

  it('keeps state, thinking deduplication and subscribers isolated between sessions', () => {
    const first = createSession();
    const second = createSession({ pendingAssistantText: 'second' });
    const listener = vi.fn();
    second.session.subscribe(listener);
    delta(first.session, 'thinking_delta', thinking);
    delta(first.session, 'text_delta', 'first');
    first.session.dispose();
    expect(second.session.getSnapshot().pendingAssistantText).toBe('second');
    expect(listener).not.toHaveBeenCalled();
    second.session.apply({
      type: 'assistant_message',
      thinkingTexts: [thinking],
      text: '',
    });
    expect(second.history).toEqual([{ type: 'thinking', thought }]);
  });

  it('removes only the requested subscription and supports subscription after disposal', () => {
    const { session } = createSession();
    const removed = vi.fn();
    const retained = vi.fn();
    const unsubscribe = session.subscribe(removed);
    session.subscribe(retained);
    unsubscribe();
    delta(session, 'text_delta', 'one');
    expect(removed).not.toHaveBeenCalled();
    expect(retained).toHaveBeenCalledOnce();
    session.dispose();
    delta(session, 'text_delta', 'two');
    expect(retained).toHaveBeenCalledOnce();
    session.subscribe(removed);
    delta(session, 'text_delta', 'three');
    expect(removed).toHaveBeenCalledOnce();
  });
});
