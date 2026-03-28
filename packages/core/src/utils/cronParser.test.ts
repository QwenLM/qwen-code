import { describe, it, expect } from 'vitest';
import { matches, nextFireTime, parseCron } from './cronParser.js';

describe('parseCron', () => {
  it('parses wildcard fields', () => {
    const fields = parseCron('* * * * *');
    expect(fields.minute.size).toBe(60);
    expect(fields.hour.size).toBe(24);
    expect(fields.dayOfMonth.size).toBe(31);
    expect(fields.month.size).toBe(12);
    expect(fields.dayOfWeek.size).toBe(7);
  });

  it('parses single values', () => {
    const fields = parseCron('5 14 1 6 3');
    expect([...fields.minute]).toEqual([5]);
    expect([...fields.hour]).toEqual([14]);
    expect([...fields.dayOfMonth]).toEqual([1]);
    expect([...fields.month]).toEqual([6]);
    expect([...fields.dayOfWeek]).toEqual([3]);
  });

  it('parses ranges', () => {
    const fields = parseCron('1-5 * * * *');
    expect([...fields.minute].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it('parses comma lists', () => {
    const fields = parseCron('0,15,30,45 * * * *');
    expect([...fields.minute].sort((a, b) => a - b)).toEqual([0, 15, 30, 45]);
  });

  it('parses steps', () => {
    const fields = parseCron('*/15 * * * *');
    expect([...fields.minute].sort((a, b) => a - b)).toEqual([0, 15, 30, 45]);
  });

  it('parses range with step', () => {
    const fields = parseCron('1-10/3 * * * *');
    expect([...fields.minute].sort((a, b) => a - b)).toEqual([1, 4, 7, 10]);
  });

  it('throws on wrong number of fields', () => {
    expect(() => parseCron('* * *')).toThrow('must have exactly 5 fields');
    expect(() => parseCron('* * * * * *')).toThrow(
      'must have exactly 5 fields',
    );
  });

  it('throws on out-of-range values', () => {
    expect(() => parseCron('60 * * * *')).toThrow('out of bounds');
    expect(() => parseCron('* 25 * * *')).toThrow('out of bounds');
    expect(() => parseCron('* * 0 * *')).toThrow('out of bounds');
    expect(() => parseCron('* * * 13 *')).toThrow('out of bounds');
    expect(() => parseCron('* * * * 7')).toThrow('out of bounds');
  });

  it('throws on invalid step', () => {
    expect(() => parseCron('*/0 * * * *')).toThrow('Invalid step');
  });
});

describe('matches', () => {
  it('matches every-minute cron', () => {
    const date = new Date(2025, 0, 15, 10, 30); // Jan 15 2025, 10:30
    expect(matches('* * * * *', date)).toBe(true);
  });

  it('matches specific minute', () => {
    const date = new Date(2025, 0, 15, 10, 30);
    expect(matches('30 * * * *', date)).toBe(true);
    expect(matches('31 * * * *', date)).toBe(false);
  });

  it('matches specific hour and minute', () => {
    const date = new Date(2025, 0, 15, 14, 0);
    expect(matches('0 14 * * *', date)).toBe(true);
    expect(matches('0 13 * * *', date)).toBe(false);
  });

  it('matches day of week', () => {
    // Jan 15 2025 is a Wednesday (day 3)
    const date = new Date(2025, 0, 15, 10, 0);
    expect(matches('* * * * 3', date)).toBe(true);
    expect(matches('* * * * 1', date)).toBe(false);
  });

  it('matches every-N-minutes pattern', () => {
    const date0 = new Date(2025, 0, 15, 10, 0);
    const date5 = new Date(2025, 0, 15, 10, 5);
    const date3 = new Date(2025, 0, 15, 10, 3);
    expect(matches('*/5 * * * *', date0)).toBe(true);
    expect(matches('*/5 * * * *', date5)).toBe(true);
    expect(matches('*/5 * * * *', date3)).toBe(false);
  });
});

describe('nextFireTime', () => {
  it('finds next minute for * * * * *', () => {
    const now = new Date(2025, 0, 15, 10, 30, 15); // 10:30:15
    const next = nextFireTime('* * * * *', now);
    expect(next.getHours()).toBe(10);
    expect(next.getMinutes()).toBe(31);
    expect(next.getSeconds()).toBe(0);
  });

  it('finds next match for specific minute', () => {
    const now = new Date(2025, 0, 15, 10, 30, 0);
    const next = nextFireTime('45 * * * *', now);
    expect(next.getHours()).toBe(10);
    expect(next.getMinutes()).toBe(45);
  });

  it('rolls to next hour when no match in current hour', () => {
    const now = new Date(2025, 0, 15, 10, 50, 0);
    const next = nextFireTime('15 * * * *', now);
    expect(next.getHours()).toBe(11);
    expect(next.getMinutes()).toBe(15);
  });

  it('finds next match for every-5-minutes', () => {
    const now = new Date(2025, 0, 15, 10, 31, 0);
    const next = nextFireTime('*/5 * * * *', now);
    expect(next.getMinutes()).toBe(35);
  });

  it('finds next match for specific hour', () => {
    const now = new Date(2025, 0, 15, 10, 30, 0);
    const next = nextFireTime('0 14 * * *', now);
    expect(next.getHours()).toBe(14);
    expect(next.getMinutes()).toBe(0);
    expect(next.getDate()).toBe(15);
  });

  it('rolls to next day for past time', () => {
    const now = new Date(2025, 0, 15, 15, 0, 0); // 3pm
    const next = nextFireTime('0 9 * * *', now); // 9am daily
    expect(next.getDate()).toBe(16);
    expect(next.getHours()).toBe(9);
  });

  it('returns time strictly after the input', () => {
    // Even if `after` is exactly on a match minute, next should be the following match
    const now = new Date(2025, 0, 15, 10, 0, 0); // exactly 10:00:00
    const next = nextFireTime('*/5 * * * *', now);
    expect(next.getTime()).toBeGreaterThan(now.getTime());
  });
});
