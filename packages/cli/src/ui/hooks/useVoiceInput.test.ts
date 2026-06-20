/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { useVoiceInput } from './useVoiceInput.js';
import type { Key } from './useKeypress.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const voiceKey: Key = {
  name: 'space',
  sequence: ' ',
  ctrl: false,
  meta: false,
  shift: false,
  paste: false,
};

function createBuffer(text = '') {
  const testBuffer = {
    text,
    insert: vi.fn((value: string) => {
      testBuffer.text += value;
    }),
  };
  return testBuffer;
}

let buffer = createBuffer();

describe('useVoiceInput', () => {
  it('warms up the backend when voice is enabled', () => {
    buffer = createBuffer();
    const warmup = vi.fn();
    renderHook(() =>
      useVoiceInput({
        enabled: true,
        voiceModel: 'qwen3-asr-flash',
        buffer,
        createRecorder: vi.fn(),
        transcribe: vi.fn(),
        warmup,
      }),
    );
    expect(warmup).toHaveBeenCalled();
  });

  it('does not warm up the backend when voice is disabled', () => {
    buffer = createBuffer();
    const warmup = vi.fn();
    renderHook(() =>
      useVoiceInput({
        enabled: false,
        voiceModel: 'qwen3-asr-flash',
        buffer,
        createRecorder: vi.fn(),
        transcribe: vi.fn(),
        warmup,
      }),
    );
    expect(warmup).not.toHaveBeenCalled();
  });

  it('does not intercept Space when voice input is disabled', () => {
    buffer = createBuffer();
    const { result } = renderHook(() =>
      useVoiceInput({
        enabled: false,
        voiceModel: 'qwen3-asr-flash',
        buffer,
        createRecorder: vi.fn(),
        transcribe: vi.fn(),
      }),
    );

    expect(result.current.handleKeypress(voiceKey)).toBe(false);
  });

  it('tap mode: records on first Space, transcribes and submits on second', async () => {
    buffer = createBuffer('explain');
    const stop = vi.fn().mockResolvedValue({
      data: new Uint8Array([1, 2, 3]),
      mimeType: 'audio/wav',
    });
    const recorder = { start: vi.fn().mockResolvedValue(undefined), stop };
    const createRecorder = vi.fn(() => recorder);
    const transcribe = vi.fn().mockResolvedValue('the diff');
    const onSubmit = vi.fn();

    const { result } = renderHook(() =>
      useVoiceInput({
        enabled: true,
        mode: 'tap',
        voiceModel: 'qwen3-asr-flash',
        buffer,
        createRecorder,
        transcribe,
        onSubmit,
      }),
    );

    await act(async () => {
      expect(result.current.handleKeypress(voiceKey)).toBe(true);
    });

    expect(createRecorder).toHaveBeenCalledTimes(1);
    // Tap mode arms silence auto-stop.
    expect(recorder.start).toHaveBeenCalledWith({
      silenceDetection: true,
      onAutoStop: expect.any(Function),
    });
    expect(result.current.status).toBe('recording');

    await act(async () => {
      expect(result.current.handleKeypress(voiceKey)).toBe(true);
    });

    await waitFor(() => {
      expect(transcribe).toHaveBeenCalledWith(
        {
          data: new Uint8Array([1, 2, 3]),
          mimeType: 'audio/wav',
        },
        { voiceModel: 'qwen3-asr-flash' },
      );
      expect(buffer.insert).toHaveBeenCalledWith(' the diff');
      expect(onSubmit).toHaveBeenCalledTimes(1);
      expect(result.current.status).toBe('idle');
    });
  });

  it('hold mode: starts the recorder without silence detection', async () => {
    buffer = createBuffer();
    const recorder = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue({
        data: new Uint8Array([1]),
        mimeType: 'audio/wav',
      }),
    };

    const { result } = renderHook(() =>
      useVoiceInput({
        enabled: true,
        mode: 'hold',
        voiceModel: 'qwen3-asr-flash',
        buffer,
        createRecorder: () => recorder,
        transcribe: vi.fn().mockResolvedValue('hold text'),
        onSubmit: vi.fn(),
      }),
    );

    await act(async () => {
      result.current.handleKeypress(voiceKey);
    });

    // Hold mode never arms silence auto-stop; release is driven by key repeats.
    expect(recorder.start).toHaveBeenCalledWith({
      silenceDetection: false,
      onAutoStop: expect.any(Function),
    });
    expect(result.current.status).toBe('recording');
  });

  it('surfaces recorder errors without inserting text', async () => {
    buffer = createBuffer();
    const addItem = vi.fn();
    const recorder = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockRejectedValue(new Error('microphone denied')),
    };

    const { result } = renderHook(() =>
      useVoiceInput({
        enabled: true,
        mode: 'tap',
        voiceModel: 'qwen3-asr-flash',
        buffer,
        addItem,
        createRecorder: () => recorder,
        transcribe: vi.fn(),
      }),
    );

    await act(async () => {
      result.current.handleKeypress(voiceKey);
      result.current.handleKeypress(voiceKey);
    });

    await waitFor(() => {
      expect(addItem).toHaveBeenCalledWith(
        {
          type: 'error',
          text: 'Voice transcription failed: microphone denied',
        },
        expect.any(Number),
      );
      expect(buffer.insert).not.toHaveBeenCalled();
      expect(result.current.status).toBe('idle');
    });
  });

  it('does not restart recording during the start error cooldown', async () => {
    buffer = createBuffer();
    const addItem = vi.fn();
    const createRecorder = vi.fn(() => ({
      start: vi.fn().mockRejectedValue(new Error('missing recorder')),
      stop: vi.fn(),
    }));
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);

    try {
      const { result } = renderHook(() =>
        useVoiceInput({
          enabled: true,
          voiceModel: 'qwen3-asr-flash',
          buffer,
          addItem,
          createRecorder,
          transcribe: vi.fn(),
        }),
      );

      await act(async () => {
        expect(result.current.handleKeypress(voiceKey)).toBe(true);
      });

      await waitFor(() => {
        expect(addItem).toHaveBeenCalledTimes(1);
      });
      expect(createRecorder).toHaveBeenCalledTimes(1);

      now.mockReturnValue(1500);
      act(() => {
        expect(result.current.handleKeypress(voiceKey)).toBe(true);
      });
      expect(createRecorder).toHaveBeenCalledTimes(1);

      now.mockReturnValue(3100);
      act(() => {
        expect(result.current.handleKeypress(voiceKey)).toBe(true);
      });
      expect(createRecorder).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
    }
  });

  it('waits for recorder startup before stopping on a quick second Space', async () => {
    buffer = createBuffer();
    const start = deferred<void>();
    const stop = vi.fn().mockResolvedValue({
      data: new Uint8Array([1, 2, 3]),
      mimeType: 'audio/wav',
    });
    const recorder = { start: vi.fn(() => start.promise), stop };
    const transcribe = vi.fn().mockResolvedValue('hello');

    const { result } = renderHook(() =>
      useVoiceInput({
        enabled: true,
        mode: 'tap',
        voiceModel: 'qwen3-asr-flash',
        buffer,
        createRecorder: () => recorder,
        transcribe,
      }),
    );

    act(() => {
      result.current.handleKeypress(voiceKey);
      result.current.handleKeypress(voiceKey);
    });

    expect(stop).not.toHaveBeenCalled();

    await act(async () => {
      start.resolve();
      await start.promise;
    });

    await waitFor(() => {
      expect(stop).toHaveBeenCalledTimes(1);
      expect(transcribe).toHaveBeenCalled();
      expect(result.current.status).toBe('idle');
    });
  });

  it('stops an active recorder when unmounted without transcribing', async () => {
    buffer = createBuffer();
    const stop = vi.fn().mockResolvedValue({
      data: new Uint8Array([1, 2, 3]),
      mimeType: 'audio/wav',
    });
    const recorder = { start: vi.fn().mockResolvedValue(undefined), stop };
    const transcribe = vi.fn();

    const { result, unmount } = renderHook(() =>
      useVoiceInput({
        enabled: true,
        voiceModel: 'qwen3-asr-flash',
        buffer,
        createRecorder: () => recorder,
        transcribe,
      }),
    );

    act(() => {
      result.current.handleKeypress(voiceKey);
    });

    unmount();

    await waitFor(() => {
      expect(stop).toHaveBeenCalledTimes(1);
    });
    expect(transcribe).not.toHaveBeenCalled();
  });

  it('treats an empty-audio capture as a silent no-op (no error item)', async () => {
    buffer = createBuffer();
    const addItem = vi.fn();
    const recorder = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi
        .fn()
        .mockRejectedValue(
          new Error('Native audio capture produced empty audio.'),
        ),
    };

    const { result } = renderHook(() =>
      useVoiceInput({
        enabled: true,
        mode: 'tap',
        voiceModel: 'qwen3-asr-flash',
        buffer,
        addItem,
        createRecorder: () => recorder,
        transcribe: vi.fn(),
      }),
    );

    await act(async () => {
      result.current.handleKeypress(voiceKey);
      result.current.handleKeypress(voiceKey);
    });

    await waitFor(() => {
      expect(result.current.status).toBe('idle');
    });
    expect(addItem).not.toHaveBeenCalled();
    expect(buffer.insert).not.toHaveBeenCalled();
  });
});
