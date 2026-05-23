/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import * as core from '@qwen-code/qwen-code-core';
import { useAwaySummary } from './useAwaySummary.js';
import type { HistoryItem } from '../types.js';

vi.mock('@qwen-code/qwen-code-core', async () => {
  const actual = await vi.importActual<
    typeof import('@qwen-code/qwen-code-core')
  >('@qwen-code/qwen-code-core');
  return {
    ...actual,
    generateSessionRecap: vi.fn(),
  };
});

const generateSessionRecapMock = vi.mocked(core.generateSessionRecap);

function makeConfig(recordSlashCommand = vi.fn()) {
  return {
    getChatRecordingService: vi.fn().mockReturnValue({
      recordSlashCommand,
    }),
  } as unknown as core.Config;
}

function userMsg(text: string): HistoryItem {
  return { id: Math.random(), type: 'user', text };
}

const THREE_USER_HISTORY: HistoryItem[] = [
  userMsg('one'),
  userMsg('two'),
  userMsg('three'),
];

beforeEach(() => {
  vi.useFakeTimers();
  generateSessionRecapMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useAwaySummary', () => {
  it('records the auto-fired recap to chatRecordingService so it survives /resume', async () => {
    const recordSlashCommand = vi.fn();
    const config = makeConfig(recordSlashCommand);
    const addItem = vi.fn();
    generateSessionRecapMock.mockResolvedValue({
      text: 'recap text',
      modelUsed: 'fast',
    });

    // Mount blurred to set the away-start timestamp.
    const { rerender } = renderHook(
      ({ isFocused }: { isFocused: boolean }) =>
        useAwaySummary({
          enabled: true,
          config,
          isFocused,
          isIdle: true,
          addItem,
          history: THREE_USER_HISTORY,
          awayThresholdMinutes: 0.1, // 6 s
        }),
      { initialProps: { isFocused: false } },
    );

    // Advance past the threshold while still blurred.
    vi.advanceTimersByTime(7000);

    // Focus comes back — should kick off the LLM call.
    rerender({ isFocused: true });

    // Drain the resolved promise + microtasks.
    await vi.waitFor(() => {
      expect(addItem).toHaveBeenCalledTimes(1);
    });

    expect(addItem).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'away_recap', text: 'recap text' }),
      expect.any(Number),
    );
    expect(recordSlashCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: 'result',
        rawCommand: '/recap',
        outputHistoryItems: [
          expect.objectContaining({ type: 'away_recap', text: 'recap text' }),
        ],
      }),
    );
  });

  it('skips the recap when shouldFireRecap returns false (no new user turns since last recap)', async () => {
    const recordSlashCommand = vi.fn();
    const config = makeConfig(recordSlashCommand);
    const addItem = vi.fn();
    generateSessionRecapMock.mockResolvedValue({
      text: 'should not appear',
      modelUsed: 'fast',
    });

    const historyWithRecentRecap: HistoryItem[] = [
      ...THREE_USER_HISTORY,
      { id: 999, type: 'away_recap', text: 'previous recap' },
      // Fewer than 2 user messages since the recap → gated.
      userMsg('only one new turn'),
    ];

    const { rerender } = renderHook(
      ({ isFocused }: { isFocused: boolean }) =>
        useAwaySummary({
          enabled: true,
          config,
          isFocused,
          isIdle: true,
          addItem,
          history: historyWithRecentRecap,
          awayThresholdMinutes: 0.1,
        }),
      { initialProps: { isFocused: false } },
    );

    vi.advanceTimersByTime(7000);
    rerender({ isFocused: true });

    // Give any pending microtasks a chance to flush — they shouldn't.
    await Promise.resolve();
    await Promise.resolve();

    expect(generateSessionRecapMock).not.toHaveBeenCalled();
    expect(addItem).not.toHaveBeenCalled();
    expect(recordSlashCommand).not.toHaveBeenCalled();
  });
});
