import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  shouldActivateNativeServices,
  shouldDeactivateNativeServices,
} from '../native-service-policy.ts';

describe('Live Host native service lifecycle', () => {
  it('starts only after an enabled daemon completes the welcome', () => {
    assert.equal(shouldActivateNativeServices('disconnected'), false);
    assert.equal(shouldActivateNativeServices('connecting'), false);
    assert.equal(shouldActivateNativeServices('ready'), true);
  });

  it('stops on a real disconnect but survives an intentional reconnect', () => {
    assert.equal(shouldDeactivateNativeServices('connecting'), false);
    assert.equal(shouldDeactivateNativeServices('disconnected'), true);
    assert.equal(shouldDeactivateNativeServices('incompatible'), true);
    assert.equal(shouldDeactivateNativeServices('error'), true);
  });
});
