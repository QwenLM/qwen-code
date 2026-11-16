/**
 * Live READ-ONLY smoke against real Aone (group D of the E2E plan).
 * Opt-in: AONE_LIVE_SMOKE=1. Fetches real comment events through the same
 * parse path the adapter uses; never dispatches, never writes. Requires an
 * authenticated a1 on PATH with access to middleware/tddl5.
 */
import { describe, it, expect } from 'vitest';
import { runA1Json } from './a1-client.js';

const live = process.env['AONE_LIVE_SMOKE'] === '1';

function localDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

describe.skipIf(!live)('live Aone events (read-only)', () => {
  it('fetches and parses real comment events', async () => {
    // a1 0.2.51 requires explicit dates (the FAQ's auto-completion does not
    // hold) — the adapter passes the same 3-day window.
    const until = new Date();
    const since = new Date(
      until.getFullYear(),
      until.getMonth(),
      until.getDate() - 3,
    );
    const raw = await runA1Json<unknown>([
      'events',
      'repo',
      'middleware/tddl5',
      '--type',
      'comments',
      '--since',
      localDate(since),
      '--until',
      localDate(until),
      '--per-page',
      '20',
    ]);
    expect(Array.isArray(raw)).toBe(true);
    const events = raw as Array<{
      id: number;
      note?: { note?: string; noteable_type?: string };
      mergeRequest?: { id?: number };
    }>;
    for (const event of events) {
      expect(typeof event.id).toBe('number');
    }
    // The probed repo always carries MR comment events in a 3-day window;
    // an empty answer here means the parse or the platform drifted.
    expect(events.length).toBeGreaterThan(0);
    expect(
      events.some(
        (e) =>
          e.note?.noteable_type === 'MergeRequest' &&
          typeof e.mergeRequest?.id === 'number' &&
          typeof e.note?.note === 'string',
      ),
    ).toBe(true);
  }, 60_000);
});
