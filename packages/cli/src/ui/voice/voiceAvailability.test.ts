/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { getVoiceUnavailableReason } from './voiceAvailability.js';

describe('getVoiceUnavailableReason', () => {
  it('is available on supported desktop platforms', () => {
    expect(
      getVoiceUnavailableReason({ platform: 'darwin', env: {} }),
    ).toBeUndefined();
    expect(
      getVoiceUnavailableReason({ platform: 'linux', env: {} }),
    ).toBeUndefined();
    expect(
      getVoiceUnavailableReason({ platform: 'win32', env: {} }),
    ).toBeUndefined();
  });

  it('flags unsupported platforms', () => {
    expect(
      getVoiceUnavailableReason({
        platform: 'aix' as NodeJS.Platform,
        env: {},
      }),
    ).toMatch(/not supported/);
  });

  it('flags WSL without PulseAudio', () => {
    expect(
      getVoiceUnavailableReason({
        platform: 'linux',
        env: { WSL_DISTRO_NAME: 'Ubuntu' },
      }),
    ).toMatch(/WSL/);
  });

  it('allows WSL when PulseAudio is configured', () => {
    expect(
      getVoiceUnavailableReason({
        platform: 'linux',
        env: {
          WSL_DISTRO_NAME: 'Ubuntu',
          PULSE_SERVER: '/mnt/wslg/PulseServer',
        },
      }),
    ).toBeUndefined();
  });
});
