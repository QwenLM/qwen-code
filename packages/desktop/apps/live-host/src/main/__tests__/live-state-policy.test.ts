import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LiveStatus } from '../../shared/protocol.ts';
import {
  canToggleLive,
  isActiveLiveCall,
  shouldCaptureLiveAudio,
} from '../live-state-policy.ts';

function status(
  state: LiveStatus['state'],
  available: boolean,
): LiveStatus {
  return { v: 1, state, available };
}

describe('Live Host state policy', () => {
  it('lets DoubleCommand stop an active call while provider readiness checks', () => {
    const reconnecting = status('starting', false);
    assert.equal(isActiveLiveCall(reconnecting), true);
    assert.equal(canToggleLive(reconnecting, true, true), true);
    assert.equal(canToggleLive(reconnecting, false, true), false);
    assert.equal(canToggleLive(reconnecting, true, false), false);
  });

  it('does not toggle an unavailable inactive call', () => {
    assert.equal(canToggleLive(status('unavailable', false), true, true), false);
    assert.equal(canToggleLive(status('idle', true), true, true), true);
  });

  it('captures only after realtime can accept input', () => {
    assert.equal(shouldCaptureLiveAudio(status('starting', true), true), false);
    assert.equal(shouldCaptureLiveAudio(status('listening', true), true), true);
    assert.equal(shouldCaptureLiveAudio(status('thinking', true), true), true);
    assert.equal(shouldCaptureLiveAudio(status('speaking', true), true), true);
    assert.equal(shouldCaptureLiveAudio(status('listening', false), true), false);
    assert.equal(shouldCaptureLiveAudio(status('listening', true), false), false);
  });
});
