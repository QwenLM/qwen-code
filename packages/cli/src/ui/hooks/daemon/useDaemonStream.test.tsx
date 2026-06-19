/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { ToolConfirmationOutcome } from '@qwen-code/qwen-code-core';
import { StreamingState, type HistoryItemWithoutId } from '../../types.js';
import {
  useDaemonStream,
  type DaemonSessionDriver,
  type DaemonPermissionResponse,
} from './useDaemonStream.js';
import type { DaemonFrame } from './projectDaemonEvent.js';

/**
 * A controllable fake daemon driver: tests `push()` frames into the live
 * `events()` subscription and assert the hook's projected state, plus record
 * prompt/cancel/permission calls.
 */
function makeFakeDriver(
  opts: { clientId?: string; throwOnce?: string; manualPrompt?: boolean } = {},
) {
  const queue: DaemonFrame[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  let eventsCalls = 0;
  let resolvePrompt: ((v: unknown) => void) | null = null;
  const prompts: Array<{ prompt: Array<{ type: 'text'; text: string }> }> = [];
  const permissions: Array<{
    requestId: string;
    response: DaemonPermissionResponse;
  }> = [];
  let cancels = 0;
  let lastSignal: AbortSignal | undefined;

  const driver: DaemonSessionDriver & {
    push: (f: DaemonFrame) => void;
    end: () => void;
    finishPrompt: (result?: unknown) => void;
    stats: () => {
      eventsCalls: number;
      prompts: typeof prompts;
      permissions: typeof permissions;
      cancels: number;
      aborted: boolean;
    };
  } = {
    clientId: opts.clientId,
    async *events({ signal } = {}) {
      eventsCalls += 1;
      lastSignal = signal;
      if (opts.throwOnce && eventsCalls === 1) {
        throw new Error(opts.throwOnce);
      }
      for (;;) {
        if (signal?.aborted) return;
        if (queue.length) {
          const next = queue.shift()!;
          yield next;
          continue;
        }
        if (ended) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
          signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      }
    },
    async prompt(req) {
      prompts.push(req);
      if (opts.manualPrompt) {
        return new Promise((resolve) => {
          resolvePrompt = resolve;
        });
      }
      return { stopReason: 'end_turn' };
    },
    async cancel() {
      cancels += 1;
    },
    async respondToSessionPermission(requestId, response) {
      permissions.push({ requestId, response });
      return true;
    },
    push(f) {
      queue.push(f);
      wake?.();
      wake = null;
    },
    end() {
      ended = true;
      wake?.();
      wake = null;
    },
    finishPrompt(result: unknown = { stopReason: 'end_turn' }) {
      resolvePrompt?.(result);
      resolvePrompt = null;
    },
    stats() {
      return {
        eventsCalls,
        prompts,
        permissions,
        cancels,
        aborted: lastSignal?.aborted ?? false,
      };
    },
  };
  return driver;
}

const su = (
  update: Record<string, unknown>,
  originatorClientId?: string,
): DaemonFrame => ({
  type: 'session_update',
  data: { sessionId: 's1', update },
  originatorClientId,
});

describe('useDaemonStream', () => {
  it('streams a text turn into history and tracks streaming state', async () => {
    const driver = makeFakeDriver({ clientId: 'me' });
    const added: HistoryItemWithoutId[] = [];
    const addItem = vi.fn((item: HistoryItemWithoutId) => {
      added.push(item);
      return added.length;
    });
    const { result } = renderHook(() => useDaemonStream(driver, addItem));

    act(() => {
      driver.push(
        su(
          {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'PO' },
          },
          'me',
        ),
      );
      driver.push(
        su(
          {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'NG' },
          },
          'me',
        ),
      );
    });

    await waitFor(() =>
      expect(result.current.streamingState).toBe(StreamingState.Responding),
    );
    await waitFor(() =>
      expect(result.current.pendingHistoryItems).toEqual([
        { type: 'gemini', text: 'PONG' },
      ]),
    );

    act(() => driver.push({ type: 'turn_complete', data: {} }));

    await waitFor(() =>
      expect(result.current.streamingState).toBe(StreamingState.Idle),
    );
    expect(added).toContainEqual({ type: 'gemini', text: 'PONG' });
    expect(result.current.pendingHistoryItems).toEqual([]);
  });

  it('finalizes the turn when prompt() resolves — no turn_complete frame (0.17.x)', async () => {
    // The fork's daemon signals completion via the prompt() HTTP response, not a
    // turn_complete SSE frame. The hook must finalize (commit + Idle) on resolve.
    const driver = makeFakeDriver({ clientId: 'me', manualPrompt: true });
    const committed: HistoryItemWithoutId[] = [];
    const addItem = vi.fn((item: HistoryItemWithoutId) => {
      committed.push(item);
      return committed.length;
    });
    const { result } = renderHook(() => useDaemonStream(driver, addItem));

    let p: Promise<void> = Promise.resolve();
    act(() => {
      p = result.current.submitQuery('hey');
    });
    // Stream the reply WITHOUT any turn_complete frame.
    act(() => {
      driver.push(
        su(
          {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Going' },
          },
          'me',
        ),
      );
      driver.push(
        su(
          {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: ' well' },
          },
          'me',
        ),
      );
    });
    await waitFor(() =>
      expect(result.current.pendingHistoryItems).toEqual([
        { type: 'gemini', text: 'Going well' },
      ]),
    );
    expect(result.current.streamingState).toBe(StreamingState.Responding);

    // The daemon's prompt() HTTP call resolves with the turn's stopReason.
    await act(async () => {
      driver.finishPrompt({ stopReason: 'end_turn' });
      await p;
    });

    expect(committed).toContainEqual({ type: 'user', text: 'hey' });
    expect(committed).toContainEqual({ type: 'gemini', text: 'Going well' });
    expect(result.current.streamingState).toBe(StreamingState.Idle);
    expect(result.current.pendingHistoryItems).toEqual([]);
  });

  it('submitQuery echoes locally and forwards to the daemon', async () => {
    const driver = makeFakeDriver({ clientId: 'me' });
    const added: HistoryItemWithoutId[] = [];
    const addItem = vi.fn((item: HistoryItemWithoutId) => {
      added.push(item);
      return added.length;
    });
    const { result } = renderHook(() => useDaemonStream(driver, addItem));

    await act(async () => {
      await result.current.submitQuery('hello');
    });

    expect(added).toEqual([{ type: 'user', text: 'hello' }]);
    expect(driver.stats().prompts).toEqual([
      { prompt: [{ type: 'text', text: 'hello' }] },
    ]);
  });

  it('does NOT double-render our own turn: local echo + dropped daemon self-echo', async () => {
    const driver = makeFakeDriver({ clientId: 'me' });
    const userItems: HistoryItemWithoutId[] = [];
    const addItem = vi.fn((item: HistoryItemWithoutId) => {
      if (item.type === 'user') userItems.push(item);
      return userItems.length;
    });
    const { result } = renderHook(() => useDaemonStream(driver, addItem));

    await act(async () => {
      await result.current.submitQuery('hello');
    });
    // The daemon echoes our own input back, tagged with OUR clientId.
    act(() =>
      driver.push(
        su(
          {
            sessionUpdate: 'user_message_chunk',
            content: { type: 'text', text: 'hello' },
          },
          'me',
        ),
      ),
    );
    act(() => driver.push({ type: 'turn_complete', data: {} }));
    await waitFor(() =>
      expect(result.current.streamingState).toBe(StreamingState.Idle),
    );

    // Exactly ONE user line — the local echo; the self-echo was dropped.
    expect(userItems).toEqual([{ type: 'user', text: 'hello' }]);
  });

  it('renders a turn from another client (the phone) — different originator', async () => {
    const driver = makeFakeDriver({ clientId: 'me' });
    const userItems: HistoryItemWithoutId[] = [];
    const addItem = vi.fn((item: HistoryItemWithoutId) => {
      if (item.type === 'user') userItems.push(item);
      return userItems.length;
    });
    renderHook(() => useDaemonStream(driver, addItem));

    act(() =>
      driver.push(
        su(
          {
            sessionUpdate: 'user_message_chunk',
            content: { type: 'text', text: 'from phone' },
          },
          'phone',
        ),
      ),
    );

    await waitFor(() =>
      expect(userItems).toEqual([{ type: 'user', text: 'from phone' }]),
    );
  });

  it('cancelOngoingRequest cancels the daemon turn', async () => {
    const driver = makeFakeDriver({ clientId: 'me' });
    const { result } = renderHook(() => useDaemonStream(driver, vi.fn()));
    act(() => result.current.cancelOngoingRequest());
    await waitFor(() => expect(driver.stats().cancels).toBe(1));
  });

  it('exposes the permission gate and posts a vote (select / cancel)', async () => {
    const driver = makeFakeDriver({ clientId: 'me' });
    const { result } = renderHook(() => useDaemonStream(driver, vi.fn()));

    act(() => {
      driver.push(
        su(
          {
            sessionUpdate: 'tool_call',
            toolCallId: 'call_1',
            _meta: { toolName: 'write_file' },
            title: 'Write file',
            status: 'in_progress',
          },
          'me',
        ),
      );
      driver.push({
        type: 'permission_request',
        data: {
          requestId: 'req_1',
          toolCall: { toolCallId: 'call_1' },
          options: [{ optionId: 'proceed_once' }, { optionId: 'cancel' }],
        },
      });
    });

    await waitFor(() =>
      expect(result.current.activePermission?.requestId).toBe('req_1'),
    );
    expect(result.current.streamingState).toBe(
      StreamingState.WaitingForConfirmation,
    );

    await act(async () => {
      await result.current.respondToPermission('proceed_once');
    });
    expect(driver.stats().permissions).toEqual([
      {
        requestId: 'req_1',
        response: {
          outcome: { outcome: 'selected', optionId: 'proceed_once' },
        },
      },
    ]);

    await act(async () => {
      await result.current.respondToPermission(null);
    });
    expect(driver.stats().permissions[1]).toEqual({
      requestId: 'req_1',
      response: { outcome: { outcome: 'cancelled' } },
    });
  });

  it('attaches an answerable confirmation to the gated tool (outcome → optionId)', async () => {
    // An edit gate arrives as a permission_request with no prior tool_call; the
    // reducer seeds the tool and the hook attaches a confirmation whose
    // onConfirm maps the chosen outcome to the daemon optionId by `kind`.
    const driver = makeFakeDriver({ clientId: 'me' });
    const { result } = renderHook(() => useDaemonStream(driver, vi.fn()));

    act(() => {
      driver.push({
        type: 'permission_request',
        data: {
          requestId: 'req_1',
          toolCall: {
            toolCallId: 'call_1',
            title: 'Writing to /tmp/x.txt',
            status: 'pending',
          },
          options: [
            { kind: 'allow_always', optionId: 'proceed_always' },
            { kind: 'allow_once', optionId: 'proceed_once' },
            { kind: 'reject_once', optionId: 'cancel' },
          ],
        },
      });
    });

    await waitFor(() =>
      expect(result.current.streamingState).toBe(
        StreamingState.WaitingForConfirmation,
      ),
    );

    const group = result.current.pendingHistoryItems.find(
      (i) => i.type === 'tool_group',
    );
    if (!group || group.type !== 'tool_group') {
      throw new Error('expected a tool_group in pendingHistoryItems');
    }
    const tool = group.tools.find((t) => t.callId === 'call_1');
    const details = tool?.confirmationDetails;
    expect(details?.type).toBe('info');

    // "Allow always" → the daemon's allow_always optionId.
    await act(async () => {
      await details!.onConfirm(ToolConfirmationOutcome.ProceedAlways);
    });
    expect(driver.stats().permissions).toEqual([
      {
        requestId: 'req_1',
        response: {
          outcome: { outcome: 'selected', optionId: 'proceed_always' },
        },
      },
    ]);

    // Esc/No → the reject_once optionId.
    await act(async () => {
      await details!.onConfirm(ToolConfirmationOutcome.Cancel);
    });
    expect(driver.stats().permissions[1]).toEqual({
      requestId: 'req_1',
      response: { outcome: { outcome: 'selected', optionId: 'cancel' } },
    });
  });

  it('retries when the daemon reports an existing subscription (StrictMode race)', async () => {
    const driver = makeFakeDriver({
      clientId: 'me',
      throwOnce:
        'Another event subscription is already active on this session.',
    });
    const added: HistoryItemWithoutId[] = [];
    const addItem = vi.fn((item: HistoryItemWithoutId) => {
      added.push(item);
      return added.length;
    });
    const { result } = renderHook(() => useDaemonStream(driver, addItem));

    // First events() call threw; the hook must retry and then stream normally.
    await waitFor(() => expect(driver.stats().eventsCalls).toBeGreaterThan(1));
    act(() =>
      driver.push(
        su(
          {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'ok' },
          },
          'me',
        ),
      ),
    );
    await waitFor(() =>
      expect(result.current.pendingHistoryItems).toEqual([
        { type: 'gemini', text: 'ok' },
      ]),
    );
    expect(result.current.initError).toBeNull();
  });

  it('aborts the subscription on unmount', async () => {
    const driver = makeFakeDriver({ clientId: 'me' });
    const { unmount } = renderHook(() => useDaemonStream(driver, vi.fn()));
    // Let the subscription establish.
    await waitFor(() => expect(driver.stats().eventsCalls).toBe(1));
    unmount();
    await waitFor(() => expect(driver.stats().aborted).toBe(true));
  });
});
