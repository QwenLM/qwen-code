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
    const opened = session();
    const open = vi
      .fn<() => Promise<VoiceStreamSession>>()
      .mockRejectedValueOnce(new Error('early connect failed'))
      .mockResolvedValueOnce(opened);

    await expect(openVoiceStreamWithRetry(open)).resolves.toBe(opened);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('throws the second open error after the retry is exhausted', async () => {
    const second = new Error('still failing');
    const open = vi
      .fn<() => Promise<VoiceStreamSession>>()
      .mockRejectedValueOnce(new Error('first failure'))
      .mockRejectedValueOnce(second);

    await expect(openVoiceStreamWithRetry(open)).rejects.toBe(second);
    expect(open).toHaveBeenCalledTimes(2);
  });
});
