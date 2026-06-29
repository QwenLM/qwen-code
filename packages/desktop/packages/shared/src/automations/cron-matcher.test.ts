/**
 * Tests for cron-matcher.ts
 */

import { describe, it, expect, afterEach, jest, spyOn } from 'bun:test';
import { matchesCron } from './cron-matcher.ts';

describe('cron-matcher', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('should match wildcard cron (every minute)', () => {
    // '* * * * *' matches every minute
    expect(matchesCron('* * * * *')).toBe(true);
  });

  it('should match when current minute matches exactly', () => {
    // Set time to 09:30:15 on Feb 10, 2026
    jest.useFakeTimers(); jest.setSystemTime(new Date(2026, 1, 10, 9, 30, 15));
    expect(matchesCron('30 9 * * *')).toBe(true);
  });

  it('should not match when minute does not match', () => {
    // Set time to 09:31:00
    jest.useFakeTimers(); jest.setSystemTime(new Date(2026, 1, 10, 9, 31, 0));
    expect(matchesCron('30 9 * * *')).toBe(false);
  });

  it('should match at the start of the minute (00 seconds)', () => {
    jest.useFakeTimers(); jest.setSystemTime(new Date(2026, 1, 10, 14, 0, 0));
    expect(matchesCron('0 14 * * *')).toBe(true);
  });

  it('should match at 59 seconds within the minute', () => {
    jest.useFakeTimers(); jest.setSystemTime(new Date(2026, 1, 10, 14, 0, 59));
    expect(matchesCron('0 14 * * *')).toBe(true);
  });

  it('should not match at the next minute boundary', () => {
    jest.useFakeTimers(); jest.setSystemTime(new Date(2026, 1, 10, 14, 1, 0));
    expect(matchesCron('0 14 * * *')).toBe(false);
  });

  it('should match day-of-month and month fields', () => {
    // Feb 9 at 16:15
    jest.useFakeTimers(); jest.setSystemTime(new Date(2026, 1, 9, 16, 15, 0));
    expect(matchesCron('15 16 9 2 *')).toBe(true);
  });

  it('should not match wrong day-of-month', () => {
    // Feb 10 at 16:15 — day doesn't match
    jest.useFakeTimers(); jest.setSystemTime(new Date(2026, 1, 10, 16, 15, 0));
    expect(matchesCron('15 16 9 2 *')).toBe(false);
  });

  it('should match with timezone conversion', () => {
    // Simulate 16:15 in Europe/Budapest (UTC+1 in winter)
    // That's 15:15 UTC
    jest.useFakeTimers(); jest.setSystemTime(new Date('2026-02-09T15:15:30Z'));
    expect(matchesCron('15 16 * * *', 'Europe/Budapest')).toBe(true);
  });

  it('should not match with explicit UTC timezone when time is wrong', () => {
    // 15:15 UTC — should not match 16:15 UTC
    jest.useFakeTimers(); jest.setSystemTime(new Date('2026-02-09T15:15:30Z'));
    expect(matchesCron('15 16 * * *', 'UTC')).toBe(false);
  });

  it('should match day-of-week', () => {
    // Feb 10, 2026 is a Tuesday (day 2)
    jest.useFakeTimers(); jest.setSystemTime(new Date(2026, 1, 10, 12, 0, 0));
    expect(matchesCron('0 12 * * 2')).toBe(true);
  });

  it('should not match wrong day-of-week', () => {
    // Feb 10, 2026 is a Tuesday — should not match Wednesday (day 3)
    jest.useFakeTimers(); jest.setSystemTime(new Date(2026, 1, 10, 12, 0, 0));
    expect(matchesCron('0 12 * * 3')).toBe(false);
  });

  it('should return false for invalid cron expression', () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    expect(matchesCron('invalid cron')).toBe(false);
    errorSpy.mockRestore();
  });

  it('should match every 5 minutes pattern', () => {
    jest.useFakeTimers(); jest.setSystemTime(new Date(2026, 1, 10, 10, 15, 0));
    expect(matchesCron('*/5 * * * *')).toBe(true);
  });

  it('should not match between 5-minute intervals', () => {
    jest.useFakeTimers(); jest.setSystemTime(new Date(2026, 1, 10, 10, 13, 0));
    expect(matchesCron('*/5 * * * *')).toBe(false);
  });
});
