/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  formatDuration,
  formatMemoryUsage,
  formatRelativeTime,
} from './formatters.js';

describe('formatters', () => {
  describe('formatRelativeTime', () => {
    const NOW = 1700000000000; // Fixed timestamp for testing

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should return "just now" for timestamps less than a minute ago', () => {
      expect(formatRelativeTime(NOW - 30 * 1000)).toBe('just now');
      expect(formatRelativeTime(NOW - 59 * 1000)).toBe('just now');
    });

    it('should return "1 minute ago" for exactly one minute', () => {
      expect(formatRelativeTime(NOW - 60 * 1000)).toBe('1 minute ago');
    });

    it('should return plural minutes for multiple minutes', () => {
      expect(formatRelativeTime(NOW - 5 * 60 * 1000)).toBe('5 minutes ago');
      expect(formatRelativeTime(NOW - 30 * 60 * 1000)).toBe('30 minutes ago');
    });

    it('should return "1 hour ago" for exactly one hour', () => {
      expect(formatRelativeTime(NOW - 60 * 60 * 1000)).toBe('1 hour ago');
    });

    it('should return plural hours for multiple hours', () => {
      expect(formatRelativeTime(NOW - 3 * 60 * 60 * 1000)).toBe('3 hours ago');
      expect(formatRelativeTime(NOW - 23 * 60 * 60 * 1000)).toBe(
        '23 hours ago',
      );
    });

    it('should return "1 day ago" for exactly one day', () => {
      expect(formatRelativeTime(NOW - 24 * 60 * 60 * 1000)).toBe('1 day ago');
    });

    it('should return plural days for multiple days', () => {
      expect(formatRelativeTime(NOW - 3 * 24 * 60 * 60 * 1000)).toBe(
        '3 days ago',
      );
      expect(formatRelativeTime(NOW - 6 * 24 * 60 * 60 * 1000)).toBe(
        '6 days ago',
      );
    });

    it('should return "1 week ago" for exactly one week', () => {
      expect(formatRelativeTime(NOW - 7 * 24 * 60 * 60 * 1000)).toBe(
        '1 week ago',
      );
    });

    it('should return plural weeks for multiple weeks', () => {
      expect(formatRelativeTime(NOW - 14 * 24 * 60 * 60 * 1000)).toBe(
        '2 weeks ago',
      );
      expect(formatRelativeTime(NOW - 21 * 24 * 60 * 60 * 1000)).toBe(
        '3 weeks ago',
      );
    });

    it('should return "1 month ago" for exactly one month (30 days)', () => {
      expect(formatRelativeTime(NOW - 30 * 24 * 60 * 60 * 1000)).toBe(
        '1 month ago',
      );
    });

    it('should return plural months for multiple months', () => {
      expect(formatRelativeTime(NOW - 60 * 24 * 60 * 60 * 1000)).toBe(
        '2 months ago',
      );
      expect(formatRelativeTime(NOW - 90 * 24 * 60 * 60 * 1000)).toBe(
        '3 months ago',
      );
    });
  });

  describe('formatMemoryUsage', () => {
    it('should format bytes into KB', () => {
      expect(formatMemoryUsage(12345)).toBe('12.1 KB');
    });

    it('should format bytes into MB', () => {
      expect(formatMemoryUsage(12345678)).toBe('11.8 MB');
    });

    it('should format bytes into GB', () => {
      expect(formatMemoryUsage(12345678901)).toBe('11.50 GB');
    });
  });

  describe('formatDuration', () => {
    it('should format milliseconds less than a second', () => {
      expect(formatDuration(500)).toBe('500ms');
    });

    it('should format a duration of 0', () => {
      expect(formatDuration(0)).toBe('0s');
    });

    it('should format an exact number of seconds', () => {
      expect(formatDuration(5000)).toBe('5.0s');
    });

    it('should format a duration in seconds with one decimal place', () => {
      expect(formatDuration(12345)).toBe('12.3s');
    });

    it('should format an exact number of minutes', () => {
      expect(formatDuration(120000)).toBe('2m');
    });

    it('should format a duration in minutes and seconds', () => {
      expect(formatDuration(123000)).toBe('2m 3s');
    });

    it('should format an exact number of hours', () => {
      expect(formatDuration(3600000)).toBe('1h');
    });

    it('should format a duration in hours and seconds', () => {
      expect(formatDuration(3605000)).toBe('1h 5s');
    });

    it('should format a duration in hours, minutes, and seconds', () => {
      expect(formatDuration(3723000)).toBe('1h 2m 3s');
    });

    it('should handle large durations', () => {
      expect(formatDuration(86400000 + 3600000 + 120000 + 1000)).toBe(
        '25h 2m 1s',
      );
    });

    it('should handle negative durations', () => {
      expect(formatDuration(-100)).toBe('0s');
    });
  });
});
