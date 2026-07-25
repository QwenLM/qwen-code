/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  buildCron,
  describeCron,
  describeLastRun,
  formatCountdown,
  parseCronToBuilder,
  parseHhmm,
  type BuilderState,
  type TranslateFn,
} from './scheduledTasksSchedule';

// Fake t: echoes the key with its interpolation vars so assertions can check
// both which message was chosen and the values passed in. weekdayNames returns
// a real comma-joined list so describeCron's weekly branch can index it.
const t: TranslateFn = (key, vars) => {
  if (key === 'scheduledTasks.weekdayNames')
    return 'Sun,Mon,Tue,Wed,Thu,Fri,Sat';
  if (!vars) return key;
  const parts = Object.entries(vars)
    .map(([k, v]) => `${k}=${v}`)
    .join(',');
  return `${key}(${parts})`;
};

const builder = (over: Partial<BuilderState>): BuilderState => ({
  frequency: 'daily',
  time: '09:00',
  weekday: 1,
  minuteInterval: 30,
  customCron: '0 9 * * *',
  ...over,
});

describe('parseHhmm', () => {
  it('parses valid HH:MM', () => {
    expect(parseHhmm('09:30')).toEqual({ hh: 9, mm: 30 });
    expect(parseHhmm('23:59')).toEqual({ hh: 23, mm: 59 });
    expect(parseHhmm('0:05')).toEqual({ hh: 0, mm: 5 });
  });
  it('rejects out-of-range and malformed values', () => {
    expect(parseHhmm('24:00')).toBeNull();
    expect(parseHhmm('12:60')).toBeNull();
    expect(parseHhmm('9:5')).toBeNull(); // minutes must be two digits
    expect(parseHhmm('abc')).toBeNull();
    expect(parseHhmm('')).toBeNull();
  });
});

describe('buildCron', () => {
  it('builds each frequency shape', () => {
    expect(buildCron(builder({ frequency: 'daily', time: '09:30' }))).toBe(
      '30 9 * * *',
    );
    expect(buildCron(builder({ frequency: 'weekdays', time: '12:30' }))).toBe(
      '30 12 * * 1-5',
    );
    expect(
      buildCron(builder({ frequency: 'weekly', time: '10:00', weekday: 1 })),
    ).toBe('0 10 * * 1');
    expect(buildCron(builder({ frequency: 'hourly', time: '00:07' }))).toBe(
      '7 * * * *',
    );
    expect(
      buildCron(builder({ frequency: 'minutes', minuteInterval: 15 })),
    ).toBe('*/15 * * * *');
    expect(
      buildCron(builder({ frequency: 'custom', customCron: '0 9 * * 1-5' })),
    ).toBe('0 9 * * 1-5');
  });
  it('returns null for invalid inputs', () => {
    expect(
      buildCron(builder({ frequency: 'custom', customCron: '   ' })),
    ).toBeNull();
    expect(
      buildCron(builder({ frequency: 'minutes', minuteInterval: 0 })),
    ).toBeNull();
    expect(
      buildCron(builder({ frequency: 'minutes', minuteInterval: 60 })),
    ).toBeNull();
    // Non-divisors of 60 are rejected — */45 would not mean "every 45 minutes".
    expect(
      buildCron(builder({ frequency: 'minutes', minuteInterval: 45 })),
    ).toBeNull();
    expect(
      buildCron(builder({ frequency: 'daily', time: '25:00' })),
    ).toBeNull();
  });
});

describe('describeCron', () => {
  it('labels the builder-emitted shapes', () => {
    expect(describeCron('0 9 * * *', t)).toBe(
      'scheduledTasks.human.daily(time=09:00)',
    );
    expect(describeCron('30 12 * * 1-5', t)).toBe(
      'scheduledTasks.human.weekdays(time=12:30)',
    );
    expect(describeCron('0 9 * * 1', t)).toBe(
      'scheduledTasks.human.weekly(day=Mon,time=09:00)',
    );
    expect(describeCron('0 9 * * 0', t)).toBe(
      'scheduledTasks.human.weekly(day=Sun,time=09:00)',
    );
    // Cron allows 7 as an alternate notation for Sunday.
    expect(describeCron('0 9 * * 7', t)).toBe(
      'scheduledTasks.human.weekly(day=Sun,time=09:00)',
    );
    expect(describeCron('15 * * * *', t)).toBe(
      'scheduledTasks.human.hourly(min=15)',
    );
    expect(describeCron('*/30 * * * *', t)).toBe(
      'scheduledTasks.human.everyMinutes(n=30)',
    );
  });
  it('falls back to the raw expression for anything else', () => {
    expect(describeCron('0 0 1 1 *', t)).toBe('0 0 1 1 *'); // day-of-month pinned
    expect(describeCron('0 9 * * 1-3', t)).toBe('0 9 * * 1-3'); // weekday range
    expect(describeCron('not a cron', t)).toBe('not a cron'); // not 5 fields
    // Non-divisor */N: fires irregularly, so it is not labeled "every N min".
    expect(describeCron('*/45 * * * *', t)).toBe('*/45 * * * *');
    expect(describeCron('*/7 * * * *', t)).toBe('*/7 * * * *');
  });
});

describe('parseCronToBuilder', () => {
  // The load-bearing property: for every shape the pickers can represent,
  // reversing then rebuilding must yield the exact same cron — otherwise
  // opening the edit form would silently rewrite the schedule.
  it('round-trips every builder-representable shape', () => {
    for (const cron of [
      '*/15 * * * *',
      '*/1 * * * *',
      '30 * * * *', // hourly at :30 — minute rides in `time`
      '0 * * * *', // hourly at :00
      '0 9 * * *', // daily
      '30 8 * * 1-5', // weekdays
      '0 9 * * 3', // weekly (Wed)
      '0 9 * * 0', // weekly (Sun, canonical 0)
    ]) {
      expect(buildCron(parseCronToBuilder(cron))).toBe(cron);
    }
  });

  it('maps recognized shapes onto the right pickers', () => {
    expect(parseCronToBuilder('*/15 * * * *')).toMatchObject({
      frequency: 'minutes',
      minuteInterval: 15,
    });
    expect(parseCronToBuilder('30 * * * *')).toMatchObject({
      frequency: 'hourly',
      time: '00:30',
    });
    expect(parseCronToBuilder('0 9 * * *')).toMatchObject({
      frequency: 'daily',
      time: '09:00',
    });
    expect(parseCronToBuilder('30 8 * * 1-5')).toMatchObject({
      frequency: 'weekdays',
      time: '08:30',
    });
    expect(parseCronToBuilder('0 9 * * 3')).toMatchObject({
      frequency: 'weekly',
      time: '09:00',
      weekday: 3,
    });
  });

  it('normalizes Sunday-as-7 to weekday 0', () => {
    const b = parseCronToBuilder('0 9 * * 7');
    expect(b).toMatchObject({ frequency: 'weekly', weekday: 0 });
    // Rebuilds to the canonical Sunday form.
    expect(buildCron(b)).toBe('0 9 * * 0');
  });

  it('falls back to custom for anything the pickers cannot represent', () => {
    for (const cron of [
      '*/45 * * * *', // non-divisor of 60
      '*/7 * * * *', // non-divisor of 60
      '0 9 * * 1,3,5', // day-of-week list
      '0 9 1 * *', // day-of-month
      '0 9,17 * * *', // hour list
      '99 9 * * *', // minute out of range
      '0 33 * * *', // hour out of range
      'not a cron',
    ]) {
      const b = parseCronToBuilder(cron);
      expect(b.frequency).toBe('custom');
      expect(b.customCron).toBe(cron);
    }
  });

  it('handles surrounding whitespace and blank input', () => {
    expect(parseCronToBuilder('  0 9 * * *  ')).toMatchObject({
      frequency: 'daily',
      time: '09:00',
    });
    // Blank falls back to custom with a safe default expression.
    expect(parseCronToBuilder('   ')).toMatchObject({ frequency: 'custom' });
  });
});

describe('formatCountdown', () => {
  // Real-ish t: maps the unit/dueNow keys to short words so assertions read
  // like the rendered pill.
  const tc: TranslateFn = (key) =>
    ({
      'scheduledTasks.dueNow': 'due',
      'scheduledTasks.dur.d': 'd',
      'scheduledTasks.dur.h': 'h',
      'scheduledTasks.dur.m': 'm',
      'scheduledTasks.dur.s': 's',
    })[key] ?? key;

  const S = 1000;
  const M = 60 * S;
  const H = 60 * M;
  const D = 24 * H;

  it('reads "due" at or past zero', () => {
    expect(formatCountdown(0, tc)).toBe('due');
    expect(formatCountdown(-5000, tc)).toBe('due');
  });

  it('shows the two most-significant units', () => {
    expect(formatCountdown(45 * S, tc)).toBe('45s');
    expect(formatCountdown(5 * M + 20 * S, tc)).toBe('5m 20s');
    expect(formatCountdown(3 * H + 12 * M, tc)).toBe('3h 12m');
    expect(formatCountdown(2 * D + 5 * H, tc)).toBe('2d 5h');
    expect(formatCountdown(1 * M + 30 * S, tc)).toBe('1m 30s');
  });

  it('drops a zero secondary unit', () => {
    expect(formatCountdown(3 * H, tc)).toBe('3h');
    expect(formatCountdown(2 * D, tc)).toBe('2d');
    expect(formatCountdown(5 * M, tc)).toBe('5m');
  });

  it('floors sub-second remainders into the seconds bucket', () => {
    expect(formatCountdown(999, tc)).toBe('0s');
    expect(formatCountdown(1500, tc)).toBe('1s');
  });
});

describe('describeLastRun', () => {
  const created = 1_700_000_000_000; // arbitrary fixed ms
  const createdMinute = created - (created % 60_000);

  it('reads as "never" for a fresh (creation-minute) or null stamp', () => {
    expect(describeLastRun({ createdAt: created, lastFiredAt: null }, t)).toBe(
      'scheduledTasks.never',
    );
    expect(
      describeLastRun({ createdAt: created, lastFiredAt: createdMinute }, t),
    ).toBe('scheduledTasks.never');
  });
  it('reads as a real run once lastFiredAt advances past the creation minute', () => {
    const label = describeLastRun(
      { createdAt: created, lastFiredAt: createdMinute + 60_000 },
      t,
    );
    expect(label.startsWith('scheduledTasks.lastFired(')).toBe(true);
  });
});
