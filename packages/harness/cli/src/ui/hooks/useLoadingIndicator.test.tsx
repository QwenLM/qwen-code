/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { render as renderRaw } from '../../test-utils/render.js';
import type { ReactElement } from 'react';
import { I18nServiceProvider } from '../i18n/I18nServiceContext.js';
import { createTestI18nService } from '../../test-utils/i18n.js';

async function render(tree: ReactElement, width?: number, height?: number) {
  const wrap = (element: ReactElement) => (
    <I18nServiceProvider
      service={createTestI18nService(
        (element.props as { locale?: UiLocale }).locale,
      )}
    >
      {element}
    </I18nServiceProvider>
  );
  const result = await renderRaw(wrap(tree), width, height);
  return {
    ...result,
    rerender: (next: ReactElement) => result.rerender(wrap(next)),
  };
}
import { useLoadingIndicator } from './useLoadingIndicator.js';
import { StreamingState } from '../types.js';
import { PHRASE_CHANGE_INTERVAL_MS } from './usePhraseCycler.js';
import { WITTY_LOADING_PHRASES } from '../constants/wittyPhrases.js';
import {
  getLocalizedInformativeTip,
  INFORMATIVE_TIP_CATALOG,
} from '../i18n/informativeTips.js';

const EN_INFORMATIVE_TIPS = INFORMATIVE_TIP_CATALOG.map(
  ({ id }) => getLocalizedInformativeTip('en', id) ?? '',
);
import type { RetryAttemptPayload } from '@qwen-code/core';
import type { UiLocale } from '@qwen-code/core';

describe('useLoadingIndicator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers(); // Restore real timers after each test
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    act(() => vi.runOnlyPendingTimers);
    vi.restoreAllMocks();
  });

  const renderLoadingIndicatorHook = async (
    initialStreamingState: StreamingState,
    initialRetryStatus: RetryAttemptPayload | null = null,
    initialShowTips: boolean = true,
    initialShowWit: boolean = true,
    initialErrorVerbosity: 'low' | 'full' = 'full',
    initialLocale: UiLocale = 'en',
  ) => {
    let hookResult: ReturnType<typeof useLoadingIndicator>;
    function TestComponent({
      streamingState,
      retryStatus,
      showTips,
      showWit,
      errorVerbosity,
      locale,
    }: {
      streamingState: StreamingState;
      retryStatus?: RetryAttemptPayload | null;
      showTips?: boolean;
      showWit?: boolean;
      errorVerbosity?: 'low' | 'full';
      locale?: UiLocale;
    }) {
      hookResult = useLoadingIndicator({
        streamingState,
        retryStatus: retryStatus || null,
        showTips,
        showWit,
        errorVerbosity,
        locale,
      });
      return null;
    }

    const { rerender, waitUntilReady } = await render(
      <TestComponent
        streamingState={initialStreamingState}
        retryStatus={initialRetryStatus}
        showTips={initialShowTips}
        showWit={initialShowWit}
        errorVerbosity={initialErrorVerbosity}
        locale={initialLocale}
      />,
    );
    return {
      result: {
        get current() {
          return hookResult;
        },
      },
      rerender: async (newProps: {
        streamingState: StreamingState;
        retryStatus?: RetryAttemptPayload | null;
        showTips?: boolean;
        showWit?: boolean;
        errorVerbosity?: 'low' | 'full';
        locale?: UiLocale;
      }) => {
        rerender(
          <TestComponent
            showTips={initialShowTips}
            showWit={initialShowWit}
            errorVerbosity={initialErrorVerbosity}
            locale={initialLocale}
            {...newProps}
          />,
        );
        await waitUntilReady();
      },
      waitUntilReady,
    };
  };

  it('should initialize with default values when Idle', async () => {
    vi.spyOn(Math, 'random').mockImplementation(() => 0.5); // Always witty
    const { result } = await renderLoadingIndicatorHook(StreamingState.Idle);
    expect(result.current.elapsedTime).toBe(0);
    expect(result.current.currentLoadingPhrase).toBeUndefined();
  });

  it('should reflect values when Responding', async () => {
    vi.spyOn(Math, 'random').mockImplementation(() => 0.5); // Always witty for subsequent phrases
    const { result } = await renderLoadingIndicatorHook(
      StreamingState.Responding,
    );

    expect(result.current.elapsedTime).toBe(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(PHRASE_CHANGE_INTERVAL_MS + 1);
    });

    // Both tip and witty phrase are available in the currentLoadingPhrase because it defaults to tip if present
    expect([...WITTY_LOADING_PHRASES, ...EN_INFORMATIVE_TIPS]).toContain(
      result.current.currentLoadingPhrase,
    );
  });

  it('returns localized built-in tips for the requested UI locale', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { result } = await renderLoadingIndicatorHook(
      StreamingState.Responding,
      null,
      true,
      false,
      'full',
      'zh-CN',
    );

    expect(result.current.currentTip).toContain('/settings');
    expect(result.current.currentTip).toContain('首选编辑器');
    expect(result.current.currentTip).not.toContain(
      'Set your preferred editor',
    );
  });

  it('should show waiting phrase and retain elapsedTime when WaitingForConfirmation', async () => {
    const { result, rerender } = await renderLoadingIndicatorHook(
      StreamingState.Responding,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    expect(result.current.elapsedTime).toBe(60);

    await act(async () => {
      await rerender({ streamingState: StreamingState.WaitingForConfirmation });
    });

    expect(result.current.currentLoadingPhrase).toBe(
      'Waiting for user confirmation...',
    );
    expect(result.current.elapsedTime).toBe(60); // Elapsed time should be retained

    // Timer should not advance further
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(result.current.elapsedTime).toBe(60);
  });

  it('should resume elapsedTime and cycle phrases when transitioning from WaitingForConfirmation to Responding', async () => {
    vi.spyOn(Math, 'random').mockImplementation(() => 0.5); // Always witty
    const { result, rerender } = await renderLoadingIndicatorHook(
      StreamingState.Responding,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000); // 5s
    });
    expect(result.current.elapsedTime).toBe(5);

    await act(async () => {
      await rerender({ streamingState: StreamingState.WaitingForConfirmation });
    });
    expect(result.current.elapsedTime).toBe(5);
    expect(result.current.currentLoadingPhrase).toBe(
      'Waiting for user confirmation...',
    );

    await act(async () => {
      await rerender({ streamingState: StreamingState.Responding });
    });
    expect(result.current.elapsedTime).toBe(5);
    expect([...WITTY_LOADING_PHRASES, ...EN_INFORMATIVE_TIPS]).toContain(
      result.current.currentLoadingPhrase,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(result.current.elapsedTime).toBe(6);
  });

  it('should reset timer and phrase when streamingState changes from Responding to Idle', async () => {
    vi.spyOn(Math, 'random').mockImplementation(() => 0.5); // Always witty
    const { result, rerender } = await renderLoadingIndicatorHook(
      StreamingState.Responding,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000); // 10s
    });
    expect(result.current.elapsedTime).toBe(10);

    await act(async () => {
      await rerender({ streamingState: StreamingState.Idle });
    });

    expect(result.current.elapsedTime).toBe(0);
    expect(result.current.currentLoadingPhrase).toBeUndefined();
  });

  it('should reflect retry status in currentLoadingPhrase when provided', async () => {
    const retryStatus = {
      sessionId: 'test-session',
      model: 'gemini-pro',
      attempt: 2,
      maxAttempts: 3,
      delayMs: 1000,
    };
    const { result } = await renderLoadingIndicatorHook(
      StreamingState.Responding,
      retryStatus,
    );

    expect(result.current.currentLoadingPhrase).toContain('Trying to reach');
    expect(result.current.currentLoadingPhrase).toContain('gemini-pro');
    expect(result.current.currentLoadingPhrase).not.toContain('Gemini-pro');
    expect(result.current.currentLoadingPhrase).toContain('Attempt 3/3');
  });

  it('localizes full retry status while preserving the model and counters', async () => {
    const retryStatus = {
      sessionId: 'test-session',
      model: 'gemini-pro',
      attempt: 2,
      maxAttempts: 3,
      delayMs: 1000,
    };
    const { result } = await renderLoadingIndicatorHook(
      StreamingState.Responding,
      retryStatus,
      true,
      true,
      'full',
      'zh-CN',
    );

    expect(result.current.currentLoadingPhrase).toBe(
      '正在连接 gemini-pro（第 3/3 次尝试）',
    );
  });

  it('should not show retry status phrase when idle', async () => {
    const retryStatus = {
      sessionId: 'test-session',
      model: 'gemini-pro',
      attempt: 2,
      maxAttempts: 3,
      delayMs: 1000,
    };
    const { result } = await renderLoadingIndicatorHook(
      StreamingState.Idle,
      retryStatus,
    );

    expect(result.current.currentLoadingPhrase).toBeUndefined();
  });

  it('should hide low-verbosity retry status for early retry attempts', async () => {
    const retryStatus = {
      sessionId: 'test-session',
      model: 'gemini-pro',
      attempt: 1,
      maxAttempts: 5,
      delayMs: 1000,
    };
    const { result } = await renderLoadingIndicatorHook(
      StreamingState.Responding,
      retryStatus,
      true,
      true,
      'low',
    );

    expect(result.current.currentLoadingPhrase).not.toBe(
      "This is taking a bit longer, we're still on it.",
    );
  });

  it('should show a generic retry phrase in low error verbosity mode for later retries', async () => {
    const retryStatus = {
      sessionId: 'test-session',
      model: 'gemini-pro',
      attempt: 2,
      maxAttempts: 5,
      delayMs: 1000,
    };
    const { result } = await renderLoadingIndicatorHook(
      StreamingState.Responding,
      retryStatus,
      true,
      true,
      'low',
    );

    expect(result.current.currentLoadingPhrase).toBe(
      "This is taking a bit longer, we're still on it.",
    );
  });

  it('localizes the generic retry phrase in low error verbosity mode', async () => {
    const retryStatus = {
      sessionId: 'test-session',
      model: 'gemini-pro',
      attempt: 2,
      maxAttempts: 5,
      delayMs: 1000,
    };
    const { result } = await renderLoadingIndicatorHook(
      StreamingState.Responding,
      retryStatus,
      true,
      true,
      'low',
      'zh-CN',
    );

    expect(result.current.currentLoadingPhrase).toBe(
      '响应时间较长，仍在处理中。',
    );
  });

  it('should show no phrases when showTips and showWit are false', async () => {
    const { result } = await renderLoadingIndicatorHook(
      StreamingState.Responding,
      null,
      false,
      false,
    );

    expect(result.current.currentLoadingPhrase).toBeUndefined();
  });
});
