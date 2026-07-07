/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  createInitialMessageDisplayState,
  stepMessageDisplay,
  MESSAGE_DISPLAY_DEBOUNCE_MS,
} from './message-display-buffer.js';

describe('messageDisplayBuffer', () => {
  describe('createInitialMessageDisplayState', () => {
    it('starts empty with the given clock reading', () => {
      const state = createInitialMessageDisplayState(1000);
      expect(state).toEqual({
        displayedText: '',
        lastFlushMs: 1000,
        lastFlushedText: '',
      });
    });
  });

  describe('stepMessageDisplay', () => {
    it('does not flush a chunk that arrives before the debounce window elapses', () => {
      const initial = createInitialMessageDisplayState(0);
      const step = stepMessageDisplay(initial, 'Hello', 50, 200, false);
      expect(step.flush).toBeUndefined();
      expect(step.next.displayedText).toBe('Hello');
    });

    it('flushes once the debounce window has elapsed and there is new text', () => {
      const initial = createInitialMessageDisplayState(0);
      const step = stepMessageDisplay(initial, 'Hello', 200, 200, false);
      expect(step.flush).toEqual({ displayedText: 'Hello', isFinal: false });
      expect(step.next.lastFlushMs).toBe(200);
      expect(step.next.lastFlushedText).toBe('Hello');
    });

    it('accumulates chunks across non-flushing steps', () => {
      let state = createInitialMessageDisplayState(0);
      state = stepMessageDisplay(state, 'Hel', 10, 200, false).next;
      state = stepMessageDisplay(state, 'lo', 20, 200, false).next;
      expect(state.displayedText).toBe('Hello');
    });

    it('does not flush when due by time but there is no new text since the last flush', () => {
      let state = createInitialMessageDisplayState(0);
      const first = stepMessageDisplay(state, 'Hello', 200, 200, false);
      expect(first.flush).toBeDefined();
      state = first.next;

      // No new chunk arrived, but plenty of time has passed.
      const second = stepMessageDisplay(state, '', 500, 200, false);
      expect(second.flush).toBeUndefined();
    });

    it('always flushes on isFinal, even with an empty chunk and within the debounce window', () => {
      const initial = createInitialMessageDisplayState(0);
      const step = stepMessageDisplay(initial, '', 5, 200, true);
      expect(step.flush).toEqual({ displayedText: '', isFinal: true });
    });

    it('isFinal flush carries the full cumulative text, including the final chunk', () => {
      let state = createInitialMessageDisplayState(0);
      state = stepMessageDisplay(state, 'Hello, ', 10, 200, false).next;
      const final = stepMessageDisplay(state, 'world.', 15, 200, true);
      expect(final.flush).toEqual({
        displayedText: 'Hello, world.',
        isFinal: true,
      });
    });

    it('resets the debounce clock after each flush, independent of the caller-supplied window', () => {
      let state = createInitialMessageDisplayState(0);
      const first = stepMessageDisplay(
        state,
        'a',
        MESSAGE_DISPLAY_DEBOUNCE_MS,
        MESSAGE_DISPLAY_DEBOUNCE_MS,
        false,
      );
      expect(first.flush).toBeDefined();
      state = first.next;

      // Immediately after the flush, a new chunk should NOT flush yet.
      const tooSoon = stepMessageDisplay(
        state,
        'b',
        MESSAGE_DISPLAY_DEBOUNCE_MS + 1,
        MESSAGE_DISPLAY_DEBOUNCE_MS,
        false,
      );
      expect(tooSoon.flush).toBeUndefined();

      // Once the window elapses again, it flushes with everything accumulated.
      state = tooSoon.next;
      const later = stepMessageDisplay(
        state,
        'c',
        2 * MESSAGE_DISPLAY_DEBOUNCE_MS + 1,
        MESSAGE_DISPLAY_DEBOUNCE_MS,
        false,
      );
      expect(later.flush).toEqual({ displayedText: 'abc', isFinal: false });
    });
  });
});
