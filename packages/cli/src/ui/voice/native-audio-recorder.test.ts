/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { createNativeAudioRecorder } from './native-audio-recorder.js';

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

  it('auto-stops when native silence polling fails', async () => {
    vi.useFakeTimers();
    try {
      const backend = {
        startRecording: vi.fn(),
        stopRecording: vi.fn(() => new Uint8Array([1])),
        isRecording: vi.fn(() => true),
        silenceDetected: vi.fn(() => {
          throw new Error('silence poll failed');
        }),
        microphoneAuthorizationStatus: vi.fn(() => 'unknown' as const),
      };
      const onAutoStop = vi.fn();
      const recorder = createNativeAudioRecorder({
        loadBackend: () => backend,
      });

      await recorder.start({ silenceDetection: true, onAutoStop });
      await vi.advanceTimersByTimeAsync(200);

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

  it('rejects concurrent starts while the backend is loading', async () => {
    const backend = {
      startRecording: vi.fn(),
      stopRecording: vi.fn(() => new Uint8Array([1])),
      isRecording: vi.fn(() => true),
      microphoneAuthorizationStatus: vi.fn(() => 'unknown' as const),
    };
    type Backend = typeof backend;
    let resolveBackend: (backend: Backend) => void = () => {};
    const loadBackend = vi.fn(
      () =>
        new Promise<Backend>((resolve) => {
          resolveBackend = resolve;
        }),
    );
    const recorder = createNativeAudioRecorder({ loadBackend });

    const firstStart = recorder.start();
    await expect(recorder.start()).rejects.toThrow(/already recording/);
    resolveBackend(backend);
    await firstStart;

    expect(loadBackend).toHaveBeenCalledTimes(1);
    expect(backend.startRecording).toHaveBeenCalledTimes(1);
  });

  it('allows retry after backend loading fails', async () => {
    const backend = {
      startRecording: vi.fn(),
      stopRecording: vi.fn(() => new Uint8Array([1])),
      isRecording: vi.fn(() => true),
      microphoneAuthorizationStatus: vi.fn(() => 'unknown' as const),
    };
    const loadBackend = vi
      .fn()
      .mockRejectedValueOnce(new Error('load failed'))
      .mockResolvedValueOnce(backend);
    const recorder = createNativeAudioRecorder({ loadBackend });

    await expect(recorder.start()).rejects.toThrow('load failed');
    await recorder.start();

    expect(loadBackend).toHaveBeenCalledTimes(2);
    expect(backend.startRecording).toHaveBeenCalledTimes(1);
  });

  it('explains mirror registry installs when the native package is missing', async () => {
    const recorder = createNativeAudioRecorder({
      loadBackend: () => {
        throw new Error(
          "Cannot find package '@qwen-code/audio-capture' imported from /qwen/dist/cli.js",
        );
      },
    });

    await expect(recorder.start()).rejects.toThrow(
      /mirror or private registry/,
    );
    await expect(recorder.start()).rejects.toThrow(/@qwen-code\/audio-capture/);
  });

  it.each(['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND'])(
    'explains mirror registry installs for %s native package errors',
    async (code) => {
      const error = Object.assign(
        new Error('missing @qwen-code/audio-capture dependency'),
        { code },
      );
      const recorder = createNativeAudioRecorder({
        loadBackend: () => {
          throw error;
        },
      });

      await expect(recorder.start()).rejects.toThrow(
        /mirror or private registry/,
      );
      await expect(recorder.start()).rejects.toThrow(
        /@qwen-code\/audio-capture/,
      );
    },
  );

  it('does not rewrite wrapped native addon load failures as missing packages', async () => {
    const loadError = new Error(
      "Native audio capture addon could not be loaded. Reinstall @qwen-code/audio-capture, or use the SoX fallback. (Cannot find module 'node-gyp-build')",
    );
    const recorder = createNativeAudioRecorder({
      loadBackend: () => {
        throw loadError;
      },
    });

    await expect(recorder.start()).rejects.toBe(loadError);
  });

  it('does not explain native start failures as missing packages', async () => {
    const startError = new Error(
      "Cannot find package '@qwen-code/audio-capture' while starting",
    );
    const backend = {
      startRecording: vi.fn(() => {
        throw startError;
      }),
      stopRecording: vi.fn(() => new Uint8Array([1])),
      isRecording: vi.fn(() => false),
      microphoneAuthorizationStatus: vi.fn(() => 'unknown' as const),
    };
    const recorder = createNativeAudioRecorder({
      loadBackend: () => backend,
    });

    await expect(recorder.start()).rejects.toBe(startError);

    expect(backend.startRecording).toHaveBeenCalledTimes(1);
  });

  it('allows retry after native stop throws', async () => {
    const backend = {
      startRecording: vi.fn(),
      stopRecording: vi
        .fn()
        .mockImplementationOnce(() => {
          throw new Error('Native audio capture produced empty audio.');
        })
        .mockReturnValueOnce(new Uint8Array([1])),
      isRecording: vi.fn(() => false),
      microphoneAuthorizationStatus: vi.fn(() => 'unknown' as const),
    };
    const recorder = createNativeAudioRecorder({
      loadBackend: () => backend,
    });

    await recorder.start();
    await expect(recorder.stop()).rejects.toThrow(/empty audio/);
    await recorder.start();
    await recorder.stop();

    expect(backend.startRecording).toHaveBeenCalledTimes(2);
    expect(backend.stopRecording).toHaveBeenCalledTimes(2);
  });
});
