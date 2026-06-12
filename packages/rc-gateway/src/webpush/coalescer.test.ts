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
    expect(c.tryPass('s1', 'permission.required', 'sess', 1000)).toBe(true);
    // 3s later, same (sub, kind, session) -> within 5s window -> suppress.
    expect(c.tryPass('s1', 'permission.required', 'sess', 4000)).toBe(false);
  });

  it('allows again once the window has elapsed', () => {
    const c = new PushCoalescer(5000);
    expect(c.tryPass('s1', 'k', 'sess', 1000)).toBe(true);
    expect(c.tryPass('s1', 'k', 'sess', 5999)).toBe(false); // 4999ms < 5000
    expect(c.tryPass('s1', 'k', 'sess', 6000)).toBe(true); // exactly 5000ms -> not < window
  });

  it('treats different kind / session / subscription as independent keys', () => {
    const c = new PushCoalescer(5000);
    expect(c.tryPass('s1', 'k', 'sess', 1000)).toBe(true);
    expect(c.tryPass('s1', 'OTHER', 'sess', 1100)).toBe(true); // different kind
    expect(c.tryPass('s1', 'k', 'OTHER', 1100)).toBe(true); // different session
    expect(c.tryPass('s2', 'k', 'sess', 1100)).toBe(true); // different subscription
    // ...but each of those now coalesces its own repeat.
    expect(c.tryPass('s1', 'k', 'sess', 1200)).toBe(false);
  });

  it('is disabled (always allows) when the window is 0 or negative', () => {
    for (const w of [0, -1, NaN]) {
      const c = new PushCoalescer(w);
      expect(c.tryPass('s1', 'k', 'sess', 1)).toBe(true);
      expect(c.tryPass('s1', 'k', 'sess', 2)).toBe(true);
      expect(c.tryPass('s1', 'k', 'sess', 3)).toBe(true);
    }
  });

  it('forget clears a subscription windows so its next push passes', () => {
    const c = new PushCoalescer(5000);
    expect(c.tryPass('s1', 'k', 'sess', 1000)).toBe(true);
    expect(c.tryPass('s1', 'k', 'sess', 1100)).toBe(false); // coalesced
    c.forget('s1');
    expect(c.tryPass('s1', 'k', 'sess', 1200)).toBe(true); // window forgotten
  });

  it('forget only clears the named subscription, not others', () => {
    const c = new PushCoalescer(5000);
    c.tryPass('s1', 'k', 'sess', 1000);
    c.tryPass('s2', 'k', 'sess', 1000);
    c.forget('s1');
    expect(c.tryPass('s1', 'k', 'sess', 1100)).toBe(true); // s1 cleared
    expect(c.tryPass('s2', 'k', 'sess', 1100)).toBe(false); // s2 untouched
  });

  it('defaults to the D6 5s window when none is supplied', () => {
    const c = new PushCoalescer();
    expect(DEFAULT_COALESCE_WINDOW_MS).toBe(5000);
    expect(c.tryPass('s1', 'k', 'sess', 0)).toBe(true);
    expect(c.tryPass('s1', 'k', 'sess', 4999)).toBe(false);
    expect(c.tryPass('s1', 'k', 'sess', 5000)).toBe(true);
  });
});
