/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  DEADLINE_ENV,
  RESERVE_ENV,
  DEFAULT_RESERVE_SECONDS,
  reverseAuditBudgetExhausted,
  reverseAuditBudgetMessage,
} from './deadline.js';

const NOW_MS = 1_754_000_000_000;
const NOW_S = NOW_MS / 1000;

describe('reverseAuditBudgetExhausted', () => {
  it('stays silent when no deadline is set — every local run', () => {
    expect(reverseAuditBudgetExhausted({}, NOW_MS)).toBeNull();
    expect(
      reverseAuditBudgetExhausted({ [DEADLINE_ENV]: '' }, NOW_MS),
    ).toBeNull();
  });

  it('lets a round through while the reserve still fits', () => {
    const env = {
      [DEADLINE_ENV]: String(NOW_S + DEFAULT_RESERVE_SECONDS + 60),
    };
    expect(reverseAuditBudgetExhausted(env, NOW_MS)).toBeNull();
  });

  it('refuses a round that would eat the tail reserve', () => {
    const env = {
      [DEADLINE_ENV]: String(NOW_S + DEFAULT_RESERVE_SECONDS - 300),
    };
    const spent = reverseAuditBudgetExhausted(env, NOW_MS);
    expect(spent).toEqual({
      remainingSeconds: DEFAULT_RESERVE_SECONDS - 300,
      reserveSeconds: DEFAULT_RESERVE_SECONDS,
    });
  });

  it('honours a reserve override, in both directions', () => {
    const env = {
      [DEADLINE_ENV]: String(NOW_S + 900),
      [RESERVE_ENV]: '600',
    };
    expect(reverseAuditBudgetExhausted(env, NOW_MS)).toBeNull();
    env[RESERVE_ENV] = '1200';
    expect(reverseAuditBudgetExhausted(env, NOW_MS)).not.toBeNull();
  });

  it('fails OPEN on a malformed deadline — the outer kill still bounds the run', () => {
    for (const bad of ['soon', 'NaN', '-5', '0']) {
      expect(
        reverseAuditBudgetExhausted({ [DEADLINE_ENV]: bad }, NOW_MS),
      ).toBeNull();
    }
  });

  it('ignores a malformed reserve and keeps the default', () => {
    const env = {
      [DEADLINE_ENV]: String(NOW_S + DEFAULT_RESERVE_SECONDS - 1),
      [RESERVE_ENV]: 'an hour',
    };
    const spent = reverseAuditBudgetExhausted(env, NOW_MS);
    expect(spent?.reserveSeconds).toBe(DEFAULT_RESERVE_SECONDS);
  });

  it('reports a past deadline as negative remaining, not a crash', () => {
    const env = { [DEADLINE_ENV]: String(NOW_S - 120) };
    const spent = reverseAuditBudgetExhausted(env, NOW_MS);
    expect(spent?.remainingSeconds).toBe(-120);
  });
});

describe('reverseAuditBudgetMessage', () => {
  it('names the round and carries the exact disclosure entry', () => {
    const msg = reverseAuditBudgetMessage(
      { remainingSeconds: 1500, reserveSeconds: 3600 },
      3,
    );
    expect(msg).toContain('BUDGET:');
    expect(msg).toContain('25 minute(s) remain');
    expect(msg).toContain('60-minute reserve');
    expect(msg).toContain(
      '`reverse audit — stopped before round 3 by the review time budget`',
    );
    expect(msg).toContain('proceed to Step 6');
    expect(msg).toContain('do not relaunch auditors');
  });

  it('says "the next round" when no round number was passed', () => {
    const msg = reverseAuditBudgetMessage(
      { remainingSeconds: -30, reserveSeconds: 3600 },
      undefined,
    );
    expect(msg).toContain('0 minute(s) remain');
    expect(msg).toContain('stopped before the next round');
  });
});
