/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Mock audioCapture module
vi.mock('../../services/audioCapture.js', () => ({
  detectBackend: vi.fn().mockReturnValue('sox'),
  startRecording: vi.fn().mockResolvedValue({ kill: vi.fn(), once: vi.fn() }),
  stopRecording: vi.fn().mockResolvedValue(undefined),
}));

// Mock sttClient module
vi.mock('../../services/sttClient.js', () => ({
  transcribe: vi.fn().mockResolvedValue('hello from voice'),
}));

// Mock fs.unlink
vi.mock('node:fs', () => ({
  default: {
    unlink: vi.fn((_path: string, cb: () => void) => cb()),
  },
}));

const { useVoice } = await import('./useVoice.js');
const { startRecording, stopRecording } = await import(
  '../../services/audioCapture.js'
);
const { transcribe } = await import('../../services/sttClient.js');

const mockStartRecording = vi.mocked(startRecording);
const mockStopRecording = vi.mocked(stopRecording);
const mockTranscribe = vi.mocked(transcribe);

beforeEach(() => {
  vi.clearAllMocks();
  mockStartRecording.mockResolvedValue({
    kill: vi.fn(),
    once: vi.fn(),
  } as unknown as Awaited<ReturnType<typeof startRecording>>);
  mockStopRecording.mockResolvedValue(undefined);
  mockTranscribe.mockResolvedValue('hello from voice');
});

const STT_ENDPOINT = 'http://localhost:8000/v1/audio/transcriptions';

describe('useVoice', () => {
  it('starts in idle state', () => {
    const { result } = renderHook(() => useVoice(STT_ENDPOINT));
    expect(result.current.voiceState).toBe('idle');
    expect(result.current.error).toBeNull();
    expect(result.current.backendAvailable).toBe(true);
  });

  it('transitions to recording when start() is called', async () => {
    const { result } = renderHook(() => useVoice(STT_ENDPOINT));

    await act(async () => {
      await result.current.start();
    });

    expect(result.current.voiceState).toBe('recording');
    expect(mockStartRecording).toHaveBeenCalledOnce();
  });

  it('transitions through transcribing to idle and returns transcript', async () => {
    const { result } = renderHook(() => useVoice(STT_ENDPOINT));

    await act(async () => {
      await result.current.start();
    });

    let transcript = '';
    await act(async () => {
      transcript = await result.current.stop();
    });

    expect(mockStopRecording).toHaveBeenCalledOnce();
    expect(mockTranscribe).toHaveBeenCalledWith(
      expect.stringContaining('proto-voice-'),
      STT_ENDPOINT,
    );
    expect(transcript).toBe('hello from voice');
    expect(result.current.voiceState).toBe('idle');
  });

  it('sets error state when startRecording fails', async () => {
    mockStartRecording.mockRejectedValueOnce(
      new Error('No audio capture backend available'),
    );

    const { result } = renderHook(() => useVoice(STT_ENDPOINT));

    await act(async () => {
      await result.current.start();
    });

    expect(result.current.voiceState).toBe('error');
    expect(result.current.error).toBe('No audio capture backend available');
  });

  it('sets error state when transcription fails', async () => {
    mockTranscribe.mockRejectedValueOnce(
      new Error('STT endpoint returned 500'),
    );

    const { result } = renderHook(() => useVoice(STT_ENDPOINT));

    await act(async () => {
      await result.current.start();
    });
    await act(async () => {
      await result.current.stop();
    });

    expect(result.current.voiceState).toBe('error');
    expect(result.current.error).toBe('STT endpoint returned 500');
  });

  it('reset() clears error and returns to idle', async () => {
    mockStartRecording.mockRejectedValueOnce(new Error('fail'));

    const { result } = renderHook(() => useVoice(STT_ENDPOINT));

    await act(async () => {
      await result.current.start();
    });
    expect(result.current.voiceState).toBe('error');

    act(() => {
      result.current.reset();
    });

    expect(result.current.voiceState).toBe('idle');
    expect(result.current.error).toBeNull();
  });

  it('stop() is a no-op when not recording', async () => {
    const { result } = renderHook(() => useVoice(STT_ENDPOINT));

    let transcript = '';
    await act(async () => {
      transcript = await result.current.stop();
    });

    expect(transcript).toBe('');
    expect(mockStopRecording).not.toHaveBeenCalled();
  });
});
