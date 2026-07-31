/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config, PromptSuggestionEvent } from '@qwen-code/qwen-code-core';

const { mockLogPromptSuggestion } = vi.hoisted(() => ({
  mockLogPromptSuggestion: vi.fn(),
}));

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...actual,
    logPromptSuggestion: mockLogPromptSuggestion,
  };
});

import { useFollowupSuggestionsCLI } from './useFollowupSuggestions.js';

// Mirror of SUGGESTION_DELAY_MS in core's followupState controller.
const SUGGESTION_DELAY_MS = 300;
const config = {} as Config;

function acceptedEvent(): PromptSuggestionEvent | undefined {
  const call = mockLogPromptSuggestion.mock.calls.find(
    ([, event]) => (event as PromptSuggestionEvent).outcome === 'accepted',
  );
  return call?.[1] as PromptSuggestionEvent | undefined;
}

describe('useFollowupSuggestionsCLI telemetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockLogPromptSuggestion.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('omits time_to_first_keystroke_ms on fallback accepts even with stale shown/keystroke refs', () => {
    const { result } = renderHook(() =>
      useFollowupSuggestionsCLI({ enabled: true, config }),
    );

    // Show a live suggestion so prevShownAtRef + firstKeystrokeAtRef get set
    // from this turn — exactly the stale state that would corrupt a later
    // fallback accept if the accept_source guard were missing.
    act(() => {
      result.current.setSuggestion('run the tests');
      vi.advanceTimersByTime(SUGGESTION_DELAY_MS);
    });
    expect(result.current.state.isVisible).toBe(true);

    act(() => {
      vi.advanceTimersByTime(50);
      result.current.recordKeystroke();
    });

    // Drop the live suggestion and accept via fallback in the same tick, before
    // the ref-reset effect runs. accept_source is 'fallback' (no live
    // suggestion), so the keystroke delta must be suppressed.
    act(() => {
      result.current.setSuggestion(null);
      result.current.accept('tab', { fallbackText: 'run the tests' });
    });

    const event = acceptedEvent();
    expect(event).toBeDefined();
    expect(event?.accept_source).toBe('fallback');
    expect(event?.time_to_first_keystroke_ms).toBeUndefined();
  });

  it('includes time_to_first_keystroke_ms on live accepts', () => {
    const { result } = renderHook(() =>
      useFollowupSuggestionsCLI({ enabled: true, config }),
    );

    act(() => {
      result.current.setSuggestion('run the tests');
      vi.advanceTimersByTime(SUGGESTION_DELAY_MS);
    });

    act(() => {
      vi.advanceTimersByTime(50);
      result.current.recordKeystroke();
    });

    act(() => {
      result.current.accept('tab');
    });

    const event = acceptedEvent();
    expect(event).toBeDefined();
    expect(event?.accept_source).toBe('live');
    expect(event?.time_to_first_keystroke_ms).toBe(50);
  });
});
