/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  renderHookWithProviders,
  persistentStateMock,
} from '../../test-utils/render.js';
import { act } from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useTips, _clearTipsShownForTest } from './useTips.js';

describe('useTips()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset persisted data so impression counts don't leak between tests.
    persistentStateMock.setData({});
    // The impression dedupe is module-scoped (survives remounts within a
    // launch), so it must be reset between tests or it leaks in file order.
    _clearTipsShownForTest();
  });

  it('does not count an impression until markShown is called', async () => {
    const { result } = await renderHookWithProviders(() => useTips());

    expect(result.current.showTips).toBe(true);
    // Counting is deferred to markShown so a suppressed box doesn't burn it.
    expect(persistentStateMock.set).not.toHaveBeenCalled();
  });

  it('increments to 1 on markShown when state is undefined', async () => {
    const { result } = await renderHookWithProviders(() => useTips());

    expect(result.current.showTips).toBe(true);
    await act(async () => {
      result.current.markShown();
    });

    expect(persistentStateMock.set).toHaveBeenCalledWith('tipsShown', 1);
    expect(persistentStateMock.get('tipsShown')).toBe(1);
  });

  it('increments to 6 on markShown when state is 5', async () => {
    persistentStateMock.setData({ tipsShown: 5 });

    const { result } = await renderHookWithProviders(() => useTips());
    await act(async () => {
      result.current.markShown();
    });

    expect(result.current.showTips).toBe(true);
    expect(persistentStateMock.get('tipsShown')).toBe(6);
  });

  it('counts at most one impression per launch', async () => {
    const { result } = await renderHookWithProviders(() => useTips());
    await act(async () => {
      result.current.markShown();
      result.current.markShown();
    });

    expect(persistentStateMock.set).toHaveBeenCalledTimes(1);
    expect(persistentStateMock.get('tipsShown')).toBe(1);
  });

  it('does not count once the budget is exhausted (state is 10)', async () => {
    persistentStateMock.setData({ tipsShown: 10 });

    const { result } = await renderHookWithProviders(() => useTips());
    await act(async () => {
      result.current.markShown();
    });

    expect(result.current.showTips).toBe(false);
    expect(persistentStateMock.set).not.toHaveBeenCalled();
    expect(persistentStateMock.get('tipsShown')).toBe(10);
  });

  it('counts at most one impression across separate mounts in one launch', async () => {
    // A remount within the same process (e.g. a conversationKey bump on
    // --resume) must NOT burn a second impression: the dedupe is module-scoped.
    // The persisted value is the robust signal here — renderHookWithProviders
    // clears the set spy's call history on each render, so a cross-mount
    // toHaveBeenCalledTimes count is unreliable.
    const first = await renderHookWithProviders(() => useTips());
    await act(async () => {
      first.result.current.markShown();
    });
    first.unmount();

    const second = await renderHookWithProviders(() => useTips());
    await act(async () => {
      second.result.current.markShown();
    });
    second.unmount();

    // Only the first mount counted; the second no-ops via the module flag.
    expect(persistentStateMock.get('tipsShown')).toBe(1);
  });

  it('_clearTipsShownForTest restores per-test isolation', async () => {
    const first = await renderHookWithProviders(() => useTips());
    await act(async () => {
      first.result.current.markShown();
    });
    first.unmount();

    _clearTipsShownForTest();

    const second = await renderHookWithProviders(() => useTips());
    await act(async () => {
      second.result.current.markShown();
    });
    second.unmount();

    // After the reset the second launch counts again: 1 -> 2.
    expect(persistentStateMock.get('tipsShown')).toBe(2);
  });
});
