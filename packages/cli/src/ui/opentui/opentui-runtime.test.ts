/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core';

const mockState = vi.hoisted(() => ({
  bridgeInstances: [] as Array<{
    opts: unknown;
    shutdown: ReturnType<typeof vi.fn>;
  }>,
  watcherInstances: [] as Array<{
    path: string;
    shutdown: ReturnType<typeof vi.fn>;
  }>,
  writeRuntimeStatus: vi.fn(async () => {}),
  writeStderrLine: vi.fn(),
  bridgeShouldThrow: false,
}));

vi.mock('../../dualOutput/DualOutputBridge.js', () => ({
  DualOutputBridge: class {
    opts: unknown;
    shutdown: ReturnType<typeof vi.fn>;
    constructor(_config: unknown, target: unknown, meta: unknown) {
      if (mockState.bridgeShouldThrow) {
        throw new Error('bridge boom');
      }
      this.opts = { target, meta };
      this.shutdown = vi.fn(async () => {});
      mockState.bridgeInstances.push({
        opts: this.opts,
        shutdown: this.shutdown,
      });
    }
  },
}));

vi.mock('../../remoteInput/RemoteInputWatcher.js', () => ({
  RemoteInputWatcher: class {
    path: string;
    shutdown: ReturnType<typeof vi.fn>;
    constructor(path: string) {
      this.path = path;
      this.shutdown = vi.fn();
      mockState.watcherInstances.push({ path, shutdown: this.shutdown });
    }
  },
}));

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...actual,
    createDebugLogger: () => ({ error: vi.fn(), debug: vi.fn() }),
    writeRuntimeStatus: mockState.writeRuntimeStatus,
  };
});

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStderrLine: mockState.writeStderrLine,
}));

import { OpenTuiRuntime } from './opentui-runtime.js';

function makeConfig(overrides: Record<string, unknown> = {}): Config {
  const performCheck = vi.fn();
  const config = {
    getJsonFd: () => undefined,
    getJsonFile: () => undefined,
    getInputFile: () => undefined,
    getMemoryPressureMonitor: () => undefined,
    markRuntimeStatusEnabled: vi.fn(),
    getSessionId: () => 'sess-1',
    getTargetDir: () => '/work',
    storage: { getRuntimeStatusPath: () => '/tmp/runtime.json' },
    ...overrides,
    _performCheck: performCheck,
  } as unknown as Config & { _performCheck: ReturnType<typeof vi.fn> };
  return config;
}

beforeEach(() => {
  mockState.bridgeInstances = [];
  mockState.watcherInstances = [];
  mockState.bridgeShouldThrow = false;
  mockState.writeRuntimeStatus.mockClear();
  mockState.writeStderrLine.mockClear();
});

describe('OpenTuiRuntime.create', () => {
  it('builds a dual-output bridge from --json-fd', () => {
    const config = makeConfig({ getJsonFd: () => 7 });
    const runtime = OpenTuiRuntime.create({ config, version: '1.2.3' });
    expect(runtime.dualOutputBridge).not.toBeNull();
    expect(mockState.bridgeInstances[0]?.opts).toEqual({
      target: { fd: 7 },
      meta: { version: '1.2.3' },
    });
    expect(runtime.remoteInputWatcher).toBeNull();
  });

  it('builds a remote input watcher from --input-file', () => {
    const config = makeConfig({ getInputFile: () => '/in.jsonl' });
    const runtime = OpenTuiRuntime.create({ config, version: '1' });
    expect(runtime.remoteInputWatcher).not.toBeNull();
    expect(mockState.watcherInstances[0]?.path).toBe('/in.jsonl');
  });

  it('degrades to null and warns when a bridge ctor throws', () => {
    mockState.bridgeShouldThrow = true;
    try {
      const config = makeConfig({ getJsonFile: () => '/out.json' });
      let runtime!: OpenTuiRuntime;
      expect(() => {
        runtime = OpenTuiRuntime.create({ config, version: '1' });
      }).not.toThrow();
      expect(runtime.dualOutputBridge).toBeNull();
      expect(mockState.writeStderrLine).toHaveBeenCalledWith(
        expect.stringContaining('dual output disabled'),
      );
    } finally {
      mockState.bridgeShouldThrow = false;
    }
  });
});

describe('OpenTuiRuntime.writeRuntimeSidecar', () => {
  it('writes the sidecar and arms runtime status', async () => {
    const config = makeConfig();
    const runtime = OpenTuiRuntime.create({ config, version: '9' });
    await runtime.writeRuntimeSidecar();
    expect(mockState.writeRuntimeStatus).toHaveBeenCalledWith(
      '/tmp/runtime.json',
      { sessionId: 'sess-1', workDir: '/work', qwenVersion: '9' },
    );
    expect(config.markRuntimeStatusEnabled).toHaveBeenCalledTimes(1);
  });

  it('swallows sidecar failures (best-effort)', async () => {
    const config = makeConfig();
    mockState.writeRuntimeStatus.mockRejectedValueOnce(new Error('ro fs'));
    const runtime = OpenTuiRuntime.create({ config, version: '9' });
    await expect(runtime.writeRuntimeSidecar()).resolves.toBeUndefined();
    expect(config.markRuntimeStatusEnabled).not.toHaveBeenCalled();
  });
});

describe('OpenTuiRuntime pressure monitor', () => {
  it('returns undefined and arms nothing without a monitor', () => {
    const runtime = OpenTuiRuntime.create({
      config: makeConfig(),
      version: '1',
    });
    expect(runtime.startPressureMonitor()).toBeUndefined();
  });

  it('ticks performCheck on the interval and is idempotent', () => {
    vi.useFakeTimers();
    try {
      const performCheck = vi.fn();
      const config = makeConfig({
        getMemoryPressureMonitor: () => ({ performCheck }),
      });
      const runtime = OpenTuiRuntime.create({ config, version: '1' });
      const first = runtime.startPressureMonitor();
      const second = runtime.startPressureMonitor();
      expect(first).toBeDefined();
      expect(second).toBe(first);
      vi.advanceTimersByTime(30_000);
      expect(performCheck).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('OpenTuiRuntime.shutdown', () => {
  it('clears the timer, reclaims, and tears the bridges down in order', async () => {
    vi.useFakeTimers();
    try {
      const order: string[] = [];
      const performCheck = vi.fn(() => order.push('check'));
      const config = makeConfig({
        getMemoryPressureMonitor: () => ({ performCheck }),
        getInputFile: () => '/in.jsonl',
        getJsonFd: () => 5,
      });
      const runtime = OpenTuiRuntime.create({ config, version: '1' });
      runtime.startPressureMonitor();
      const watcherShutdown =
        mockState.watcherInstances[0]!.shutdown.mockImplementation(() =>
          order.push('watcher'),
        );
      const bridgeShutdown =
        mockState.bridgeInstances[0]!.shutdown.mockImplementation(async () => {
          order.push('bridge');
        });
      void watcherShutdown;
      void bridgeShutdown;

      await runtime.shutdown();
      // Advancing after shutdown must not resurrect the cleared interval.
      vi.advanceTimersByTime(60_000);

      // Final reclaim + watchers, in the declared order.
      expect(order).toEqual(['check', 'watcher', 'bridge']);
      // Only the shutdown reclaim ran; the interval was cleared.
      expect(performCheck).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
