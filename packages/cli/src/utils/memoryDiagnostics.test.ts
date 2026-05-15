/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  formatMemoryDiagnostics,
  getMemoryDiagnostics,
} from './memoryDiagnostics.js';

describe('memoryDiagnostics', () => {
  it('collects baseline process and V8 memory fields', () => {
    const diagnostics = getMemoryDiagnostics();

    expect(diagnostics.process.pid).toBe(process.pid);
    expect(diagnostics.process.nodeVersion).toBe(process.version);
    expect(diagnostics.process.platform).toBe(process.platform);
    expect(diagnostics.process.arch).toBe(process.arch);
    expect(diagnostics.memory.rss).toBeGreaterThan(0);
    expect(diagnostics.memory.heapTotal).toBeGreaterThan(0);
    expect(diagnostics.memory.heapUsed).toBeGreaterThan(0);
    expect(diagnostics.memory.external).toBeGreaterThanOrEqual(0);
    expect(diagnostics.memory.arrayBuffers).toBeGreaterThanOrEqual(0);
    expect(diagnostics.v8.heapStatistics).toBeDefined();
    expect(diagnostics.v8.heapSpaces.length).toBeGreaterThan(0);
    expect(diagnostics.activeHandles.count).toBeGreaterThanOrEqual(0);
    expect(diagnostics.activeRequests.count).toBeGreaterThanOrEqual(0);
  });

  it('formats a paste-safe human-readable report with key sections', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-15T12:00:00.000Z'));

    try {
      const report = formatMemoryDiagnostics({
        generatedAt: new Date().toISOString(),
        process: {
          pid: 123,
          nodeVersion: 'v22.0.0',
          platform: 'linux',
          arch: 'x64',
          uptimeSeconds: 42.4,
        },
        memory: {
          rss: 100 * 1024 * 1024,
          heapTotal: 80 * 1024 * 1024,
          heapUsed: 40 * 1024 * 1024,
          external: 5 * 1024 * 1024,
          arrayBuffers: 2 * 1024 * 1024,
        },
        v8: {
          heapStatistics: {
            heap_size_limit: 4096 * 1024 * 1024,
            total_available_size: 3000 * 1024 * 1024,
          },
          heapSpaces: [
            {
              space_name: 'old_space',
              space_size: 30 * 1024 * 1024,
              space_used_size: 20 * 1024 * 1024,
            },
          ],
        },
        activeHandles: { count: 3, unavailable: false },
        activeRequests: { count: 1, unavailable: false },
      });

      expect(report).toContain('Memory diagnostics');
      expect(report).toContain('Generated: 2026-05-15T12:00:00.000Z');
      expect(report).toContain('Node.js: v22.0.0');
      expect(report).toContain('RSS: 100.0 MiB');
      expect(report).toContain('Heap used / total: 40.0 MiB / 80.0 MiB');
      expect(report).toContain('External: 5.0 MiB');
      expect(report).toContain('Array buffers: 2.0 MiB');
      expect(report).toContain('Heap size limit: 4096.0 MiB');
      expect(report).toContain('old_space: 20.0 MiB / 30.0 MiB');
      expect(report).toContain('Active handles: 3');
      expect(report).toContain('Active requests: 1');
    } finally {
      vi.useRealTimers();
    }
  });
});
