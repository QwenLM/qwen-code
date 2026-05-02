/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { collectMemoryDiagnostics } from './memoryDiagnostics.js';

describe('collectMemoryDiagnostics', () => {
  it('captures memory, V8, resource, handle, fd, smaps, and risk data', async () => {
    const diagnostics = await collectMemoryDiagnostics({
      now: () => new Date('2026-05-01T10:00:00.000Z'),
      sessionId: 'session-123',
      qwenVersion: '0.15.6',
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
        malloced_memory: 100,
        peak_malloced_memory: 200,
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
      activeHandles: () => 101,
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
        heapUsed: 1_600,
        heapTotal: 2_000,
        rss: 5_000,
        external: 700,
        arrayBuffers: 300,
      },
      v8HeapStats: {
        heapSizeLimit: 2_000,
        totalHeapSize: 2_000,
        usedHeapSize: 1_600,
        mallocedMemory: 100,
        peakMallocedMemory: 200,
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
        maxRSS: 6 * 1024,
        userCPUTime: 10,
        systemCPUTime: 20,
      },
      activeHandles: 101,
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
  });

  it('does not multiply maxRSS by 1024 on non-Linux platforms', async () => {
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

    // On macOS, maxRSS is already in bytes — no ×1024 conversion.
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
      openFileDescriptors: async () => {
        throw new Error('not available');
      },
      smapsRollup: async () => {
        throw new Error('not available');
      },
    });

    expect(diagnostics.v8HeapSpaces).toBeUndefined();
    expect(diagnostics.openFileDescriptors).toBeUndefined();
    expect(diagnostics.smapsRollup).toBeUndefined();
    expect(diagnostics.analysis.risks).toEqual([]);
    expect(diagnostics.analysis.recommendation).toContain(
      'No obvious leak indicators',
    );
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
});
