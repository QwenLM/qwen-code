import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  audioInputConstraints,
  hasAudioInputDevice,
  isUnavailableDevicePreference,
  shouldRecheckAudioInput,
} from '../../preload/audio-input-policy.ts';

describe('Live Host audio input policy', () => {
  it('matches Codex microphone constraints and exact device preference', () => {
    assert.deepEqual(audioInputConstraints(), {
      channelCount: 1,
      noiseSuppression: true,
    });
    assert.deepEqual(audioInputConstraints('bluetooth-mic'), {
      channelCount: 1,
      noiseSuppression: true,
      deviceId: { exact: 'bluetooth-mic' },
    });
  });

  it('falls back only when a preferred device is unavailable', () => {
    assert.equal(
      isUnavailableDevicePreference(
        new DOMException('missing', 'NotFoundError'),
      ),
      true,
    );
    assert.equal(
      isUnavailableDevicePreference(
        new DOMException('constraint', 'OverconstrainedError'),
      ),
      true,
    );
    assert.equal(
      isUnavailableDevicePreference(
        new DOMException('denied', 'NotAllowedError'),
      ),
      false,
    );
  });

  it('does not recycle an active capture for a Bluetooth profile change', () => {
    assert.equal(shouldRecheckAudioInput(true), false);
    assert.equal(shouldRecheckAudioInput(false), true);
  });

  it('checks input availability without opening a microphone stream', () => {
    assert.equal(hasAudioInputDevice([{ kind: 'audiooutput' }]), false);
    assert.equal(
      hasAudioInputDevice([{ kind: 'audiooutput' }, { kind: 'audioinput' }]),
      true,
    );
  });
});
