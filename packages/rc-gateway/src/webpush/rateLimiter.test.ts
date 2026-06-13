/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { PushRateLimiter, DEFAULT_MAX_PER_HOUR } from './rateLimiter.js';

const T0 = 1_000_000;
const HOUR = 3_600_000;

describe('PushRateLimiter', () => {
  it('allows up to the cap then drops (spec: maxPerHour 5, 6th dropped)', () => {
    const rl = new PushRateLimiter();
    const results = [];
    for (let i = 0; i < 6; i++) {
      results.push(rl.tryConsume('s1', 5, T0 + i)); // 6 events within the hour
    }
    expect(results.slice(0, 5).every((r) => r.allowed)).toBe(true);
    expect(results[5].allowed).toBe(false); // the 6th is dropped
  });

  it('audits only the TRANSITION into rate-limited (firstDrop once)', () => {
    const rl = new PushRateLimiter();
    for (let i = 0; i < 2; i++) rl.tryConsume('s1', 2, T0 + i); // fill the cap
    const sixth = rl.tryConsume('s1', 2, T0 + 2);
    const seventh = rl.tryConsume('s1', 2, T0 + 3);
    expect(sixth).toEqual({ allowed: false, firstDrop: true }); // first drop audits
    expect(seventh).toEqual({ allowed: false, firstDrop: false }); // no re-audit
  });

  it('remaining() reports unconsumed budget WITHOUT consuming a slot', () => {
    const rl = new PushRateLimiter();
    expect(rl.remaining('s1', 5, T0)).toBe(5); // untouched session → full cap
    // Reading does not consume: a subsequent read is still full.
    expect(rl.remaining('s1', 5, T0)).toBe(5);
    rl.tryConsume('s1', 5, T0);
    rl.tryConsume('s1', 5, T0 + 1);
    expect(rl.remaining('s1', 5, T0 + 2)).toBe(3); // 5 - 2 consumed
    // Clamped at 0 when over cap (never negative).
    for (let i = 0; i < 10; i++) rl.tryConsume('s1', 5, T0 + 3 + i);
    expect(rl.remaining('s1', 5, T0 + 20)).toBe(0);
    // Aged-out instants free budget again.
    expect(rl.remaining('s1', 5, T0 + HOUR + 100)).toBe(5);
  });

  it('frees a slot once an instant ages out of the window', () => {
    const rl = new PushRateLimiter();
    expect(rl.tryConsume('s1', 1, T0).allowed).toBe(true);
    expect(rl.tryConsume('s1', 1, T0 + 1).allowed).toBe(false); // at cap
    // 1h + 1ms later the lone instant has aged out → room again.
    const after = rl.tryConsume('s1', 1, T0 + HOUR + 1);
    expect(after.allowed).toBe(true);
  });

  it('re-audits a new storm episode after the window recovers', () => {
    const rl = new PushRateLimiter();
    rl.tryConsume('s1', 1, T0); // fill
    expect(rl.tryConsume('s1', 1, T0 + 1).firstDrop).toBe(true); // episode 1 drop
    // window recovers → an allowed send clears the dropping flag
    expect(rl.tryConsume('s1', 1, T0 + HOUR + 1).allowed).toBe(true);
    // fills again, next drop is a fresh transition
    expect(rl.tryConsume('s1', 1, T0 + HOUR + 2).firstDrop).toBe(true);
  });

  it('isolates subscriptions', () => {
    const rl = new PushRateLimiter();
    expect(rl.tryConsume('s1', 1, T0).allowed).toBe(true);
    expect(rl.tryConsume('s1', 1, T0 + 1).allowed).toBe(false); // s1 capped
    expect(rl.tryConsume('s2', 1, T0 + 1).allowed).toBe(true); // s2 independent
  });

  it('forget() resets a subscription window', () => {
    const rl = new PushRateLimiter();
    rl.tryConsume('s1', 1, T0);
    expect(rl.tryConsume('s1', 1, T0 + 1).allowed).toBe(false);
    rl.forget('s1');
    expect(rl.tryConsume('s1', 1, T0 + 2).allowed).toBe(true); // window cleared
  });

  it('exports a sane default cap', () => {
    expect(DEFAULT_MAX_PER_HOUR).toBe(30);
  });
});
