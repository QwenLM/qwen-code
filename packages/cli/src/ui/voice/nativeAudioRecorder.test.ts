/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { createNativeAudioRecorder } from './nativeAudioRecorder.js';

describe('createNativeAudioRecorder', () => {
  it('records mono 16k audio through the native capture backend', async () => {
    const backend = {
      startRecording: vi.fn(),
      stopRecording: vi.fn(() => new Uint8Array([1, 2, 3])),
      isRecording: vi.fn(() => false),
      microphoneAuthorizationStatus: vi.fn(() => 'unknown' as const),
    };

    const recorder = createNativeAudioRecorder({
      loadBackend: () => backend,
    });

    await recorder.start();
    const audio = await recorder.stop();

    expect(backend.startRecording).toHaveBeenCalledWith({
      sampleRate: 16000,
      channels: 1,
      silenceDetection: false,
    });
    expect(backend.stopRecording).toHaveBeenCalledTimes(1);
    expect(audio).toEqual({
      data: new Uint8Array([1, 2, 3]),
      mimeType: 'audio/wav',
    });
  });

  it('polls the silence flag and auto-stops when silence is detected', async () => {
    vi.useFakeTimers();
    try {
      let silent = false;
      const backend = {
        startRecording: vi.fn(),
        stopRecording: vi.fn(() => new Uint8Array([1])),
        isRecording: vi.fn(() => true),
        silenceDetected: vi.fn(() => silent),
        microphoneAuthorizationStatus: vi.fn(() => 'unknown' as const),
      };
      const onAutoStop = vi.fn();
      const recorder = createNativeAudioRecorder({
        loadBackend: () => backend,
      });

      await recorder.start({ silenceDetection: true, onAutoStop });
      expect(backend.startRecording).toHaveBeenCalledWith({
        sampleRate: 16000,
        channels: 1,
        silenceDetection: true,
      });

      await vi.advanceTimersByTimeAsync(400);
      expect(onAutoStop).not.toHaveBeenCalled();

      silent = true;
      await vi.advanceTimersByTimeAsync(400);
      expect(onAutoStop).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a second start while already recording', async () => {
    const backend = {
      startRecording: vi.fn(),
      stopRecording: vi.fn(() => new Uint8Array([1])),
      isRecording: vi.fn(() => true),
      microphoneAuthorizationStatus: vi.fn(() => 'unknown' as const),
    };
    const recorder = createNativeAudioRecorder({
      loadBackend: () => backend,
    });

    await recorder.start();
    await expect(recorder.start()).rejects.toThrow(/already recording/);

    expect(backend.startRecording).toHaveBeenCalledTimes(1);
  });
});
