/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearHeapSnapshotRateLimit,
  collectMemoryPressureSamples,
  formatMemoryDiagnostics,
  formatMemoryPressureSamples,
  getMemoryDiagnostics,
  isHighHeapPressure,
  writeMemoryHeapSnapshot,
} from './memoryDiagnostics.js';

describe('memoryDiagnostics', () => {
  afterEach(() => {
    clearHeapSnapshotRateLimit();
    vi.restoreAllMocks();
    vi.doUnmock('node:fs');
    vi.doUnmock('node:v8');
  });

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

  it('orders heap snapshot cleanup by modification time across process ids', () => {
    const outputDir = path.join(
      os.tmpdir(),
      `qwen-memory-diagnostics-mtime-cleanup-${process.pid}`,
    );
    fs.rmSync(outputDir, { recursive: true, force: true });
    fs.mkdirSync(outputDir, { recursive: true });

    const newerLowPidSnapshot = path.join(
      outputDir,
      'qwen-code-heap-9-2026-05-15T12-30-00-000Z.heapsnapshot',
    );
    const olderHighPidSnapshot = path.join(
      outputDir,
      'qwen-code-heap-12345-2026-05-15T12-00-00-000Z.heapsnapshot',
    );
    fs.writeFileSync(newerLowPidSnapshot, 'newer');
    fs.writeFileSync(olderHighPidSnapshot, 'older');
    fs.utimesSync(
      olderHighPidSnapshot,
      new Date('2026-05-15T12:00:00.000Z'),
      new Date('2026-05-15T12:00:00.000Z'),
    );
    fs.utimesSync(
      newerLowPidSnapshot,
      new Date('2026-05-15T12:30:00.000Z'),
      new Date('2026-05-15T12:30:00.000Z'),
    );

    const writtenPath = writeMemoryHeapSnapshot({
      outputDir,
      now: new Date('2026-05-15T13:00:00.000Z'),
      maxSnapshots: 2,
      writeSnapshot: (filePath) => {
        fs.writeFileSync(filePath, 'snapshot');
        return filePath;
      },
    });

    try {
      expect(fs.existsSync(olderHighPidSnapshot)).toBe(false);
      expect(fs.existsSync(newerLowPidSnapshot)).toBe(true);
      expect(fs.existsSync(writtenPath)).toBe(true);
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('uses filename timestamps to break equal-mtime cleanup ties', () => {
    const outputDir = path.join(
      os.tmpdir(),
      `qwen-memory-diagnostics-equal-mtime-cleanup-${process.pid}`,
    );
    fs.rmSync(outputDir, { recursive: true, force: true });
    fs.mkdirSync(outputDir, { recursive: true });

    const olderSnapshot = path.join(
      outputDir,
      'qwen-code-heap-1-2026-05-15T11-00-00-000Z.heapsnapshot',
    );
    const newerSnapshot = path.join(
      outputDir,
      'qwen-code-heap-1-2026-05-15T12-00-00-000Z.heapsnapshot',
    );
    fs.writeFileSync(olderSnapshot, 'older');
    fs.writeFileSync(newerSnapshot, 'newer');
    const sameMtime = new Date('2026-05-15T12:00:00.000Z');
    fs.utimesSync(olderSnapshot, sameMtime, sameMtime);
    fs.utimesSync(newerSnapshot, sameMtime, sameMtime);

    const writtenPath = writeMemoryHeapSnapshot({
      outputDir,
      now: new Date('2026-05-15T13:00:00.000Z'),
      maxSnapshots: 2,
      writeSnapshot: (filePath) => {
        fs.writeFileSync(filePath, 'snapshot');
        return filePath;
      },
    });

    try {
      expect(fs.existsSync(olderSnapshot)).toBe(false);
      expect(fs.existsSync(newerSnapshot)).toBe(true);
      expect(fs.existsSync(writtenPath)).toBe(true);
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('keeps successful heap snapshot writes when cleanup fails', () => {
    const outputDir = path.join(
      os.tmpdir(),
      `qwen-memory-diagnostics-cleanup-fail-${process.pid}`,
    );
    fs.rmSync(outputDir, { recursive: true, force: true });
    fs.mkdirSync(outputDir, { recursive: true });
    const brokenSymlink = path.join(
      outputDir,
      'qwen-code-heap-999-2026-05-15T11-00-00-000Z.heapsnapshot',
    );
    fs.symlinkSync('missing-target.heapsnapshot', brokenSymlink);

    try {
      const writtenPath = writeMemoryHeapSnapshot({
        outputDir,
        now: new Date('2026-05-15T12:00:00.000Z'),
        maxSnapshots: 1,
        writeSnapshot: (filePath) => {
          fs.writeFileSync(filePath, 'snapshot');
          return filePath;
        },
      });

      expect(fs.existsSync(writtenPath)).toBe(true);
      expect(() => fs.lstatSync(brokenSymlink)).toThrow();
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('removes partial heap snapshot files after a failed write', () => {
    const outputDir = path.join(
      os.tmpdir(),
      `qwen-memory-diagnostics-partial-${process.pid}`,
    );
    fs.rmSync(outputDir, { recursive: true, force: true });
    let partialPath = '';

    try {
      expect(() =>
        writeMemoryHeapSnapshot({
          outputDir,
          now: new Date('2026-05-15T12:00:00.000Z'),
          writeSnapshot: (filePath) => {
            partialPath = filePath;
            fs.writeFileSync(filePath, 'partial');
            throw new Error('write failed');
          },
        }),
      ).toThrow('write failed');

      expect(fs.existsSync(partialPath)).toBe(false);
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
      expect(fs.existsSync(outputDir)).toBe(true);
      expect(fs.existsSync(writtenPath)).toBe(true);
      if (process.platform !== 'win32') {
        expect(fs.statSync(outputDir).mode & 0o777).toBe(0o700);
        expect(fs.statSync(writtenPath).mode & 0o777).toBe(0o600);
      }
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('refuses heap snapshot writes when free disk space cannot be read', async () => {
    const outputDir = path.join(
      os.tmpdir(),
      `qwen-memory-diagnostics-statfs-fallback-${process.pid}`,
    );
    fs.rmSync(outputDir, { recursive: true, force: true });
    vi.resetModules();
    const statfsSync = vi.fn(() => {
      throw new Error('statfs unavailable');
    });
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>();
      return { ...actual, statfsSync };
    });
    const { writeMemoryHeapSnapshot: writeWithMockedFs } = await import(
      './memoryDiagnostics.js'
    );

    try {
      expect(() =>
        writeWithMockedFs({
          outputDir,
          now: new Date('2026-05-15T12:00:00.000Z'),
          writeSnapshot: (filePath) => {
            fs.writeFileSync(filePath, 'snapshot');
            return filePath;
          },
        }),
      ).toThrow('Unable to check available disk space');

      expect(statfsSync).toHaveBeenCalledWith(outputDir);
      expect(fs.readdirSync(outputDir)).toHaveLength(0);
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('falls back to process heap total when V8 heap statistics are unavailable for snapshot sizing', async () => {
    const outputDir = path.join(
      os.tmpdir(),
      `qwen-memory-diagnostics-estimate-fallback-${process.pid}`,
    );
    fs.rmSync(outputDir, { recursive: true, force: true });
    vi.resetModules();
    const getHeapStatistics = vi.fn(() => {
      throw new Error('heap statistics unavailable');
    });
    vi.doMock('node:v8', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:v8')>();
      return { ...actual, getHeapStatistics };
    });
    const { writeMemoryHeapSnapshot: writeWithMockedV8 } = await import(
      './memoryDiagnostics.js'
    );
    vi.spyOn(process, 'memoryUsage').mockReturnValue({
      rss: 40,
      heapTotal: 100,
      heapUsed: 50,
      external: 10,
      arrayBuffers: 5,
    });

    try {
      expect(() =>
        writeWithMockedV8({
          outputDir,
          now: new Date('2026-05-15T12:00:00.000Z'),
          writeSnapshot: (filePath) => {
            fs.writeFileSync(filePath, 'snapshot');
            return filePath;
          },
          getAvailableBytes: () => 350,
          minFreeBytesAfterSnapshot: 60,
        }),
      ).toThrow('Insufficient free disk space');
      expect(getHeapStatistics).toHaveBeenCalled();
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('uses the default sample count for non-positive sample counts', async () => {
    const samples = await collectMemoryPressureSamples({
      sampleCount: 0,
      intervalMs: 0,
      now: () => new Date('2026-05-15T12:00:00.000Z'),
      memoryUsage: () => ({
        rss: 100,
        heapTotal: 80,
        heapUsed: 40,
        external: 5,
        arrayBuffers: 2,
      }),
      wait: async () => {},
    });

    expect(samples).toHaveLength(3);
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

  it('surfaces high active handle counts with actionable recommendations', () => {
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
        heapStatistics: {
          heap_size_limit: 4096 * 1024 * 1024,
        },
        heapSpaces: [],
      },
      activeHandles: { count: 1000, unavailable: false },
      activeRequests: { count: 1, unavailable: false },
    });

    expect(report).toContain('Active handle count is high');
    expect(report).toContain('MCP servers, watchers, or streaming sessions');
  });

  it('reports high heap pressure only with a finite positive heap limit', () => {
    const baseDiagnostics = {
      generatedAt: '2026-05-15T12:00:00.000Z',
      process: {
        pid: 123,
        nodeVersion: 'v22.0.0',
        platform: 'linux' as const,
        arch: 'x64',
        uptimeSeconds: 120,
      },
      memory: {
        rss: 100,
        heapTotal: 80,
        heapUsed: 90,
        external: 5,
        arrayBuffers: 2,
      },
      v8: {
        heapSpaces: [],
      },
      activeHandles: { count: 3, unavailable: false },
      activeRequests: { count: 1, unavailable: false },
    };

    expect(
      isHighHeapPressure({
        ...baseDiagnostics,
        v8: { ...baseDiagnostics.v8, heapStatistics: { heap_size_limit: 0 } },
      }),
    ).toBe(false);
    expect(
      isHighHeapPressure({
        ...baseDiagnostics,
        v8: { ...baseDiagnostics.v8, heapStatistics: {} },
      }),
    ).toBe(false);
    expect(isHighHeapPressure(baseDiagnostics)).toBe(false);
    expect(
      isHighHeapPressure({
        ...baseDiagnostics,
        v8: {
          ...baseDiagnostics.v8,
          heapStatistics: { heap_size_limit: 100 },
        },
      }),
    ).toBe(true);
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

  it('stops collecting memory pressure samples when aborted', async () => {
    const abortController = new AbortController();
    const samples = await collectMemoryPressureSamples({
      sampleCount: 3,
      intervalMs: 25,
      signal: abortController.signal,
      now: () => new Date('2026-05-15T12:00:00.000Z'),
      memoryUsage: () => {
        abortController.abort();
        return {
          rss: 100,
          heapTotal: 80,
          heapUsed: 40,
          external: 5,
          arrayBuffers: 2,
        };
      },
      wait: async () => {
        throw new Error('should not wait after abort');
      },
    });

    expect(samples).toHaveLength(1);
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
