/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runLogger } from './runLogger.js';
import { _resetRuntimeProfiler } from './runtimeProfiler.js';
import {
  _resetSignalHandlers,
  registerProfilingSignalHandlers,
} from './runtimeProfilingSignals.js';

const runtimeProfilerMocks = vi.hoisted(() => {
  const profiler = {
    hasPendingCpuProfile: vi.fn(),
    isCpuProfilingActive: vi.fn(),
    startCpuProfiling: vi.fn(),
    stopCpuProfiling: vi.fn(),
    takeHeapSnapshot: vi.fn(),
  };

  return {
    initializeRuntimeProfiler: vi.fn(() => profiler),
    profiler,
    resetRuntimeProfiler: vi.fn(),
  };
});

vi.mock('./runtimeProfiler.js', () => ({
  _resetRuntimeProfiler: runtimeProfilerMocks.resetRuntimeProfiler,
  initializeRuntimeProfiler: runtimeProfilerMocks.initializeRuntimeProfiler,
}));

vi.mock('./runLogger.js', () => ({
  runLogger: {
    debug: vi.fn(),
    error: vi.fn(),
    log: vi.fn(),
    warn: vi.fn(),
  },
}));

describe('profiling-signals', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtimeProfilerMocks.initializeRuntimeProfiler.mockReturnValue(
      runtimeProfilerMocks.profiler,
    );
    runtimeProfilerMocks.profiler.isCpuProfilingActive.mockReturnValue(false);
    runtimeProfilerMocks.profiler.hasPendingCpuProfile.mockReturnValue(false);
    runtimeProfilerMocks.profiler.startCpuProfiling.mockResolvedValue(
      undefined,
    );
    runtimeProfilerMocks.profiler.stopCpuProfiling.mockResolvedValue({
      filePath: '/tmp/profile/cpu.cpuprofile.enc',
    });
    runtimeProfilerMocks.profiler.takeHeapSnapshot.mockResolvedValue({
      filePath: '/tmp/profile/heap.heapsnapshot.enc',
    });
    _resetSignalHandlers();
    _resetRuntimeProfiler();
  });

  afterEach(() => {
    _resetSignalHandlers();
    _resetRuntimeProfiler();
    vi.restoreAllMocks();
  });

  it('registers signal handlers without error', () => {
    expect(() => registerProfilingSignalHandlers()).not.toThrow();
  });

  it('is idempotent', () => {
    const addListenerSpy = vi.spyOn(process, 'on');

    registerProfilingSignalHandlers();
    const callCount = addListenerSpy.mock.calls.length;
    registerProfilingSignalHandlers();

    expect(addListenerSpy.mock.calls.length).toBe(callCount);
    addListenerSpy.mockRestore();
  });

  it('removes registered handlers on reset', () => {
    const removeListenerSpy = vi.spyOn(process, 'removeListener');

    registerProfilingSignalHandlers();
    _resetSignalHandlers();

    const removedSignals = removeListenerSpy.mock.calls.map((call) => call[0]);
    expect(removedSignals).toContain('SIGUSR1');
    expect(removedSignals).toContain('SIGUSR2');
    removeListenerSpy.mockRestore();
  });

  it('passes configured output directory to a signal-created profiler', async () => {
    const listeners = new Map<string, () => Promise<void>>();
    vi.spyOn(process, 'on').mockImplementation((signal, listener) => {
      listeners.set(String(signal), listener as () => Promise<void>);
      return process;
    });

    registerProfilingSignalHandlers({ outputDir: '/tmp/test-profiles' });
    await listeners.get('SIGUSR1')?.();

    expect(runtimeProfilerMocks.initializeRuntimeProfiler).toHaveBeenCalledWith(
      {
        outputDir: '/tmp/test-profiles',
      },
    );
  });

  it('ignores overlapping SIGUSR1 handlers', async () => {
    const listeners = new Map<string, () => Promise<void>>();
    vi.spyOn(process, 'on').mockImplementation((signal, listener) => {
      listeners.set(String(signal), listener as () => Promise<void>);
      return process;
    });

    let resolveStart: (() => void) | undefined;
    runtimeProfilerMocks.profiler.startCpuProfiling.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveStart = resolve;
        }),
    );

    registerProfilingSignalHandlers();
    const first = listeners.get('SIGUSR1')?.();
    const second = listeners.get('SIGUSR1')?.();

    expect(runtimeProfilerMocks.profiler.startCpuProfiling).toHaveBeenCalledTimes(
      1,
    );
    expect(runLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('SIGUSR1 ignored'),
    );

    resolveStart?.();
    await first;
    await second;
  });
});
