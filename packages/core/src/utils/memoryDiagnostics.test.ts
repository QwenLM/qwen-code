/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import process from 'node:process';

const debugLogger = vi.hoisted(() => ({
  debug: vi.fn(),
}));

vi.mock('./debugLogger.js', () => ({
  createDebugLogger: () => debugLogger,
}));

import { collectMemoryDiagnostics } from './memoryDiagnostics.js';

describe('collectMemoryDiagnostics', () => {
  afterEach(() => {
    debugLogger.debug.mockReset();
    vi.restoreAllMocks();
  });

  it('captures memory, V8, resource, handle, fd, smaps, and risk data', async () => {
    const diagnostics = await collectMemoryDiagnostics({
      now: () => new Date('2026-05-01T10:00:00.000Z'),
      sessionId: 'session-123',
      qwenVersion: '0.15.6',
      memoryUsage: () => ({
        heapUsed: 32 * 1024 * 1024,
        heapTotal: 40 * 1024 * 1024,
        rss: 100 * 1024 * 1024,
        external: 700,
        arrayBuffers: 300,
      }),
      heapStatistics: () => ({
        heap_size_limit: 40 * 1024 * 1024,
        total_heap_size: 40 * 1024 * 1024,
        total_heap_size_executable: 0,
        total_physical_size: 40 * 1024 * 1024,
        used_heap_size: 32 * 1024 * 1024,
        malloced_memory: 80 * 1024 * 1024,
        peak_malloced_memory: 90 * 1024 * 1024,
        does_zap_garbage: 0,
        number_of_native_contexts: 2,
        number_of_detached_contexts: 1,
        total_available_size: 400,
        total_global_handles_size: 0,
        used_global_handles_size: 0,
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
      resourceUsage: () => ({
        userCPUTime: 10,
        systemCPUTime: 20,
        maxRSS: 6,
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
      }),
      uptimeSeconds: () => 60,
      activeHandles: () => 300,
      activeRequests: () => 3,
      openFileDescriptors: async () => 501,
      smapsRollup: async () => 'Rss: 5000 kB',
      platform: 'linux',
      nodeVersion: 'v20.19.0',
    });

    expect(diagnostics).toMatchObject({
      timestamp: '2026-05-01T10:00:00.000Z',
      sessionId: 'session-123',
      qwenVersion: '0.15.6',
      uptimeSeconds: 60,
      memoryUsage: {
        heapUsed: 32 * 1024 * 1024,
        heapTotal: 40 * 1024 * 1024,
        rss: 100 * 1024 * 1024,
        external: 700,
        arrayBuffers: 300,
      },
      v8HeapStats: {
        heapSizeLimit: 40 * 1024 * 1024,
        totalHeapSize: 40 * 1024 * 1024,
        usedHeapSize: 32 * 1024 * 1024,
        mallocedMemory: 80 * 1024 * 1024,
        peakMallocedMemory: 90 * 1024 * 1024,
        detachedContexts: 1,
        nativeContexts: 2,
      },
      v8HeapSpaces: [
        {
          name: 'old_space',
          size: 1_000,
          used: 800,
          available: 200,
        },
      ],
      resourceUsage: {
        maxRSS: 6,
        userCPUTime: 10,
        systemCPUTime: 20,
      },
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
    const diagnostics = await collectMemoryDiagnostics({
      memoryUsage: () => ({
        heapUsed: 1_600,
        heapTotal: 2_000,
        rss: 5_000,
        external: 700,
        arrayBuffers: 300,
      }),
      heapStatistics: () => ({
        heap_size_limit: 2_000,
        total_heap_size: 2_000,
        total_heap_size_executable: 0,
        total_physical_size: 2_000,
        used_heap_size: 1_600,
        // 32 MB malloced, well above 2× the tiny heap but below the 64 MB
        // floor — should not flag as a leak indicator.
        malloced_memory: 32 * 1024 * 1024,
        peak_malloced_memory: 32 * 1024 * 1024,
        does_zap_garbage: 0,
        number_of_native_contexts: 1,
        number_of_detached_contexts: 0,
        total_available_size: 400,
        total_global_handles_size: 0,
        used_global_handles_size: 0,
        external_memory: 700,
      }),
      activeHandles: () => 0,
      activeRequests: () => 0,
    });

    expect(diagnostics.analysis.risks).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'native-memory-pressure' }),
      ]),
    );
  });

  it('does not flag active-handles below the 256 threshold', async () => {
    const diagnostics = await collectMemoryDiagnostics({
      memoryUsage: () => ({
        heapUsed: 100,
        heapTotal: 200,
        rss: 300,
        external: 10,
        arrayBuffers: 5,
      }),
      heapStatistics: () => ({
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
      }),
      activeHandles: () => 200,
      activeRequests: () => 0,
    });

    expect(diagnostics.analysis.risks).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'active-handles' }),
      ]),
    );
  });

  it('treats maxRSS as bytes on all platforms', async () => {
    const diagnostics = await collectMemoryDiagnostics({
      memoryUsage: () => ({
        heapUsed: 100,
        heapTotal: 200,
        rss: 300,
        external: 10,
        arrayBuffers: 5,
      }),
      heapStatistics: () => ({
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
      }),
      resourceUsage: () => ({
        userCPUTime: 10,
        systemCPUTime: 20,
        maxRSS: 4_096,
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
      }),
      platform: 'darwin',
      nodeVersion: 'v20.19.0',
    });

    // Node.js >=14.10.0 returns maxRSS in bytes on all platforms.
    expect(diagnostics.resourceUsage.maxRSS).toBe(4_096);
  });

  it('treats unsupported optional probes as unavailable instead of failing', async () => {
    const diagnostics = await collectMemoryDiagnostics({
      memoryUsage: () => ({
        heapUsed: 100,
        heapTotal: 200,
        rss: 300,
        external: 10,
        arrayBuffers: 5,
      }),
      heapStatistics: () => ({
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
      }),
      heapSpaceStatistics: () => {
        throw new Error('not available');
      },
      activeHandles: () => 0,
      activeRequests: () => 0,
      openFileDescriptors: async () => {
        throw new Error('not available');
      },
      smapsRollup: async () => {
        throw new Error('not available');
      },
    });

    expect(diagnostics.v8HeapSpaces).toBeNull();
    expect(diagnostics.openFileDescriptors).toBeNull();
    expect(diagnostics.smapsRollup).toBeNull();
    expect(diagnostics.analysis.risks).toEqual([]);
    expect(diagnostics.analysis.recommendation).toBe(
      'No obvious leak indicators detected.',
    );
    expect(diagnostics.analysis.recommendation).not.toContain('heap snapshot');
    expect(debugLogger.debug).toHaveBeenCalledWith(
      expect.stringContaining('heapSpaceStatistics'),
      expect.any(Error),
    );
    expect(debugLogger.debug).toHaveBeenCalledWith(
      expect.stringContaining('openFileDescriptors'),
      expect.any(Error),
    );
    expect(debugLogger.debug).toHaveBeenCalledWith(
      expect.stringContaining('smapsRollup'),
      expect.any(Error),
    );
  });

  it('treats active handle and request probe failures as zero counts', async () => {
    const diagnostics = await collectMemoryDiagnostics({
      memoryUsage: () => ({
        heapUsed: 100,
        heapTotal: 200,
        rss: 300,
        external: 10,
        arrayBuffers: 5,
      }),
      heapStatistics: () => ({
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
      }),
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
      const diagnostics = await collectMemoryDiagnostics({
        memoryUsage: () => ({
          heapUsed: 100,
          heapTotal: 200,
          rss: 300,
          external: 10,
          arrayBuffers: 5,
        }),
        heapStatistics: () => ({
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
        }),
      });

      expect(diagnostics.activeHandles).toBe(0);
      expect(diagnostics.activeRequests).toBe(0);
      expect(debugLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('activeHandles'),
        expect.any(Error),
      );
      expect(debugLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('activeRequests'),
        expect.any(Error),
      );
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

    const diagnosticsPromise = collectMemoryDiagnostics({
      memoryUsage: () => ({
        heapUsed: 100,
        heapTotal: 200,
        rss: 300,
        external: 10,
        arrayBuffers: 5,
      }),
      heapStatistics: () => ({
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
      }),
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
    const diagnostics = await collectMemoryDiagnostics({
      memoryUsage: () => ({
        heapUsed: 100,
        heapTotal: 200,
        rss: 300,
        external: 10,
        arrayBuffers: 5,
      }),
      heapStatistics: () => ({
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
      }),
      activeRequests: () => 101,
    });

    expect(diagnostics.analysis.risks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'active-requests' }),
      ]),
    );
  });

  it('does not flag native pressure from normal RSS overhead alone', async () => {
    const diagnostics = await collectMemoryDiagnostics({
      memoryUsage: () => ({
        heapUsed: 5 * 1024 * 1024,
        heapTotal: 8 * 1024 * 1024,
        rss: 50 * 1024 * 1024,
        external: 10,
        arrayBuffers: 5,
      }),
      heapStatistics: () => ({
        heap_size_limit: 512 * 1024 * 1024,
        total_heap_size: 8 * 1024 * 1024,
        total_heap_size_executable: 0,
        total_physical_size: 8 * 1024 * 1024,
        used_heap_size: 5 * 1024 * 1024,
        malloced_memory: 512 * 1024,
        peak_malloced_memory: 1024 * 1024,
        does_zap_garbage: 0,
        number_of_native_contexts: 1,
        number_of_detached_contexts: 0,
        total_available_size: 500 * 1024 * 1024,
        total_global_handles_size: 0,
        used_global_handles_size: 0,
        external_memory: 10,
      }),
    });

    expect(diagnostics.analysis.risks).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'native-memory-pressure' }),
      ]),
    );
  });

  it('flags RSS that is much larger than JS heap with a high floor', async () => {
    const diagnostics = await collectMemoryDiagnostics({
      memoryUsage: () => ({
        heapUsed: 50 * 1024 * 1024,
        heapTotal: 64 * 1024 * 1024,
        rss: 800 * 1024 * 1024,
        external: 10,
        arrayBuffers: 5,
      }),
      heapStatistics: () => ({
        heap_size_limit: 512 * 1024 * 1024,
        total_heap_size: 64 * 1024 * 1024,
        total_heap_size_executable: 0,
        total_physical_size: 64 * 1024 * 1024,
        used_heap_size: 50 * 1024 * 1024,
        malloced_memory: 512 * 1024,
        peak_malloced_memory: 1024 * 1024,
        does_zap_garbage: 0,
        number_of_native_contexts: 1,
        number_of_detached_contexts: 0,
        total_available_size: 450 * 1024 * 1024,
        total_global_handles_size: 0,
        used_global_handles_size: 0,
        external_memory: 10,
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
