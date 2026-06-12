/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  QuietDigestWatcher,
  type QuietDigestRecord,
} from './quietDigestWatcher.js';

// A subscription quiet 22:00 -> 07:00 UTC (a wrap window, from > to).
const QUIET_WRAP: QuietDigestRecord = {
  id: 'sub-1',
  quietHours: { from: '22:00', to: '07:00', timezone: 'UTC' },
};
// A non-wrap window 09:00 -> 17:00 UTC.
const QUIET_DAY: QuietDigestRecord = {
  id: 'sub-2',
  quietHours: { from: '09:00', to: '17:00', timezone: 'UTC' },
};

const at = (iso: string): Date => new Date(iso);

/** Run a tick and return the ids fired. */
function tick(
  w: QuietDigestWatcher,
  records: QuietDigestRecord[],
  now: Date,
): string[] {
  const fired: string[] = [];
  w.tick(records, now, (id) => fired.push(id));
  return fired;
}

describe('QuietDigestWatcher', () => {
  it('never fires on the first sighting, even mid-quiet (boot init)', () => {
    const w = new QuietDigestWatcher();
    // 02:00 UTC is inside the 22:00->07:00 wrap window.
    expect(tick(w, [QUIET_WRAP], at('2026-06-09T02:00:00Z'))).toEqual([]);
  });

  it('fires exactly once on the quiet -> not-quiet exit', () => {
    const w = new QuietDigestWatcher();
    // mid-quiet (seed) -> still quiet -> exit at 07:01.
    expect(tick(w, [QUIET_WRAP], at('2026-06-09T02:00:00Z'))).toEqual([]);
    expect(tick(w, [QUIET_WRAP], at('2026-06-09T06:30:00Z'))).toEqual([]);
    expect(tick(w, [QUIET_WRAP], at('2026-06-09T07:01:00Z'))).toEqual([
      'sub-1',
    ]);
  });

  it('does not re-fire on the tick after firing', () => {
    const w = new QuietDigestWatcher();
    tick(w, [QUIET_WRAP], at('2026-06-09T02:00:00Z')); // seed quiet
    expect(tick(w, [QUIET_WRAP], at('2026-06-09T07:01:00Z'))).toEqual([
      'sub-1',
    ]);
    // Next tick: still outside the window, must NOT fire again.
    expect(tick(w, [QUIET_WRAP], at('2026-06-09T07:02:00Z'))).toEqual([]);
  });

  it('marches across a wrap window without a spurious midnight/double fire', () => {
    const w = new QuietDigestWatcher();
    // Enter at 21:00 (not quiet), then quiet across midnight, exit at 07:00+.
    expect(tick(w, [QUIET_WRAP], at('2026-06-09T21:00:00Z'))).toEqual([]); // seed not-quiet
    expect(tick(w, [QUIET_WRAP], at('2026-06-09T22:30:00Z'))).toEqual([]); // enter quiet
    expect(tick(w, [QUIET_WRAP], at('2026-06-09T23:59:00Z'))).toEqual([]); // still quiet
    expect(tick(w, [QUIET_WRAP], at('2026-06-10T00:01:00Z'))).toEqual([]); // crossed midnight, still quiet
    expect(tick(w, [QUIET_WRAP], at('2026-06-10T03:00:00Z'))).toEqual([]); // still quiet
    expect(tick(w, [QUIET_WRAP], at('2026-06-10T07:30:00Z'))).toEqual([
      'sub-1',
    ]); // exit — single fire
  });

  it('does not fire while staying quiet across many ticks', () => {
    const w = new QuietDigestWatcher();
    tick(w, [QUIET_WRAP], at('2026-06-09T22:30:00Z')); // seed quiet
    for (const t of ['23:00', '23:59']) {
      expect(tick(w, [QUIET_WRAP], at(`2026-06-09T${t}:00Z`))).toEqual([]);
    }
    for (const t of ['00:30', '03:00', '06:59']) {
      expect(tick(w, [QUIET_WRAP], at(`2026-06-10T${t}:00Z`))).toEqual([]);
    }
  });

  it('enter -> no fire, exit -> fire for a non-wrap window', () => {
    const w = new QuietDigestWatcher();
    expect(tick(w, [QUIET_DAY], at('2026-06-09T08:00:00Z'))).toEqual([]); // seed not-quiet
    expect(tick(w, [QUIET_DAY], at('2026-06-09T10:00:00Z'))).toEqual([]); // enter
    expect(tick(w, [QUIET_DAY], at('2026-06-09T17:30:00Z'))).toEqual(['sub-2']); // exit
  });

  it('fails open on a missing/invalid quiet window (never quiet, never fires)', () => {
    const w = new QuietDigestWatcher();
    const noWindow: QuietDigestRecord = { id: 'n' };
    const bad: QuietDigestRecord = {
      id: 'b',
      quietHours: { from: '99:99', to: 'xx:xx', timezone: 'Nowhere/Void' },
    };
    expect(tick(w, [noWindow, bad], at('2026-06-09T02:00:00Z'))).toEqual([]);
    expect(tick(w, [noWindow, bad], at('2026-06-09T12:00:00Z'))).toEqual([]);
  });

  it('prunes state for subscriptions no longer present', () => {
    const w = new QuietDigestWatcher();
    tick(w, [QUIET_WRAP], at('2026-06-09T02:00:00Z')); // seed sub-1 quiet
    // sub-1 disappears; later it reappears already mid-quiet — must be re-seeded
    // (no fire), proving its old "quiet" state was pruned.
    expect(tick(w, [], at('2026-06-09T07:30:00Z'))).toEqual([]);
    expect(tick(w, [QUIET_WRAP], at('2026-06-09T08:00:00Z'))).toEqual([]); // re-seed not-quiet
    expect(tick(w, [QUIET_WRAP], at('2026-06-09T23:00:00Z'))).toEqual([]); // enter quiet again
  });

  it('forget drops a subscription edge state', () => {
    const w = new QuietDigestWatcher();
    tick(w, [QUIET_WRAP], at('2026-06-09T02:00:00Z')); // seed quiet
    w.forget('sub-1');
    // After forget, the exit tick re-seeds (not-quiet) rather than firing.
    expect(tick(w, [QUIET_WRAP], at('2026-06-09T07:30:00Z'))).toEqual([]);
  });
});
