/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  SubActorRateLimiter,
  SUB_ACTOR_WINDOW_MS,
} from './subActorRateLimiter.js';

const T0 = 1_000_000;

describe('SubActorRateLimiter', () => {
  it('allows up to the cap then drops the next', () => {
    const rl = new SubActorRateLimiter();
    const r = [];
    for (let i = 0; i < 4; i++)
      r.push(rl.tryConsume('telegram:alice', 3, T0 + i));
    expect(r.slice(0, 3).every((x) => x.allowed)).toBe(true);
    expect(r[3].allowed).toBe(false);
  });

  it('audits only the transition into the limited state (firstDrop once)', () => {
    const rl = new SubActorRateLimiter();
    rl.tryConsume('u', 1, T0);
    const second = rl.tryConsume('u', 1, T0 + 1);
    const third = rl.tryConsume('u', 1, T0 + 2);
    expect(second).toEqual({ allowed: false, firstDrop: true });
    expect(third).toEqual({ allowed: false, firstDrop: false });
  });

  it('isolates sub-actors (one rude user does not throttle another)', () => {
    const rl = new SubActorRateLimiter();
    expect(rl.tryConsume('a', 1, T0).allowed).toBe(true);
    expect(rl.tryConsume('a', 1, T0 + 1).allowed).toBe(false); // a at cap
    expect(rl.tryConsume('b', 1, T0 + 2).allowed).toBe(true); // b unaffected
  });

  it('frees budget once writes age out of the window', () => {
    const rl = new SubActorRateLimiter();
    expect(rl.tryConsume('u', 1, T0).allowed).toBe(true);
    expect(rl.tryConsume('u', 1, T0 + 1).allowed).toBe(false);
    const after = rl.tryConsume('u', 1, T0 + SUB_ACTOR_WINDOW_MS + 1);
    expect(after.allowed).toBe(true);
  });

  it('forget() clears a sub-actor window', () => {
    const rl = new SubActorRateLimiter();
    rl.tryConsume('u', 1, T0);
    expect(rl.tryConsume('u', 1, T0 + 1).allowed).toBe(false);
    rl.forget('u');
    expect(rl.tryConsume('u', 1, T0 + 2).allowed).toBe(true);
  });

  it('honors a custom window', () => {
    const rl = new SubActorRateLimiter(10);
    expect(rl.tryConsume('u', 1, T0).allowed).toBe(true);
    expect(rl.tryConsume('u', 1, T0 + 5).allowed).toBe(false);
    expect(rl.tryConsume('u', 1, T0 + 11).allowed).toBe(true); // aged out
  });
});
