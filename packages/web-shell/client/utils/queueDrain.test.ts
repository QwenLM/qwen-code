import { describe, expect, it } from 'vitest';
import { canDrainQueue, type QueueDrainGate } from './queueDrain';

// A gate where every condition is satisfied — the next prompt should drain.
const ready: QueueDrainGate = {
  draining: false,
  awaitingTurnStart: false,
  connected: true,
  streaming: false,
  interactionBlocked: false,
  pendingApproval: false,
  queueLength: 1,
};

describe('canDrainQueue', () => {
  it('drains when every condition is satisfied', () => {
    expect(canDrainQueue(ready)).toBe(true);
  });

  it('holds the queue when it is empty', () => {
    expect(canDrainQueue({ ...ready, queueLength: 0 })).toBe(false);
  });

  it.each([
    ['a drain is already in flight', { draining: true }],
    ['waiting for the prior turn to start', { awaitingTurnStart: true }],
    ['the connection is down', { connected: false }],
    ['a turn is streaming', { streaming: true }],
    ['interaction is blocked', { interactionBlocked: true }],
    ['a tool approval is pending', { pendingApproval: true }],
  ] as const)('holds the queue when %s', (_label, override) => {
    expect(canDrainQueue({ ...ready, ...override })).toBe(false);
  });
});
