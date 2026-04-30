/**
 * Tests for EventQueue
 *
 * EventQueue bridges async event handlers (.on() listeners) with AsyncGenerator<AgentEvent>.
 * Used by backends where events arrive asynchronously.
 */
import { describe, it, expect } from 'bun:test';
import { EventQueue } from '../backend/event-queue.ts';
import type { AgentEvent } from '@craft-agent/core/types';

// Helper: create a minimal AgentEvent
function textDelta(text: string): AgentEvent {
  return { type: 'text_delta', text };
}

function completeEvent(): AgentEvent {
  return { type: 'complete' };
}

// Helper: collect all events from drain()
async function collectDrain(queue: EventQueue): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of queue.drain()) {
    events.push(event);
  }
  return events;
}

describe('EventQueue', () => {
  describe('basic enqueue and drain', () => {
    it('should yield enqueued events in order', async () => {
      const queue = new EventQueue();

      // Enqueue some events then complete
      queue.enqueue(textDelta('hello'));
      queue.enqueue(textDelta(' world'));
      queue.complete();

      const events = await collectDrain(queue);
      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({ type: 'text_delta', text: 'hello' });
      expect(events[1]).toEqual({ type: 'text_delta', text: ' world' });
    });

    it('should complete with no events when complete() called immediately', async () => {
      const queue = new EventQueue();
      queue.complete();

      const events = await collectDrain(queue);
      expect(events).toHaveLength(0);
    });

    it('should yield events enqueued before drain starts', async () => {
      const queue = new EventQueue();

      // Pre-enqueue events before anyone calls drain()
      queue.enqueue(textDelta('a'));
      queue.enqueue(textDelta('b'));
      queue.complete();

      const events = await collectDrain(queue);
      expect(events).toHaveLength(2);
    });
  });

  describe('async interleaving', () => {
    it('should wait for events when queue is empty', async () => {
      const queue = new EventQueue();

      // Start draining in background
      const drainPromise = collectDrain(queue);

      // Enqueue after a micro-task delay
      await new Promise(resolve => setTimeout(resolve, 10));
      queue.enqueue(textDelta('delayed'));
      queue.complete();

      const events = await drainPromise;
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ type: 'text_delta', text: 'delayed' });
    });

    it('should handle interleaved enqueue and drain', async () => {
      const queue = new EventQueue();
      const events: AgentEvent[] = [];

      // Start draining
      const drainPromise = (async () => {
        for await (const event of queue.drain()) {
          events.push(event);
        }
      })();

      // Enqueue in batches with delays
      queue.enqueue(textDelta('1'));
      await new Promise(resolve => setTimeout(resolve, 5));
      queue.enqueue(textDelta('2'));
      await new Promise(resolve => setTimeout(resolve, 5));
      queue.enqueue(textDelta('3'));
      queue.complete();

      await drainPromise;
      expect(events).toHaveLength(3);
      expect(events.map(e => (e as any).text)).toEqual(['1', '2', '3']);
    });
  });

  describe('reset', () => {
    it('should allow reuse after reset', async () => {
      const queue = new EventQueue();

      // First turn
      queue.enqueue(textDelta('turn1'));
      queue.complete();
      const events1 = await collectDrain(queue);
      expect(events1).toHaveLength(1);

      // Reset for second turn
      queue.reset();

      // Second turn
      queue.enqueue(textDelta('turn2-a'));
      queue.enqueue(textDelta('turn2-b'));
      queue.complete();
      const events2 = await collectDrain(queue);
      expect(events2).toHaveLength(2);
    });

    it('should clear pending events on reset', async () => {
      const queue = new EventQueue();

      // Enqueue but don't complete
      queue.enqueue(textDelta('stale'));
      expect(queue.hasPending).toBe(true);

      // Reset clears everything
      queue.reset();
      expect(queue.hasPending).toBe(false);
      expect(queue.isComplete).toBe(false);

      // Fresh turn
      queue.enqueue(textDelta('fresh'));
      queue.complete();
      const events = await collectDrain(queue);
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ type: 'text_delta', text: 'fresh' });
    });
  });

  describe('state queries', () => {
    it('hasPending should reflect queue state', () => {
      const queue = new EventQueue();
      expect(queue.hasPending).toBe(false);

      queue.enqueue(textDelta('x'));
      expect(queue.hasPending).toBe(true);
    });

    it('isComplete should reflect completion state', () => {
      const queue = new EventQueue();
      expect(queue.isComplete).toBe(false);

      queue.complete();
      expect(queue.isComplete).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('should handle multiple complete() calls gracefully', async () => {
      const queue = new EventQueue();
      queue.enqueue(textDelta('x'));
      queue.complete();
      queue.complete(); // extra call should be harmless

      const events = await collectDrain(queue);
      expect(events).toHaveLength(1);
    });

    it('should handle enqueue after complete', async () => {
      const queue = new EventQueue();
      queue.complete();
      // Enqueue after complete — these won't be drained since done=true
      queue.enqueue(textDelta('late'));

      // drain() will see done=true first, then find events in queue
      // The implementation drains remaining events before exiting
      const events = await collectDrain(queue);
      // The event was enqueued after complete, drain will still yield queued events
      expect(events).toHaveLength(1);
    });
  });
});
