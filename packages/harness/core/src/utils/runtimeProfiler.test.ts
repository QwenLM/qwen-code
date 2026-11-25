/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runLogger } from './runLogger.js';
import {
  DEFAULT_PROFILE_LOG_INTERVAL_MS,
  RuntimeProfiler,
  _resetRuntimeProfiler,
  formatLightweightProfileSample,
  getRuntimeProfiler,
  initializeRuntimeProfiler,
  parseProfileLogIntervalMs,
  setProfileEncryption,
} from './runtimeProfiler.js';

const wasmMocks = vi.hoisted(() => {
  const profileEncrypt = vi.fn((data: Uint8Array) => data);
  const profileEncryptorInstances: Array<{
    chunkSize: number;
    chunks: Array<{ data: Buffer; finalChunk: boolean }>;
    freed: boolean;
  }> = [];
  class ProfileEncryptor {
    chunkSize: number;
    chunks: Array<{ data: Buffer; finalChunk: boolean }> = [];
    freed = false;

    constructor(chunkSize: number) {
      this.chunkSize = chunkSize;
      profileEncryptorInstances.push(this);
    }

    header(): Uint8Array {
      return Buffer.from('QPF2');
    }

    encryptChunk(data: Uint8Array, finalChunk: boolean): Uint8Array {
      const chunk = Buffer.from(data);
      this.chunks.push({ data: chunk, finalChunk });
      return Buffer.concat([Buffer.from(finalChunk ? 'F:' : 'C:'), chunk]);
    }

    free(): void {
      this.freed = true;
    }
  }

  return {
    profileEncrypt,
    ProfileEncryptor,
    profileEncryptorInstances,
  };
});

const inspectorMocks = vi.hoisted(() => {
  const session = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    on: vi.fn(),
    post: vi.fn(),
    removeListener: vi.fn(),
  };
  return {
    Session: vi.fn(() => session),
    session,
  };
});

const runtimeModeMocks = vi.hoisted(() => ({
  isRunningWithBun: vi.fn(() => false),
}));

vi.mock('./bundledMode.js', () => ({
  isRunningWithBun: runtimeModeMocks.isRunningWithBun,
}));

vi.mock('node:inspector/promises', () => ({
  Session: inspectorMocks.Session,
}));

describe('RuntimeProfiler', () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    _resetRuntimeProfiler();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-profiler-test-'));
    wasmMocks.profileEncrypt.mockImplementation((data: Uint8Array) => data);
    wasmMocks.profileEncryptorInstances.length = 0;
    setProfileEncryption({
      encrypt: async (data) => wasmMocks.profileEncrypt(data),
      createChunkEncryptor: async (chunkSize) =>
        new wasmMocks.ProfileEncryptor(chunkSize),
    });
    runtimeModeMocks.isRunningWithBun.mockReturnValue(false);
    inspectorMocks.session.post.mockImplementation(async (method: string) => {
      switch (method) {
        case 'Profiler.stop':
          return { profile: { nodes: [{ id: 1 }] } };
        case 'HeapProfiler.stopSampling':
          return { profile: { samples: [{ size: 1 }] } };
        default:
          return {};
      }
    });
  });

  afterEach(async () => {
    _resetRuntimeProfiler();
    setProfileEncryption(undefined);
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it('initializes and returns the global profiler singleton', () => {
    expect(getRuntimeProfiler()).toBeNull();

    const profiler = initializeRuntimeProfiler({ outputDir: tmpDir });

    expect(profiler).toBeInstanceOf(RuntimeProfiler);
    expect(getRuntimeProfiler()).toBe(profiler);
    expect(initializeRuntimeProfiler({ outputDir: tmpDir })).toBe(profiler);
  });

  it('parses and clamps lightweight log intervals', () => {
    expect(parseProfileLogIntervalMs()).toBe(DEFAULT_PROFILE_LOG_INTERVAL_MS);
    expect(parseProfileLogIntervalMs('25000')).toBe(25000);
    expect(parseProfileLogIntervalMs('30s')).toBe(30000);
    expect(parseProfileLogIntervalMs('1m')).toBe(60000);
    expect(parseProfileLogIntervalMs(5000)).toBe(10000);
    expect(() => parseProfileLogIntervalMs('fast')).toThrow(
      'Invalid lightweight log interval',
    );
  });

  it('starts, records, and stops lightweight logging without heavy capture', () => {
    const logSpy = vi.spyOn(runLogger, 'log').mockImplementation(() => {});
    const profiler = new RuntimeProfiler({ outputDir: tmpDir });

    profiler.startLightweightLogging(10000);
    expect(profiler.isLightweightLoggingActive()).toBe(true);
    expect(profiler.getLightweightLogIntervalMs()).toBe(10000);
    expect(profiler.isCpuProfilingActive()).toBe(false);
    expect(profiler.isHeapAllocationProfilingActive()).toBe(false);

    const sample = profiler.recordLightweightSample('test');
    expect(sample.reason).toBe('test');
    expect(formatLightweightProfileSample(sample)).toContain(
      '[profile] sample reason=test',
    );

    profiler.stopLightweightLogging();
    expect(profiler.isLightweightLoggingActive()).toBe(false);
    expect(logSpy).toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it('requires an absolute output directory', () => {
    expect(() => new RuntimeProfiler({ outputDir: 'relative-profile-dir' })).toThrow(
      'Output directory must be an absolute path',
    );
  });

  it('rejects CPU profiling under Bun before creating an inspector session', async () => {
    const errorSpy = vi.spyOn(runLogger, 'error').mockImplementation(() => {});
    runtimeModeMocks.isRunningWithBun.mockReturnValue(true);
    const profiler = new RuntimeProfiler({ outputDir: tmpDir });

    await expect(profiler.startCpuProfiling()).rejects.toThrow(
      'CPU profiling is not supported under Bun',
    );

    expect(inspectorMocks.Session).not.toHaveBeenCalled();
    expect(profiler.isCpuProfilingActive()).toBe(false);
    errorSpy.mockRestore();
  });

  it('retains a stopped CPU profile when encrypted write fails and retries without stopping inspector again', async () => {
    const profiler = new RuntimeProfiler({ outputDir: tmpDir });
    await profiler.startCpuProfiling();
    wasmMocks.profileEncrypt.mockImplementationOnce(() => {
      throw new Error('encrypt failed');
    });

    await expect(profiler.stopCpuProfiling()).rejects.toThrow(
      'encrypt failed',
    );

    expect(profiler.isCpuProfilingActive()).toBe(false);
    expect(profiler.hasPendingCpuProfile()).toBe(true);
    const stopCallsAfterFailure = inspectorMocks.session.post.mock.calls.filter(
      ([method]) => method === 'Profiler.stop',
    ).length;

    const result = await profiler.stopCpuProfiling();

    expect(result.filePath).toMatch(/\.cpuprofile\.enc$/);
    expect(profiler.hasPendingCpuProfile()).toBe(false);
    expect(
      inspectorMocks.session.post.mock.calls.filter(
        ([method]) => method === 'Profiler.stop',
      ).length,
    ).toBe(stopCallsAfterFailure);
  });

  it('retains a stopped heap allocation profile when encrypted write fails and retries without stopping inspector again', async () => {
    const profiler = new RuntimeProfiler({ outputDir: tmpDir });
    await profiler.startHeapAllocationProfiling();
    wasmMocks.profileEncrypt.mockImplementationOnce(() => {
      throw new Error('encrypt failed');
    });

    await expect(profiler.stopHeapAllocationProfiling()).rejects.toThrow(
      'encrypt failed',
    );

    expect(profiler.isHeapAllocationProfilingActive()).toBe(false);
    expect(profiler.hasPendingHeapAllocationProfile()).toBe(true);
    const stopCallsAfterFailure = inspectorMocks.session.post.mock.calls.filter(
      ([method]) => method === 'HeapProfiler.stopSampling',
    ).length;

    const result = await profiler.stopHeapAllocationProfiling();

    expect(result.filePath).toMatch(/\.heapprofile\.enc$/);
    expect(profiler.hasPendingHeapAllocationProfile()).toBe(false);
    expect(
      inspectorMocks.session.post.mock.calls.filter(
        ([method]) => method === 'HeapProfiler.stopSampling',
      ).length,
    ).toBe(stopCallsAfterFailure);
  });

  it('serializes heavy inspector operations', async () => {
    const profiler = new RuntimeProfiler({ outputDir: tmpDir });
    const postOrder: string[] = [];
    let resolveProfilerEnable: (() => void) | undefined;
    inspectorMocks.session.post.mockImplementation(async (method: string) => {
      postOrder.push(method);
      if (method === 'Profiler.enable') {
        await new Promise<void>((resolve) => {
          resolveProfilerEnable = resolve;
        });
      }
      return method === 'Profiler.stop'
        ? { profile: { nodes: [] } }
        : method === 'HeapProfiler.stopSampling'
          ? { profile: { samples: [] } }
          : {};
    });

    const startPromise = profiler.startCpuProfiling();
    const snapshotPromise = profiler.takeHeapSnapshot();

    await vi.waitFor(() => {
      expect(postOrder).toEqual(['Profiler.enable']);
    });

    resolveProfilerEnable?.();
    await Promise.all([startPromise, snapshotPromise]);

    expect(postOrder).toEqual([
      'Profiler.enable',
      'Profiler.setSamplingInterval',
      'Profiler.start',
      'HeapProfiler.takeHeapSnapshot',
    ]);
  });

  it('streams V8 heap snapshot chunks into encrypted output and removes temporary files', async () => {
    let heapChunkListener:
      | ((
          message: import('node:inspector').InspectorNotification<{
            chunk: string;
          }>,
        ) => void)
      | undefined;
    inspectorMocks.session.on.mockImplementation((event, listener) => {
      if (event === 'HeapProfiler.addHeapSnapshotChunk') {
        heapChunkListener = listener as typeof heapChunkListener;
      }
      return inspectorMocks.session;
    });
    inspectorMocks.session.post.mockImplementation(async (method: string) => {
      if (method === 'HeapProfiler.takeHeapSnapshot') {
        heapChunkListener?.({
          method: 'HeapProfiler.addHeapSnapshotChunk',
          params: { chunk: '{"nodes":[' },
        });
        heapChunkListener?.({
          method: 'HeapProfiler.addHeapSnapshotChunk',
          params: { chunk: ']}' },
        });
      }
      return {};
    });

    const profiler = new RuntimeProfiler({ outputDir: tmpDir });
    const result = await profiler.takeHeapSnapshot();

    expect(result.filePath).toMatch(/\.heapsnapshot\.enc$/);
    await expect(fs.readFile(result.filePath, 'utf-8')).resolves.toBe(
      'QPF2C:{"nodes":[F:]}',
    );
    const entries = await fs.readdir(tmpDir);
    expect(entries.some((entry) => entry.includes('.raw.tmp.'))).toBe(false);
    expect(entries.some((entry) => entry.includes('.enc.tmp.'))).toBe(false);
    expect(wasmMocks.profileEncrypt).not.toHaveBeenCalled();
    expect(wasmMocks.profileEncryptorInstances).toHaveLength(1);
    expect(wasmMocks.profileEncryptorInstances[0].chunks).toEqual([
      { data: Buffer.from('{"nodes":['), finalChunk: false },
      { data: Buffer.from(']}'), finalChunk: true },
    ]);
    expect(wasmMocks.profileEncryptorInstances[0].freed).toBe(true);
    expect(inspectorMocks.session.removeListener).toHaveBeenCalledWith(
      'HeapProfiler.addHeapSnapshotChunk',
      heapChunkListener,
    );
  });
});
