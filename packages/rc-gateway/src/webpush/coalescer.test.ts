/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { PushCoalescer, DEFAULT_COALESCE_WINDOW_MS } from './coalescer.js';

describe('PushCoalescer', () => {
  it('allows the first push and suppresses a same-key repeat within the window', () => {
    const c = new PushCoalescer(5000);
    expect(c.tryPass('s1', 'permission.required', 'sess', 1000).allowed).toBe(
      true,
    );
    // 3s later, same (sub, kind, session) -> within 5s window -> suppress.
    expect(c.tryPass('s1', 'permission.required', 'sess', 4000).allowed).toBe(
      false,
    );
  });

  it('allows again once the window has elapsed (anchored on last ALLOWED)', () => {
    const c = new PushCoalescer(5000);
    expect(c.tryPass('s1', 'k', 'sess', 1000).allowed).toBe(true);
    expect(c.tryPass('s1', 'k', 'sess', 5999).allowed).toBe(false); // 4999ms < 5000
    expect(c.tryPass('s1', 'k', 'sess', 6000).allowed).toBe(true); // exactly 5000ms -> not < window
  });

  it('firstSuppress is true only on the FIRST drop of a burst (audit-once)', () => {
    const c = new PushCoalescer(5000);
    expect(c.tryPass('s1', 'k', 'sess', 1000)).toEqual({
      allowed: true,
      firstSuppress: false,
    });
    expect(c.tryPass('s1', 'k', 'sess', 2000)).toEqual({
      allowed: false,
      firstSuppress: true,
    });
    // Further drops in the same window do NOT re-flag firstSuppress.
    expect(c.tryPass('s1', 'k', 'sess', 3000)).toEqual({
      allowed: false,
      firstSuppress: false,
    });
    expect(c.tryPass('s1', 'k', 'sess', 4000)).toEqual({
      allowed: false,
      firstSuppress: false,
    });
    // After the window, an allow resets, so the next drop re-flags firstSuppress.
    expect(c.tryPass('s1', 'k', 'sess', 6001).allowed).toBe(true);
    expect(c.tryPass('s1', 'k', 'sess', 7000)).toEqual({
      allowed: false,
      firstSuppress: true,
    });
  });

  it('treats different kind / session / subscription as independent keys', () => {
    const c = new PushCoalescer(5000);
    expect(c.tryPass('s1', 'k', 'sess', 1000).allowed).toBe(true);
    expect(c.tryPass('s1', 'OTHER', 'sess', 1100).allowed).toBe(true); // different kind
    expect(c.tryPass('s1', 'k', 'OTHER', 1100).allowed).toBe(true); // different session
    expect(c.tryPass('s2', 'k', 'sess', 1100).allowed).toBe(true); // different subscription
    // ...but each of those now coalesces its own repeat.
    expect(c.tryPass('s1', 'k', 'sess', 1200).allowed).toBe(false);
  });

  it('is disabled (always allows) when the window is 0 or negative', () => {
    for (const w of [0, -1, NaN]) {
      const c = new PushCoalescer(w);
      expect(c.tryPass('s1', 'k', 'sess', 1).allowed).toBe(true);
      expect(c.tryPass('s1', 'k', 'sess', 2).allowed).toBe(true);
      expect(c.tryPass('s1', 'k', 'sess', 3).allowed).toBe(true);
    }
  });

  it('forget clears a subscription windows so its next push passes', () => {
    const c = new PushCoalescer(5000);
    expect(c.tryPass('s1', 'k', 'sess', 1000).allowed).toBe(true);
    expect(c.tryPass('s1', 'k', 'sess', 1100).allowed).toBe(false); // coalesced
    c.forget('s1');
    expect(c.tryPass('s1', 'k', 'sess', 1200).allowed).toBe(true); // window forgotten
  });

  it('forget only clears the named subscription, not others', () => {
    const c = new PushCoalescer(5000);
    c.tryPass('s1', 'k', 'sess', 1000);
    c.tryPass('s2', 'k', 'sess', 1000);
    c.forget('s1');
    expect(c.tryPass('s1', 'k', 'sess', 1100).allowed).toBe(true); // s1 cleared
    expect(c.tryPass('s2', 'k', 'sess', 1100).allowed).toBe(false); // s2 untouched
  });

  it('defaults to the D6 5s window when none is supplied', () => {
    const c = new PushCoalescer();
    expect(DEFAULT_COALESCE_WINDOW_MS).toBe(5000);
    expect(c.tryPass('s1', 'k', 'sess', 0).allowed).toBe(true);
    expect(c.tryPass('s1', 'k', 'sess', 4999).allowed).toBe(false);
    expect(c.tryPass('s1', 'k', 'sess', 5000).allowed).toBe(true);
  });
});
