/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  enqueue,
  enqueuePendingNotification,
  dequeue,
  dequeueAllMatching,
  getCommandsByMaxPriority,
  remove,
  removeByFilter,
  peek,
  hasCommandsInQueue,
  clearCommandQueue,
  getCommandQueue,
  recheckCommandQueue,
  isSlashCommand,
  getCommandQueueSnapshot,
  getCommandQueueLength,
  getCommandQueueRevision,
  subscribeToCommandQueue,
  setInFlightDrainBatch,
  clearInFlightDrainBatch,
  someInFlightDrainCommand,
  getInFlightDrainBatch,
  markCancelPending,
  markInFlightDrainBatchCancelPending,
  consumeCancelPending,
  consumeInFlightBatchCancellation,
  _resetQueueForTest,
} from './messageQueueManager.js';

describe('messageQueueManager', () => {
  beforeEach(() => {
    _resetQueueForTest();
  });

  describe('enqueuePendingNotification', () => {
    it('should add a command to the queue with default priority "later"', () => {
      enqueuePendingNotification({
        prompt: 'test',
        commandMode: 'task-notification',
      });
      expect(getCommandQueueLength()).toBe(1);
      const snapshot = getCommandQueueSnapshot();
      expect(snapshot[0]?.priority).toBe('later');
      expect(snapshot[0]?.prompt).toBe('test');
      expect(snapshot[0]?.commandMode).toBe('task-notification');
    });

    it('should respect explicit priority', () => {
      enqueuePendingNotification({
        prompt: 'urgent',
        commandMode: 'task-notification',
        priority: 'next',
      });
      expect(getCommandQueueSnapshot()[0]?.priority).toBe('next');
    });
  });

  describe('command queue revision', () => {
    it('increments exactly once for every actual queue mutation', () => {
      const start = getCommandQueueRevision();
      enqueue({ prompt: 'a', commandMode: 'prompt' });
      expect(getCommandQueueRevision()).toBe(start + 1);

      enqueuePendingNotification({
        prompt: 'notification',
        commandMode: 'task-notification',
      });
      expect(getCommandQueueRevision()).toBe(start + 2);

      dequeue((command) => command.prompt === 'a');
      expect(getCommandQueueRevision()).toBe(start + 3);

      enqueue({ prompt: 'b', commandMode: 'prompt' });
      enqueue({ prompt: 'c', commandMode: 'prompt' });
      expect(getCommandQueueRevision()).toBe(start + 5);

      dequeueAllMatching((command) => command.prompt === 'b');
      expect(getCommandQueueRevision()).toBe(start + 6);

      const [c] = getCommandsByMaxPriority('later').filter(
        (command) => command.prompt === 'c',
      );
      remove(c ? [c] : []);
      expect(getCommandQueueRevision()).toBe(start + 7);

      removeByFilter((command) => command.commandMode === 'task-notification');
      expect(getCommandQueueRevision()).toBe(start + 8);

      enqueue({ prompt: 'last', commandMode: 'prompt' });
      clearCommandQueue();
      expect(getCommandQueueRevision()).toBe(start + 10);
    });

    it('does not increment for reads, notifications, or no-op removals', () => {
      enqueue({ prompt: 'kept', commandMode: 'prompt' });
      const revision = getCommandQueueRevision();

      peek();
      getCommandQueue();
      getCommandQueueSnapshot();
      getCommandQueueLength();
      recheckCommandQueue();
      dequeue(() => false);
      dequeueAllMatching(() => false);
      remove([]);
      remove([{ prompt: 'copy', commandMode: 'prompt' }]);
      removeByFilter(() => false);

      expect(getCommandQueueRevision()).toBe(revision);
    });

    it('does not increment when clearing an already empty queue', () => {
      const revision = getCommandQueueRevision();

      clearCommandQueue();

      expect(getCommandQueueRevision()).toBe(revision);
    });
  });

  describe('enqueue', () => {
    it('should add a command with default priority "next"', () => {
      enqueue({
        prompt: 'user input',
        commandMode: 'prompt',
      });
      expect(getCommandQueueLength()).toBe(1);
      const snapshot = getCommandQueueSnapshot();
      expect(snapshot[0]?.priority).toBe('next');
      expect(snapshot[0]?.prompt).toBe('user input');
    });

    it('should respect explicit priority', () => {
      enqueue({
        prompt: 'urgent',
        commandMode: 'prompt',
        priority: 'now',
      });
      expect(getCommandQueueSnapshot()[0]?.priority).toBe('now');
    });
  });

  describe('dequeue', () => {
    it('should return undefined for empty queue', () => {
      expect(dequeue()).toBeUndefined();
    });

    it('should dequeue highest priority first', () => {
      enqueuePendingNotification({
        prompt: 'later-item',
        commandMode: 'task-notification',
        priority: 'later',
      });
      enqueuePendingNotification({
        prompt: 'next-item',
        commandMode: 'task-notification',
        priority: 'next',
      });
      enqueuePendingNotification({
        prompt: 'now-item',
        commandMode: 'task-notification',
        priority: 'now',
      });

      const first = dequeue();
      expect(first?.prompt).toBe('now-item');

      const second = dequeue();
      expect(second?.prompt).toBe('next-item');

      const third = dequeue();
      expect(third?.prompt).toBe('later-item');
    });

    it('should dequeue FIFO within same priority', () => {
      enqueuePendingNotification({
        prompt: 'first',
        commandMode: 'task-notification',
      });
      enqueuePendingNotification({
        prompt: 'second',
        commandMode: 'task-notification',
      });

      expect(dequeue()?.prompt).toBe('first');
      expect(dequeue()?.prompt).toBe('second');
    });

    it('should respect filter', () => {
      enqueuePendingNotification({
        prompt: 'agent-1',
        commandMode: 'task-notification',
        targetAgentId: 'a1',
      });
      enqueuePendingNotification({
        prompt: 'main-thread',
        commandMode: 'task-notification',
      });

      const result = dequeue((cmd) => cmd.targetAgentId === undefined);
      expect(result?.prompt).toBe('main-thread');
      expect(getCommandQueueLength()).toBe(1);
    });
  });

  describe('peek', () => {
    it('should return undefined for empty queue', () => {
      expect(peek()).toBeUndefined();
    });

    it('should return highest priority without removing', () => {
      enqueuePendingNotification({
        prompt: 'later',
        commandMode: 'task-notification',
        priority: 'later',
      });
      enqueue({
        prompt: 'next',
        commandMode: 'prompt',
        priority: 'next',
      });

      const peeked = peek();
      expect(peeked?.prompt).toBe('next');
      expect(getCommandQueueLength()).toBe(2); // not removed
    });

    it('should respect filter', () => {
      enqueue({ prompt: 'a', commandMode: 'prompt', priority: 'now' });
      enqueuePendingNotification({
        prompt: 'b',
        commandMode: 'task-notification',
        priority: 'next',
      });

      const result = peek((cmd) => cmd.commandMode === 'task-notification');
      expect(result?.prompt).toBe('b');
    });
  });

  describe('dequeueAllMatching', () => {
    it('should drain all matching commands', () => {
      enqueuePendingNotification({
        prompt: 'notif-1',
        commandMode: 'task-notification',
      });
      enqueuePendingNotification({ prompt: 'prompt-1', commandMode: 'prompt' });
      enqueuePendingNotification({
        prompt: 'notif-2',
        commandMode: 'task-notification',
      });

      const matched = dequeueAllMatching(
        (cmd) => cmd.commandMode === 'task-notification',
      );
      expect(matched).toHaveLength(2);
      expect(matched[0]?.prompt).toBe('notif-1');
      expect(matched[1]?.prompt).toBe('notif-2');
      expect(getCommandQueueLength()).toBe(1);
    });

    it('should return empty array if nothing matches', () => {
      enqueuePendingNotification({ prompt: 'x', commandMode: 'prompt' });
      const matched = dequeueAllMatching(
        (cmd) => cmd.commandMode === 'task-notification',
      );
      expect(matched).toHaveLength(0);
      expect(getCommandQueueLength()).toBe(1);
    });
  });

  describe('getCommandsByMaxPriority', () => {
    it('should return commands at or above threshold without removing', () => {
      enqueuePendingNotification({
        prompt: 'now',
        commandMode: 'task-notification',
        priority: 'now',
      });
      enqueuePendingNotification({
        prompt: 'next',
        commandMode: 'task-notification',
        priority: 'next',
      });
      enqueuePendingNotification({
        prompt: 'later',
        commandMode: 'task-notification',
        priority: 'later',
      });

      const nextAndAbove = getCommandsByMaxPriority('next');
      expect(nextAndAbove).toHaveLength(2);
      expect(nextAndAbove.map((c) => c.prompt)).toEqual(['now', 'next']);
      // Queue unchanged
      expect(getCommandQueueLength()).toBe(3);
    });

    it('should support filter parameter', () => {
      enqueuePendingNotification({
        prompt: 'a',
        commandMode: 'task-notification',
        priority: 'next',
        targetAgentId: 'agent-1',
      });
      enqueuePendingNotification({
        prompt: 'b',
        commandMode: 'task-notification',
        priority: 'next',
      });

      const mainOnly = getCommandsByMaxPriority(
        'next',
        (cmd) => cmd.targetAgentId === undefined,
      );
      expect(mainOnly).toHaveLength(1);
      expect(mainOnly[0]?.prompt).toBe('b');
    });
  });

  describe('remove', () => {
    it('should remove commands by reference identity', () => {
      enqueuePendingNotification({
        prompt: 'a',
        commandMode: 'task-notification',
      });
      enqueuePendingNotification({
        prompt: 'b',
        commandMode: 'task-notification',
      });

      // snapshot items are copies, but getCommandsByMaxPriority returns references
      const refs = getCommandsByMaxPriority('later');
      remove(refs.slice(0, 1));
      expect(getCommandQueueLength()).toBe(1);
      expect(getCommandQueueSnapshot()[0]?.prompt).toBe('b');
    });

    it('should no-op on empty array', () => {
      enqueuePendingNotification({
        prompt: 'a',
        commandMode: 'task-notification',
      });
      remove([]);
      expect(getCommandQueueLength()).toBe(1);
    });
  });

  describe('removeByFilter', () => {
    it('should remove and return commands matching predicate', () => {
      enqueue({ prompt: 'a', commandMode: 'prompt' });
      enqueuePendingNotification({
        prompt: 'b',
        commandMode: 'task-notification',
      });
      enqueue({ prompt: 'c', commandMode: 'prompt' });

      const removed = removeByFilter(
        (cmd) => cmd.commandMode === 'task-notification',
      );
      expect(removed).toHaveLength(1);
      expect(removed[0]?.prompt).toBe('b');
      expect(getCommandQueueLength()).toBe(2);
    });
  });

  describe('hasCommandsInQueue', () => {
    it('should return false for empty queue', () => {
      expect(hasCommandsInQueue()).toBe(false);
    });

    it('should return true when queue has items', () => {
      enqueue({ prompt: 'test', commandMode: 'prompt' });
      expect(hasCommandsInQueue()).toBe(true);
    });
  });

  describe('clearCommandQueue', () => {
    it('should remove all commands', () => {
      enqueue({ prompt: 'a', commandMode: 'prompt' });
      enqueue({ prompt: 'b', commandMode: 'prompt' });
      clearCommandQueue();
      expect(getCommandQueueLength()).toBe(0);
    });

    it('should no-op on empty queue', () => {
      const listener = vi.fn();
      subscribeToCommandQueue(listener);
      clearCommandQueue();
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('getCommandQueue', () => {
    it('should return mutable copy', () => {
      enqueue({ prompt: 'test', commandMode: 'prompt' });
      const copy = getCommandQueue();
      expect(copy).toHaveLength(1);
      copy.pop(); // mutate copy
      expect(getCommandQueueLength()).toBe(1); // original unchanged
    });
  });

  describe('recheckCommandQueue', () => {
    it('should notify subscribers if queue has items', () => {
      enqueue({ prompt: 'test', commandMode: 'prompt' });
      const listener = vi.fn();
      subscribeToCommandQueue(listener);
      recheckCommandQueue();
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('should not notify if queue is empty', () => {
      const listener = vi.fn();
      subscribeToCommandQueue(listener);
      recheckCommandQueue();
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('in-flight drain batch', () => {
    it('keeps dequeued commands observable until the matching batch clears', () => {
      const command = { prompt: 'test', commandMode: 'prompt' } as const;
      const batch = [command];

      setInFlightDrainBatch(batch);

      expect(
        someInFlightDrainCommand((candidate) => candidate === command),
      ).toBe(true);
      expect(getInFlightDrainBatch()).toEqual(batch);

      clearInFlightDrainBatch([{ ...command }]);
      expect(someInFlightDrainCommand(() => true)).toBe(true);

      clearInFlightDrainBatch(batch);
      expect(someInFlightDrainCommand(() => true)).toBe(false);
    });

    it('drops a coalesced batch only when its representative is cancelled', () => {
      const batch = [
        { prompt: 'anonymous first', commandMode: 'prompt' },
        { prompt: 'identified member', commandMode: 'prompt', uuid: 'member' },
        { prompt: 'anonymous middle', commandMode: 'prompt' },
        {
          prompt: 'identified representative',
          commandMode: 'prompt',
          uuid: 'representative',
        },
        { prompt: 'anonymous last', commandMode: 'prompt' },
      ] as const;

      markCancelPending('member');
      expect(consumeInFlightBatchCancellation(batch)).toBe(false);
      expect(consumeCancelPending('member')).toBe(false);

      markCancelPending('representative');
      markCancelPending('member');
      expect(consumeInFlightBatchCancellation(batch)).toBe(true);
      expect(consumeCancelPending('representative')).toBe(false);
      expect(consumeCancelPending('member')).toBe(false);
    });

    it('drops the in-flight batch when an interrupt marks a UUID-bearing member', () => {
      const batch = [
        { prompt: 'anonymous first', commandMode: 'prompt' },
        {
          prompt: 'identified command',
          commandMode: 'prompt',
          uuid: 'identified',
        },
      ] as const;
      setInFlightDrainBatch(batch);

      expect(
        markInFlightDrainBatchCancelPending(
          (command) => command.uuid !== undefined,
        ),
      ).toEqual([batch[1]]);
      expect(consumeInFlightBatchCancellation(batch)).toBe(true);
      expect(consumeInFlightBatchCancellation(batch)).toBe(false);
    });

    it('drops an anonymous in-flight batch when an interrupt targets the main thread', () => {
      const batch = [
        { prompt: 'anonymous command', commandMode: 'prompt' },
      ] as const;
      setInFlightDrainBatch(batch);

      expect(
        markInFlightDrainBatchCancelPending(
          (command) => command.targetAgentId === undefined,
        ),
      ).toEqual(batch);
      expect(consumeInFlightBatchCancellation(batch)).toBe(true);
      expect(consumeInFlightBatchCancellation(batch)).toBe(false);
    });

    it('resets in-flight state with the rest of the queue', () => {
      setInFlightDrainBatch([{ prompt: 'test', commandMode: 'prompt' }]);

      _resetQueueForTest();

      expect(someInFlightDrainCommand(() => true)).toBe(false);
    });
  });

  describe('isSlashCommand', () => {
    it('should detect slash commands', () => {
      expect(isSlashCommand({ prompt: '/help', commandMode: 'prompt' })).toBe(
        true,
      );
      expect(
        isSlashCommand({ prompt: '  /compact  ', commandMode: 'prompt' }),
      ).toBe(true);
    });

    it('should return false for non-slash commands', () => {
      expect(isSlashCommand({ prompt: 'hello', commandMode: 'prompt' })).toBe(
        false,
      );
      expect(
        isSlashCommand({
          prompt: '/Users/me/project 这里面有啥',
          commandMode: 'prompt',
        }),
      ).toBe(false);
    });

    it('should return false when skipSlashCommands is true', () => {
      expect(
        isSlashCommand({
          prompt: '/help',
          commandMode: 'prompt',
          skipSlashCommands: true,
        }),
      ).toBe(false);
    });

    it('should return false for non-string prompts', () => {
      expect(
        isSlashCommand({
          prompt: [{ type: 'text', text: '/help' }],
          commandMode: 'prompt',
        }),
      ).toBe(false);
    });
  });

  describe('subscribe', () => {
    it('should notify listeners on enqueue', () => {
      const listener = vi.fn();
      const unsub = subscribeToCommandQueue(listener);

      enqueuePendingNotification({
        prompt: 'test',
        commandMode: 'task-notification',
      });
      expect(listener).toHaveBeenCalledTimes(1);

      unsub();
      enqueuePendingNotification({
        prompt: 'test2',
        commandMode: 'task-notification',
      });
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('should notify listeners on dequeue', () => {
      enqueuePendingNotification({
        prompt: 'test',
        commandMode: 'task-notification',
      });

      const listener = vi.fn();
      const unsub = subscribeToCommandQueue(listener);

      dequeue();
      expect(listener).toHaveBeenCalledTimes(1);

      unsub();
    });
  });

  describe('snapshot', () => {
    it('should return frozen array that changes reference on mutation', () => {
      const snap1 = getCommandQueueSnapshot();
      expect(snap1).toHaveLength(0);

      enqueuePendingNotification({
        prompt: 'a',
        commandMode: 'task-notification',
      });
      const snap2 = getCommandQueueSnapshot();
      expect(snap2).toHaveLength(1);
      expect(snap1).not.toBe(snap2);
      expect(Object.isFrozen(snap2)).toBe(true);
    });
  });

  describe('pending cancellation', () => {
    it('should consume a cancellation marker exactly once', () => {
      markCancelPending('message-uuid');

      expect(consumeCancelPending('message-uuid')).toBe(true);
      expect(consumeCancelPending('message-uuid')).toBe(false);
    });

    it('should clear cancellation markers when resetting test state', () => {
      markCancelPending('message-uuid');

      _resetQueueForTest();

      expect(consumeCancelPending('message-uuid')).toBe(false);
    });
  });
});
