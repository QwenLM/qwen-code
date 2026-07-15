/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  DaemonTodoStopGuard,
  TODO_STOP_GUARD_MAX_ATTEMPTS,
} from './daemon-todo-stop-guard.js';

const pendingResult = {
  type: 'todo_list',
  todos: [{ id: '1', content: 'finish', status: 'pending' }],
};

describe('DaemonTodoStopGuard', () => {
  it('arms only from a strict successful Todo result', () => {
    const guard = new DaemonTodoStopGuard(true);

    expect(guard.observeTodoWrite({ todos: pendingResult.todos }, true)).toBe(
      false,
    );
    expect(guard.observeTodoWrite(JSON.stringify(pendingResult), true)).toBe(
      false,
    );
    expect(
      guard.observeTodoWrite(
        { type: 'todo_list', todos: [{ status: 'pending' }] },
        true,
      ),
    ).toBe(false);
    expect(guard.decide(false)).toEqual({ kind: 'inactive' });

    expect(guard.observeTodoWrite(pendingResult, true)).toBe(true);
    expect(guard.decide(false)).toMatchObject({
      kind: 'continue',
      attempt: 1,
      unfinishedCount: 1,
    });
  });

  it('disarms when the latest Todo list is completed or empty', () => {
    const guard = new DaemonTodoStopGuard(true);
    guard.observeTodoWrite(pendingResult, true);

    guard.observeTodoWrite(
      {
        type: 'todo_list',
        todos: [{ id: '1', content: 'finish', status: 'completed' }],
      },
      true,
    );
    expect(guard.decide(false)).toEqual({ kind: 'inactive' });

    guard.observeTodoWrite(pendingResult, true);
    guard.observeTodoWrite({ type: 'todo_list', todos: [] }, true);
    expect(guard.decide(false)).toEqual({ kind: 'inactive' });
  });

  it('commits exactly two attempts only when explicitly told', () => {
    const guard = new DaemonTodoStopGuard(true);
    guard.observeTodoWrite(pendingResult, true);

    expect(guard.decide(false)).toMatchObject({ attempt: 1 });
    expect(guard.decide(false)).toMatchObject({ attempt: 1 });
    guard.commitContinuation(1);
    expect(guard.decide(false)).toMatchObject({ attempt: 2 });
    guard.commitContinuation(2);
    expect(guard.decide(false)).toEqual({
      kind: 'exhausted',
      attempt: 2,
      maxAttempts: TODO_STOP_GUARD_MAX_ATTEMPTS,
      unfinishedCount: 1,
    });
  });

  it('uses the remaining attempt to close tools after Todo completion', () => {
    const guard = new DaemonTodoStopGuard(true);
    guard.observeTodoWrite(pendingResult, true);
    expect(guard.commitContinuation(1)).toBe(true);
    expect(guard.hasCommittedContinuation).toBe(true);
    guard.observeTodoWrite({ type: 'todo_list', todos: [] }, true);

    expect(guard.awaitQueuedPrompt()).toBe(true);
    expect(guard.decideToolClosure(1, false)).toEqual({ kind: 'inactive' });
    guard.resumeTrustedPrompt();
    expect(guard.decideToolClosure(1, true)).toEqual({ kind: 'deferred' });
    expect(guard.decideToolClosure(1, false)).toEqual({
      kind: 'continue',
      attempt: 2,
      maxAttempts: TODO_STOP_GUARD_MAX_ATTEMPTS,
      unfinishedCount: 0,
      toolClosure: true,
    });
    expect(guard.commitContinuation(2)).toBe(true);
    expect(guard.decideToolClosure(2, false)).toEqual({ kind: 'inactive' });
  });

  it('does not close completed Todo tools after a hard stop', () => {
    const guard = new DaemonTodoStopGuard(true);
    guard.observeTodoWrite(pendingResult, true);
    expect(guard.commitContinuation(1)).toBe(true);
    guard.observeTodoWrite({ type: 'todo_list', todos: [] }, true);

    guard.suspend();

    expect(guard.decideToolClosure(1, false)).toEqual({ kind: 'inactive' });
    expect(guard.awaitQueuedPrompt()).toBe(false);
    expect(guard.commitContinuation(2)).toBe(false);
  });

  it('resets trust for an ordinary prompt but preserves it for retry', () => {
    const guard = new DaemonTodoStopGuard(true);
    guard.observeTodoWrite(pendingResult, true);
    guard.commitContinuation(1);

    guard.resumeTrustedPrompt();
    expect(guard.decide(false)).toMatchObject({ attempt: 2 });

    guard.startOrdinaryPrompt();
    expect(guard.decide(false)).toEqual({ kind: 'inactive' });
  });

  it('pauses API failures until a trusted retry resumes the chain', () => {
    const guard = new DaemonTodoStopGuard(true);
    guard.observeTodoWrite(pendingResult, true);
    guard.commitContinuation(1);
    guard.pauseForTrustedRetry();
    expect(guard.decide(false)).toEqual({ kind: 'inactive' });

    guard.resumeTrustedPrompt();
    expect(guard.decide(false)).toMatchObject({ kind: 'continue', attempt: 2 });
  });

  it('rejects late writes from a superseded prompt', () => {
    const guard = new DaemonTodoStopGuard(true);
    guard.blockUntilOrdinaryPromptStarts();
    guard.observeTodoWrite(pendingResult, true);
    expect(guard.decide(false)).toEqual({ kind: 'inactive' });
    expect(guard.hasTrustedUnfinishedState).toBe(false);

    guard.startOrdinaryPrompt();
    expect(guard.decide(false)).toEqual({ kind: 'inactive' });
  });

  it('lets mid-turn user input retain activation and reset the budget', () => {
    const guard = new DaemonTodoStopGuard(true);
    guard.observeTodoWrite(pendingResult, true);
    guard.commitContinuation(1);
    guard.acceptMidTurnUserInput();

    expect(guard.decide(false)).toMatchObject({ attempt: 1 });
  });

  it('gives a mid-turn reactivation a fresh budget after completion', () => {
    const guard = new DaemonTodoStopGuard(true);
    guard.observeTodoWrite(pendingResult, true);
    guard.commitContinuation(1);
    guard.observeTodoWrite({ type: 'todo_list', todos: [] }, true);

    guard.acceptMidTurnUserInput();
    guard.observeTodoWrite(pendingResult, true);

    expect(guard.decide(false)).toMatchObject({ attempt: 1 });
  });

  it('does not let mid-turn user input revive a hard-suspended chain', () => {
    const guard = new DaemonTodoStopGuard(true);
    guard.observeTodoWrite(pendingResult, true);
    guard.commitContinuation(1);
    guard.suspend();
    guard.acceptMidTurnUserInput();

    expect(guard.decide(false)).toEqual({ kind: 'inactive' });
    expect(guard.isHardSuspended).toBe(true);
  });

  it('records a hard stop even when no Todo is currently active', () => {
    const guard = new DaemonTodoStopGuard(true);

    guard.suspend();
    guard.observeTodoWrite(pendingResult, true);

    expect(guard.isHardSuspended).toBe(true);
    expect(guard.decide(false)).toEqual({ kind: 'inactive' });

    guard.startOrdinaryPrompt();
    guard.observeTodoWrite(pendingResult, true);
    expect(guard.decide(false)).toMatchObject({ kind: 'continue', attempt: 1 });
  });

  it('defers for background work and locks a suspended work chain', () => {
    const guard = new DaemonTodoStopGuard(true);
    guard.observeTodoWrite(pendingResult, true);
    expect(guard.decide(true)).toEqual({ kind: 'deferred' });

    guard.suspend();
    guard.observeTodoWrite(pendingResult, true);
    expect(guard.decide(false)).toEqual({ kind: 'inactive' });
    expect(guard.blocksUnrelatedAutomaticTurns).toBe(false);
  });

  it('blocks unrelated automatic turns while a chain can still resume', () => {
    const guard = new DaemonTodoStopGuard(true);
    guard.observeTodoWrite(pendingResult, true);
    expect(guard.blocksUnrelatedAutomaticTurns).toBe(true);

    guard.pauseForTrustedRetry();
    expect(guard.blocksUnrelatedAutomaticTurns).toBe(true);
  });

  it('does not let automatic Todo writes revive a chain awaiting a prompt', () => {
    const guard = new DaemonTodoStopGuard(true);
    guard.observeTodoWrite(pendingResult, true);
    guard.awaitQueuedPrompt();
    guard.observeTodoWrite(pendingResult, true);

    expect(guard.decide(false)).toEqual({ kind: 'inactive' });
  });

  it('terminates an awaiting chain when the queued prompt disappears', () => {
    const guard = new DaemonTodoStopGuard(true);
    guard.observeTodoWrite(pendingResult, true);
    expect(guard.awaitQueuedPrompt()).toBe(true);

    expect(guard.blocksUnrelatedAutomaticTurns).toBe(true);
    guard.clearTrust();
    expect(guard.blocksUnrelatedAutomaticTurns).toBe(false);
    expect(guard.decide(false)).toEqual({ kind: 'inactive' });
    expect(guard.awaitQueuedPrompt()).toBe(false);
    expect(guard.blocksUnrelatedAutomaticTurns).toBe(false);
  });

  it('does not arm while the current mode disallows the guard', () => {
    const guard = new DaemonTodoStopGuard(true);
    expect(guard.observeTodoWrite(pendingResult, false)).toBe(true);
    expect(guard.decide(false)).toEqual({ kind: 'inactive' });

    guard.observeTodoWrite(pendingResult, true);
    expect(guard.decide(false)).toEqual({ kind: 'inactive' });

    guard.startOrdinaryPrompt();
    guard.observeTodoWrite(pendingResult, true);
    expect(guard.decide(false)).toMatchObject({ kind: 'continue', attempt: 1 });
  });

  it('stays inert when disabled', () => {
    const guard = new DaemonTodoStopGuard(false);
    expect(guard.observeTodoWrite(pendingResult, true)).toBe(false);
    expect(guard.decide(false)).toEqual({ kind: 'inactive' });
  });
});
