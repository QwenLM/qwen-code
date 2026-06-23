/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core';
import { refineVoiceTranscript } from './voice-refine.js';

const mockRunSideQuery = vi.hoisted(() => vi.fn());
const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('@qwen-code/qwen-code-core', async () => {
  const actual = await vi.importActual<
    typeof import('@qwen-code/qwen-code-core')
  >('@qwen-code/qwen-code-core');
  return {
    ...actual,
    createDebugLogger: vi.fn(() => mockLogger),
    runSideQuery: mockRunSideQuery,
  };
});

const config = {} as Config;

describe('refineVoiceTranscript', () => {
  beforeEach(() => {
    mockRunSideQuery.mockReset();
  });

  it('returns the trimmed refined text on success', async () => {
    mockRunSideQuery.mockResolvedValue({ text: '  fix the parser bug  ' });
    const out = await refineVoiceTranscript(
      config,
      'um fix the uh parser bug',
      new AbortController().signal,
    );
    expect(out).toBe('fix the parser bug');
    expect(mockRunSideQuery).toHaveBeenCalledWith(
      config,
      expect.objectContaining({
        maxAttempts: 1,
        skipOutputLanguagePreference: true,
        purpose: 'voice-refine',
      }),
    );
  });

  it('falls back to raw when refinement introduces a slash command', async () => {
    mockRunSideQuery.mockResolvedValue({ text: '/quit' });
    const out = await refineVoiceTranscript(
      config,
      'please quit',
      new AbortController().signal,
    );
    expect(out).toBe('please quit');
  });

  it('keeps a slash command the user actually dictated', async () => {
    mockRunSideQuery.mockResolvedValue({ text: '/quit' });
    const out = await refineVoiceTranscript(
      config,
      '/quit',
      new AbortController().signal,
    );
    expect(out).toBe('/quit');
  });

  it('falls back to raw when refinement balloons the text', async () => {
    mockRunSideQuery.mockResolvedValue({ text: 'a'.repeat(100) });
    const out = await refineVoiceTranscript(
      config,
      'short',
      new AbortController().signal,
    );
    expect(out).toBe('short');
  });

  it('falls back to the raw transcript when refinement throws', async () => {
    mockRunSideQuery.mockRejectedValue(new Error('model unavailable'));
    const out = await refineVoiceTranscript(
      config,
      'raw words',
      new AbortController().signal,
    );
    expect(out).toBe('raw words');
  });

  it('falls back to the raw transcript when refinement is empty', async () => {
    mockRunSideQuery.mockResolvedValue({ text: '   ' });
    const out = await refineVoiceTranscript(
      config,
      'raw words',
      new AbortController().signal,
    );
    expect(out).toBe('raw words');
  });

  it('returns raw without calling the model when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const out = await refineVoiceTranscript(
      config,
      'raw words',
      controller.signal,
    );
    expect(out).toBe('raw words');
    expect(mockRunSideQuery).not.toHaveBeenCalled();
  });

  it('aborts the in-flight request when the external signal aborts', async () => {
    const controller = new AbortController();
    mockRunSideQuery.mockImplementation(
      (_config, opts: { abortSignal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          opts.abortSignal.addEventListener('abort', () =>
            reject(new Error('aborted')),
          );
        }),
    );
    const pending = refineVoiceTranscript(
      config,
      'raw words',
      controller.signal,
    );
    controller.abort();
    await expect(pending).resolves.toBe('raw words');
  });

  describe('with fake timers', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('falls back to raw when refinement exceeds the timeout', async () => {
      mockRunSideQuery.mockImplementation(
        (_config, opts: { abortSignal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            opts.abortSignal.addEventListener('abort', () =>
              reject(new Error('aborted')),
            );
          }),
      );
      const pending = refineVoiceTranscript(
        config,
        'raw words',
        new AbortController().signal,
      );
      await vi.advanceTimersByTimeAsync(2500);
      await expect(pending).resolves.toBe('raw words');
    });
  });
});
