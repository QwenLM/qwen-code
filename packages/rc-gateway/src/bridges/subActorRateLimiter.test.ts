/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  SubActorRateLimiter,
  SUB_ACTOR_WINDOW_MS,
  CARDINALITY_WINDOW_MS,
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

describe('SubActorRateLimiter — cardinality cap', () => {
  it('allows up to the cap distinct sub-actors per token', () => {
    const rl = new SubActorRateLimiter(
      SUB_ACTOR_WINDOW_MS,
      CARDINALITY_WINDOW_MS,
      3,
    );
    expect(rl.checkCardinality('tok1', 'a', T0).allowed).toBe(true);
    expect(rl.checkCardinality('tok1', 'b', T0).allowed).toBe(true);
    expect(rl.checkCardinality('tok1', 'c', T0).allowed).toBe(true);
    // 4th new sub-actor → rejected
    expect(rl.checkCardinality('tok1', 'd', T0).allowed).toBe(false);
  });

  it('already-seen sub-actors are served even after the cap is hit', () => {
    const rl = new SubActorRateLimiter(
      SUB_ACTOR_WINDOW_MS,
      CARDINALITY_WINDOW_MS,
      2,
    );
    rl.checkCardinality('tok1', 'a', T0);
    rl.checkCardinality('tok1', 'b', T0);
    // cap hit
    expect(rl.checkCardinality('tok1', 'c', T0).allowed).toBe(false);
    // already-seen actors still work
    expect(rl.checkCardinality('tok1', 'a', T0 + 1).allowed).toBe(true);
    expect(rl.checkCardinality('tok1', 'b', T0 + 1).allowed).toBe(true);
  });

  it('cardinality is per-token (different tokens are independent)', () => {
    const rl = new SubActorRateLimiter(
      SUB_ACTOR_WINDOW_MS,
      CARDINALITY_WINDOW_MS,
      1,
    );
    rl.checkCardinality('tok1', 'a', T0);
    // tok1 cap hit
    expect(rl.checkCardinality('tok1', 'b', T0).allowed).toBe(false);
    // tok2 unaffected
    expect(rl.checkCardinality('tok2', 'b', T0).allowed).toBe(true);
  });

  it('sub-actors aged out of the 24 h window free capacity for new ones', () => {
    const cardWin = 1000; // 1 s for test speed
    const rl = new SubActorRateLimiter(SUB_ACTOR_WINDOW_MS, cardWin, 1);
    rl.checkCardinality('tok1', 'a', T0);
    // cap hit at T0+1
    expect(rl.checkCardinality('tok1', 'b', T0 + 1).allowed).toBe(false);
    // after window expires, 'a' is evicted and 'b' can be admitted
    expect(rl.checkCardinality('tok1', 'b', T0 + cardWin + 1).allowed).toBe(
      true,
    );
  });

  it('default cap allows 200 sub-actors', () => {
    const rl = new SubActorRateLimiter();
    for (let i = 0; i < 200; i++) {
      expect(rl.checkCardinality('tok', `user-${i}`, T0).allowed).toBe(true);
    }
    // 201st is rejected
    expect(rl.checkCardinality('tok', 'user-overflow', T0).allowed).toBe(false);
  });
});
