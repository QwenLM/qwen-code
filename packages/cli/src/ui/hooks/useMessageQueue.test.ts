/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { GoalTurnHost, GoalTurnPermit } from '@qwen-code/qwen-code-core';
import { useMessageQueue } from './useMessageQueue.js';

describe('useMessageQueue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('should initialize with empty queue', () => {
    const { result } = renderHook(() => useMessageQueue());

    expect(result.current.messageQueue).toEqual([]);
    expect(result.current.getQueuedMessagesText()).toBe('');
  });

  it('should add messages to queue', () => {
    const { result } = renderHook(() => useMessageQueue());

    act(() => {
      result.current.addMessage('Test message 1');
      result.current.addMessage('Test message 2');
    });

    expect(result.current.messageQueue).toEqual([
      'Test message 1',
      'Test message 2',
    ]);
  });

  it('should filter out empty messages', () => {
    const { result } = renderHook(() => useMessageQueue());

    act(() => {
      result.current.addMessage('Valid message');
      result.current.addMessage('   '); // Only whitespace
      result.current.addMessage(''); // Empty
      result.current.addMessage('Another valid message');
    });

    expect(result.current.messageQueue).toEqual([
      'Valid message',
      'Another valid message',
    ]);
  });

  it('should clear queue', () => {
    const { result } = renderHook(() => useMessageQueue());

    act(() => {
      result.current.addMessage('Test message');
    });

    expect(result.current.messageQueue).toEqual(['Test message']);

    act(() => {
      result.current.clearQueue();
    });

    expect(result.current.messageQueue).toEqual([]);
  });

  it('should return queued messages as text with double newlines', () => {
    const { result } = renderHook(() => useMessageQueue());

    act(() => {
      result.current.addMessage('Message 1');
      result.current.addMessage('Message 2');
      result.current.addMessage('Message 3');
    });

    expect(result.current.getQueuedMessagesText()).toBe(
      'Message 1\n\nMessage 2\n\nMessage 3',
    );
  });

  it('keeps one hidden Goal turn out of the public queue and wakes dequeue', () => {
    const permit: GoalTurnPermit = {
      goalId: 'goal-1',
      revision: 2,
      turnId: 'turn-1',
    };
    const input: Parameters<GoalTurnHost['startGoalTurn']>[0] = {
      permit,
      continuationContext: 'Continue the active Goal',
      windDown: true,
      verifierFeedback: 'Need stronger evidence',
    };
    const { result } = renderHook(() => useMessageQueue());
    const queue = result.current as typeof result.current & {
      enqueueGoalTurn?: (value: typeof input) => void;
      pendingSubmissionCount?: number;
      popNextSubmission?: () => unknown;
    };

    expect(queue.enqueueGoalTurn).toBeTypeOf('function');
    act(() => {
      queue.enqueueGoalTurn!(input);
      queue.enqueueGoalTurn!(input);
    });

    expect(result.current.messageQueue).toEqual([]);
    expect((result.current as typeof queue).pendingSubmissionCount).toBe(1);

    let submission: unknown;
    act(() => {
      submission = queue.popNextSubmission!();
    });
    expect(submission).toEqual({
      kind: 'goal',
      permit,
      turnKey: 'goal-runtime:turn-1',
      continuationContext: 'Continue the active Goal',
      windDown: true,
      verifierFeedback: 'Need stronger evidence',
    });
    expect(queue.popNextSubmission!()).toBeNull();
  });

  it('peeks a stable plain-user batch key without consuming messages', () => {
    const { result } = renderHook(() => useMessageQueue());
    act(() => {
      result.current.addMessage('first prompt');
      result.current.addMessage('/help');
      result.current.addMessage('second prompt');
    });
    const queue = result.current as typeof result.current & {
      peekNextUserBatchKey?: () => string | undefined;
      popNextSubmission: () => unknown;
    };

    expect(queue.peekNextUserBatchKey).toBeTypeOf('function');
    const firstPeek = queue.peekNextUserBatchKey!();
    const secondPeek = queue.peekNextUserBatchKey!();

    expect(firstPeek).toEqual(expect.any(String));
    expect(secondPeek).toBe(firstPeek);
    expect(result.current.messageQueue).toEqual([
      'first prompt',
      '/help',
      'second prompt',
    ]);

    let submission: unknown;
    act(() => {
      submission = queue.popNextSubmission();
    });
    expect(submission).toEqual({
      kind: 'user',
      modelText: 'first prompt\n\nsecond prompt',
      turnKey: firstPeek,
    });
    expect(result.current.messageQueue).toEqual(['/help']);
    expect(queue.peekNextUserBatchKey!()).toBeUndefined();
  });

  it('pops a slash-command-headed queue one command at a time in normal mode', () => {
    const { result } = renderHook(() => useMessageQueue());
    act(() => {
      result.current.addMessage('/model');
      result.current.addMessage('/help');
    });

    let submission: ReturnType<typeof result.current.popNextSubmission> = null;
    act(() => {
      submission = result.current.popNextSubmission();
    });

    expect(submission).toMatchObject({ kind: 'user', modelText: '/model' });
    expect(result.current.messageQueue).toEqual(['/help']);

    let second: ReturnType<typeof result.current.popNextSubmission> = null;
    act(() => {
      second = result.current.popNextSubmission();
    });

    expect(second).toMatchObject({ kind: 'user', modelText: '/help' });
    expect(result.current.messageQueue).toEqual([]);
  });

  it('hides the plain-user batch key from an active Goal turn reservation', () => {
    const { result } = renderHook(() => useMessageQueue());
    act(() => {
      result.current.addMessage('queued user');
    });
    const queue = result.current as typeof result.current & {
      peekNextUserBatchKey?: (goalTurnActive?: boolean) => string | undefined;
    };

    // Idle boundary: the plain message is deliverable, so it is reservable.
    expect(queue.peekNextUserBatchKey!()).toEqual(expect.any(String));
    // Active Goal turn: the two-lane drain gate holds plain messages, so no
    // key is reported and the Goal loop continues instead of reserving a turn
    // the queue will never release.
    expect(queue.peekNextUserBatchKey!(true)).toBeUndefined();
    expect(result.current.messageQueue).toEqual(['queued user']);
    expect(queue.peekNextUserBatchKey!()).toEqual(expect.any(String));
  });

  it('keeps a Goal permit hidden until plain user preprocessing succeeds', () => {
    const permit: GoalTurnPermit = {
      goalId: 'goal-1',
      revision: 2,
      turnId: 'turn-user-priority',
    };
    const { result } = renderHook(() => useMessageQueue());
    act(() => {
      result.current.enqueueGoalTurn({
        permit,
        continuationContext: 'automatic continuation',
      });
      result.current.addMessage('user goes first');
    });
    const userTurnKey = result.current.peekNextUserBatchKey();

    let submission;
    act(() => {
      submission = result.current.popNextSubmission();
    });

    expect(submission).toEqual({
      kind: 'user',
      modelText: 'user goes first',
      turnKey: userTurnKey,
    });
    expect(result.current.pendingSubmissionCount).toBe(1);
    let claimedGoal;
    act(() => {
      claimedGoal = result.current.claimGoalTurn();
    });
    expect(claimedGoal).toEqual({
      kind: 'goal',
      permit,
      turnKey: 'goal-runtime:turn-user-priority',
      continuationContext: 'automatic continuation',
    });
    expect(result.current.pendingSubmissionCount).toBe(0);
  });

  it('defensively copies a Goal permit when it is admitted', () => {
    const permit: GoalTurnPermit = {
      goalId: 'goal-copy',
      revision: 3,
      turnId: 'turn-copy',
    };
    const { result } = renderHook(() => useMessageQueue());
    act(() => {
      result.current.enqueueGoalTurn({
        permit,
        continuationContext: 'copy the permit',
      });
    });

    permit.revision = 99;
    let submission: unknown;
    act(() => {
      submission = result.current.popNextSubmission();
    });

    expect(submission).toMatchObject({ kind: 'goal' });
    const goalSubmission = submission as {
      kind: 'goal';
      permit: typeof permit;
    };
    expect(goalSubmission.permit).toEqual({
      goalId: 'goal-copy',
      revision: 3,
      turnId: 'turn-copy',
    });
    expect(goalSubmission.permit).not.toBe(permit);
  });

  it('creates a stable direct-user admission that claims a hidden Goal', () => {
    const permit: GoalTurnPermit = {
      goalId: 'goal-direct',
      revision: 4,
      turnId: 'turn-direct',
    };
    const { result } = renderHook(() => useMessageQueue());
    act(() => {
      result.current.enqueueGoalTurn({
        permit,
        continuationContext: 'direct user wins',
      });
    });
    const queue = result.current as typeof result.current & {
      claimDirectUserAdmission?: () => unknown;
    };

    expect(queue.claimDirectUserAdmission).toBeTypeOf('function');
    let admission: unknown;
    act(() => {
      admission = queue.claimDirectUserAdmission!();
    });

    expect(admission).toEqual({
      turnKey: expect.any(String),
      goal: {
        kind: 'goal',
        permit,
        turnKey: 'goal-runtime:turn-direct',
        continuationContext: 'direct user wins',
      },
    });
    expect(result.current.pendingSubmissionCount).toBe(0);
    let nextAdmission: unknown;
    act(() => {
      nextAdmission = queue.claimDirectUserAdmission!();
    });
    expect(nextAdmission).toEqual({
      turnKey: expect.any(String),
    });
  });

  it('lets a system turn claim a hidden Goal without creating a user key', () => {
    const { result } = renderHook(() => useMessageQueue());
    act(() => {
      result.current.enqueueGoalTurn({
        permit: {
          goalId: 'goal-system',
          revision: 2,
          turnId: 'turn-system',
        },
        continuationContext: 'system event goes first',
      });
    });
    const queue = result.current as typeof result.current & {
      claimGoalTurn?: () => unknown;
    };

    expect(queue.claimGoalTurn).toBeTypeOf('function');
    let claimed: unknown;
    act(() => {
      claimed = queue.claimGoalTurn!();
    });

    expect(claimed).toEqual({
      kind: 'goal',
      permit: {
        goalId: 'goal-system',
        revision: 2,
        turnId: 'turn-system',
      },
      turnKey: 'goal-runtime:turn-system',
      continuationContext: 'system event goes first',
    });
    expect(result.current.pendingSubmissionCount).toBe(0);
    expect(queue.claimGoalTurn!()).toBeUndefined();
  });

  it('does not reuse real-user turn keys across hook instances', () => {
    const first = renderHook(() => useMessageQueue());
    const second = renderHook(() => useMessageQueue());

    const firstAdmission = first.result.current.claimDirectUserAdmission();
    const secondAdmission = second.result.current.claimDirectUserAdmission();

    expect(firstAdmission.turnKey).not.toBe(secondAdmission.turnKey);
  });

  it('releases Goal dedup state after many claimed turns', () => {
    const { result } = renderHook(() => useMessageQueue());
    for (let index = 0; index < 160; index++) {
      act(() => {
        result.current.enqueueGoalTurn({
          permit: {
            goalId: 'goal-many-turns',
            revision: 1,
            turnId: `turn-${index}`,
          },
          continuationContext: `continue ${index}`,
        });
        result.current.claimGoalTurn();
      });
    }

    expect(result.current.pendingSubmissionCount).toBe(0);
    act(() => {
      result.current.enqueueGoalTurn({
        permit: {
          goalId: 'goal-many-turns',
          revision: 1,
          turnId: 'turn-0',
        },
        continuationContext: 'turn ids do not leak forever',
      });
    });
    expect(result.current.pendingSubmissionCount).toBe(1);
  });

  it('reports queued real-user priority separately from hidden Goal work', () => {
    const { result } = renderHook(() => useMessageQueue());

    expect(result.current.hasQueuedUserMessages()).toBe(false);
    expect(result.current.getPendingSubmissionCount()).toBe(0);
    act(() => {
      result.current.enqueueGoalTurn({
        permit: {
          goalId: 'goal-priority',
          revision: 1,
          turnId: 'turn-priority',
        },
        continuationContext: 'hidden',
      });
    });
    expect(result.current.hasQueuedUserMessages()).toBe(false);
    expect(result.current.getPendingSubmissionCount()).toBe(1);
    act(() => {
      result.current.addMessage('/help');
    });
    expect(result.current.hasQueuedUserMessages()).toBe(true);
    expect(result.current.getPendingSubmissionCount()).toBe(2);
  });

  it('removes queued Goal turns without deleting real user text', () => {
    const { result } = renderHook(() => useMessageQueue());
    act(() => {
      result.current.enqueueGoalTurn({
        permit: {
          goalId: 'goal-preempt',
          revision: 1,
          turnId: 'turn-preempt',
        },
        continuationContext: 'remove only this entry',
      });
      result.current.addMessage('keep me');
    });
    const queue = result.current as typeof result.current & {
      removeGoalTurns?: () => string[];
    };

    expect(queue.removeGoalTurns).toBeTypeOf('function');
    let removedKeys: string[] = [];
    act(() => {
      removedKeys = queue.removeGoalTurns!();
    });

    expect(removedKeys).toHaveLength(1);
    expect(removedKeys[0]).toMatch(/^goal-runtime:/);
    expect(result.current.messageQueue).toEqual(['keep me']);
    expect(result.current.pendingSubmissionCount).toBe(1);
    let kept: unknown;
    act(() => {
      kept = result.current.popNextSubmission();
    });
    expect(kept).toMatchObject({
      kind: 'user',
      modelText: 'keep me',
    });
  });

  describe('popAllMessages (cancel and ESC/Up restore)', () => {
    it('returns null when the queue is empty', () => {
      const { result } = renderHook(() => useMessageQueue());

      let popped: ReturnType<typeof result.current.popAllMessages> = null;
      act(() => {
        popped = result.current.popAllMessages();
      });

      expect(popped).toBeNull();
      expect(result.current.messageQueue).toEqual([]);
    });

    it('joins all queued messages with double newlines and clears the queue', () => {
      const { result } = renderHook(() => useMessageQueue());

      act(() => {
        result.current.addMessage('Message 1');
        result.current.addMessage('Message 2');
        result.current.addMessage('Message 3');
      });

      let popped: ReturnType<typeof result.current.popAllMessages> = null;
      act(() => {
        popped = result.current.popAllMessages();
      });

      expect(popped).toMatchObject({
        kind: 'user',
        modelText: 'Message 1\n\nMessage 2\n\nMessage 3',
      });
      expect(result.current.messageQueue).toEqual([]);
    });

    it('returns a single message without separator', () => {
      const { result } = renderHook(() => useMessageQueue());

      act(() => {
        result.current.addMessage('Only message');
      });

      let popped: ReturnType<typeof result.current.popAllMessages> = null;
      act(() => {
        popped = result.current.popAllMessages();
      });

      expect(popped).toMatchObject({
        kind: 'user',
        modelText: 'Only message',
      });
      expect(result.current.messageQueue).toEqual([]);
    });

    it('joins mixed slash commands and prompts in original order', () => {
      // Edit-restore intentionally collapses segment boundaries: the user is
      // recovering input into the buffer to edit before resubmitting, so
      // typing order matters more than slash-vs-prompt routing boundaries.
      const { result } = renderHook(() => useMessageQueue());

      act(() => {
        result.current.addMessage('/model');
        result.current.addMessage('hello');
        result.current.addMessage('world');
      });

      let popped: ReturnType<typeof result.current.popAllMessages> = null;
      act(() => {
        popped = result.current.popAllMessages();
      });

      expect(popped).toMatchObject({
        kind: 'user',
        modelText: '/model\n\nhello\n\nworld',
      });
      expect(result.current.messageQueue).toEqual([]);
    });

    it('reports the exact removed turn keys for Goal reservation release', () => {
      const { result } = renderHook(() => useMessageQueue());
      act(() => result.current.addMessage('queued user'));
      const reservedKey = result.current.peekNextUserBatchKey();
      const removed: string[][] = [];

      act(() => {
        result.current.popAllMessages((keys) => removed.push(keys));
      });

      expect(removed).toEqual([[reservedKey]]);
    });

    it('aggregates submittedPrompt when every message has one', () => {
      const { result } = renderHook(() => useMessageQueue());
      act(() => {
        result.current.addMessage('msg A', false, 'prompt A');
        result.current.addMessage('msg B', false, 'prompt B');
      });

      let popped: ReturnType<typeof result.current.popAllMessages> = null;
      act(() => {
        popped = result.current.popAllMessages();
      });

      expect(popped).toMatchObject({
        kind: 'user',
        modelText: 'msg A\n\nmsg B',
        submittedPrompt: 'prompt A\n\nprompt B',
      });
    });

    it('omits submittedPrompt when any message lacks one', () => {
      const { result } = renderHook(() => useMessageQueue());
      act(() => {
        result.current.addMessage('msg A', false, 'prompt A');
        result.current.addMessage('msg B');
      });

      let popped: ReturnType<typeof result.current.popAllMessages> = null;
      act(() => {
        popped = result.current.popAllMessages();
      });

      expect(popped).toMatchObject({
        kind: 'user',
        modelText: 'msg A\n\nmsg B',
      });
      expect(popped!.submittedPrompt).toBeUndefined();
    });
  });

  it('holds reserved user input behind a stopped Goal until /goal resumes it', () => {
    const { result } = renderHook(() => useMessageQueue());
    act(() => {
      result.current.addMessage('queued user');
      result.current.addMessage('/goal resume');
    });
    const reservedKey = result.current.peekNextUserBatchKey();

    let goalControl: ReturnType<typeof result.current.popNextSubmission>;
    act(() => {
      goalControl = result.current.popNextSubmission('only');
    });
    expect(goalControl!).toMatchObject({
      kind: 'user',
      modelText: '/goal resume',
    });
    expect(result.current.messageQueue).toEqual(['queued user']);
    expect(result.current.popNextSubmission('only')).toBeNull();
    let userSubmission: ReturnType<typeof result.current.popNextSubmission>;
    act(() => {
      userSubmission = result.current.popNextSubmission();
    });
    expect(userSubmission!).toEqual({
      kind: 'user',
      modelText: 'queued user',
      turnKey: reservedKey,
    });
  });

  it('prioritizes a Goal control over ordinary input while the Goal is active', () => {
    const { result } = renderHook(() => useMessageQueue());
    act(() => {
      result.current.addMessage('queued user');
      result.current.addMessage('/goal pause');
    });

    let goalControl: ReturnType<typeof result.current.popNextSubmission>;
    act(() => {
      goalControl = result.current.popNextSubmission('priority');
    });

    expect(goalControl!).toMatchObject({
      kind: 'user',
      modelText: '/goal pause',
    });
    expect(result.current.messageQueue).toEqual(['queued user']);
  });

  it('keeps ordinary input queued while an active Goal has no continuation ready', () => {
    const { result } = renderHook(() => useMessageQueue());
    act(() => {
      result.current.addMessage('queued user');
    });

    expect(result.current.popNextSubmission('priority')).toBeNull();
    expect(result.current.messageQueue).toEqual(['queued user']);
  });

  it('drains a hidden Goal continuation before ordinary queued input', () => {
    const { result } = renderHook(() => useMessageQueue());
    act(() => {
      result.current.addMessage('queued user');
      result.current.enqueueGoalTurn({
        permit: {
          goalId: 'goal-1',
          revision: 1,
          turnId: 'goal-turn-1',
        },
        continuationContext: 'continue the active Goal',
      });
    });

    let submission: ReturnType<typeof result.current.popNextSubmission>;
    act(() => {
      submission = result.current.popNextSubmission('priority');
    });

    expect(submission!).toMatchObject({
      kind: 'goal',
      turnKey: 'goal-runtime:goal-turn-1',
    });
    expect(result.current.messageQueue).toEqual(['queued user']);
    expect(result.current.popNextSubmission('priority')).toBeNull();
  });

  describe('drainQueue (mid-turn drain for tool-result injection)', () => {
    it('returns an empty array when the queue is empty', () => {
      const { result } = renderHook(() => useMessageQueue());

      let drained: string[] = [];
      act(() => {
        drained = result.current.drainQueue();
      });
      expect(drained).toEqual([]);
    });

    it('drains all plain-text messages and leaves slash commands queued', () => {
      const { result } = renderHook(() => useMessageQueue());

      act(() => {
        result.current.addMessage('one');
        result.current.addMessage('two');
        result.current.addMessage('/model');
        result.current.addMessage('three');
      });

      let drained: string[] = [];
      act(() => {
        drained = result.current.drainQueue();
      });

      expect(drained).toEqual(['one', 'two', 'three']);
      expect(result.current.messageQueue).toEqual(['/model']);
    });

    it('keeps Goal creation queued until an ordinary turn reaches idle', () => {
      const { result } = renderHook(() => useMessageQueue());

      act(() => {
        result.current.addMessage('steer now');
        result.current.addMessage('/goal ship the release');
        result.current.addMessage('/model');
      });

      let drained: string[] = [];
      act(() => {
        drained = result.current.drainQueue();
      });

      expect(drained).toEqual(['steer now']);
      expect(result.current.messageQueue).toEqual([
        '/goal ship the release',
        '/model',
      ]);
    });

    it('drains only Goal controls while a Goal turn is running', () => {
      const { result } = renderHook(() => useMessageQueue());

      act(() => {
        result.current.addMessage('plain user text');
        result.current.addMessage('/goal pause');
        result.current.addMessage('/model');
        result.current.addMessage('/goal edit revised objective');
        result.current.addMessage('/goal clear');
      });

      let drained: string[] = [];
      act(() => {
        drained = result.current.drainQueue(false, true);
      });

      expect(drained).toEqual([
        '/goal pause',
        '/goal edit revised objective',
        '/goal clear',
      ]);
      expect(result.current.messageQueue).toEqual([
        'plain user text',
        '/model',
      ]);
    });

    it('leaves goal commands queued at the idle boundary', () => {
      const { result } = renderHook(() => useMessageQueue());

      act(() => {
        result.current.addMessage('/goal clear');
      });

      let drained: string[] = [];
      act(() => {
        drained = result.current.drainQueue(true);
      });

      expect(drained).toEqual([]);
      expect(result.current.messageQueue).toEqual(['/goal clear']);
    });

    it('returns an empty array when the queue contains only slash commands', () => {
      const { result } = renderHook(() => useMessageQueue());

      act(() => {
        result.current.addMessage('/model');
        result.current.addMessage('/help');
      });

      let drained: string[] = [];
      act(() => {
        drained = result.current.drainQueue();
      });

      expect(drained).toEqual([]);
      expect(result.current.messageQueue).toEqual(['/model', '/help']);
    });

    it('drains the whole queue when it contains no slash commands', () => {
      const { result } = renderHook(() => useMessageQueue());

      act(() => {
        result.current.addMessage('a');
        result.current.addMessage('b');
        result.current.addMessage('c');
      });

      let drained: string[] = [];
      act(() => {
        drained = result.current.drainQueue();
      });

      expect(drained).toEqual(['a', 'b', 'c']);
      expect(result.current.messageQueue).toEqual([]);
    });

    it('leaves Ctrl+Q messages queued during an active turn', () => {
      const { result } = renderHook(() => useMessageQueue());

      act(() => {
        result.current.addMessage('steer now');
        result.current.addMessage('wait for idle', true);
      });

      let drained: string[] = [];
      act(() => {
        drained = result.current.drainQueue();
      });

      expect(drained).toEqual(['steer now']);
      expect(result.current.messageQueue).toEqual(['wait for idle']);
    });

    it('drains Ctrl+Q messages at the idle boundary', () => {
      const { result } = renderHook(() => useMessageQueue());

      act(() => {
        result.current.addMessage('wait for idle', true);
      });

      let drained: string[] = [];
      act(() => {
        drained = result.current.drainQueue(true);
      });

      expect(drained).toEqual(['wait for idle']);
      expect(result.current.messageQueue).toEqual([]);
    });

    it('restores interrupted steer messages ahead of newer queued input', () => {
      const { result } = renderHook(() => useMessageQueue());

      act(() => {
        result.current.addMessage('steer now');
      });
      act(() => {
        result.current.drainQueue();
        result.current.addMessage('newer input');
        result.current.restoreMessages(['steer now']);
      });

      expect(result.current.messageQueue).toEqual(['steer now', 'newer input']);
    });

    it('preserves submittedPrompt provenance when restoring one interrupted message', () => {
      const { result } = renderHook(() => useMessageQueue());

      act(() => {
        result.current.restoreMessages(['steer now'], 'original prompt');
      });

      let popped: ReturnType<typeof result.current.popAllMessages> = null;
      act(() => {
        popped = result.current.popAllMessages();
      });

      expect(popped).toMatchObject({
        kind: 'user',
        modelText: 'steer now',
        submittedPrompt: 'original prompt',
      });
    });

    it('drops submittedPrompt provenance when restoring multiple messages', () => {
      const { result } = renderHook(() => useMessageQueue());

      act(() => {
        result.current.restoreMessages(['first', 'second'], 'original prompt');
      });

      let popped: ReturnType<typeof result.current.popAllMessages> = null;
      act(() => {
        popped = result.current.popAllMessages();
      });

      expect(popped).toMatchObject({
        kind: 'user',
        modelText: 'first\n\nsecond',
      });
      expect(popped!.submittedPrompt).toBeUndefined();
    });
  });
});
