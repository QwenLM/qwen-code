/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CoreEvent,
  coreEvents,
  initializeI18nService,
  type CompressionProgressPayload,
} from '@qwen-code/core';
import { renderHook } from '../../test-utils/render.js';
import { useCompressionProgress } from './useCompressionProgress.js';

const SESSION_ID = 'session-main';

function emitProgress(
  overrides: Partial<CompressionProgressPayload> = {},
): void {
  coreEvents.emit(CoreEvent.CompressionProgress, {
    stage: 'starting',
    trigger: 'auto',
    sessionId: SESSION_ID,
    sessionScopeId: SESSION_ID,
    target: 'main',
    ...overrides,
  });
}

describe('useCompressionProgress', () => {
  beforeEach(() => {
    initializeI18nService();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('delays visibility and advances by compression phase', async () => {
    const { result, unmount } = await renderHook(() =>
      useCompressionProgress(SESSION_ID),
    );

    act(() => emitProgress());
    expect(result.current).toBeNull();

    act(() => {
      vi.advanceTimersByTime(199);
    });
    expect(result.current).toBeNull();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toMatchObject({
      stage: 'starting',
      percent: 2,
    });

    act(() => emitProgress({ stage: 'summarizing' }));
    expect(result.current).toMatchObject({
      stage: 'summarizing',
      percent: 8,
    });

    // The summarizing curve only pushes a re-render once the displayed integer
    // percent advances, so give it enough time to cross the first step.
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(result.current?.percent).toBeGreaterThan(8);
    expect(result.current?.percent).toBeLessThan(75);

    act(() => emitProgress({ stage: 'post_processing' }));
    expect(result.current?.stage).toBe('post_processing');
    expect(result.current?.percent).toBeLessThan(90);
    act(() => {
      vi.advanceTimersByTime(700);
    });
    expect(result.current?.percent).toBe(90);

    act(() => emitProgress({ stage: 'done' }));
    expect(result.current?.stage).toBe('done');
    expect(result.current?.percent).toBe(90);
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(result.current?.percent).toBe(100);

    act(() => {
      vi.advanceTimersByTime(399);
    });
    expect(result.current?.stage).toBe('done');
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBeNull();

    unmount();
  });

  it('slows summarizing progress instead of racing to a hard ceiling', async () => {
    const { result, unmount } = await renderHook(() =>
      useCompressionProgress(SESSION_ID),
    );

    act(() => emitProgress({ stage: 'summarizing' }));
    act(() => {
      vi.advanceTimersByTime(200);
    });

    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(result.current?.percent).toBeGreaterThan(24);
    expect(result.current?.percent).toBeLessThan(25);

    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(result.current?.percent).toBeGreaterThan(46);
    expect(result.current?.percent).toBeLessThan(47);

    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(result.current?.percent).toBeGreaterThan(62);
    expect(result.current?.percent).toBeLessThan(63);

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(result.current?.percent).toBeGreaterThan(72);
    expect(result.current?.percent).toBeLessThan(73);
    expect(result.current?.percent).toBeLessThan(75);

    unmount();
  });

  it('does not flash a panel for fast compactions', async () => {
    const { result, unmount } = await renderHook(() =>
      useCompressionProgress(SESSION_ID),
    );

    act(() => emitProgress());
    act(() => {
      vi.advanceTimersByTime(100);
    });
    act(() => emitProgress({ stage: 'done' }));
    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(result.current).toBeNull();
    unmount();
  });

  it('surfaces a fast failure and then clears it', async () => {
    const { result, unmount } = await renderHook(() =>
      useCompressionProgress(SESSION_ID),
    );

    act(() => emitProgress());
    act(() => emitProgress({ stage: 'failed' }));

    expect(result.current).toMatchObject({
      stage: 'failed',
      percent: 100,
      tone: 'warning',
    });

    act(() => {
      vi.advanceTimersByTime(1_499);
    });
    expect(result.current?.stage).toBe('failed');
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBeNull();

    unmount();
  });

  it('clears visible progress immediately when compaction is cancelled', async () => {
    const { result, unmount } = await renderHook(() =>
      useCompressionProgress(SESSION_ID),
    );

    act(() => emitProgress({ stage: 'summarizing' }));
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current?.stage).toBe('summarizing');

    act(() =>
      emitProgress({ stage: 'failed', failureReason: 'cancelled' }),
    );
    expect(result.current).toBeNull();

    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(result.current).toBeNull();

    unmount();
  });

  it('surfaces dynamic provider text for a model request failure', async () => {
    const { result, unmount } = await renderHook(() =>
      useCompressionProgress(SESSION_ID),
    );

    act(() =>
      emitProgress({
        stage: 'failed',
        failureReason: 'provider_error',
        providerSource: 'qoder',
        displayErrorCode: 'missing.compact.error.code',
        errorFallbackMessage: 'This conversation contains sensitive content.',
      }),
    );

    expect(result.current).toMatchObject({
      stage: 'failed',
      label: 'This conversation contains sensitive content.',
      tone: 'warning',
    });

    unmount();
  });

  it('shows a permission hint for a third-party HTTP 403/code 122', async () => {
    const { result, unmount } = await renderHook(() =>
      useCompressionProgress(SESSION_ID),
    );

    act(() =>
      emitProgress({
        stage: 'failed',
        failureReason: 'auth_error',
        providerSource: 'qwen-subscription',
        providerStatus: 403,
        displayErrorCode: '122',
      }),
    );

    expect(result.current?.label).toContain('provider permissions');
    unmount();
  });

  it('shows manual main-thread progress', async () => {
    const { result, unmount } = await renderHook(() =>
      useCompressionProgress(SESSION_ID),
    );

    act(() => emitProgress({ trigger: 'manual' }));
    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(result.current).toMatchObject({
      stage: 'starting',
      percent: 2,
    });
    unmount();
  });

  it('ignores subagent and other-session progress', async () => {
    const { result, unmount } = await renderHook(() =>
      useCompressionProgress(SESSION_ID),
    );

    act(() => {
      emitProgress({ target: 'subagent', agentId: 'agent-1' });
      emitProgress({ sessionScopeId: 'session-other' });
      vi.advanceTimersByTime(1_000);
    });

    expect(result.current).toBeNull();
    unmount();
  });
});
