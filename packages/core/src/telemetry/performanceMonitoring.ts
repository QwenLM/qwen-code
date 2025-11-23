/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import type { ToolExecutionPhase, ApiRequestPhase } from './metrics.js';
import {
  recordStartupPerformance,
  recordMemoryUsage,
  recordCpuUsage,
  recordPerformanceScore,
  recordPerformanceRegression,
  recordBaselineComparison,
  isPerformanceMonitoringActive,
  MemoryMetricType,
  recordToolExecutionBreakdown,
  recordApiRequestBreakdown,
  recordToolQueueDepth,
} from './metrics.js';
import * as os from 'os';
import v8 from 'node:v8';

/**
 * Interface for tracking performance metrics
 */
export interface PerformanceMetrics {
  startupTime: number;
  memoryUsage: {
    heapUsed: number;
    heapTotal: number;
    external: number;
    rss: number;
  };
  cpuUsage: number;
  toolExecutionTimes: Map<ToolExecutionPhase, number>;
  apiRequestTimes: Map<ApiRequestPhase, number>;
  toolQueueDepth: number;
}

/**
 * Default baseline values for performance comparison
 */
const DEFAULT_BASELINES: Record<string, number> = {
  startup_time: 2000, // 2 seconds
  memory_usage_heap_used: 100 * 1024 * 1024, // 100 MB
  memory_usage_rss: 200 * 1024 * 1024, // 200 MB
  cpu_usage: 20, // 20%
};

/**
 * Performance monitoring service that tracks and reports various performance metrics
 */
export class PerformanceMonitoringService {
  private config: Config;
  private baselines: Record<string, number> = { ...DEFAULT_BASELINES };
  private startupStartTime: number | null = null;
  private active = false;
  private reportInterval: NodeJS.Timeout | null = null;
  private readonly reportIntervalMs = 30000; // Report every 30 seconds

  constructor(config: Config) {
    this.config = config;
    this.active = isPerformanceMonitoringActive();
  }

  /**
   * Start monitoring performance metrics
   */
  start(): void {
    if (!this.active) return;

    this.startupStartTime = Date.now();
    this.startReporting();
  }

  /**
   * Start periodic reporting of performance metrics
   */
  private startReporting(): void {
    if (this.reportInterval) {
      clearInterval(this.reportInterval);
    }

    this.reportInterval = setInterval(() => {
      this.reportCurrentMetrics();
    }, this.reportIntervalMs);
  }

  /**
   * Report current performance metrics
   */
  private reportCurrentMetrics(): void {
    if (!this.active) return;

    // Record current memory usage
    this.recordMemoryMetrics();

    // Record current CPU usage (approximation using process and system stats)
    this.recordCpuMetrics();

    // Record current tool queue depth
    this.recordToolQueueMetrics();
  }

  /**
   * Record memory usage metrics
   */
  private recordMemoryMetrics(): void {
    const heapStats = v8.getHeapStatistics();
    const memoryUsage = process.memoryUsage();

    // Record heap usage
    recordMemoryUsage(this.config, heapStats.used_heap_size, {
      memory_type: MemoryMetricType.HEAP_USED,
    });

    recordMemoryUsage(this.config, heapStats.total_heap_size, {
      memory_type: MemoryMetricType.HEAP_TOTAL,
    });

    // Record external memory
    recordMemoryUsage(this.config, memoryUsage.external, {
      memory_type: MemoryMetricType.EXTERNAL,
    });

    // Record RSS (Resident Set Size)
    recordMemoryUsage(this.config, memoryUsage.rss, {
      memory_type: MemoryMetricType.RSS,
    });

    // Check for regression against baseline
    this.checkMemoryRegression(heapStats.used_heap_size, memoryUsage.rss);
  }

  /**
   * Record CPU usage metrics (approximate using load average)
   */
  private recordCpuMetrics(): void {
    const loadAvg = os.loadavg();
    // Use 1-minute load average as a proxy for CPU usage
    // Normalize against number of CPU cores
    const cpuCount = os.cpus().length;
    const cpuUsage = (loadAvg[0] / cpuCount) * 100;

    // Ensure value is between 0 and 100
    const normalizedCpuUsage = Math.min(100, Math.max(0, cpuUsage));

    recordCpuUsage(this.config, normalizedCpuUsage, {});

    // Check for regression against baseline
    this.checkCpuRegression(normalizedCpuUsage);
  }

  /**
   * Record tool queue depth metrics
   */
  private recordToolQueueMetrics(): void {
    // For now, we'll use a mock value since we don't have access to the actual queue
    // In a real implementation, this would come from the tool scheduler
    const queueDepth = 0; // This would be passed from the tool scheduler

    recordToolQueueDepth(this.config, queueDepth);
  }

  /**
   * Record startup performance metrics
   */
  recordStartupMetrics(
    phase: string,
    durationMs: number,
    details?: Record<string, string | number | boolean>,
  ): void {
    if (!this.active || !this.startupStartTime) return;

    recordStartupPerformance(this.config, durationMs, {
      phase,
      details,
    });

    // Check for startup regression
    this.checkStartupRegression(durationMs, phase);
  }

  /**
   * Record tool execution breakdown metrics
   */
  recordToolExecutionMetrics(
    phase: ToolExecutionPhase,
    durationMs: number,
  ): void {
    if (!this.active) return;

    recordToolExecutionBreakdown(this.config, durationMs, {
      function_name: 'unknown', // Would be passed by the caller
      phase,
    });
  }

  /**
   * Record API request breakdown metrics
   */
  recordApiRequestMetrics(
    phase: ApiRequestPhase,
    durationMs: number,
    model: string,
  ): void {
    if (!this.active) return;

    recordApiRequestBreakdown(this.config, durationMs, {
      model,
      phase,
    });
  }

  /**
   * Record a composite performance score
   */
  recordPerformanceScore(score: number, category: string): void {
    if (!this.active) return;

    recordPerformanceScore(this.config, score, {
      category,
    });
  }

  /**
   * Check for memory usage regression
   */
  private checkMemoryRegression(heapUsed: number, rss: number): void {
    // Check heap usage regression
    if (heapUsed > this.baselines['memory_usage_heap_used'] * 1.5) {
      recordPerformanceRegression(this.config, {
        metric: 'memory_usage_heap_used',
        severity: 'high',
        current_value: heapUsed,
        baseline_value: this.baselines['memory_usage_heap_used'],
      });
    } else if (heapUsed > this.baselines['memory_usage_heap_used'] * 1.25) {
      recordPerformanceRegression(this.config, {
        metric: 'memory_usage_heap_used',
        severity: 'medium',
        current_value: heapUsed,
        baseline_value: this.baselines['memory_usage_heap_used'],
      });
    }

    // Check RSS regression
    if (rss > this.baselines['memory_usage_rss'] * 1.5) {
      recordPerformanceRegression(this.config, {
        metric: 'memory_usage_rss',
        severity: 'high',
        current_value: rss,
        baseline_value: this.baselines['memory_usage_rss'],
      });
    }
  }

  /**
   * Check for CPU usage regression
   */
  private checkCpuRegression(cpuUsage: number): void {
    if (cpuUsage > this.baselines['cpu_usage'] * 1.5) {
      recordPerformanceRegression(this.config, {
        metric: 'cpu_usage',
        severity: 'high',
        current_value: cpuUsage,
        baseline_value: this.baselines['cpu_usage'],
      });
    } else if (cpuUsage > this.baselines['cpu_usage'] * 1.25) {
      recordPerformanceRegression(this.config, {
        metric: 'cpu_usage',
        severity: 'medium',
        current_value: cpuUsage,
        baseline_value: this.baselines['cpu_usage'],
      });
    }
  }

  /**
   * Check for startup time regression
   */
  private checkStartupRegression(duration: number, phase: string): void {
    const baselineKey = `startup_time_${phase}`;
    const baseline =
      this.baselines[baselineKey] || this.baselines['startup_time'];

    if (duration > baseline * 1.5) {
      recordPerformanceRegression(this.config, {
        metric: baselineKey,
        severity: 'high',
        current_value: duration,
        baseline_value: baseline,
      });
    } else if (duration > baseline * 1.25) {
      recordPerformanceRegression(this.config, {
        metric: baselineKey,
        severity: 'medium',
        current_value: duration,
        baseline_value: baseline,
      });
    }

    // Record comparison to baseline
    recordBaselineComparison(this.config, {
      metric: baselineKey,
      category: 'startup',
      current_value: duration,
      baseline_value: baseline,
    });
  }

  /**
   * Set performance baseline for a given metric
   */
  setBaseline(metric: string, value: number): void {
    this.baselines[metric] = value;
  }

  /**
   * Get the current baseline for a given metric
   */
  getBaseline(metric: string): number {
    return (
      this.baselines[metric] ||
      DEFAULT_BASELINES[metric as keyof typeof DEFAULT_BASELINES] ||
      0
    );
  }

  /**
   * Stop monitoring performance metrics
   */
  stop(): void {
    if (this.reportInterval) {
      clearInterval(this.reportInterval);
      this.reportInterval = null;
    }
    this.active = false;
  }
}
