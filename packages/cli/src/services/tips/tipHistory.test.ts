/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { TipHistory } from './tipHistory.js';

function tmpPath(): string {
  return join(
    tmpdir(),
    `test-tip-history-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
}

function createHistory(sessionCount = 1): TipHistory {
  return new TipHistory({ sessionCount, tips: {} }, tmpPath());
}

describe('TipHistory', () => {
  describe('isCooledDown', () => {
    it('returns true when tip was never shown', () => {
      const history = createHistory();
      expect(history.isCooledDown('any-tip', 5, 10)).toBe(true);
    });

    it('returns false when within cooldown period', () => {
      const history = createHistory();
      history.recordShown('tip-a', 3);
      // currentPrompt=5, lastShown=3, diff=2 < cooldown=5
      expect(history.isCooledDown('tip-a', 5, 5)).toBe(false);
    });

    it('returns true when cooldown period has passed', () => {
      const history = createHistory();
      history.recordShown('tip-a', 3);
      // currentPrompt=8, lastShown=3, diff=5 >= cooldown=5
      expect(history.isCooledDown('tip-a', 5, 8)).toBe(true);
    });

    it('returns true when cooldownPrompts is 0 even if just shown', () => {
      const history = createHistory();
      history.recordShown('tip-a', 5);
      // cooldown=0, currentPrompt=5, lastShown=5, diff=0 >= 0
      expect(history.isCooledDown('tip-a', 0, 5)).toBe(true);
    });

    it('handles exact boundary (diff equals cooldown)', () => {
      const history = createHistory();
      history.recordShown('tip-a', 3);
      // diff = 6 - 3 = 3 >= cooldown 3
      expect(history.isCooledDown('tip-a', 3, 6)).toBe(true);
    });
  });

  describe('getLastShown', () => {
    it('returns 0 for never-shown tip', () => {
      const history = createHistory();
      expect(history.getLastShown('unknown')).toBe(0);
    });

    it('returns high score after recordShown (session-shown offset)', () => {
      const history = createHistory();
      history.recordShown('tip-a', 7);
      // Session-shown tips get Number.MAX_SAFE_INTEGER - 1_000_000 + promptCount
      expect(history.getLastShown('tip-a')).toBe(
        Number.MAX_SAFE_INTEGER - 1_000_000 + 7,
      );
    });

    it('updates on subsequent recordShown calls', () => {
      const history = createHistory();
      history.recordShown('tip-a', 3);
      history.recordShown('tip-a', 10);
      expect(history.getLastShown('tip-a')).toBe(
        Number.MAX_SAFE_INTEGER - 1_000_000 + 10,
      );
    });

    it('falls back to lastSessionTimestamp from cross-session data when session has no record', () => {
      const history = new TipHistory(
        {
          sessionCount: 5,
          tips: { 'tip-x': { totalShown: 3, lastSessionTimestamp: 1000 } },
        },
        tmpPath(),
      );
      // No sessionShown record, so fallback to lastSessionTimestamp=1000
      expect(history.getLastShown('tip-x')).toBe(1000);
    });

    it('session-shown tips always sort after cross-session-only tips', () => {
      const history = new TipHistory(
        {
          sessionCount: 5,
          tips: {
            'tip-old': { totalShown: 999, lastSessionTimestamp: Date.now() },
          },
        },
        tmpPath(),
      );
      history.recordShown('tip-new', 0);
      // tip-old: cross-session only → 999
      // tip-new: session-shown → 1_000_000
      expect(history.getLastShown('tip-old')).toBeLessThan(
        history.getLastShown('tip-new'),
      );
    });
  });

  describe('sessionCount', () => {
    it('exposes sessionCount from data', () => {
      const history = createHistory(42);
      expect(history.sessionCount).toBe(42);
    });
  });
});
