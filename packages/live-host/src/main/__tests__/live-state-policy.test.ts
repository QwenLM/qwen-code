import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LiveStatus } from '../../shared/protocol.ts';
import {
  canToggleLive,
  isActiveLiveCall,
  projectLiveStatusForCapture,
  shouldCaptureLiveAudio,
  shouldRenderSetup,
  shouldStopLiveOnToggle,
} from '../live-state-policy.ts';

function status(state: LiveStatus['state'], available: boolean): LiveStatus {
  return { v: 1, state, available, shortcut: 'Command+Q' };
}

describe('Live Host state policy', () => {
  it('lets the registered shortcut stop an active call while readiness checks', () => {
    const starting = status('starting', false);
    assert.equal(isActiveLiveCall(starting), true);
    assert.equal(canToggleLive(starting, true, true), true);
    assert.equal(canToggleLive(starting, false, true), false);
    assert.equal(canToggleLive(starting, true, false), false);
  });

  it('does not toggle an unavailable inactive call', () => {
    assert.equal(
      canToggleLive(status('unavailable', false), true, true),
      false,
    );
    assert.equal(canToggleLive(status('idle', true), true, true), true);
  });

  it('keeps the voice surface visible while an active call starts', () => {
    assert.equal(shouldRenderSetup(status('starting', false), true), false);
    assert.equal(shouldRenderSetup(status('listening', true), true), false);
    assert.equal(shouldRenderSetup(status('unavailable', false), true), true);
    assert.equal(shouldRenderSetup(status('starting', false), false), true);
  });

  it('captures only after realtime can accept input', () => {
    assert.equal(shouldCaptureLiveAudio(status('starting', true), true), false);
    assert.equal(shouldCaptureLiveAudio(status('listening', true), true), true);
    assert.equal(shouldCaptureLiveAudio(status('thinking', true), true), true);
    assert.equal(shouldCaptureLiveAudio(status('speaking', true), true), true);
    assert.equal(
      shouldCaptureLiveAudio(status('listening', false), true),
      false,
    );
    assert.equal(
      shouldCaptureLiveAudio(status('listening', true), false),
      false,
    );
  });

  it('keeps the surface loading until microphone capture is ready', () => {
    const listening = {
      ...status('listening', true),
      statusText: 'Listening',
    };
    assert.deepEqual(projectLiveStatusForCapture(listening, false), {
      ...listening,
      state: 'starting',
      statusText: undefined,
    });
    assert.equal(projectLiveStatusForCapture(listening, true), listening);
  });

  it('treats a second shortcut press as stop while start is pending', () => {
    assert.equal(shouldStopLiveOnToggle(status('idle', true), true), true);
    assert.equal(
      shouldStopLiveOnToggle(status('listening', true), false),
      true,
    );
    assert.equal(shouldStopLiveOnToggle(status('idle', true), false), false);
  });
});
