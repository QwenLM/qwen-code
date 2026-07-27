import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CaptureRecoveryPolicy } from '../../preload/capture-recovery-policy.ts';

describe('CaptureRecoveryPolicy', () => {
  it('bounds same-call microphone rebuilds and resets after recovery', () => {
    const policy = new CaptureRecoveryPolicy([10, 20, 40]);
    assert.deepEqual(
      [
        policy.nextDelayMs(),
        policy.nextDelayMs(),
        policy.nextDelayMs(),
        policy.nextDelayMs(),
      ],
      [10, 20, 40, undefined],
    );
    policy.reset();
    assert.equal(policy.nextDelayMs(), 10);
  });
});
