import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BoundedReconnectPolicy } from '../reconnect-policy.ts';

describe('BoundedReconnectPolicy', () => {
  it('stops after its finite budget', () => {
    const policy = new BoundedReconnectPolicy([10, 20, 40], 0, () => 0.5);
    assert.deepEqual(
      [
        policy.nextDelayMs(),
        policy.nextDelayMs(),
        policy.nextDelayMs(),
        policy.nextDelayMs(),
      ],
      [10, 20, 40, undefined],
    );
    assert.equal(policy.attemptsUsed, 3);
  });

  it('resets only when explicitly requested', () => {
    const policy = new BoundedReconnectPolicy([100], 0);
    assert.equal(policy.nextDelayMs(), 100);
    assert.equal(policy.nextDelayMs(), undefined);
    policy.reset();
    assert.equal(policy.nextDelayMs(), 100);
  });

  it('keeps jitter bounded', () => {
    assert.equal(
      new BoundedReconnectPolicy([100], 0.2, () => 0).nextDelayMs(),
      80,
    );
    assert.equal(
      new BoundedReconnectPolicy([100], 0.2, () => 1).nextDelayMs(),
      120,
    );
  });
});
