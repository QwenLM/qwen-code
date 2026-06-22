/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { VoiceRecorder } from '../hooks/use-voice-input.js';
import { createVoiceRecorder } from './voice-recorder.js';

const debugLogger = vi.hoisted(() => ({
  warn: vi.fn(),
}));

vi.mock('@qwen-code/qwen-code-core', () => ({
  createDebugLogger: () => debugLogger,
}));

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
      platform: 'darwin',
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
      platform: 'darwin',
    });

    await voiceRecorder.start();
    await voiceRecorder.stop();

    expect(nativeRecorder.start).toHaveBeenCalledTimes(1);
    expect(nativeRecorder.stop).not.toHaveBeenCalled();
    expect(soxRecorder.start).toHaveBeenCalledTimes(1);
    expect(soxRecorder.stop).toHaveBeenCalledTimes(1);
  });

  it('prefers sox before arecord on Linux so tap mode can auto-stop on silence', async () => {
    const nativeRecorder = recorder({
      start: vi.fn().mockRejectedValue(new Error('native unavailable')),
    });
    const arecordRecorder = recorder();
    const soxRecorder = recorder();

    const voiceRecorder = createVoiceRecorder({
      createNativeRecorder: vi.fn(() => nativeRecorder),
      createArecordRecorder: vi.fn(() => arecordRecorder),
      createSoxRecorder: vi.fn(() => soxRecorder),
      platform: 'linux',
    });

    await voiceRecorder.start({ silenceDetection: true });
    await voiceRecorder.stop();

    expect(soxRecorder.start).toHaveBeenCalledWith({
      silenceDetection: true,
    });
    expect(soxRecorder.stop).toHaveBeenCalledTimes(1);
    expect(arecordRecorder.start).not.toHaveBeenCalled();
  });

  it('reports streaming support from the active native recorder', async () => {
    const nativeRecorder = recorder({
      supportsStreaming: vi.fn(() => true),
    });

    const voiceRecorder = createVoiceRecorder({
      createNativeRecorder: vi.fn(() => nativeRecorder),
      createSoxRecorder: vi.fn(() => recorder()),
      platform: 'darwin',
    });

    await voiceRecorder.start();

    expect(voiceRecorder.supportsStreaming?.()).toBe(true);
  });

  it('reports no streaming support after falling back to shell recording', async () => {
    const nativeRecorder = recorder({
      start: vi.fn().mockRejectedValue(new Error('native unavailable')),
    });
    const soxRecorder = recorder({
      drain: vi.fn(() => new Uint8Array(0)),
    });

    const voiceRecorder = createVoiceRecorder({
      createNativeRecorder: vi.fn(() => nativeRecorder),
      createSoxRecorder: vi.fn(() => soxRecorder),
      platform: 'darwin',
    });

    await voiceRecorder.start();

    expect(voiceRecorder.supportsStreaming?.()).toBe(false);
  });

  it('reuses backend instances across warmup, status, and start', async () => {
    const nativeRecorder = recorder({
      warmup: vi.fn().mockResolvedValue(undefined),
      microphoneStatus: vi.fn().mockResolvedValue('granted'),
    });
    const createNativeRecorder = vi.fn(() => nativeRecorder);

    const voiceRecorder = createVoiceRecorder({
      createNativeRecorder,
      createSoxRecorder: vi.fn(() => recorder()),
      platform: 'darwin',
    });

    await voiceRecorder.warmup?.();
    await expect(voiceRecorder.microphoneStatus?.()).resolves.toBe('granted');
    await voiceRecorder.start();

    expect(createNativeRecorder).toHaveBeenCalledTimes(1);
    expect(nativeRecorder.warmup).toHaveBeenCalledTimes(1);
    expect(nativeRecorder.microphoneStatus).toHaveBeenCalledTimes(1);
    expect(nativeRecorder.start).toHaveBeenCalledTimes(1);
  });

  it('logs warmup failures and still lets start fall back', async () => {
    const nativeRecorder = recorder({
      warmup: vi.fn().mockRejectedValue(new Error('native load failed')),
      start: vi.fn().mockRejectedValue(new Error('native unavailable')),
    });
    const soxRecorder = recorder();

    const voiceRecorder = createVoiceRecorder({
      createNativeRecorder: vi.fn(() => nativeRecorder),
      createSoxRecorder: vi.fn(() => soxRecorder),
      platform: 'darwin',
    });

    await voiceRecorder.warmup?.();
    await voiceRecorder.start();

    expect(debugLogger.warn).toHaveBeenCalledWith(
      '[voice] recorder warmup failed:',
      new Error('native load failed'),
    );
    expect(soxRecorder.start).toHaveBeenCalledTimes(1);
  });
});
