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
