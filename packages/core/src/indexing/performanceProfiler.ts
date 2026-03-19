/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Performance profiler for indexing operations.
 * Records method call statistics including call count, total time,
 * average time, min/max times for performance analysis.
 */

/**
 * Statistics for a single method.
 */
export interface MethodStats {
  /** Method name (e.g., 'FileScanner.scanFiles') */
  name: string;
  /** Number of times this method was called */
  callCount: number;
  /** Total execution time in milliseconds */
  totalTimeMs: number;
  /** Minimum execution time in milliseconds */
  minTimeMs: number;
  /** Maximum execution time in milliseconds */
  maxTimeMs: number;
  /** Average execution time in milliseconds */
  avgTimeMs: number;
}

/**
 * Internal tracking data for a method.
 */
interface MethodTracker {
  callCount: number;
  totalTimeMs: number;
  minTimeMs: number;
  maxTimeMs: number;
}

/**
 * Overall profiling summary.
 */
export interface ProfilingSummary {
  /** Start time of profiling (ISO string) */
  startTime: string;
  /** End time of profiling (ISO string) */
  endTime: string;
  /** Total profiling duration in milliseconds */
  totalDurationMs: number;
  /** Statistics for each tracked method */
  methods: MethodStats[];
  /** Methods sorted by total time (descending) */
  hotspots: MethodStats[];
}

/**
 * Timer handle for tracking method execution.
 */
export interface TimerHandle {
  /** Stop the timer and record the elapsed time */
  stop: () => number;
}

/**
 * Performance profiler singleton for indexing operations.
 *
 * Usage:
 * ```typescript
 * const profiler = PerformanceProfiler.getInstance();
 * profiler.start();
 *
 * // Track synchronous code
 * const timer = profiler.startTimer('FileScanner.scanFiles');
 * // ... do work ...
 * timer.stop();
 *
 * // Or track async code
 * const result = await profiler.trackAsync('EmbeddingService.embed', async () => {
 *   return await embeddingService.embed(chunks);
 * });
 *
 * // Get summary
 * const summary = profiler.getSummary();
 * console.log(profiler.formatReport());
 * ```
 */
export class PerformanceProfiler {
  private static instance: PerformanceProfiler | null = null;

  private trackers: Map<string, MethodTracker> = new Map();
  private startTimeMs: number = 0;
  private endTimeMs: number = 0;
  private isRunning: boolean = false;

  private constructor() {}

  /**
   * Get the singleton instance.
   */
  static getInstance(): PerformanceProfiler {
    if (!PerformanceProfiler.instance) {
      PerformanceProfiler.instance = new PerformanceProfiler();
    }
    return PerformanceProfiler.instance;
  }

  /**
   * Reset the singleton instance (useful for testing).
   */
  static resetInstance(): void {
    PerformanceProfiler.instance = null;
  }

  /**
   * Start profiling session.
   * Clears any existing data.
   */
  start(): void {
    this.trackers.clear();
    this.startTimeMs = performance.now();
    this.endTimeMs = 0;
    this.isRunning = true;
  }

  /**
   * Stop profiling session.
   */
  stop(): void {
    this.endTimeMs = performance.now();
    this.isRunning = false;
  }

  /**
   * Check if profiler is currently running.
   */
  isActive(): boolean {
    return this.isRunning;
  }

  /**
   * Start a timer for a method.
   * Returns a handle to stop the timer.
   *
   * @param methodName - Name of the method being timed (e.g., 'FileScanner.scanFiles')
   * @returns Timer handle with stop() method
   */
  startTimer(methodName: string): TimerHandle {
    const startTime = performance.now();

    return {
      stop: (): number => {
        const elapsed = performance.now() - startTime;
        this.recordTime(methodName, elapsed);
        return elapsed;
      },
    };
  }

  /**
   * Track a synchronous function execution.
   *
   * @param methodName - Name of the method being timed
   * @param fn - Function to execute
   * @returns Result of the function
   */
  track<T>(methodName: string, fn: () => T): T {
    const timer = this.startTimer(methodName);
    try {
      return fn();
    } finally {
      timer.stop();
    }
  }

  /**
   * Track an async function execution.
   *
   * @param methodName - Name of the method being timed
   * @param fn - Async function to execute
   * @returns Promise resolving to the function result
   */
  async trackAsync<T>(methodName: string, fn: () => Promise<T>): Promise<T> {
    const timer = this.startTimer(methodName);
    try {
      return await fn();
    } finally {
      timer.stop();
    }
  }

  /**
   * Manually record a time measurement.
   *
   * @param methodName - Name of the method
   * @param timeMs - Execution time in milliseconds
   */
  recordTime(methodName: string, timeMs: number): void {
    if (!this.isRunning) return;

    let tracker = this.trackers.get(methodName);
    if (!tracker) {
      tracker = {
        callCount: 0,
        totalTimeMs: 0,
        minTimeMs: Infinity,
        maxTimeMs: -Infinity,
      };
      this.trackers.set(methodName, tracker);
    }

    tracker.callCount++;
    tracker.totalTimeMs += timeMs;
    tracker.minTimeMs = Math.min(tracker.minTimeMs, timeMs);
    tracker.maxTimeMs = Math.max(tracker.maxTimeMs, timeMs);
  }

  /**
   * Get statistics for a specific method.
   *
   * @param methodName - Name of the method
   * @returns Method statistics or null if not tracked
   */
  getMethodStats(methodName: string): MethodStats | null {
    const tracker = this.trackers.get(methodName);
    if (!tracker) return null;

    return {
      name: methodName,
      callCount: tracker.callCount,
      totalTimeMs: tracker.totalTimeMs,
      minTimeMs: tracker.callCount > 0 ? tracker.minTimeMs : 0,
      maxTimeMs: tracker.callCount > 0 ? tracker.maxTimeMs : 0,
      avgTimeMs:
        tracker.callCount > 0 ? tracker.totalTimeMs / tracker.callCount : 0,
    };
  }

  /**
   * Get all tracked method names.
   */
  getTrackedMethods(): string[] {
    return Array.from(this.trackers.keys());
  }

  /**
   * Get profiling summary with all statistics.
   */
  getSummary(): ProfilingSummary {
    const endTime = this.endTimeMs || performance.now();
    const methods: MethodStats[] = [];

    for (const [name, tracker] of this.trackers) {
      methods.push({
        name,
        callCount: tracker.callCount,
        totalTimeMs: tracker.totalTimeMs,
        minTimeMs: tracker.callCount > 0 ? tracker.minTimeMs : 0,
        maxTimeMs: tracker.callCount > 0 ? tracker.maxTimeMs : 0,
        avgTimeMs:
          tracker.callCount > 0 ? tracker.totalTimeMs / tracker.callCount : 0,
      });
    }

    // Sort by name for consistent output
    methods.sort((a, b) => a.name.localeCompare(b.name));

    // Create hotspots list (sorted by total time descending)
    const hotspots = [...methods].sort((a, b) => b.totalTimeMs - a.totalTimeMs);

    return {
      startTime: new Date(
        Date.now() - (endTime - this.startTimeMs),
      ).toISOString(),
      endTime: new Date().toISOString(),
      totalDurationMs: endTime - this.startTimeMs,
      methods,
      hotspots,
    };
  }

  /**
   * Format a human-readable performance report.
   *
   * @param topN - Number of top hotspots to show (default: 10)
   * @returns Formatted report string
   */
  formatReport(topN: number = 10): string {
    const summary = this.getSummary();
    const lines: string[] = [];

    lines.push('');
    lines.push('='.repeat(80));
    lines.push('PERFORMANCE PROFILING REPORT');
    lines.push('='.repeat(80));
    lines.push('');
    lines.push(`Start Time:     ${summary.startTime}`);
    lines.push(`End Time:       ${summary.endTime}`);
    lines.push(
      `Total Duration: ${this.formatDuration(summary.totalDurationMs)}`,
    );
    lines.push(`Methods Tracked: ${summary.methods.length}`);
    lines.push('');

    // Top hotspots
    lines.push('-'.repeat(80));
    lines.push(
      `TOP ${Math.min(topN, summary.hotspots.length)} HOTSPOTS (by total time)`,
    );
    lines.push('-'.repeat(80));
    lines.push('');
    lines.push(
      this.padRight('Method', 45) +
        this.padLeft('Calls', 8) +
        this.padLeft('Total', 12) +
        this.padLeft('Avg', 10) +
        this.padLeft('Min', 10) +
        this.padLeft('Max', 10),
    );
    lines.push('-'.repeat(95));

    for (const stats of summary.hotspots.slice(0, topN)) {
      const pct = ((stats.totalTimeMs / summary.totalDurationMs) * 100).toFixed(
        1,
      );
      lines.push(
        this.padRight(this.truncate(stats.name, 43), 45) +
          this.padLeft(stats.callCount.toString(), 8) +
          this.padLeft(
            `${this.formatDuration(stats.totalTimeMs)} (${pct}%)`,
            12,
          ) +
          this.padLeft(this.formatDuration(stats.avgTimeMs), 10) +
          this.padLeft(this.formatDuration(stats.minTimeMs), 10) +
          this.padLeft(this.formatDuration(stats.maxTimeMs), 10),
      );
    }

    lines.push('');
    lines.push('-'.repeat(80));
    lines.push('ALL METHODS (sorted alphabetically)');
    lines.push('-'.repeat(80));
    lines.push('');
    lines.push(
      this.padRight('Method', 45) +
        this.padLeft('Calls', 8) +
        this.padLeft('Total', 12) +
        this.padLeft('Avg', 10) +
        this.padLeft('Min', 10) +
        this.padLeft('Max', 10),
    );
    lines.push('-'.repeat(95));

    for (const stats of summary.methods) {
      lines.push(
        this.padRight(this.truncate(stats.name, 43), 45) +
          this.padLeft(stats.callCount.toString(), 8) +
          this.padLeft(this.formatDuration(stats.totalTimeMs), 12) +
          this.padLeft(this.formatDuration(stats.avgTimeMs), 10) +
          this.padLeft(this.formatDuration(stats.minTimeMs), 10) +
          this.padLeft(this.formatDuration(stats.maxTimeMs), 10),
      );
    }

    lines.push('');
    lines.push('='.repeat(80));
    lines.push('');

    return lines.join('\n');
  }

  /**
   * Get summary as JSON string (for logging/persistence).
   */
  toJSON(): string {
    return JSON.stringify(this.getSummary(), null, 2);
  }

  /**
   * Clear all recorded data without stopping the profiler.
   */
  clear(): void {
    this.trackers.clear();
  }

  // ===== Helper Methods =====

  private formatDuration(ms: number): string {
    if (ms < 1) {
      return `${(ms * 1000).toFixed(0)}μs`;
    } else if (ms < 1000) {
      return `${ms.toFixed(1)}ms`;
    } else if (ms < 60000) {
      return `${(ms / 1000).toFixed(2)}s`;
    } else {
      const minutes = Math.floor(ms / 60000);
      const seconds = ((ms % 60000) / 1000).toFixed(1);
      return `${minutes}m${seconds}s`;
    }
  }

  private padRight(str: string, len: number): string {
    return str.padEnd(len);
  }

  private padLeft(str: string, len: number): string {
    return str.padStart(len);
  }

  private truncate(str: string, maxLen: number): string {
    if (str.length <= maxLen) return str;
    return str.slice(0, maxLen - 2) + '..';
  }
}

/**
 * Decorator function for profiling class methods.
 *
 * Usage:
 * ```typescript
 * class MyService {
 *   @profileMethod('MyService.doWork')
 *   async doWork() { ... }
 * }
 * ```
 */
export function profileMethod(methodName: string) {
  return function (
    _target: unknown,
    _propertyKey: string,
    descriptor: PropertyDescriptor,
  ) {
    const originalMethod = descriptor.value;

    descriptor.value = async function (...args: unknown[]) {
      const profiler = PerformanceProfiler.getInstance();
      if (!profiler.isActive()) {
        return originalMethod.apply(this, args);
      }

      return profiler.trackAsync(methodName, () =>
        originalMethod.apply(this, args),
      );
    };

    return descriptor;
  };
}

/**
 * Convenience function to get the global profiler instance.
 */
export function getProfiler(): PerformanceProfiler {
  return PerformanceProfiler.getInstance();
}
