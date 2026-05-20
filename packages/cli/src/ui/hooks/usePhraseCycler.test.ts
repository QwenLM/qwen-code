/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  usePhraseCycler,
  PHRASE_CHANGE_INTERVAL_MS,
} from './usePhraseCycler.js';
import * as i18n from '../../i18n/index.js';

const MOCK_WITTY_PHRASES = ['Phrase 1', 'Phrase 2', 'Phrase 3'];
const MOCK_FORTUNE_QUOTE = 'The fortune favors the bold.';

// Mock the getFortuneQuote function
vi.mock('./fortune.js', () => ({
  getFortuneQuote: vi.fn(),
}));

// Mock the selectRandomPhrase function to return phrases deterministically
vi.mock('./phraseSelector.js', () => ({
  selectRandomPhrase: vi.fn((phrases) => phrases[0]),
}));

describe('usePhraseCycler', () => {
  let mockGetFortuneQuote: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.spyOn(i18n, 'ta').mockReturnValue(MOCK_WITTY_PHRASES);
    vi.spyOn(i18n, 't').mockImplementation((key) => key);
    const fortuneModule = await import('./fortune.js');
    mockGetFortuneQuote = fortuneModule.getFortuneQuote as ReturnType<
      typeof vi.fn
    >;
    mockGetFortuneQuote.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should initialize with a witty phrase when not active and not waiting', () => {
    const { result } = renderHook(() => usePhraseCycler(false, false));
    expect(MOCK_WITTY_PHRASES).toContain(result.current);
  });

  it('should show "Waiting for user confirmation..." when isWaiting is true', () => {
    const { result, rerender } = renderHook(
      ({ isActive, isWaiting }) => usePhraseCycler(isActive, isWaiting),
      { initialProps: { isActive: true, isWaiting: false } },
    );
    rerender({ isActive: true, isWaiting: true });
    expect(result.current).toBe('Waiting for user confirmation...');
  });

  it('should not cycle phrases if isActive is false and not waiting', () => {
    const { result } = renderHook(() => usePhraseCycler(false, false));
    const initialPhrase = result.current;
    act(() => {
      vi.advanceTimersByTime(PHRASE_CHANGE_INTERVAL_MS * 2);
    });
    expect(result.current).toBe(initialPhrase);
  });

  it('should cycle through witty phrases when isActive is true and not waiting', () => {
    const { result } = renderHook(() => usePhraseCycler(true, false));
    // Initial phrase should be one of the witty phrases
    expect(MOCK_WITTY_PHRASES).toContain(result.current);
    const _initialPhrase = result.current;

    act(() => {
      vi.advanceTimersByTime(PHRASE_CHANGE_INTERVAL_MS);
    });
    // Phrase should change and be one of the witty phrases
    expect(MOCK_WITTY_PHRASES).toContain(result.current);

    const _secondPhrase = result.current;
    act(() => {
      vi.advanceTimersByTime(PHRASE_CHANGE_INTERVAL_MS);
    });
    expect(MOCK_WITTY_PHRASES).toContain(result.current);
  });

  it('should reset to a witty phrase when isActive becomes true after being false (and not waiting)', async () => {
    // Mock selectRandomPhrase to cycle through phrases deterministically
    const { selectRandomPhrase } = await import('./phraseSelector.js');
    let callCount = 0;
    vi.mocked(selectRandomPhrase).mockImplementation((phrases) => {
      // Cycle through 0, 1, 0, 1, ...
      const val = callCount % 2;
      callCount++;
      return phrases[val];
    });

    const { result, rerender } = renderHook(
      ({ isActive, isWaiting }) => usePhraseCycler(isActive, isWaiting),
      { initialProps: { isActive: false, isWaiting: false } },
    );

    // Activate
    rerender({ isActive: true, isWaiting: false });
    await act(async () => {
      await Promise.resolve();
    });
    const firstActivePhrase = result.current;
    expect(MOCK_WITTY_PHRASES).toContain(firstActivePhrase);
    // With our mock, this should be the first phrase.
    expect(firstActivePhrase).toBe(MOCK_WITTY_PHRASES[0]);

    act(() => {
      vi.advanceTimersByTime(PHRASE_CHANGE_INTERVAL_MS);
    });

    // Phrase should change to the second phrase.
    expect(result.current).not.toBe(firstActivePhrase);
    expect(result.current).toBe(MOCK_WITTY_PHRASES[1]);

    // Set to inactive - should reset to the default initial phrase
    rerender({ isActive: false, isWaiting: false });
    expect(MOCK_WITTY_PHRASES).toContain(result.current);

    // Set back to active - should pick a random witty phrase (which our mock controls)
    act(() => {
      rerender({ isActive: true, isWaiting: false });
    });
    // The mock will now return 0, so it should be the first phrase again.
    expect(result.current).toBe(MOCK_WITTY_PHRASES[0]);
  });

  it('should clear phrase interval on unmount when active', () => {
    const { unmount } = renderHook(() => usePhraseCycler(true, false));
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval');
    unmount();
    expect(clearIntervalSpy).toHaveBeenCalledOnce();
  });

  it('should use custom phrases when provided', async () => {
    const customPhrases = ['Custom Phrase 1', 'Custom Phrase 2'];
    // Mock selectRandomPhrase to cycle through phrases deterministically
    const { selectRandomPhrase } = await import('./phraseSelector.js');
    let callCount = 0;
    vi.mocked(selectRandomPhrase).mockImplementation((phrases) => {
      const val = callCount % 2;
      callCount++;
      return phrases[val];
    });

    const { result, rerender } = renderHook(
      ({ isActive, isWaiting, customPhrases: phrases }) =>
        usePhraseCycler(isActive, isWaiting, phrases),
      {
        initialProps: {
          isActive: true,
          isWaiting: false,
          customPhrases,
        },
      },
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current).toBe(customPhrases[0]);

    act(() => {
      vi.advanceTimersByTime(PHRASE_CHANGE_INTERVAL_MS);
    });

    expect(result.current).toBe(customPhrases[1]);

    rerender({ isActive: true, isWaiting: false, customPhrases: undefined });

    expect(MOCK_WITTY_PHRASES).toContain(result.current);
  });

  it('should fall back to witty phrases if custom phrases are an empty array', () => {
    const { result } = renderHook(
      ({ isActive, isWaiting, customPhrases: phrases }) =>
        usePhraseCycler(isActive, isWaiting, phrases),
      {
        initialProps: {
          isActive: true,
          isWaiting: false,
          customPhrases: [],
        },
      },
    );

    expect(MOCK_WITTY_PHRASES).toContain(result.current);
  });

  it('should reset to a witty phrase when transitioning from waiting to active', () => {
    const { result, rerender } = renderHook(
      ({ isActive, isWaiting }) => usePhraseCycler(isActive, isWaiting),
      { initialProps: { isActive: true, isWaiting: false } },
    );

    const _initialPhrase = result.current;
    expect(MOCK_WITTY_PHRASES).toContain(_initialPhrase);

    // Cycle to a different phrase (potentially)
    act(() => {
      vi.advanceTimersByTime(PHRASE_CHANGE_INTERVAL_MS);
    });
    expect(MOCK_WITTY_PHRASES).toContain(result.current);

    // Go to waiting state
    rerender({ isActive: false, isWaiting: true });
    expect(result.current).toBe('Waiting for user confirmation...');

    // Go back to active cycling - should pick a random witty phrase
    rerender({ isActive: true, isWaiting: false });
    expect(MOCK_WITTY_PHRASES).toContain(result.current);
  });

  // Fortune integration tests
  it('should use fortune quote when enableFortunes is true', async () => {
    mockGetFortuneQuote.mockResolvedValue(MOCK_FORTUNE_QUOTE);

    const { result } = renderHook(() =>
      usePhraseCycler(
        true,
        false,
        undefined,
        true,
        '/usr/games/fortune -s -n 45',
      ),
    );

    // Wait for the async fortune call to complete
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current).toBe(MOCK_FORTUNE_QUOTE);
  });

  it('should fall back to static phrase when fortune command fails', async () => {
    mockGetFortuneQuote.mockResolvedValue(null);

    const { result } = renderHook(() =>
      usePhraseCycler(
        true,
        false,
        undefined,
        true,
        '/usr/games/fortune -s -n 45',
      ),
    );

    // Wait for the async fortune call to complete
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current).toBe(MOCK_WITTY_PHRASES[0]);
  });

  it('should use custom fortune command when provided', async () => {
    const customCommand = '/custom/fortune -n 100';
    mockGetFortuneQuote.mockResolvedValue(MOCK_FORTUNE_QUOTE);

    const { result } = renderHook(() =>
      usePhraseCycler(true, false, undefined, true, customCommand),
    );

    // Wait for the async fortune call to complete
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockGetFortuneQuote).toHaveBeenCalledWith(customCommand);
    expect(result.current).toBe(MOCK_FORTUNE_QUOTE);
  });

  it('should not use fortune when enableFortunes is false', async () => {
    mockGetFortuneQuote.mockResolvedValue(MOCK_FORTUNE_QUOTE);

    const { result } = renderHook(() =>
      usePhraseCycler(
        true,
        false,
        undefined,
        false,
        '/usr/games/fortune -s -n 45',
      ),
    );

    // Wait for the async fortune call to complete
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockGetFortuneQuote).not.toHaveBeenCalled();
    expect(result.current).toBe(MOCK_WITTY_PHRASES[0]);
  });

  it('should cycle fortune quotes every 15 seconds when enabled', async () => {
    const firstFortune = 'First fortune quote.';
    const secondFortune = 'Second fortune quote.';

    let callIndex = 0;
    mockGetFortuneQuote.mockImplementation(() => {
      if (callIndex === 0) {
        callIndex++;
        return Promise.resolve(firstFortune);
      }
      return Promise.resolve(secondFortune);
    });

    const { result } = renderHook(() =>
      usePhraseCycler(
        true,
        false,
        undefined,
        true,
        '/usr/games/fortune -s -n 45',
      ),
    );

    // Wait for initial fortune call
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current).toBe(firstFortune);

    // Advance time to trigger next fortune update
    await act(async () => {
      vi.advanceTimersByTime(PHRASE_CHANGE_INTERVAL_MS);
      await Promise.resolve();
    });

    expect(result.current).toBe(secondFortune);
  });

  it('should disable fortune cycling when isActive becomes false', async () => {
    mockGetFortuneQuote.mockResolvedValue(MOCK_FORTUNE_QUOTE);

    const { result, rerender } = renderHook(
      ({ isActive }) =>
        usePhraseCycler(
          isActive,
          false,
          undefined,
          true,
          '/usr/games/fortune -s -n 45',
        ),
      { initialProps: { isActive: true } },
    );

    // Wait for initial fortune call
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current).toBe(MOCK_FORTUNE_QUOTE);
    const callCount = mockGetFortuneQuote.mock.calls.length;

    // Deactivate
    rerender({ isActive: false });

    // Advance time - should not trigger new fortune calls
    await act(async () => {
      vi.advanceTimersByTime(PHRASE_CHANGE_INTERVAL_MS);
      await Promise.resolve();
    });

    expect(mockGetFortuneQuote.mock.calls.length).toBe(callCount);
  });
});
