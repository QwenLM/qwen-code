/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { openVoiceStreamWithRetry } from './voiceStreamRetry.js';
import type { VoiceStreamSession } from './voiceStreamSession.js';

function session(): VoiceStreamSession {
  return {
    pushAudio: vi.fn(),
    finish: vi.fn().mockResolvedValue('ok'),
    abort: vi.fn(),
  };
}

describe('openVoiceStreamWithRetry', () => {
  it('retries once when opening the realtime stream fails before use', async () => {
    vi.useFakeTimers();
    try {
      const opened = session();
      const open = vi
        .fn<() => Promise<VoiceStreamSession>>()
        .mockRejectedValueOnce(new Error('early connect failed'))
        .mockResolvedValueOnce(opened);

      const result = openVoiceStreamWithRetry(open);
      const assertion = await expect(result).resolves.toBe(opened);
      await vi.advanceTimersByTimeAsync(200);

      await assertion;
      expect(open).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('throws the second open error after the retry is exhausted', async () => {
    vi.useFakeTimers();
    try {
      const second = new Error('still failing');
      const open = vi
        .fn<() => Promise<VoiceStreamSession>>()
        .mockRejectedValueOnce(new Error('first failure'))
        .mockRejectedValueOnce(second);

      const result = openVoiceStreamWithRetry(open);
      const assertion = await expect(result).rejects.toBe(second);
      await vi.advanceTimersByTimeAsync(200);

      await assertion;
      expect(open).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not retry non-retryable request errors', async () => {
    const error = new Error('401 Unauthorized');
    const open = vi
      .fn<() => Promise<VoiceStreamSession>>()
      .mockRejectedValueOnce(error);

    await expect(openVoiceStreamWithRetry(open)).rejects.toBe(error);
    expect(open).toHaveBeenCalledTimes(1);
  });
});
