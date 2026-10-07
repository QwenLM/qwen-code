/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  automationSlots,
  compileCron,
  cronMatches,
  isSlot,
  resolvesTimezone,
  slotOccurrenceKey,
  wallClock,
} from './managed-automation-slots.js';
import { ManagedSessionRecordError } from './managed-session-records.js';

interface SlotCase {
  id: string;
  cron: string;
  timezone: string;
  after: string;
  until: string;
  limit: number;
  slots: string[];
  truncated: boolean;
}
interface WallCase {
  instant: string;
  timezone: string;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
  offsetMinutes: number;
}
const fixtures = JSON.parse(
  readFileSync(
    new URL(
      './contracts/managed-automation-slots-v1.fixtures.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as {
  contract: string;
  timezones: string[];
  cases: SlotCase[];
  wallClocks: WallCase[];
};

const at = (iso: string) => Date.parse(iso);
const iso = (ms: number) => `${new Date(ms).toISOString().slice(0, 19)}Z`;

describe('automation slots contract', () => {
  it('pins the contract name and resolves every anchored zone', () => {
    expect(fixtures.contract).toBe('managed-automation-slots/1');
    for (const zone of fixtures.timezones) {
      expect({ zone, resolves: resolvesTimezone(zone) }).toEqual({
        zone,
        resolves: true,
      });
    }
    expect(resolvesTimezone('Mars/Olympus_Mons')).toBe(false);
  });

  it('replays every shared slot case', () => {
    expect(fixtures.cases.length).toBeGreaterThan(20);
    for (const slotCase of fixtures.cases) {
      const result = automationSlots({
        cron: slotCase.cron,
        timezone: slotCase.timezone,
        afterMs: at(slotCase.after),
        untilMs: at(slotCase.until),
        limit: slotCase.limit,
      });
      expect({
        id: slotCase.id,
        slots: result.slots.map(iso),
        truncated: result.truncated,
      }).toEqual({
        id: slotCase.id,
        slots: slotCase.slots,
        truncated: slotCase.truncated,
      });
    }
  });

  it('replays every shared wall clock', () => {
    for (const wall of fixtures.wallClocks) {
      const { instant, timezone, ...expected } = wall;
      expect(
        wallClock(at(instant), timezone),
        `${instant} ${timezone}`,
      ).toEqual(expected);
    }
  });
});

describe('automation slots evaluator', () => {
  it('expands the H6a grammar into matched values', () => {
    const matcher = compileCron('5/15 9-10,22 1 * 7');
    expect([...matcher.minute]).toEqual([5, 20, 35, 50]);
    expect([...matcher.hour]).toEqual([9, 10, 22]);
    expect([...matcher.dayOfMonth]).toEqual([1]);
    expect([...matcher.month]).toHaveLength(12);
    expect([...matcher.dayOfWeek]).toEqual([0]);
    expect(matcher.dayOfMonthWild).toBe(false);
    expect(matcher.dayOfWeekWild).toBe(false);
    expect(compileCron('* * */2 * *').dayOfMonthWild).toBe(true);
  });

  it('refuses what the contract refuses', () => {
    for (const expression of [
      '* * * *',
      '60 * * * *',
      '* * 0 * *',
      '* * * 13 *',
      '* * * * 8',
      '*/0 * * * *',
      '5-5 * * * *',
      '9-5 * * * *',
    ]) {
      expect(() => compileCron(expression)).toThrow(ManagedSessionRecordError);
    }
  });

  it('matches a day under Vixie semantics', () => {
    const either = compileCron('0 0 1 * 1');
    const monday = { minute: 0, hour: 0, day: 8, month: 6, weekday: 1 };
    const first = { minute: 0, hour: 0, day: 1, month: 7, weekday: 3 };
    const neither = { minute: 0, hour: 0, day: 9, month: 6, weekday: 2 };
    expect(cronMatches(either, monday)).toBe(true);
    expect(cronMatches(either, first)).toBe(true);
    expect(cronMatches(either, neither)).toBe(false);
    const both = compileCron('0 0 1 * */1');
    expect(cronMatches(both, monday)).toBe(false);
    expect(cronMatches(both, first)).toBe(true);
  });

  it('fires a skipped wall-clock minute once, after the gap', () => {
    const matcher = compileCron('30 2 * * *');
    // 2026-03-08 02:30 America/New_York does not exist; 07:00Z follows.
    expect(
      isSlot(matcher, 'America/New_York', at('2026-03-08T06:59:00Z')),
    ).toBe(false);
    expect(
      isSlot(matcher, 'America/New_York', at('2026-03-08T07:00:00Z')),
    ).toBe(true);
    expect(
      isSlot(matcher, 'America/New_York', at('2026-03-08T07:01:00Z')),
    ).toBe(false);
  });

  it('fires a repeated wall-clock minute once, at its first instant', () => {
    const matcher = compileCron('30 1 * * *');
    // 2026-11-01 01:30 America/New_York happens at 05:30Z and 06:30Z.
    expect(
      isSlot(matcher, 'America/New_York', at('2026-11-01T05:30:00Z')),
    ).toBe(true);
    expect(
      isSlot(matcher, 'America/New_York', at('2026-11-01T06:30:00Z')),
    ).toBe(false);
    // The fold never hides an ordinary day.
    expect(
      isSlot(matcher, 'America/New_York', at('2026-11-02T06:30:00Z')),
    ).toBe(true);
  });

  it('keeps the newest slots when the window overflows the limit', () => {
    const result = automationSlots({
      cron: '* * * * *',
      timezone: 'UTC',
      afterMs: at('2026-01-05T10:00:00Z'),
      untilMs: at('2026-01-05T10:10:00Z'),
      limit: 2,
    });
    expect(result.slots.map(iso)).toEqual([
      '2026-01-05T10:09:00Z',
      '2026-01-05T10:10:00Z',
    ]);
    expect(result.truncated).toBe(true);
  });

  it('refuses a window it cannot evaluate', () => {
    expect(() =>
      automationSlots({
        cron: '* * * * *',
        timezone: 'Mars/Olympus_Mons',
        afterMs: 0,
        untilMs: 60_000,
        limit: 1,
      }),
    ).toThrow(/does not resolve/);
    expect(() =>
      automationSlots({
        cron: '* * * * *',
        timezone: 'UTC',
        afterMs: 0,
        untilMs: 60_000,
        limit: 0,
      }),
    ).toThrow(/positive limit/);
  });

  it('canonicalizes a slot into its occurrence key', () => {
    expect(slotOccurrenceKey(at('2026-03-08T07:00:00Z'))).toBe(
      'schedule:2026-03-08T07:00:00Z',
    );
    expect(() => slotOccurrenceKey(at('2026-03-08T07:00:30Z'))).toThrow(
      /whole-minute/,
    );
  });
});
