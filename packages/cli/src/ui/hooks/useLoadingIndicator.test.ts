/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useLoadingIndicator } from './useLoadingIndicator.js';
import { StreamingState } from '../types.js';
import type { ThoughtSummary } from '../types.js';
import { PHRASE_CHANGE_INTERVAL_MS } from './usePhraseCycler.js';
import * as i18n from '../../i18n/index.js';

const MOCK_WITTY_PHRASES = ['Phrase 1', 'Phrase 2', 'Phrase 3'];

describe('useLoadingIndicator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(i18n, 'ta').mockReturnValue(MOCK_WITTY_PHRASES);
    vi.spyOn(i18n, 't').mockImplementation((key) => key);
  });

  afterEach(() => {
    vi.useRealTimers(); // Restore real timers after each test
    act(() => vi.runOnlyPendingTimers);
    vi.restoreAllMocks();
  });

  it('should initialize with default values when Idle', () => {
    const { result } = renderHook(() =>
      useLoadingIndicator(StreamingState.Idle),
    );
    expect(result.current.elapsedTime).toBe(0);
    expect(MOCK_WITTY_PHRASES).toContain(result.current.currentLoadingPhrase);
  });

  it('should reflect values when Responding', async () => {
    const { result } = renderHook(() =>
      useLoadingIndicator(StreamingState.Responding),
    );

    // Initial state before timers advance
    expect(result.current.elapsedTime).toBe(0);
    expect(MOCK_WITTY_PHRASES).toContain(result.current.currentLoadingPhrase);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(PHRASE_CHANGE_INTERVAL_MS + 1);
    });

    // Phrase should cycle if PHRASE_CHANGE_INTERVAL_MS has passed
    expect(MOCK_WITTY_PHRASES).toContain(result.current.currentLoadingPhrase);
  });

  it('should show waiting phrase and retain elapsedTime when WaitingForConfirmation', async () => {
    const { result, rerender } = renderHook(
      ({ streamingState }) => useLoadingIndicator(streamingState),
      { initialProps: { streamingState: StreamingState.Responding } },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    expect(result.current.elapsedTime).toBe(60);

    act(() => {
      rerender({ streamingState: StreamingState.WaitingForConfirmation });
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

  it('should reset elapsedTime and use a witty phrase when transitioning from WaitingForConfirmation to Responding', async () => {
    const { result, rerender } = renderHook(
      ({ streamingState }) => useLoadingIndicator(streamingState),
      { initialProps: { streamingState: StreamingState.Responding } },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000); // 5s
    });
    expect(result.current.elapsedTime).toBe(5);

    act(() => {
      rerender({ streamingState: StreamingState.WaitingForConfirmation });
    });
    expect(result.current.elapsedTime).toBe(5);
    expect(result.current.currentLoadingPhrase).toBe(
      'Waiting for user confirmation...',
    );

    act(() => {
      rerender({ streamingState: StreamingState.Responding });
    });
    expect(result.current.elapsedTime).toBe(0); // Should reset
    expect(MOCK_WITTY_PHRASES).toContain(result.current.currentLoadingPhrase);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(result.current.elapsedTime).toBe(1);
  });

  it('should reset timer and phrase when streamingState changes from Responding to Idle', async () => {
    const { result, rerender } = renderHook(
      ({ streamingState }) => useLoadingIndicator(streamingState),
      { initialProps: { streamingState: StreamingState.Responding } },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000); // 10s
    });
    expect(result.current.elapsedTime).toBe(10);

    act(() => {
      rerender({ streamingState: StreamingState.Idle });
    });

    expect(result.current.elapsedTime).toBe(0);
    expect(MOCK_WITTY_PHRASES).toContain(result.current.currentLoadingPhrase);

    // Timer should not advance
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(result.current.elapsedTime).toBe(0);
  });

  describe('token tracking', () => {
    it('should capture token snapshot when task starts', () => {
      const { result, rerender } = renderHook(
        ({ streamingState, currentCandidatesTokens, currentStreamingChars }) =>
          useLoadingIndicator(
            streamingState,
            undefined,
            currentCandidatesTokens,
            currentStreamingChars,
          ),
        {
          initialProps: {
            streamingState: StreamingState.Idle,
            currentCandidatesTokens: 100,
            currentStreamingChars: 400,
          },
        },
      );

      expect(result.current.taskStartTokens).toBe(0);
      expect(result.current.taskStartStreamingChars).toBe(0);

      act(() => {
        rerender({
          streamingState: StreamingState.Responding,
          currentCandidatesTokens: 100,
          currentStreamingChars: 400,
        });
      });

      expect(result.current.taskStartTokens).toBe(100);
      expect(result.current.taskStartStreamingChars).toBe(400);
    });

    it('should reset token snapshot when transitioning from Responding to Idle', async () => {
      const { result, rerender } = renderHook(
        ({ streamingState, currentCandidatesTokens, currentStreamingChars }) =>
          useLoadingIndicator(
            streamingState,
            undefined,
            currentCandidatesTokens,
            currentStreamingChars,
          ),
        {
          initialProps: {
            streamingState: StreamingState.Idle,
            currentCandidatesTokens: 0,
            currentStreamingChars: 0,
          },
        },
      );

      act(() => {
        rerender({
          streamingState: StreamingState.Responding,
          currentCandidatesTokens: 0,
          currentStreamingChars: 0,
        });
      });
      expect(result.current.taskStartTokens).toBe(0);
      expect(result.current.taskStartStreamingChars).toBe(0);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
        rerender({
          streamingState: StreamingState.Responding,
          currentCandidatesTokens: 500,
          currentStreamingChars: 2000,
        });
      });

      act(() => {
        rerender({
          streamingState: StreamingState.Idle,
          currentCandidatesTokens: 500,
          currentStreamingChars: 2000,
        });
      });

      expect(result.current.taskStartTokens).toBe(0);
      expect(result.current.taskStartStreamingChars).toBe(0);
    });

    it('should reset token snapshot when transitioning from WaitingForConfirmation to Responding', async () => {
      const { result, rerender } = renderHook(
        ({ streamingState, currentCandidatesTokens, currentStreamingChars }) =>
          useLoadingIndicator(
            streamingState,
            undefined,
            currentCandidatesTokens,
            currentStreamingChars,
          ),
        {
          initialProps: {
            streamingState: StreamingState.Responding,
            currentCandidatesTokens: 100,
            currentStreamingChars: 400,
          },
        },
      );

      expect(result.current.taskStartTokens).toBe(100);
      expect(result.current.taskStartStreamingChars).toBe(400);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
        rerender({
          streamingState: StreamingState.Responding,
          currentCandidatesTokens: 500,
          currentStreamingChars: 2000,
        });
      });

      act(() => {
        rerender({
          streamingState: StreamingState.WaitingForConfirmation,
          currentCandidatesTokens: 500,
          currentStreamingChars: 2000,
        });
      });

      act(() => {
        rerender({
          streamingState: StreamingState.Responding,
          currentCandidatesTokens: 500,
          currentStreamingChars: 2000,
        });
      });

      expect(result.current.taskStartTokens).toBe(500);
      expect(result.current.taskStartStreamingChars).toBe(2000);
    });
  });

  describe('thinking-intent-driven phrase', () => {
    const thoughtWithSubject: ThoughtSummary = {
      subject: 'Analyzing auth flow',
      description: 'Checking how sessions are managed',
    };

    it('should show thought subject during Responding', () => {
      const { result } = renderHook(() =>
        useLoadingIndicator(
          StreamingState.Responding,
          undefined,
          undefined,
          undefined,
          thoughtWithSubject,
        ),
      );

      expect(result.current.currentLoadingPhrase).toBe('Analyzing auth flow');
    });

    it('should fall back to witty phrase when thought is null', () => {
      const { result } = renderHook(() =>
        useLoadingIndicator(
          StreamingState.Responding,
          undefined,
          undefined,
          undefined,
          null,
        ),
      );

      expect(MOCK_WITTY_PHRASES).toContain(result.current.currentLoadingPhrase);
    });

    it('should fall back to description when thought subject is empty', () => {
      const { result } = renderHook(() =>
        useLoadingIndicator(
          StreamingState.Responding,
          undefined,
          undefined,
          undefined,
          { subject: '', description: 'some reasoning' },
        ),
      );

      expect(result.current.currentLoadingPhrase).toBe('some reasoning');
    });

    it('should use only first line of multiline description when subject is empty', () => {
      const { result } = renderHook(() =>
        useLoadingIndicator(
          StreamingState.Responding,
          undefined,
          undefined,
          undefined,
          { subject: '', description: 'first line\nsecond line\nthird line' },
        ),
      );

      expect(result.current.currentLoadingPhrase).toBe('first line');
    });

    it('should truncate long thought subjects', () => {
      const longSubject = 'A'.repeat(120);
      const { result } = renderHook(() =>
        useLoadingIndicator(
          StreamingState.Responding,
          undefined,
          undefined,
          undefined,
          { subject: longSubject, description: '' },
        ),
      );

      expect(result.current.currentLoadingPhrase).toBe('A'.repeat(79) + '…');
      expect(result.current.currentLoadingPhrase.length).toBe(80);
    });

    it('should not use thought subject during WaitingForConfirmation', () => {
      const { result } = renderHook(() =>
        useLoadingIndicator(
          StreamingState.WaitingForConfirmation,
          undefined,
          undefined,
          undefined,
          thoughtWithSubject,
        ),
      );

      expect(result.current.currentLoadingPhrase).toBe(
        'Waiting for user confirmation...',
      );
    });

    it('should not use thought subject during Idle', () => {
      const { result } = renderHook(() =>
        useLoadingIndicator(
          StreamingState.Idle,
          undefined,
          undefined,
          undefined,
          thoughtWithSubject,
        ),
      );

      expect(MOCK_WITTY_PHRASES).toContain(result.current.currentLoadingPhrase);
    });

    it('should switch from witty phrase to thought subject when thought arrives', () => {
      const { result, rerender } = renderHook(
        ({ thought }) =>
          useLoadingIndicator(
            StreamingState.Responding,
            undefined,
            undefined,
            undefined,
            thought,
          ),
        { initialProps: { thought: null as ThoughtSummary | null } },
      );

      expect(MOCK_WITTY_PHRASES).toContain(result.current.currentLoadingPhrase);

      rerender({ thought: thoughtWithSubject });

      expect(result.current.currentLoadingPhrase).toBe('Analyzing auth flow');
    });

    it('should retain thought subject after thought is cleared (content/toolcall)', () => {
      const { result, rerender } = renderHook(
        ({ thought }) =>
          useLoadingIndicator(
            StreamingState.Responding,
            undefined,
            undefined,
            undefined,
            thought,
          ),
        {
          initialProps: {
            thought: thoughtWithSubject as ThoughtSummary | null,
          },
        },
      );

      expect(result.current.currentLoadingPhrase).toBe('Analyzing auth flow');

      // Simulate useGeminiStream clearing thought on content/toolcall
      rerender({ thought: null });

      expect(result.current.currentLoadingPhrase).toBe('Analyzing auth flow');
    });

    it('should clear retained thought subject on Idle', () => {
      const { result, rerender } = renderHook(
        ({ streamingState, thought }) =>
          useLoadingIndicator(
            streamingState,
            undefined,
            undefined,
            undefined,
            thought,
          ),
        {
          initialProps: {
            streamingState: StreamingState.Responding,
            thought: thoughtWithSubject as ThoughtSummary | null,
          },
        },
      );

      expect(result.current.currentLoadingPhrase).toBe('Analyzing auth flow');

      rerender({ streamingState: StreamingState.Idle, thought: null });

      expect(MOCK_WITTY_PHRASES).toContain(result.current.currentLoadingPhrase);
    });
  });
});
