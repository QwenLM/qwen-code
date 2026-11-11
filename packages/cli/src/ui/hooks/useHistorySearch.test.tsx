/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { renderHookWithProviders } from '../../test-utils/render.js';
import { useTextBuffer } from '../components/shared/text-buffer.js';
import { useHistorySearch } from './useHistorySearch.js';

const HISTORY = ['ls -l', 'echo hello', 'echo world', 'git status'];

function useHarness(initialText: string, history: readonly string[]) {
  const buffer = useTextBuffer({
    initialText,
    initialCursorOffset: initialText.length,
    viewport: { width: 80, height: 20 },
    onChange: () => {},
  });
  const search = useHistorySearch(buffer, history);
  return { buffer, search };
}

describe('useHistorySearch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts inactive and exposes a completion engine', async () => {
    const { result } = await renderHookWithProviders(() =>
      useHarness('', HISTORY),
    );
    expect(result.current.search.active).toBe(false);
    expect(result.current.search.completion.showSuggestions).toBe(false);
  });

  it('enter() activates the overlay and snapshots buffer state', async () => {
    const { result } = await renderHookWithProviders(() =>
      useHarness('echo', HISTORY),
    );

    act(() => {
      result.current.search.enter();
    });

    expect(result.current.search.active).toBe(true);
  });

  it('cancel() restores buffer text and deactivates', async () => {
    const { result } = await renderHookWithProviders(() =>
      useHarness('original text', HISTORY),
    );

    act(() => {
      result.current.search.enter();
    });
    // While search is active the user typically types a query that mutates
    // the buffer; simulate that here.
    act(() => {
      result.current.buffer.setText('echo');
    });
    expect(result.current.buffer.text).toBe('echo');

    act(() => {
      result.current.search.cancel();
    });

    expect(result.current.search.active).toBe(false);
    expect(result.current.buffer.text).toBe('original text');
  });

  it('finish() closes without restoring', async () => {
    const { result } = await renderHookWithProviders(() =>
      useHarness('echo', HISTORY),
    );

    act(() => {
      result.current.search.enter();
    });
    act(() => {
      result.current.buffer.setText('echo world');
    });

    act(() => {
      result.current.search.finish();
    });

    expect(result.current.search.active).toBe(false);
    // Buffer is NOT restored.
    expect(result.current.buffer.text).toBe('echo world');
  });

  it('resolveSubmitText falls back to buffer text when nothing selected', async () => {
    const { result } = await renderHookWithProviders(() =>
      useHarness('typed query', HISTORY),
    );

    act(() => {
      result.current.search.enter();
    });

    expect(result.current.search.resolveSubmitText()).toBe('typed query');
  });

  it('resolveSubmitText returns the active suggestion value when one is selected', async () => {
    const { result, rerender } = await renderHookWithProviders(
      (props: { active: boolean }) => {
        const harness = useHarness('echo', HISTORY);
        if (props.active && !harness.search.active) {
          harness.search.enter();
        }
        return harness;
      },
      { initialProps: { active: false } },
    );

    rerender({ active: true });
    // Allow useReverseSearchCompletion's debounced effect to settle.
    act(() => {
      vi.advanceTimersByTime(300);
    });

    const { suggestions, activeSuggestionIndex, showSuggestions } =
      result.current.search.completion;
    expect(showSuggestions).toBe(true);
    expect(suggestions.length).toBeGreaterThan(0);
    expect(activeSuggestionIndex).toBeGreaterThanOrEqual(0);
    expect(result.current.search.resolveSubmitText()).toBe(
      suggestions[activeSuggestionIndex].value,
    );
  });
});
