/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';

import { describe, expect, it, vi } from 'vitest';
import {
  collectMemoryPressureSamples,
  formatMemoryDiagnostics,
  formatMemoryPressureSamples,
  getMemoryDiagnostics,
  writeMemoryHeapSnapshot,
} from './memoryDiagnostics.js';

describe('memoryDiagnostics', () => {
  it('collects baseline memory fields', () => {
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
      expect(report).toContain('Assessment');
      expect(report).toContain('Status: ok');
      expect(report).toContain('Heap pressure: 1.0%');
    } finally {
      vi.useRealTimers();
    }
  });

  it('surfaces high heap pressure with actionable recommendations', () => {
    const report = formatMemoryDiagnostics({
      generatedAt: '2026-05-15T12:00:00.000Z',
      process: {
        pid: 123,
        nodeVersion: 'v22.0.0',
        platform: 'linux',
        arch: 'x64',
        uptimeSeconds: 120,
      },
      memory: {
        rss: 3900 * 1024 * 1024,
        heapTotal: 3600 * 1024 * 1024,
        heapUsed: 3500 * 1024 * 1024,
        external: 20 * 1024 * 1024,
        arrayBuffers: 10 * 1024 * 1024,
      },
      v8: {
        heapStatistics: {
          heap_size_limit: 4096 * 1024 * 1024,
          total_available_size: 200 * 1024 * 1024,
        },
        heapSpaces: [],
      },
      activeHandles: { count: 3, unavailable: false },
      activeRequests: { count: 1, unavailable: false },
    });

    expect(report).toContain('Status: warn');
    expect(report).toContain('Heap pressure: 85.4%');
    expect(report).toContain('V8 heap usage is high');
    expect(report).toContain('restart Qwen Code to recover memory');
    expect(report).toContain('capture a heap snapshot');
  });

  it('surfaces large non-heap memory gaps separately from V8 heap pressure', () => {
    const report = formatMemoryDiagnostics({
      generatedAt: '2026-05-15T12:00:00.000Z',
      process: {
        pid: 123,
        nodeVersion: 'v22.0.0',
        platform: 'linux',
        arch: 'x64',
        uptimeSeconds: 120,
      },
      memory: {
        rss: 1800 * 1024 * 1024,
        heapTotal: 500 * 1024 * 1024,
        heapUsed: 300 * 1024 * 1024,
        external: 900 * 1024 * 1024,
        arrayBuffers: 300 * 1024 * 1024,
      },
      v8: {
        heapStatistics: {
          heap_size_limit: 4096 * 1024 * 1024,
          total_available_size: 3000 * 1024 * 1024,
        },
        heapSpaces: [],
      },
      activeHandles: { count: 3, unavailable: false },
      activeRequests: { count: 1, unavailable: false },
    });

    expect(report).toContain('Status: warn');
    expect(report).toContain('RSS / heap-total gap: 1300.0 MiB');
    expect(report).toContain('Non-heap memory is high');
    expect(report).toContain(
      'large tool results, buffers, or native allocations',
    );
  });

  it('writes heap snapshots to a diagnostics directory with stable filenames', () => {
    const outputDir = path.join(os.tmpdir(), 'qwen-memory-diagnostics-test');
    const writtenPath = writeMemoryHeapSnapshot({
      outputDir,
      now: new Date('2026-05-15T12:00:00.000Z'),
      writeSnapshot: (filePath) => {
        fs.writeFileSync(filePath, 'snapshot');
        return filePath;
      },
    });

    expect(writtenPath).toBe(
      path.join(
        outputDir,
        `qwen-code-heap-${process.pid}-2026-05-15T12-00-00-000Z.heapsnapshot`,
      ),
    );
  });

  it('refuses heap snapshots when estimated heap dump would leave little free disk', () => {
    const outputDir = path.join(
      os.tmpdir(),
      `qwen-memory-diagnostics-disk-${process.pid}`,
    );
    fs.rmSync(outputDir, { recursive: true, force: true });

    try {
      expect(() =>
        writeMemoryHeapSnapshot({
          outputDir,
          writeSnapshot: (filePath) => {
            fs.writeFileSync(filePath, 'snapshot');
            return filePath;
          },
          estimateSnapshotBytes: () => 900,
          getAvailableBytes: () => 1000,
          minFreeBytesAfterSnapshot: 200,
        }),
      ).toThrow('Insufficient free disk space');
      expect(fs.readdirSync(outputDir)).toHaveLength(0);
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('rate-limits repeated heap snapshot writes in the same directory', () => {
    const outputDir = path.join(
      os.tmpdir(),
      `qwen-memory-diagnostics-rate-limit-${process.pid}`,
    );
    fs.rmSync(outputDir, { recursive: true, force: true });

    try {
      const writeSnapshot = (filePath: string) => {
        fs.writeFileSync(filePath, 'snapshot');
        return filePath;
      };

      writeMemoryHeapSnapshot({
        outputDir,
        now: new Date('2026-05-15T12:00:00.000Z'),
        writeSnapshot,
      });

      expect(() =>
        writeMemoryHeapSnapshot({
          outputDir,
          now: new Date('2026-05-15T12:00:30.000Z'),
          writeSnapshot,
        }),
      ).toThrow('Heap snapshot rate limit');
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('keeps only the newest heap snapshots after writing', () => {
    const outputDir = path.join(
      os.tmpdir(),
      `qwen-memory-diagnostics-cleanup-${process.pid}`,
    );
    fs.rmSync(outputDir, { recursive: true, force: true });
    fs.mkdirSync(outputDir, { recursive: true });

    const oldSnapshot = path.join(
      outputDir,
      `qwen-code-heap-${process.pid}-2026-05-15T11-00-00-000Z.heapsnapshot`,
    );
    const newerSnapshot = path.join(
      outputDir,
      `qwen-code-heap-${process.pid}-2026-05-15T11-30-00-000Z.heapsnapshot`,
    );
    fs.writeFileSync(oldSnapshot, 'old');
    fs.writeFileSync(newerSnapshot, 'newer');

    const writtenPath = writeMemoryHeapSnapshot({
      outputDir,
      now: new Date('2026-05-15T12:00:00.000Z'),
      maxSnapshots: 2,
      writeSnapshot: (filePath) => {
        fs.writeFileSync(filePath, 'snapshot');
        return filePath;
      },
    });

    try {
      expect(fs.existsSync(oldSnapshot)).toBe(false);
      expect(fs.existsSync(newerSnapshot)).toBe(true);
      expect(fs.existsSync(writtenPath)).toBe(true);
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('creates heap snapshot directories and files with private permissions', () => {
    const outputDir = path.join(
      os.tmpdir(),
      `qwen-memory-diagnostics-private-${process.pid}`,
    );
    fs.rmSync(outputDir, { recursive: true, force: true });

    const writtenPath = writeMemoryHeapSnapshot({
      outputDir,
      now: new Date('2026-05-15T12:00:00.000Z'),
      writeSnapshot: (filePath) => {
        fs.writeFileSync(filePath, 'snapshot');
        return filePath;
      },
    });

    try {
      expect(fs.statSync(outputDir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(writtenPath).mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('marks V8 diagnostics as warning when heap statistics are unavailable', () => {
    const report = formatMemoryDiagnostics({
      generatedAt: '2026-05-15T12:00:00.000Z',
      process: {
        pid: 123,
        nodeVersion: 'v22.0.0',
        platform: 'linux',
        arch: 'x64',
        uptimeSeconds: 120,
      },
      memory: {
        rss: 100 * 1024 * 1024,
        heapTotal: 80 * 1024 * 1024,
        heapUsed: 40 * 1024 * 1024,
        external: 5 * 1024 * 1024,
        arrayBuffers: 2 * 1024 * 1024,
      },
      v8: {
        unavailable: true,
        heapSpaces: [],
      },
      activeHandles: { count: 3, unavailable: false },
      activeRequests: { count: 1, unavailable: false },
    });

    expect(report).toContain('Status: warn');
    expect(report).toContain('V8 heap statistics are unavailable');
    expect(report).not.toContain(
      'No immediate memory pressure signals detected.',
    );
  });

  it('collects repeated memory pressure samples with waits between samples', async () => {
    const waits: number[] = [];
    const memoryUsages = [
      {
        rss: 100 * 1024 * 1024,
        heapTotal: 80 * 1024 * 1024,
        heapUsed: 40 * 1024 * 1024,
        external: 5 * 1024 * 1024,
        arrayBuffers: 2 * 1024 * 1024,
      },
      {
        rss: 130 * 1024 * 1024,
        heapTotal: 90 * 1024 * 1024,
        heapUsed: 60 * 1024 * 1024,
        external: 6 * 1024 * 1024,
        arrayBuffers: 3 * 1024 * 1024,
      },
      {
        rss: 150 * 1024 * 1024,
        heapTotal: 100 * 1024 * 1024,
        heapUsed: 70 * 1024 * 1024,
        external: 7 * 1024 * 1024,
        arrayBuffers: 4 * 1024 * 1024,
      },
    ];

    const samples = await collectMemoryPressureSamples({
      sampleCount: 3,
      intervalMs: 25,
      now: () => new Date('2026-05-15T12:00:00.000Z'),
      memoryUsage: () => memoryUsages.shift()!,
      wait: async (ms) => {
        waits.push(ms);
      },
    });

    expect(samples).toHaveLength(3);
    expect(waits).toEqual([25, 25]);
    expect(samples[0]).toMatchObject({ index: 1, rss: 100 * 1024 * 1024 });
    expect(samples[2]).toMatchObject({ index: 3, heapUsed: 70 * 1024 * 1024 });
  });

  it('formats single memory pressure sample deltas as unavailable', () => {
    const report = formatMemoryPressureSamples([
      {
        index: 1,
        timestamp: '2026-05-15T12:00:00.000Z',
        rss: 100 * 1024 * 1024,
        heapTotal: 80 * 1024 * 1024,
        heapUsed: 40 * 1024 * 1024,
        external: 5 * 1024 * 1024,
        arrayBuffers: 2 * 1024 * 1024,
      },
    ]);

    expect(report).toContain('Sample count: 1');
    expect(report).toContain('RSS delta: unavailable');
    expect(report).toContain('Heap used delta: unavailable');
  });

  it('formats memory pressure sample deltas', () => {
    const report = formatMemoryPressureSamples([
      {
        index: 1,
        timestamp: '2026-05-15T12:00:00.000Z',
        rss: 100 * 1024 * 1024,
        heapTotal: 80 * 1024 * 1024,
        heapUsed: 40 * 1024 * 1024,
        external: 5 * 1024 * 1024,
        arrayBuffers: 2 * 1024 * 1024,
      },
      {
        index: 2,
        timestamp: '2026-05-15T12:00:01.000Z',
        rss: 130 * 1024 * 1024,
        heapTotal: 90 * 1024 * 1024,
        heapUsed: 60 * 1024 * 1024,
        external: 6 * 1024 * 1024,
        arrayBuffers: 3 * 1024 * 1024,
      },
    ]);

    expect(report).toContain('Memory pressure samples');
    expect(report).toContain('Sample count: 2');
    expect(report).toContain('RSS delta: 30.0 MiB');
    expect(report).toContain('Heap used delta: 20.0 MiB');
    expect(report).toContain('#2 2026-05-15T12:00:01.000Z');
  });
});
