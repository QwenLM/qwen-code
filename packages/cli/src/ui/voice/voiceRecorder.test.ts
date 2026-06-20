/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { VoiceRecorder } from '../hooks/useVoiceInput.js';
import { createVoiceRecorder } from './voiceRecorder.js';

function recorder(overrides: Partial<VoiceRecorder> = {}): VoiceRecorder {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue({
      data: new Uint8Array([1, 2, 3]),
      mimeType: 'audio/wav',
    }),
    ...overrides,
  };
}

describe('createVoiceRecorder', () => {
  it('uses native audio capture before shell fallbacks', async () => {
    const nativeRecorder = recorder();
    const soxRecorder = recorder();

    const voiceRecorder = createVoiceRecorder({
      createNativeRecorder: vi.fn(() => nativeRecorder),
      createSoxRecorder: vi.fn(() => soxRecorder),
    });

    await voiceRecorder.start();
    const audio = await voiceRecorder.stop();

    expect(nativeRecorder.start).toHaveBeenCalledTimes(1);
    expect(nativeRecorder.stop).toHaveBeenCalledTimes(1);
    expect(soxRecorder.start).not.toHaveBeenCalled();
    expect(audio).toEqual({
      data: new Uint8Array([1, 2, 3]),
      mimeType: 'audio/wav',
    });
  });

  it('falls back to sox when native audio capture is unavailable', async () => {
    const nativeRecorder = recorder({
      start: vi.fn().mockRejectedValue(new Error('native unavailable')),
    });
    const soxRecorder = recorder();

    const voiceRecorder = createVoiceRecorder({
      createNativeRecorder: vi.fn(() => nativeRecorder),
      createSoxRecorder: vi.fn(() => soxRecorder),
    });

    await voiceRecorder.start();
    await voiceRecorder.stop();

    expect(nativeRecorder.start).toHaveBeenCalledTimes(1);
    expect(nativeRecorder.stop).not.toHaveBeenCalled();
    expect(soxRecorder.start).toHaveBeenCalledTimes(1);
    expect(soxRecorder.stop).toHaveBeenCalledTimes(1);
  });
});
