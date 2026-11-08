/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import process from 'node:process';
import type { HeapInfo } from 'node:v8';

const debugLogger = vi.hoisted(() => ({
  debug: vi.fn(),
}));

vi.mock('./debugLogger.js', () => ({
  createDebugLogger: () => debugLogger,
}));

import {
  collectMemoryDiagnostics,
  type MemoryDiagnosticsOptions,
} from './memoryDiagnostics.js';

const MB = 1024 * 1024;

/** memoryUsage probe; defaults are the small baseline heap most cases use. */
const memoryUsage =
  (overrides: Partial<NodeJS.MemoryUsage> = {}) =>
  () => ({
    heapUsed: 100,
    heapTotal: 200,
    rss: 300,
    external: 10,
    arrayBuffers: 5,
    ...overrides,
  });

/** heapStatistics probe matching the baseline memoryUsage by default. */
const heapStatistics =
  (overrides: Partial<HeapInfo> = {}) =>
  (): HeapInfo => ({
    heap_size_limit: 1_000,
    total_heap_size: 200,
    total_heap_size_executable: 0,
    total_physical_size: 200,
    used_heap_size: 100,
    malloced_memory: 0,
    peak_malloced_memory: 0,
    does_zap_garbage: 0,
    number_of_native_contexts: 1,
    number_of_detached_contexts: 0,
    total_available_size: 900,
    total_global_handles_size: 0,
    used_global_handles_size: 0,
    external_memory: 10,
    ...overrides,
  });

/** resourceUsage probe: 10/20 CPU time, the given maxRSS, all counters 0. */
const resourceUsage = (maxRSS: number) => () => ({
  userCPUTime: 10,
  systemCPUTime: 20,
  maxRSS,
  sharedMemorySize: 0,
  unsharedDataSize: 0,
  unsharedStackSize: 0,
  minorPageFault: 0,
  majorPageFault: 0,
  swappedOut: 0,
  fsRead: 0,
  fsWrite: 0,
  ipcSent: 0,
  ipcReceived: 0,
  signalsCount: 0,
  voluntaryContextSwitches: 0,
  involuntaryContextSwitches: 0,
});

const processTree = () => ({
  rootPid: 123,
  processCount: 3,
  rootRSS: 10 * MB,
  treeRSS: 25 * MB,
});

const unavailable = () => {
  throw new Error('not available');
};
const unavailableAsync = async () => unavailable();

/** Collects with the baseline heap probes unless `options` overrides them. */
const collect = (options: MemoryDiagnosticsOptions = {}) =>
  collectMemoryDiagnostics({
    memoryUsage: memoryUsage(),
    heapStatistics: heapStatistics(),
    ...options,
  });

const withRisk = (type: string) =>
  expect.arrayContaining([expect.objectContaining({ type })]);

describe('collectMemoryDiagnostics', () => {
  afterEach(() => {
    debugLogger.debug.mockReset();
    vi.restoreAllMocks();
  });

  it('captures memory, V8, resource, handle, fd, smaps, and risk data', async () => {
    const diagnostics = await collect({
      now: () => new Date('2026-05-01T10:00:00.000Z'),
      sessionId: 'session-123',
      qwenVersion: '0.15.6',
      memoryUsage: memoryUsage({
        heapUsed: 32 * MB,
        heapTotal: 40 * MB,
        rss: 100 * MB,
        external: 700,
        arrayBuffers: 300,
      }),
      heapStatistics: heapStatistics({
        heap_size_limit: 40 * MB,
        total_heap_size: 40 * MB,
        total_physical_size: 40 * MB,
        used_heap_size: 32 * MB,
        malloced_memory: 80 * MB,
        peak_malloced_memory: 90 * MB,
        number_of_native_contexts: 2,
        number_of_detached_contexts: 1,
        total_available_size: 400,
        external_memory: 700,
      }),
      heapSpaceStatistics: () => [
        {
          space_name: 'old_space',
          space_size: 1_000,
          space_used_size: 800,
          space_available_size: 200,
          physical_space_size: 1_000,
        },
      ],
      resourceUsage: resourceUsage(6),
      uptimeSeconds: () => 60,
      activeHandles: () => 300,
      activeRequests: () => 3,
      openFileDescriptors: async () => 501,
      smapsRollup: async () => 'Rss: 5000 kB',
      processTree: unavailableAsync,
      platform: 'linux',
      nodeVersion: 'v20.19.0',
    });

    expect(diagnostics).toMatchObject({
      timestamp: '2026-05-01T10:00:00.000Z',
      sessionId: 'session-123',
      qwenVersion: '0.15.6',
      uptimeSeconds: 60,
      memoryUsage: {
        heapUsed: 32 * MB,
        heapTotal: 40 * MB,
        rss: 100 * MB,
        external: 700,
        arrayBuffers: 300,
      },
      v8HeapStats: {
        heapSizeLimit: 40 * MB,
        totalHeapSize: 40 * MB,
        usedHeapSize: 32 * MB,
        mallocedMemory: 80 * MB,
        peakMallocedMemory: 90 * MB,
        detachedContexts: 1,
        nativeContexts: 2,
      },
      v8HeapSpaces: [
        { name: 'old_space', size: 1_000, used: 800, available: 200 },
      ],
      resourceUsage: {
        maxRSS: 6 * 1024,
        maxRSSRaw: 6,
        maxRSSUnit: 'KiB',
        userCPUTime: 10,
        systemCPUTime: 20,
      },
      processTree: null,
      activeHandles: 300,
      activeRequests: 3,
      openFileDescriptors: 501,
      smapsRollup: 'Rss: 5000 kB',
      platform: 'linux',
      nodeVersion: 'v20.19.0',
    });

    expect('memoryGrowthRate' in diagnostics).toBe(false);

    expect(diagnostics.analysis.risks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'heap-pressure' }),
        expect.objectContaining({ type: 'detached-contexts' }),
        expect.objectContaining({ type: 'active-handles' }),
        expect.objectContaining({ type: 'fd-leak' }),
        expect.objectContaining({ type: 'native-memory-pressure' }),
      ]),
    );

    const nativeRisk = diagnostics.analysis.risks.find(
      (risk) => risk.type === 'native-memory-pressure',
    );
    expect(nativeRisk?.message).toContain('80.0 MB');
    expect(nativeRisk?.message).toContain('32.0 MB');
    expect(diagnostics.analysis.recommendation).toBe(
      '5 potential leak indicator(s) found.',
    );
    expect(diagnostics.analysis.recommendation).not.toContain('WARNING:');
  });

  it('does not flag native pressure when malloced memory is below the absolute floor', async () => {
    const diagnostics = await collect({
      memoryUsage: memoryUsage({
        heapUsed: 1_600,
        heapTotal: 2_000,
        rss: 5_000,
        external: 700,
        arrayBuffers: 300,
      }),
      heapStatistics: heapStatistics({
        heap_size_limit: 2_000,
        total_heap_size: 2_000,
        total_physical_size: 2_000,
        used_heap_size: 1_600,
        // 32 MB malloced, well above 2× the tiny heap but below the 64 MB
        // floor — should not flag as a leak indicator.
        malloced_memory: 32 * MB,
        peak_malloced_memory: 32 * MB,
        total_available_size: 400,
        external_memory: 700,
      }),
      activeHandles: () => 0,
      activeRequests: () => 0,
    });

    expect(diagnostics.analysis.risks).not.toEqual(
      withRisk('native-memory-pressure'),
    );
  });

  it('does not flag active-handles below the 256 threshold', async () => {
    const diagnostics = await collect({
      activeHandles: () => 200,
      activeRequests: () => 0,
    });
    expect(diagnostics.analysis.risks).not.toEqual(withRisk('active-handles'));
  });

  it('normalizes resourceUsage maxRSS from KiB to bytes', async () => {
    const diagnostics = await collect({
      resourceUsage: resourceUsage(4_096),
      platform: 'darwin',
      nodeVersion: 'v20.19.0',
    });

    expect(diagnostics.resourceUsage.maxRSS).toBe(4_096 * 1024);
    expect(diagnostics.resourceUsage.maxRSSRaw).toBe(4_096);
    expect(diagnostics.resourceUsage.maxRSSUnit).toBe('KiB');
  });

  it('includes process tree RSS when the optional probe is available', async () => {
    const diagnostics = await collect({
      resourceUsage: resourceUsage(4_096),
      processTree: async () => processTree(),
      platform: 'darwin',
      nodeVersion: 'v20.19.0',
    });
    expect(diagnostics.processTree).toEqual(processTree());
  });

  it('treats unsupported optional probes as unavailable instead of failing', async () => {
    const diagnostics = await collect({
      heapSpaceStatistics: unavailable,
      activeHandles: () => 0,
      activeRequests: () => 0,
      openFileDescriptors: unavailableAsync,
      smapsRollup: unavailableAsync,
    });

    expect(diagnostics.v8HeapSpaces).toBeNull();
    expect(diagnostics.openFileDescriptors).toBeNull();
    expect(diagnostics.smapsRollup).toBeNull();
    expect(diagnostics.analysis.risks).toEqual([]);
    expect(diagnostics.analysis.recommendation).toBe(
      'No obvious leak indicators detected.',
    );
    expect(diagnostics.analysis.recommendation).not.toContain('heap snapshot');
    for (const probe of [
      'heapSpaceStatistics',
      'openFileDescriptors',
      'smapsRollup',
    ]) {
      expect(debugLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining(probe),
        expect.any(Error),
      );
    }
  });

  it('treats active handle and request probe failures as zero counts', async () => {
    const diagnostics = await collect({
      activeHandles: () => {
        throw new Error('handles unavailable');
      },
      activeRequests: () => {
        throw new Error('requests unavailable');
      },
    });

    expect(diagnostics.activeHandles).toBe(0);
    expect(diagnostics.activeRequests).toBe(0);
    expect(diagnostics.analysis.risks).toEqual([]);
  });

  it('logs unavailable Node.js internal active probes before returning zero counts', async () => {
    const internals = process as typeof process & {
      _getActiveHandles?: () => unknown[];
      _getActiveRequests?: () => unknown[];
    };
    const originalGetActiveHandles = internals._getActiveHandles;
    const originalGetActiveRequests = internals._getActiveRequests;
    internals._getActiveHandles = undefined;
    internals._getActiveRequests = undefined;

    try {
      const diagnostics = await collect();

      expect(diagnostics.activeHandles).toBe(0);
      expect(diagnostics.activeRequests).toBe(0);
      for (const probe of ['activeHandles', 'activeRequests']) {
        expect(debugLogger.debug).toHaveBeenCalledWith(
          expect.stringContaining(probe),
          expect.any(Error),
        );
      }
    } finally {
      internals._getActiveHandles = originalGetActiveHandles;
      internals._getActiveRequests = originalGetActiveRequests;
    }
  });

  it('starts independent optional probes before awaiting slow probes', async () => {
    let resolveFileDescriptors: ((count: number) => void) | undefined;
    const fileDescriptors = new Promise<number>((resolve) => {
      resolveFileDescriptors = resolve;
    });
    let smapsStarted = false;
    let heapSpacesStarted = false;

    const diagnosticsPromise = collect({
      heapSpaceStatistics: () => {
        heapSpacesStarted = true;
        return [];
      },
      activeHandles: () => 0,
      activeRequests: () => 0,
      openFileDescriptors: () => fileDescriptors,
      smapsRollup: async () => {
        smapsStarted = true;
        return 'Rss: 300 kB';
      },
    });

    await Promise.resolve();
    expect(smapsStarted).toBe(true);
    expect(heapSpacesStarted).toBe(true);

    resolveFileDescriptors?.(4);
    const diagnostics = await diagnosticsPromise;

    expect(diagnostics.openFileDescriptors).toBe(4);
    expect(diagnostics.smapsRollup).toBe('Rss: 300 kB');
  });

  it('flags unusually high active requests', async () => {
    const diagnostics = await collect({ activeRequests: () => 101 });
    expect(diagnostics.analysis.risks).toEqual(withRisk('active-requests'));
  });

  it('does not flag native pressure from normal RSS overhead alone', async () => {
    const diagnostics = await collect({
      memoryUsage: memoryUsage({
        heapUsed: 5 * MB,
        heapTotal: 8 * MB,
        rss: 50 * MB,
      }),
      heapStatistics: heapStatistics({
        heap_size_limit: 512 * MB,
        total_heap_size: 8 * MB,
        total_physical_size: 8 * MB,
        used_heap_size: 5 * MB,
        malloced_memory: 512 * 1024,
        peak_malloced_memory: MB,
        total_available_size: 500 * MB,
      }),
    });

    expect(diagnostics.analysis.risks).not.toEqual(
      withRisk('native-memory-pressure'),
    );
  });

  it('flags RSS that is much larger than JS heap with a high floor', async () => {
    const diagnostics = await collect({
      memoryUsage: memoryUsage({
        heapUsed: 50 * MB,
        heapTotal: 64 * MB,
        rss: 800 * MB,
      }),
      heapStatistics: heapStatistics({
        heap_size_limit: 512 * MB,
        total_heap_size: 64 * MB,
        total_physical_size: 64 * MB,
        used_heap_size: 50 * MB,
        malloced_memory: 512 * 1024,
        peak_malloced_memory: MB,
        total_available_size: 450 * MB,
      }),
      activeHandles: () => 0,
      activeRequests: () => 0,
    });

    expect(diagnostics.analysis.risks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'rss-heap-gap',
          message: expect.stringContaining('800.0 MB'),
        }),
      ]),
    );
  });
});
