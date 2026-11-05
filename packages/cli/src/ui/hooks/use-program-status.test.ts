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
    const { result, rerender } = setup();
    rerender({ state: StreamingState.Responding, history: [user] });
    rerender({ state: StreamingState.Idle, history: [user, error] });
    rerender({
      state: StreamingState.Responding,
      history: [user, error, user],
    });
    rerender({
      state: StreamingState.Idle,
      history: [user, error, user, reply],
    });
    expect(result.current).toBe('done');
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
