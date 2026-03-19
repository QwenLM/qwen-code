/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PerformanceProfiler, getProfiler } from './performanceProfiler.js';

describe('PerformanceProfiler', () => {
  let profiler: PerformanceProfiler;

  beforeEach(() => {
    // Reset singleton for each test
    PerformanceProfiler.resetInstance();
    profiler = PerformanceProfiler.getInstance();
  });

  afterEach(() => {
    if (profiler.isActive()) {
      profiler.stop();
    }
    PerformanceProfiler.resetInstance();
  });

  describe('Singleton Pattern', () => {
    it('should return the same instance', () => {
      const instance1 = PerformanceProfiler.getInstance();
      const instance2 = PerformanceProfiler.getInstance();
      expect(instance1).toBe(instance2);
    });

    it('should return new instance after reset', () => {
      const instance1 = PerformanceProfiler.getInstance();
      PerformanceProfiler.resetInstance();
      const instance2 = PerformanceProfiler.getInstance();
      expect(instance1).not.toBe(instance2);
    });

    it('getProfiler should return singleton instance', () => {
      const instance = getProfiler();
      expect(instance).toBe(PerformanceProfiler.getInstance());
    });
  });

  describe('Profiling Lifecycle', () => {
    it('should start profiling', () => {
      expect(profiler.isActive()).toBe(false);
      profiler.start();
      expect(profiler.isActive()).toBe(true);
    });

    it('should stop profiling', () => {
      profiler.start();
      expect(profiler.isActive()).toBe(true);
      profiler.stop();
      expect(profiler.isActive()).toBe(false);
    });

    it('should clear data on start', () => {
      profiler.start();
      profiler.recordTime('test', 100);
      expect(profiler.getTrackedMethods()).toContain('test');

      profiler.start(); // restart clears data
      expect(profiler.getTrackedMethods()).toHaveLength(0);
    });
  });

  describe('Timer Operations', () => {
    beforeEach(() => {
      profiler.start();
    });

    it('should track time with startTimer/stop', async () => {
      const timer = profiler.startTimer('testMethod');
      await new Promise((resolve) => setTimeout(resolve, 10));
      const elapsed = timer.stop();

      expect(elapsed).toBeGreaterThanOrEqual(10);
      expect(profiler.getTrackedMethods()).toContain('testMethod');
    });

    it('should track synchronous function with track()', () => {
      const result = profiler.track('syncMethod', () => {
        let sum = 0;
        for (let i = 0; i < 1000; i++) sum += i;
        return sum;
      });

      expect(result).toBe(499500);
      expect(profiler.getTrackedMethods()).toContain('syncMethod');
    });

    it('should track async function with trackAsync()', async () => {
      const result = await profiler.trackAsync('asyncMethod', async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return 'done';
      });

      expect(result).toBe('done');
      expect(profiler.getTrackedMethods()).toContain('asyncMethod');

      const stats = profiler.getMethodStats('asyncMethod');
      expect(stats?.totalTimeMs).toBeGreaterThanOrEqual(5);
    });

    it('should not record when profiler is not active', () => {
      profiler.stop();
      profiler.recordTime('inactiveMethod', 100);
      expect(profiler.getTrackedMethods()).not.toContain('inactiveMethod');
    });
  });

  describe('Statistics Calculation', () => {
    beforeEach(() => {
      profiler.start();
    });

    it('should calculate correct statistics for single call', () => {
      profiler.recordTime('singleCall', 100);

      const stats = profiler.getMethodStats('singleCall');
      expect(stats).toEqual({
        name: 'singleCall',
        callCount: 1,
        totalTimeMs: 100,
        minTimeMs: 100,
        maxTimeMs: 100,
        avgTimeMs: 100,
      });
    });

    it('should calculate correct statistics for multiple calls', () => {
      profiler.recordTime('multiCall', 50);
      profiler.recordTime('multiCall', 100);
      profiler.recordTime('multiCall', 150);

      const stats = profiler.getMethodStats('multiCall');
      expect(stats).toEqual({
        name: 'multiCall',
        callCount: 3,
        totalTimeMs: 300,
        minTimeMs: 50,
        maxTimeMs: 150,
        avgTimeMs: 100,
      });
    });

    it('should return null for untracked method', () => {
      const stats = profiler.getMethodStats('unknown');
      expect(stats).toBeNull();
    });
  });

  describe('Summary and Report', () => {
    beforeEach(() => {
      profiler.start();
      profiler.recordTime('methodA', 100);
      profiler.recordTime('methodA', 200);
      profiler.recordTime('methodB', 500);
      profiler.recordTime('methodC', 50);
    });

    it('should generate summary with all methods', () => {
      const summary = profiler.getSummary();

      expect(summary.methods).toHaveLength(3);
      expect(summary.hotspots).toHaveLength(3);
      expect(summary.totalDurationMs).toBeGreaterThan(0);
    });

    it('should sort hotspots by total time descending', () => {
      const summary = profiler.getSummary();

      expect(summary.hotspots[0].name).toBe('methodB');
      expect(summary.hotspots[1].name).toBe('methodA');
      expect(summary.hotspots[2].name).toBe('methodC');
    });

    it('should sort methods alphabetically', () => {
      const summary = profiler.getSummary();

      expect(summary.methods[0].name).toBe('methodA');
      expect(summary.methods[1].name).toBe('methodB');
      expect(summary.methods[2].name).toBe('methodC');
    });

    it('should generate formatted report', () => {
      const report = profiler.formatReport();

      expect(report).toContain('PERFORMANCE PROFILING REPORT');
      expect(report).toContain('TOP');
      expect(report).toContain('HOTSPOTS');
      expect(report).toContain('methodA');
      expect(report).toContain('methodB');
      expect(report).toContain('methodC');
    });

    it('should generate JSON output', () => {
      const json = profiler.toJSON();
      const parsed = JSON.parse(json);

      expect(parsed.methods).toBeDefined();
      expect(parsed.hotspots).toBeDefined();
      expect(parsed.totalDurationMs).toBeDefined();
    });
  });

  describe('Duration Formatting', () => {
    beforeEach(() => {
      profiler.start();
    });

    it('should format microseconds', () => {
      profiler.recordTime('micro', 0.5);
      const report = profiler.formatReport();
      expect(report).toContain('μs');
    });

    it('should format milliseconds', () => {
      profiler.recordTime('milli', 50);
      const report = profiler.formatReport();
      expect(report).toContain('ms');
    });

    it('should format seconds', () => {
      profiler.recordTime('sec', 2500);
      const report = profiler.formatReport();
      expect(report).toContain('s');
    });

    it('should format minutes', () => {
      profiler.recordTime('min', 120000);
      const report = profiler.formatReport();
      expect(report).toContain('m');
    });
  });

  describe('Clear Operation', () => {
    it('should clear all tracked data', () => {
      profiler.start();
      profiler.recordTime('method1', 100);
      profiler.recordTime('method2', 200);

      expect(profiler.getTrackedMethods()).toHaveLength(2);

      profiler.clear();
      expect(profiler.getTrackedMethods()).toHaveLength(0);
      expect(profiler.isActive()).toBe(true); // still active after clear
    });
  });

  describe('Error Handling', () => {
    beforeEach(() => {
      profiler.start();
    });

    it('should still record time when tracked function throws (sync)', () => {
      expect(() => {
        profiler.track('throwingSync', () => {
          throw new Error('test error');
        });
      }).toThrow('test error');

      expect(profiler.getTrackedMethods()).toContain('throwingSync');
    });

    it('should still record time when tracked function throws (async)', async () => {
      await expect(
        profiler.trackAsync('throwingAsync', async () => {
          throw new Error('async error');
        }),
      ).rejects.toThrow('async error');

      expect(profiler.getTrackedMethods()).toContain('throwingAsync');
    });
  });
});
