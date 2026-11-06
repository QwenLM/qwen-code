/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
// @vitest-environment jsdom

import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  MessageType,
  StreamingState,
  type HistoryItem,
  type HistoryItemWithoutId,
} from '../types.js';
import type { TrackedToolCall } from './useReactToolScheduler.js';
import {
  deriveProgramStatus,
  useProgramStatus,
  useTurnOutcome,
  type ProgramStatusInputs,
} from './use-program-status.js';

vi.mock('../../utils/program-status.js', () => ({
  reportProgramStatus: vi.fn(),
  resendProgramStatus: vi.fn(),
  finalizeProgramStatus: vi.fn(),
}));

const { reportProgramStatus, resendProgramStatus, finalizeProgramStatus } =
  await import('../../utils/program-status.js');

const base: ProgramStatusInputs = {
  streamingState: StreamingState.Idle,
  pendingToolCalls: [],
  turnOutcome: 'idle',
  authPending: false,
  shellConfirmationPending: false,
  loopDetectionPending: false,
  startupApprovalPending: false,
};

function awaiting(type: string, name = 'run_shell_command'): TrackedToolCall {
  return {
    status: 'awaiting_approval',
    request: { callId: 'c1', name, args: { command: 'rm -rf build' } },
    tool: { displayName: 'Shell' },
    confirmationDetails: { type },
  } as unknown as TrackedToolCall;
}

function subagentAwaiting(type: string): TrackedToolCall {
  return {
    status: 'executing',
    request: { callId: 'c2', name: 'agent', args: {} },
    liveOutput: {
      type: 'task_execution',
      subagentName: 'reviewer',
      status: 'running',
      pendingConfirmation: { type },
      toolCalls: [
        { callId: 'x', name: 'write_file', status: 'awaiting_approval' },
      ],
    },
  } as unknown as TrackedToolCall;
}

describe('deriveProgramStatus', () => {
  it('reports idle before any turn', () => {
    expect(deriveProgramStatus(base)).toEqual({ state: 'idle' });
  });

  it('reports working while responding', () => {
    expect(
      deriveProgramStatus({
        ...base,
        streamingState: StreamingState.Responding,
      }),
    ).toEqual({ state: 'working' });
  });

  it('names only the tool for a permission prompt, never its arguments', () => {
    const status = deriveProgramStatus({
      ...base,
      streamingState: StreamingState.WaitingForConfirmation,
      pendingToolCalls: [awaiting('exec')],
    });
    expect(status).toEqual({
      state: 'blocked',
      kind: 'permission',
      msg: 'Permission needed: Shell',
    });
    expect(status.msg).not.toContain('rm -rf');
  });

  it('maps ask_user_question to kind=question', () => {
    expect(
      deriveProgramStatus({
        ...base,
        streamingState: StreamingState.WaitingForConfirmation,
        pendingToolCalls: [awaiting('ask_user_question', 'ask_user_question')],
      }),
    ).toMatchObject({ state: 'blocked', kind: 'question' });
  });

  it('reports a subagent waiting for approval', () => {
    expect(
      deriveProgramStatus({
        ...base,
        streamingState: StreamingState.WaitingForConfirmation,
        pendingToolCalls: [subagentAwaiting('edit')],
      }),
    ).toEqual({
      state: 'blocked',
      kind: 'permission',
      msg: 'Permission needed: write_file',
    });
    expect(
      deriveProgramStatus({
        ...base,
        pendingToolCalls: [subagentAwaiting('ask_user_question')],
      }),
    ).toMatchObject({ state: 'blocked', kind: 'question' });
  });

  it('keeps a running subagent without a pending confirmation working', () => {
    const running = {
      status: 'executing',
      request: { callId: 'c3', name: 'agent', args: {} },
      liveOutput: {
        type: 'task_execution',
        subagentName: 'reviewer',
        status: 'running',
        toolCalls: [],
      },
    } as unknown as TrackedToolCall;
    expect(
      deriveProgramStatus({
        ...base,
        streamingState: StreamingState.Responding,
        pendingToolCalls: [running],
      }),
    ).toEqual({ state: 'working' });
  });

  it('falls back to a generic permission when waiting without details', () => {
    expect(
      deriveProgramStatus({
        ...base,
        streamingState: StreamingState.WaitingForConfirmation,
      }),
    ).toEqual({
      state: 'blocked',
      kind: 'permission',
      msg: 'Permission needed',
    });
  });

  it('maps auth, shell confirmation, loop detection and startup approvals', () => {
    expect(deriveProgramStatus({ ...base, authPending: true })).toMatchObject({
      state: 'blocked',
      kind: 'auth',
    });
    expect(
      deriveProgramStatus({ ...base, shellConfirmationPending: true }),
    ).toMatchObject({ state: 'blocked', kind: 'permission' });
    expect(
      deriveProgramStatus({ ...base, loopDetectionPending: true }),
    ).toMatchObject({ state: 'blocked', kind: 'question' });
    expect(
      deriveProgramStatus({ ...base, startupApprovalPending: true }),
    ).toMatchObject({ state: 'blocked', kind: 'permission' });
  });

  it('puts auth ahead of a pending tool approval', () => {
    expect(
      deriveProgramStatus({
        ...base,
        authPending: true,
        streamingState: StreamingState.WaitingForConfirmation,
        pendingToolCalls: [awaiting('exec')],
      }),
    ).toMatchObject({ kind: 'auth' });
  });

  it('reports the latched outcome when idle', () => {
    expect(deriveProgramStatus({ ...base, turnOutcome: 'done' })).toEqual({
      state: 'done',
    });
    expect(deriveProgramStatus({ ...base, turnOutcome: 'error' })).toEqual({
      state: 'error',
      msg: 'Request failed',
    });
  });
});

describe('useTurnOutcome', () => {
  const user = { id: 1, type: MessageType.USER, text: 'hi' } as HistoryItem;
  const reply = { id: 2, type: 'gemini', text: 'hello' } as HistoryItem;
  const error = {
    id: 3,
    type: MessageType.ERROR,
    text: 'API error',
  } as HistoryItem;

  function setup() {
    const cancelled = { current: false };
    const hook = renderHook(
      ({ state, history, pending = [] }) =>
        useTurnOutcome(state, history, pending, cancelled),
      {
        initialProps: {
          state: StreamingState.Idle as StreamingState,
          history: [] as HistoryItem[],
        } as {
          state: StreamingState;
          history: HistoryItem[];
          pending?: HistoryItemWithoutId[];
        },
      },
    );
    return { ...hook, cancelled };
  }

  it('is idle before the first turn', () => {
    expect(setup().result.current).toBe('idle');
  });

  it('latches done after a turn completes', () => {
    const { result, rerender } = setup();
    rerender({ state: StreamingState.Responding, history: [user] });
    expect(result.current).toBe('idle');
    rerender({ state: StreamingState.Idle, history: [user, reply] });
    expect(result.current).toBe('done');
  });

  it('latches error when the turn added an error message', () => {
    const { result, rerender } = setup();
    rerender({ state: StreamingState.Responding, history: [user] });
    rerender({ state: StreamingState.Idle, history: [user, error] });
    expect(result.current).toBe('error');
  });

  it('latches error for an API error left pending with a retry hint', () => {
    const { result, rerender } = setup();
    rerender({ state: StreamingState.Responding, history: [user] });
    rerender({
      state: StreamingState.Idle,
      history: [user],
      pending: [
        { type: MessageType.ERROR, text: '[API Error: 400]', hint: 'Ctrl+Y' },
      ] as HistoryItemWithoutId[],
    });
    expect(result.current).toBe('error');
  });

  it('ignores errors from earlier turns', () => {
    const user2 = { ...user, id: 4 } as HistoryItem;
    const reply2 = { ...reply, id: 5 } as HistoryItem;
    const { result, rerender } = setup();
    rerender({ state: StreamingState.Responding, history: [user] });
    rerender({ state: StreamingState.Idle, history: [user, error] });
    rerender({
      state: StreamingState.Responding,
      history: [user, error, user2],
    });
    rerender({
      state: StreamingState.Idle,
      history: [user, error, user2, reply2],
    });
    expect(result.current).toBe('done');
  });

  it('latches error for a blocked prompt or a stop hook loop', () => {
    for (const type of ['user_prompt_submit_blocked', 'stop_hook_loop']) {
      const { result, rerender } = setup();
      const failure = { id: 4, type } as HistoryItem;
      rerender({ state: StreamingState.Responding, history: [user] });
      rerender({ state: StreamingState.Idle, history: [user, failure] });
      expect(result.current).toBe('error');
    }
  });

  it('ignores pending items that are not errors', () => {
    const { result, rerender } = setup();
    rerender({ state: StreamingState.Responding, history: [user] });
    rerender({
      state: StreamingState.Idle,
      history: [user, reply],
      pending: [
        { type: 'retry_countdown', text: 'Retrying in 3s' },
      ] as HistoryItemWithoutId[],
    });
    expect(result.current).toBe('done');
  });

  it('keeps done when an error is added while idle', () => {
    const { result, rerender } = setup();
    rerender({ state: StreamingState.Responding, history: [user] });
    rerender({ state: StreamingState.Idle, history: [user, reply] });
    // e.g. a failed slash command after the turn ended
    rerender({ state: StreamingState.Idle, history: [user, reply, error] });
    expect(result.current).toBe('done');
  });

  it('keeps done when compaction shrinks history', () => {
    const old = (id: number) => ({ id, type: 'gemini_thought' }) as HistoryItem;
    const prompt = {
      id: 10,
      type: MessageType.USER,
      text: 'go',
    } as HistoryItem;
    const answer = { id: 11, type: 'gemini', text: 'ok' } as HistoryItem;
    const { result, rerender } = setup();
    rerender({ state: StreamingState.Idle, history: [old(1), old(2), prompt] });
    rerender({
      state: StreamingState.Responding,
      history: [old(1), old(2), prompt],
    });
    rerender({
      state: StreamingState.Idle,
      history: [old(1), old(2), prompt, answer],
    });
    expect(result.current).toBe('done');
    // Compaction drops the old thoughts after the turn ended.
    rerender({ state: StreamingState.Idle, history: [prompt, answer] });
    expect(result.current).toBe('done');
  });

  it('keeps an error from a turn that compaction shrank mid-turn', () => {
    const old = (id: number) => ({ id, type: 'gemini_thought' }) as HistoryItem;
    const prompt = {
      id: 10,
      type: MessageType.USER,
      text: 'go',
    } as HistoryItem;
    const turnError = {
      id: 11,
      type: MessageType.ERROR,
      text: 'API error',
    } as HistoryItem;
    const { result, rerender } = setup();
    rerender({ state: StreamingState.Idle, history: [old(1), old(2), prompt] });
    rerender({
      state: StreamingState.Responding,
      history: [old(1), old(2), prompt],
    });
    rerender({
      state: StreamingState.Responding,
      history: [old(1), old(2), prompt, turnError],
    });
    // Compaction drops the old thoughts before the turn ends.
    rerender({ state: StreamingState.Idle, history: [prompt, turnError] });
    expect(result.current).toBe('error');
  });

  it('returns to idle when the user cancelled the turn', () => {
    const { result, rerender, cancelled } = setup();
    rerender({ state: StreamingState.Responding, history: [user] });
    cancelled.current = true;
    rerender({ state: StreamingState.Idle, history: [user] });
    expect(result.current).toBe('idle');
  });

  it('returns to idle when history is cleared', () => {
    const { result, rerender } = setup();
    rerender({ state: StreamingState.Responding, history: [user] });
    rerender({ state: StreamingState.Idle, history: [user, reply] });
    rerender({ state: StreamingState.Idle, history: [] });
    expect(result.current).toBe('idle');
  });

  it('stays idle when an item is added while idle after a clear', () => {
    const { result, rerender } = setup();
    rerender({ state: StreamingState.Responding, history: [user] });
    rerender({ state: StreamingState.Idle, history: [user, reply] });
    rerender({ state: StreamingState.Idle, history: [] });
    rerender({ state: StreamingState.Idle, history: [reply] });
    expect(result.current).toBe('idle');
  });
});

describe('useProgramStatus', () => {
  beforeEach(() => {
    vi.mocked(reportProgramStatus).mockClear();
    vi.mocked(resendProgramStatus).mockClear();
    vi.mocked(finalizeProgramStatus).mockClear();
  });

  const props = {
    ...base,
    history: [] as HistoryItem[],
    pendingHistoryItems: [] as HistoryItemWithoutId[],
    turnCancelledRef: { current: false },
  };

  it('reports only when the record changes', () => {
    const { rerender } = renderHook((p) => useProgramStatus(p), {
      initialProps: props,
    });
    rerender({ ...props });
    rerender({ ...props, streamingState: StreamingState.Responding });
    expect(vi.mocked(reportProgramStatus).mock.calls.map((c) => c[0])).toEqual([
      { state: 'idle', kind: undefined, msg: undefined },
      { state: 'working', kind: undefined, msg: undefined },
    ]);
  });

  const reports = () =>
    vi.mocked(reportProgramStatus).mock.calls.map((c) => c[0]);

  it('reports again when only the message changes', () => {
    const { rerender } = renderHook((p) => useProgramStatus(p), {
      initialProps: {
        ...props,
        streamingState: StreamingState.WaitingForConfirmation,
        pendingToolCalls: [awaiting('exec')],
      },
    });
    rerender({
      ...props,
      streamingState: StreamingState.WaitingForConfirmation,
      pendingToolCalls: [subagentAwaiting('edit')],
    });
    expect(reports().map((r) => r.msg)).toEqual([
      'Permission needed: Shell',
      'Permission needed: write_file',
    ]);
  });

  describe('turn outcome', () => {
    const user = { id: 1, type: MessageType.USER, text: 'hi' } as HistoryItem;
    const reply = { id: 2, type: 'gemini', text: 'hello' } as HistoryItem;

    function runTurn(end: Partial<typeof props> & { history: HistoryItem[] }) {
      const turnCancelledRef = { current: false };
      const { rerender } = renderHook((p) => useProgramStatus(p), {
        initialProps: { ...props, turnCancelledRef },
      });
      rerender({
        ...props,
        turnCancelledRef,
        streamingState: StreamingState.Responding,
        history: [user],
      });
      rerender({
        ...props,
        turnCancelledRef,
        streamingState: StreamingState.Idle,
        ...end,
      });
      return reports();
    }

    it('reports done straight after working', () => {
      expect(runTurn({ history: [user, reply] }).map((r) => r.state)).toEqual([
        'idle',
        'working',
        'done',
      ]);
    });

    it('reports error for an API error left pending', () => {
      expect(
        runTurn({
          history: [user],
          pendingHistoryItems: [
            { type: MessageType.ERROR, text: '[API Error: 400]' },
          ] as HistoryItemWithoutId[],
        }).at(-1),
      ).toEqual({ state: 'error', kind: undefined, msg: 'Request failed' });
    });

    it('reports idle for a cancelled turn', () => {
      const cancelled = { current: false };
      const { rerender } = renderHook((p) => useProgramStatus(p), {
        initialProps: { ...props, turnCancelledRef: cancelled },
      });
      rerender({
        ...props,
        turnCancelledRef: cancelled,
        streamingState: StreamingState.Responding,
        history: [user],
      });
      cancelled.current = true;
      rerender({
        ...props,
        turnCancelledRef: cancelled,
        streamingState: StreamingState.Idle,
        history: [user, reply],
      });
      expect(reports().at(-1)?.state).toBe('idle');
    });
  });

  it('resends on SIGCONT and finalizes on exit and unmount', () => {
    const { unmount } = renderHook(() => useProgramStatus(props));
    process.emit('SIGCONT');
    expect(resendProgramStatus).toHaveBeenCalledTimes(1);
    process.emit('exit', 0);
    expect(finalizeProgramStatus).toHaveBeenCalledTimes(1);
    unmount();
    expect(finalizeProgramStatus).toHaveBeenCalledTimes(2);
    process.emit('SIGCONT');
    expect(resendProgramStatus).toHaveBeenCalledTimes(1);
  });
});
