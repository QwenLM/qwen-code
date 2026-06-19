/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  describe,
  expect,
  it,
  vi,
  beforeEach,
  beforeAll,
  afterEach,
} from 'vitest';
import {
  DEFAULT_PRESSURE_CONFIG,
  validateMemoryPressureConfig,
} from './memoryPressureMonitor.js';
import type { FileReadCache } from './fileReadCache.js';
import type { Config } from '../config/config.js';
import type { Content } from '@google/genai';
import { MICROCOMPACT_CLEARED_MESSAGE } from './microcompaction/microcompact.js';
import { MemoryDiagnosticsDumper } from './memoryDiagnosticsDumper.js';
import { MemoryMetricType } from '../telemetry/metrics.js';

// Hoisted so vi.mock can consume it.
const { mockDebugLogger } = vi.hoisted(() => ({
  mockDebugLogger: {
    isEnabled: vi.fn().mockReturnValue(true),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const {
  getMockOsTotalmem,
  setOsTotalmem,
  getMockCgroupFile,
  setCgroupMemoryMax,
  setCgroupV1MemoryLimit,
  getMockHeapSizeLimit,
  setHeapSizeLimit,
} = vi.hoisted(() => {
  let totalmem = 16 * 1024 * 1024 * 1024; // 16 GB default
  let cgroupMemoryMax: string | undefined = 'max';
  let cgroupV1MemoryLimit: string | undefined;
  let heapSizeLimit = 16 * 1024 * 1024 * 1024; // 16 GB default
  return {
    getMockOsTotalmem: () => totalmem,
    setOsTotalmem: (v: number) => {
      totalmem = v;
    },
    getMockCgroupFile: (path: string) => {
      if (path === '/sys/fs/cgroup/memory.max') {
        if (cgroupMemoryMax === undefined) {
          throw new Error('ENOENT');
        }
        return cgroupMemoryMax;
      }
      if (path === '/sys/fs/cgroup/memory/memory.limit_in_bytes') {
        if (cgroupV1MemoryLimit === undefined) {
          throw new Error('ENOENT');
        }
        return cgroupV1MemoryLimit;
      }
      throw new Error('ENOENT');
    },
    setCgroupMemoryMax: (v: string | undefined) => {
      cgroupMemoryMax = v;
    },
    setCgroupV1MemoryLimit: (v: string | undefined) => {
      cgroupV1MemoryLimit = v;
    },
    getMockHeapSizeLimit: () => heapSizeLimit,
    setHeapSizeLimit: (v: number) => {
      heapSizeLimit = v;
    },
  };
});

vi.mock('node:os', () => ({
  totalmem: () => getMockOsTotalmem(),
  cpus: () => [{ model: 'mock', speed: 0, times: {} }],
}));

vi.mock('node:fs', () => ({
  readFileSync: (path: string) => getMockCgroupFile(path),
}));

vi.mock('node:v8', () => ({
  getHeapStatistics: () => ({
    heap_size_limit: getMockHeapSizeLimit(),
  }),
}));

vi.mock('../utils/debugLogger.js', () => ({
  createDebugLogger: () => mockDebugLogger,
}));

// Partial mock: only the functions the monitor's sampling path calls are
// replaced; everything else (e.g. the MemoryMetricType enum) stays real.
const {
  mockIsPerformanceMonitoringActive,
  mockRecordMemoryUsage,
  mockRecordCpuUsage,
} = vi.hoisted(() => ({
  mockIsPerformanceMonitoringActive: vi.fn().mockReturnValue(false),
  mockRecordMemoryUsage: vi.fn(),
  mockRecordCpuUsage: vi.fn(),
}));

vi.mock('../telemetry/metrics.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../telemetry/metrics.js')>();
  return {
    ...actual,
    isPerformanceMonitoringActive: mockIsPerformanceMonitoringActive,
    recordMemoryUsage: mockRecordMemoryUsage,
    recordCpuUsage: mockRecordCpuUsage,
  };
});

// Must be a dynamic import AFTER vi.mock so the mocked os takes effect.
// Use let + beforeAll pattern.
let MemoryPressureMonitor: typeof import('./memoryPressureMonitor.js').MemoryPressureMonitor;

beforeAll(async () => {
  const mod = await import('./memoryPressureMonitor.js');
  MemoryPressureMonitor = mod.MemoryPressureMonitor;
});

function createMockConfig(
  overrides: {
    fileReadCache?: Partial<FileReadCache>;
    geminiClient?: {
      isInitialized?: () => boolean;
      getChat?: () => {
        getHistoryShallow?: () => unknown[];
        getHistory?: () => unknown[];
        setHistory?: (h: unknown[]) => void;
      };
    } | null;
    clearContextOnIdle?: {
      clearContextMinutes: number;
      toolResultsNumToKeep: number;
      toolResultsThresholdMinutes?: number;
    };
  } = {},
): Config {
  const client =
    overrides.geminiClient === undefined
      ? {
          isInitialized: () => true,
          getChat: () => ({
            getHistoryShallow: () => [],
            getHistory: () => [],
            setHistory: vi.fn(),
          }),
        }
      : overrides.geminiClient;
  return {
    getFileReadCache: () =>
      ({
        clear: vi.fn(),
        evictNotAccessedSince: vi.fn().mockReturnValue(0),
        ...overrides.fileReadCache,
      }) as unknown as FileReadCache,
    getGeminiClient: () => client as never,
    getClearContextOnIdle: () => ({
      clearContextMinutes: 60,
      toolResultsNumToKeep: 5,
      ...overrides.clearContextOnIdle,
    }),
  } as unknown as Config;
}

function setMemUsage(rssBytes: number, heapUsedBytes = 256 * 1024 * 1024) {
  vi.spyOn(process, 'memoryUsage').mockReturnValue(
    createMemUsage(rssBytes, heapUsedBytes),
  );
}

function createMemUsage(
  rssBytes: number,
  heapUsedBytes = 256 * 1024 * 1024,
): ReturnType<typeof process.memoryUsage> {
  return {
    rss: rssBytes,
    heapTotal: 512 * 1024 * 1024,
    heapUsed: heapUsedBytes,
    external: 0,
    arrayBuffers: 0,
  };
}

async function drainCleanupMeasurement(): Promise<void> {
  // Each cleanup step has an await Promise.resolve() boundary.
  // With up to 4 steps (evict_cold_cache, compact_history, clear_file_cache, trigger_gc),
  // we need enough microtask drains to let them all complete.
  for (let i = 0; i < 6; i++) await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await Promise.resolve();
}

describe('MemoryPressureMonitor', () => {
  beforeEach(() => {
    mockDebugLogger.debug.mockClear();
    mockDebugLogger.info.mockClear();
    mockDebugLogger.warn.mockClear();
    mockDebugLogger.error.mockClear();
    setCgroupMemoryMax('max');
    setCgroupV1MemoryLimit(undefined);
    setHeapSizeLimit(16 * 1024 * 1024 * 1024);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe('validateMemoryPressureConfig', () => {
    it('accepts valid config', () => {
      expect(() =>
        validateMemoryPressureConfig({
          softPressureRatio: 0.6,
          hardPressureRatio: 0.7,
          criticalRatio: 0.8,
          cleanupCooldownMs: 5000,
          enableExplicitGC: false,
        }),
      ).not.toThrow();
    });

    it('accepts zero cleanup cooldowns', () => {
      expect(() =>
        validateMemoryPressureConfig({
          softPressureRatio: 0.6,
          hardPressureRatio: 0.7,
          criticalRatio: 0.8,
          cleanupCooldownMs: 0,
          enableExplicitGC: false,
        }),
      ).not.toThrow();
    });

    it('rejects soft >= hard', () => {
      expect(() =>
        validateMemoryPressureConfig({
          softPressureRatio: 0.8,
          hardPressureRatio: 0.7,
          criticalRatio: 0.9,
          cleanupCooldownMs: 5000,
          enableExplicitGC: false,
        }),
      ).toThrow('softPressureRatio must be < hardPressureRatio');
    });

    it('rejects hard >= critical', () => {
      expect(() =>
        validateMemoryPressureConfig({
          softPressureRatio: 0.5,
          hardPressureRatio: 0.9,
          criticalRatio: 0.9,
          cleanupCooldownMs: 5000,
          enableExplicitGC: false,
        }),
      ).toThrow('hardPressureRatio must be < criticalRatio');
    });

    it('rejects non-finite ratios', () => {
      expect(() =>
        validateMemoryPressureConfig({
          softPressureRatio: Number.NaN,
          hardPressureRatio: 0.7,
          criticalRatio: 0.9,
          cleanupCooldownMs: 5000,
          enableExplicitGC: false,
        }),
      ).toThrow('softPressureRatio must be a finite ratio in [0.3, 0.98]');

      expect(() =>
        validateMemoryPressureConfig({
          softPressureRatio: 0.5,
          hardPressureRatio: Number.POSITIVE_INFINITY,
          criticalRatio: 0.9,
          cleanupCooldownMs: 5000,
          enableExplicitGC: false,
        }),
      ).toThrow('hardPressureRatio must be a finite ratio in [0.3, 0.98]');
    });

    it('rejects ratios below 0.3', () => {
      expect(() =>
        validateMemoryPressureConfig({
          softPressureRatio: 0.2,
          hardPressureRatio: 0.7,
          criticalRatio: 0.9,
          cleanupCooldownMs: 5000,
          enableExplicitGC: false,
        }),
      ).toThrow('softPressureRatio must be a finite ratio in [0.3, 0.98]');
    });

    it('rejects ratios above 0.98', () => {
      expect(() =>
        validateMemoryPressureConfig({
          softPressureRatio: 0.5,
          hardPressureRatio: 0.7,
          criticalRatio: 0.99,
          cleanupCooldownMs: 5000,
          enableExplicitGC: false,
        }),
      ).toThrow('criticalRatio must be a finite ratio in [0.3, 0.98]');
    });

    it('rejects negative cleanup cooldowns', () => {
      expect(() =>
        validateMemoryPressureConfig({
          softPressureRatio: 0.5,
          hardPressureRatio: 0.7,
          criticalRatio: 0.9,
          cleanupCooldownMs: -1,
          enableExplicitGC: false,
        }),
      ).toThrow('cleanupCooldownMs must be a non-negative number');
    });
  });

  describe('getPressureLevel', () => {
    let monitor: InstanceType<typeof MemoryPressureMonitor>;

    beforeEach(() => {
      setOsTotalmem(16 * 1024 * 1024 * 1024); // 16 GB
      monitor = new MemoryPressureMonitor(createMockConfig());
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('returns normal when RSS is low', () => {
      setMemUsage(1 * 1024 * 1024 * 1024); // 1 GB
      // 1/16 = 0.0625 < 0.50: normal
      expect(monitor.getPressureLevel()).toBe('normal');
    });

    it('returns soft when RSS exceeds soft ratio', () => {
      setMemUsage(9 * 1024 * 1024 * 1024); // 9 GB
      // 9/16 = 0.5625 >= 0.50: soft
      expect(monitor.getPressureLevel()).toBe('soft');
    });

    it('returns hard when RSS exceeds hard ratio', () => {
      setMemUsage(11 * 1024 * 1024 * 1024); // 11 GB
      // 11/16 = 0.6875 >= 0.65: hard
      expect(monitor.getPressureLevel()).toBe('hard');
    });

    it('returns critical when RSS exceeds critical ratio', () => {
      setMemUsage(14 * 1024 * 1024 * 1024); // 14 GB
      // 14/16 = 0.875 >= 0.80: critical
      expect(monitor.getPressureLevel()).toBe('critical');
    });

    it('does not treat a zero effective memory limit as RSS pressure', () => {
      setOsTotalmem(0);
      setCgroupMemoryMax('max');
      setCgroupV1MemoryLimit(undefined);
      monitor = new MemoryPressureMonitor(createMockConfig());

      setMemUsage(1024 * 1024 * 1024, 0);
      expect(monitor.getPressureLevel()).toBe('normal');
      expect(mockDebugLogger.warn).toHaveBeenCalledWith(
        'Effective memory limit is not positive; RSS pressure checks are disabled',
      );
    });

    it('returns normal when process memory usage cannot be read', () => {
      vi.spyOn(process, 'memoryUsage').mockImplementation(() => {
        throw new Error('memory API unavailable');
      });

      expect(monitor.getPressureLevel()).toBe('normal');
      expect(mockDebugLogger.error).toHaveBeenCalledWith(
        'Failed to read memory usage for pressure check: memory API unavailable',
      );
    });

    it('uses cgroup memory.max when available', () => {
      setOsTotalmem(16 * 1024 * 1024 * 1024);
      setCgroupMemoryMax(String(2 * 1024 * 1024 * 1024)); // 2 GB
      monitor = new MemoryPressureMonitor(createMockConfig());

      setMemUsage(1200 * 1024 * 1024); // 1.2/2 = 0.586 >= 0.50
      expect(monitor.getPressureLevel()).toBe('soft');
      expect(mockDebugLogger.info).toHaveBeenCalledWith(
        'Using cgroup v2 memory limit: 2048 MiB',
      );
    });

    it('uses cgroup memory.max even when host total memory is unavailable', () => {
      setOsTotalmem(0);
      setCgroupMemoryMax(String(2 * 1024 * 1024 * 1024)); // 2 GB
      monitor = new MemoryPressureMonitor(createMockConfig());

      setMemUsage(1200 * 1024 * 1024); // 1.2/2 = 0.586 >= 0.50
      expect(monitor.getPressureLevel()).toBe('soft');
    });

    it('uses cgroup v1 memory.limit_in_bytes when cgroup v2 is unavailable', () => {
      setOsTotalmem(16 * 1024 * 1024 * 1024);
      setCgroupMemoryMax(undefined);
      setCgroupV1MemoryLimit(String(2 * 1024 * 1024 * 1024)); // 2 GB
      monitor = new MemoryPressureMonitor(createMockConfig());

      setMemUsage(1200 * 1024 * 1024); // 1.2/2 = 0.586 >= 0.50
      expect(monitor.getPressureLevel()).toBe('soft');
      expect(mockDebugLogger.info).toHaveBeenCalledWith(
        'Using cgroup v1 memory limit: 2048 MiB',
      );
    });

    it('ignores cgroup v1 unlimited sentinel values', () => {
      setOsTotalmem(16 * 1024 * 1024 * 1024);
      setCgroupMemoryMax(undefined);
      setCgroupV1MemoryLimit('9223372036854771712');
      monitor = new MemoryPressureMonitor(createMockConfig());

      setMemUsage(1200 * 1024 * 1024); // 1.2/16 = 0.073 < 0.50
      expect(monitor.getPressureLevel()).toBe('normal');
      expect(mockDebugLogger.warn).not.toHaveBeenCalledWith(
        expect.stringContaining('9223372036854771712'),
      );
      expect(mockDebugLogger.debug).toHaveBeenCalledWith(
        'Ignoring unlimited cgroup memory limit from ' +
          '/sys/fs/cgroup/memory/memory.limit_in_bytes: 9223372036854771712',
      );
    });

    it('ignores cgroup v1 unlimited sentinel values when host total is unavailable', () => {
      setOsTotalmem(0);
      setCgroupMemoryMax(undefined);
      setCgroupV1MemoryLimit('9223372036854771712');
      monitor = new MemoryPressureMonitor(createMockConfig());

      setMemUsage(1200 * 1024 * 1024);
      expect(monitor.getPressureLevel()).toBe('normal');
      expect(mockDebugLogger.warn).not.toHaveBeenCalledWith(
        expect.stringContaining('9223372036854771712'),
      );
      expect(mockDebugLogger.debug).toHaveBeenCalledWith(
        'Ignoring unlimited cgroup memory limit from ' +
          '/sys/fs/cgroup/memory/memory.limit_in_bytes: 9223372036854771712',
      );
    });

    it('ignores malformed cgroup limits without partially parsing them', () => {
      setOsTotalmem(16 * 1024 * 1024 * 1024);
      setCgroupMemoryMax('2048garbage');
      setCgroupV1MemoryLimit(undefined);
      monitor = new MemoryPressureMonitor(createMockConfig());

      setMemUsage(1200 * 1024 * 1024); // 1.2/16 = 0.073 < 0.50
      expect(monitor.getPressureLevel()).toBe('normal');
      expect(mockDebugLogger.warn).toHaveBeenCalledWith(
        'Ignoring non-numeric cgroup memory limit from ' +
          '/sys/fs/cgroup/memory.max: 2048garbage',
      );
      expect(mockDebugLogger.info).toHaveBeenCalledWith(
        'Using host memory limit: 16384 MiB',
      );
    });

    it('logs cgroup read failures before falling back to host memory', () => {
      setOsTotalmem(16 * 1024 * 1024 * 1024);
      setCgroupMemoryMax(undefined);
      setCgroupV1MemoryLimit(undefined);
      monitor = new MemoryPressureMonitor(createMockConfig());

      setMemUsage(1200 * 1024 * 1024);
      expect(monitor.getPressureLevel()).toBe('normal');
      expect(mockDebugLogger.debug).toHaveBeenCalledWith(
        'Failed to read cgroup memory limit from /sys/fs/cgroup/memory.max: ' +
          'ENOENT',
      );
      expect(mockDebugLogger.info).toHaveBeenCalledWith(
        'Using host memory limit: 16384 MiB',
      );
    });

    it('logs out-of-range cgroup limits distinctly', () => {
      setOsTotalmem(16 * 1024 * 1024 * 1024);
      setCgroupMemoryMax('0');
      setCgroupV1MemoryLimit(undefined);
      monitor = new MemoryPressureMonitor(createMockConfig());

      setMemUsage(1200 * 1024 * 1024);
      expect(monitor.getPressureLevel()).toBe('normal');
      expect(mockDebugLogger.warn).toHaveBeenCalledWith(
        'Ignoring out-of-range cgroup memory limit from ' +
          '/sys/fs/cgroup/memory.max: 0',
      );
    });

    it('ignores negative cgroup limits as out-of-range', () => {
      setOsTotalmem(16 * 1024 * 1024 * 1024);
      setCgroupMemoryMax('-1');
      setCgroupV1MemoryLimit(undefined);
      monitor = new MemoryPressureMonitor(createMockConfig());

      setMemUsage(1200 * 1024 * 1024);
      expect(monitor.getPressureLevel()).toBe('normal');
      expect(mockDebugLogger.warn).toHaveBeenCalledWith(
        'Ignoring out-of-range cgroup memory limit from ' +
          '/sys/fs/cgroup/memory.max: -1',
      );
    });

    it('ignores safe cgroup limits above host total memory', () => {
      setOsTotalmem(16 * 1024 * 1024 * 1024);
      setCgroupMemoryMax(String(32 * 1024 * 1024 * 1024));
      setCgroupV1MemoryLimit(undefined);
      monitor = new MemoryPressureMonitor(createMockConfig());

      setMemUsage(1200 * 1024 * 1024); // 1.2/16 = 0.073 < 0.50
      expect(monitor.getPressureLevel()).toBe('normal');
      expect(mockDebugLogger.debug).toHaveBeenCalledWith(
        'Ignoring cgroup memory limit above host total from ' +
          '/sys/fs/cgroup/memory.max: 34359738368',
      );
    });

    it('ignores unrealistically small cgroup limits', () => {
      setOsTotalmem(16 * 1024 * 1024 * 1024);
      setCgroupMemoryMax('1');
      setCgroupV1MemoryLimit(undefined);
      monitor = new MemoryPressureMonitor(createMockConfig());

      setMemUsage(1200 * 1024 * 1024); // 1.2/16 = 0.073 < 0.50
      expect(monitor.getPressureLevel()).toBe('normal');
      expect(mockDebugLogger.warn).toHaveBeenCalledWith(
        'Ignoring unrealistically small cgroup memory limit from ' +
          '/sys/fs/cgroup/memory.max: 1',
      );
    });

    it('does not treat heap usage as pressure when V8 heap limit is zero', () => {
      setOsTotalmem(16 * 1024 * 1024 * 1024);
      setHeapSizeLimit(0);
      monitor = new MemoryPressureMonitor(createMockConfig());

      setMemUsage(512 * 1024 * 1024, 12 * 1024 * 1024 * 1024);
      expect(monitor.getPressureLevel()).toBe('normal');
    });

    it('refreshes the V8 heap limit for each pressure check', () => {
      setOsTotalmem(64 * 1024 * 1024 * 1024); // 64 GB
      setHeapSizeLimit(1024 * 1024 * 1024); // 1 GB at construction
      monitor = new MemoryPressureMonitor(createMockConfig());

      setHeapSizeLimit(4 * 1024 * 1024 * 1024); // V8 grew the limit later
      setMemUsage(512 * 1024 * 1024, 800 * 1024 * 1024);

      expect(monitor.getPressureLevel()).toBe('normal');
    });

    it('uses V8 heap pressure even when RSS is low versus system memory', () => {
      setOsTotalmem(64 * 1024 * 1024 * 1024); // 64 GB
      setHeapSizeLimit(2 * 1024 * 1024 * 1024); // 2 GB
      monitor = new MemoryPressureMonitor(createMockConfig());

      setMemUsage(512 * 1024 * 1024, 1200 * 1024 * 1024); // heap 1.2/2 = 0.586
      expect(monitor.getPressureLevel()).toBe('soft');
    });
  });

  describe('scheduleCheck', () => {
    it('only schedules one check per microtask round', async () => {
      setOsTotalmem(16 * 1024 * 1024 * 1024);
      const evictSpy = vi.fn().mockReturnValue(0);
      const monitor = new MemoryPressureMonitor(
        createMockConfig({
          fileReadCache: { evictNotAccessedSince: evictSpy },
        }),
        { ...DEFAULT_PRESSURE_CONFIG, cleanupCooldownMs: 0 },
      );

      // Soft pressure should call evictNotAccessedSince(60).
      vi.spyOn(process, 'memoryUsage').mockReturnValue({
        rss: 9 * 1024 * 1024 * 1024, // 9/16 = 0.5625 >= 0.50: soft
        heapTotal: 0,
        heapUsed: 0,
        external: 0,
        arrayBuffers: 0,
      });

      // Three rapid calls should be merged into one pending check.
      monitor.scheduleCheck();
      monitor.scheduleCheck();
      monitor.scheduleCheck();

      // Drain microtasks so the queued callback runs.
      await new Promise<void>((resolve) => queueMicrotask(() => resolve()));
      await new Promise<void>((resolve) => queueMicrotask(() => resolve()));

      // Verify evictNotAccessedSince was called exactly once (not 3x).
      expect(evictSpy).toHaveBeenCalledTimes(1);

      vi.restoreAllMocks();
    });
  });

  describe('performCheck with cleanup', () => {
    beforeEach(() => {
      setOsTotalmem(16 * 1024 * 1024 * 1024);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('calls evictNotAccessedSince on soft pressure', () => {
      const evictSpy = vi.fn().mockReturnValue(5);
      const monitor = new MemoryPressureMonitor(
        createMockConfig({
          fileReadCache: { evictNotAccessedSince: evictSpy },
        }),
        { ...DEFAULT_PRESSURE_CONFIG, cleanupCooldownMs: 0 },
      );

      setMemUsage(9 * 1024 * 1024 * 1024); // 9/16 = 0.5625 >= 0.50: soft
      monitor.performCheck();
      expect(evictSpy).toHaveBeenCalledWith(60);
    });

    it('calls evictNotAccessedSince on hard pressure', () => {
      const evictSpy = vi.fn().mockReturnValue(5);
      const monitor = new MemoryPressureMonitor(
        createMockConfig({
          fileReadCache: { evictNotAccessedSince: evictSpy },
        }),
        { ...DEFAULT_PRESSURE_CONFIG, cleanupCooldownMs: 0 },
      );

      setMemUsage(11 * 1024 * 1024 * 1024); // 11/16 = 0.6875 >= 0.65: hard
      monitor.performCheck();
      expect(evictSpy).toHaveBeenCalledWith(30);
    });

    it('calls clear on critical pressure', async () => {
      const clearSpy = vi.fn();
      const monitor = new MemoryPressureMonitor(
        createMockConfig({
          fileReadCache: {
            clear: clearSpy,
            evictNotAccessedSince: vi.fn(),
          },
        }),
        { ...DEFAULT_PRESSURE_CONFIG, cleanupCooldownMs: 0 },
      );

      setMemUsage(14 * 1024 * 1024 * 1024); // 14/16 = 0.875 >= 0.80: critical
      monitor.performCheck();
      await drainCleanupMeasurement();
      expect(clearSpy).toHaveBeenCalled();
    });

    it('runs escalated critical cleanup after lower cleanup finishes', async () => {
      const clearSpy = vi.fn();
      const evictSpy = vi.fn().mockReturnValue(0);
      const monitor = new MemoryPressureMonitor(
        createMockConfig({
          fileReadCache: {
            clear: clearSpy,
            evictNotAccessedSince: evictSpy,
          },
        }),
        { ...DEFAULT_PRESSURE_CONFIG, cleanupCooldownMs: 60_000 },
      );

      setMemUsage(9 * 1024 * 1024 * 1024); // soft pressure
      monitor.performCheck();
      expect(evictSpy).toHaveBeenCalledWith(60);

      setMemUsage(14 * 1024 * 1024 * 1024); // escalates to critical
      monitor.performCheck();
      expect(clearSpy).not.toHaveBeenCalled();

      await drainCleanupMeasurement();
      expect(clearSpy).toHaveBeenCalledTimes(1);
    });

    it('keeps the strongest queued cleanup while cleanup is in progress', async () => {
      const clearSpy = vi.fn();
      const evictSpy = vi.fn().mockReturnValue(0);
      const monitor = new MemoryPressureMonitor(
        createMockConfig({
          fileReadCache: {
            clear: clearSpy,
            evictNotAccessedSince: evictSpy,
          },
        }),
        { ...DEFAULT_PRESSURE_CONFIG, cleanupCooldownMs: 60_000 },
      );
      vi.spyOn(monitor, 'getPressureLevel')
        .mockReturnValueOnce('soft')
        .mockReturnValueOnce('critical')
        .mockReturnValueOnce('hard');

      monitor.performCheck();
      monitor.performCheck();
      monitor.performCheck();
      await drainCleanupMeasurement();

      expect(clearSpy).toHaveBeenCalledTimes(1);
      // critical steps now include evict_cold_cache (30 min) before clear_file_cache
      expect(evictSpy).toHaveBeenCalledWith(60);
      expect(evictSpy).toHaveBeenCalledWith(30);
    });

    it('cancels queued cleanup when the session is reset', async () => {
      const clearSpy = vi.fn();
      const evictSpy = vi.fn().mockReturnValue(0);
      const monitor = new MemoryPressureMonitor(
        createMockConfig({
          fileReadCache: {
            clear: clearSpy,
            evictNotAccessedSince: evictSpy,
          },
        }),
        { ...DEFAULT_PRESSURE_CONFIG, cleanupCooldownMs: 60_000 },
      );
      vi.spyOn(monitor, 'getPressureLevel')
        .mockReturnValueOnce('soft')
        .mockReturnValueOnce('critical')
        .mockReturnValue('critical');
      setMemUsage(14 * 1024 * 1024 * 1024);

      monitor.performCheck();
      monitor.performCheck();
      monitor.resetForNewSession();
      await drainCleanupMeasurement();

      expect(evictSpy).toHaveBeenCalledWith(60);
      expect(clearSpy).not.toHaveBeenCalled();

      monitor.performCheck();
      await drainCleanupMeasurement();
      expect(clearSpy).toHaveBeenCalledTimes(1);
    });

    it('blocks same-level cleanup within the cooldown window', async () => {
      const evictSpy = vi.fn().mockReturnValue(0);
      const monitor = new MemoryPressureMonitor(
        createMockConfig({
          fileReadCache: { evictNotAccessedSince: evictSpy },
        }),
        { ...DEFAULT_PRESSURE_CONFIG, cleanupCooldownMs: 60_000 },
      );

      setMemUsage(9 * 1024 * 1024 * 1024); // soft pressure
      monitor.performCheck();
      await drainCleanupMeasurement();
      monitor.performCheck();
      await drainCleanupMeasurement();

      expect(evictSpy).toHaveBeenCalledTimes(1);
      expect(evictSpy).toHaveBeenCalledWith(60);
    });

    it('does not count successful cleanup as a failure when RSS does not drop', async () => {
      const monitor = new MemoryPressureMonitor(
        createMockConfig({
          fileReadCache: { evictNotAccessedSince: vi.fn().mockReturnValue(0) },
        }),
        { ...DEFAULT_PRESSURE_CONFIG, cleanupCooldownMs: 0 },
      );
      const cleanupFailed = vi.fn();
      monitor.on('memory-cleanup-failed', cleanupFailed);

      setMemUsage(9 * 1024 * 1024 * 1024); // soft pressure, unchanged RSS

      for (let i = 0; i < 3; i++) {
        monitor.performCheck();
        await drainCleanupMeasurement();
      }

      expect(monitor.getConsecutiveFailures()).toBe(0);
      expect(cleanupFailed).not.toHaveBeenCalled();
    });

    it('emits a diagnostic event after repeated ineffective cleanups', async () => {
      const monitor = new MemoryPressureMonitor(
        createMockConfig({
          fileReadCache: { evictNotAccessedSince: vi.fn().mockReturnValue(0) },
        }),
        { ...DEFAULT_PRESSURE_CONFIG, cleanupCooldownMs: 0 },
      );
      const cleanupIneffective = vi.fn();
      monitor.on('memory-cleanup-ineffective', cleanupIneffective);

      setMemUsage(9 * 1024 * 1024 * 1024); // soft pressure, unchanged RSS

      for (let i = 0; i < 3; i++) {
        monitor.performCheck();
        await drainCleanupMeasurement();
      }

      expect(cleanupIneffective).toHaveBeenCalledTimes(1);
      expect(cleanupIneffective).toHaveBeenCalledWith(
        expect.objectContaining({
          consecutiveIneffectiveCleanups: 3,
          freedRatio: 0,
        }),
      );
    });

    it('throttles diagnostic events for continued ineffective cleanup', async () => {
      const monitor = new MemoryPressureMonitor(
        createMockConfig({
          fileReadCache: { evictNotAccessedSince: vi.fn().mockReturnValue(0) },
        }),
        { ...DEFAULT_PRESSURE_CONFIG, cleanupCooldownMs: 0 },
      );
      const cleanupIneffective = vi.fn();
      monitor.on('memory-cleanup-ineffective', cleanupIneffective);

      setMemUsage(9 * 1024 * 1024 * 1024); // soft pressure, unchanged RSS

      for (let i = 0; i < 10; i++) {
        monitor.performCheck();
        await drainCleanupMeasurement();
      }

      expect(cleanupIneffective).toHaveBeenCalledTimes(2);
      expect(cleanupIneffective).toHaveBeenLastCalledWith(
        expect.objectContaining({
          consecutiveIneffectiveCleanups: 10,
          freedRatio: 0,
        }),
      );
    });

    it('emits repeated ineffective cleanup diagnostics at the long interval', async () => {
      const monitor = new MemoryPressureMonitor(
        createMockConfig({
          fileReadCache: { evictNotAccessedSince: vi.fn().mockReturnValue(0) },
        }),
        { ...DEFAULT_PRESSURE_CONFIG, cleanupCooldownMs: 0 },
      );
      const cleanupIneffective = vi.fn();
      monitor.on('memory-cleanup-ineffective', cleanupIneffective);

      setMemUsage(9 * 1024 * 1024 * 1024); // soft pressure, unchanged RSS

      for (let i = 0; i < 20; i++) {
        monitor.performCheck();
        await drainCleanupMeasurement();
      }

      expect(cleanupIneffective).toHaveBeenCalledTimes(3);
      expect(cleanupIneffective).toHaveBeenLastCalledWith(
        expect.objectContaining({
          consecutiveIneffectiveCleanups: 20,
          freedRatio: 0,
        }),
      );
    });

    it('backs off repeated ineffective aggressive cleanup', async () => {
      let now = 1_000;
      vi.spyOn(Date, 'now').mockImplementation(() => now);
      const clearSpy = vi.fn();
      const monitor = new MemoryPressureMonitor(
        createMockConfig({
          fileReadCache: {
            clear: clearSpy,
            evictNotAccessedSince: vi.fn(),
          },
        }),
        { ...DEFAULT_PRESSURE_CONFIG, cleanupCooldownMs: 1_000 },
      );

      setMemUsage(14 * 1024 * 1024 * 1024); // critical, unchanged RSS

      for (let i = 0; i < 3; i++) {
        monitor.performCheck();
        await drainCleanupMeasurement();
        now += 1_000;
      }

      expect(clearSpy).toHaveBeenCalledTimes(3);

      monitor.performCheck();
      await drainCleanupMeasurement();
      expect(clearSpy).toHaveBeenCalledTimes(3);

      now += 1_000;
      monitor.performCheck();
      await drainCleanupMeasurement();
      expect(clearSpy).toHaveBeenCalledTimes(4);
    });

    it('measures a cleanup before running a queued escalation', async () => {
      let rss = 9 * 1024 * 1024 * 1024;
      vi.spyOn(process, 'memoryUsage').mockImplementation(() => ({
        rss,
        heapTotal: 512 * 1024 * 1024,
        heapUsed: 256 * 1024 * 1024,
        external: 0,
        arrayBuffers: 0,
      }));

      const evictSpy = vi.fn(() => {
        rss = 8 * 1024 * 1024 * 1024;
        return 0;
      });
      const clearSpy = vi.fn(() => {
        rss = 4 * 1024 * 1024 * 1024;
      });
      const monitor = new MemoryPressureMonitor(
        createMockConfig({
          fileReadCache: {
            clear: clearSpy,
            evictNotAccessedSince: evictSpy,
          },
        }),
        { ...DEFAULT_PRESSURE_CONFIG, cleanupCooldownMs: 60_000 },
      );
      vi.spyOn(monitor, 'getPressureLevel')
        .mockReturnValueOnce('soft')
        .mockReturnValueOnce('critical');

      monitor.performCheck();
      monitor.performCheck();
      await drainCleanupMeasurement();

      expect(clearSpy).toHaveBeenCalledTimes(1);
      expect(mockDebugLogger.info).toHaveBeenCalledWith(
        expect.stringContaining(
          'Cleanup "light" completed; RSS delta 1073741824 bytes',
        ),
      );
    });

    it('resets ineffective cleanup count after an effective cleanup', async () => {
      let rss = 9 * 1024 * 1024 * 1024;
      const evictSpy = vi.fn(() => {
        if (evictSpy.mock.calls.length === 3) {
          rss = 8 * 1024 * 1024 * 1024;
        }
        return 0;
      });
      vi.spyOn(process, 'memoryUsage').mockImplementation(() =>
        createMemUsage(rss),
      );
      const monitor = new MemoryPressureMonitor(
        createMockConfig({
          fileReadCache: { evictNotAccessedSince: evictSpy },
        }),
        { ...DEFAULT_PRESSURE_CONFIG, cleanupCooldownMs: 0 },
      );
      const cleanupIneffective = vi.fn();
      monitor.on('memory-cleanup-ineffective', cleanupIneffective);

      for (let i = 0; i < 3; i++) {
        monitor.performCheck();
        await drainCleanupMeasurement();
        rss = 9 * 1024 * 1024 * 1024;
      }
      for (let i = 0; i < 2; i++) {
        monitor.performCheck();
        await drainCleanupMeasurement();
      }

      expect(cleanupIneffective).not.toHaveBeenCalled();
    });

    it('records queued cleanup startup failures', async () => {
      const evictSpy = vi.fn().mockReturnValue(0);
      const monitor = new MemoryPressureMonitor(
        createMockConfig({
          fileReadCache: {
            clear: vi.fn(),
            evictNotAccessedSince: evictSpy,
          },
        }),
        { ...DEFAULT_PRESSURE_CONFIG, cleanupCooldownMs: 60_000 },
      );
      vi.spyOn(monitor, 'getPressureLevel')
        .mockReturnValueOnce('soft')
        .mockReturnValueOnce('critical');
      // Call order: check1 sampling snapshot, light memBefore, check2
      // sampling snapshot, light memAfter, then the dequeued aggressive
      // cleanup's memBefore (the throw under test), then the RSS read in
      // recordCleanupFailure.
      vi.spyOn(process, 'memoryUsage')
        .mockReturnValueOnce(createMemUsage(9 * 1024 * 1024 * 1024))
        .mockReturnValueOnce(createMemUsage(8 * 1024 * 1024 * 1024))
        .mockReturnValueOnce(createMemUsage(9 * 1024 * 1024 * 1024))
        .mockReturnValueOnce(createMemUsage(8 * 1024 * 1024 * 1024))
        .mockImplementationOnce(() => {
          throw new Error('queued RSS unavailable');
        })
        .mockReturnValueOnce(createMemUsage(8 * 1024 * 1024 * 1024));

      monitor.performCheck();
      monitor.performCheck();
      await drainCleanupMeasurement();

      expect(monitor.getConsecutiveFailures()).toBe(1);
      expect(mockDebugLogger.error).toHaveBeenCalledWith(
        'Cleanup "aggressive" failed: queued RSS unavailable; ' +
          'consecutive failures: 1',
      );
    });

    it('warns when explicit GC is requested but unavailable', async () => {
      vi.stubGlobal('gc', undefined);
      const clearSpy = vi.fn();
      const monitor = new MemoryPressureMonitor(
        createMockConfig({
          fileReadCache: {
            clear: clearSpy,
            evictNotAccessedSince: vi.fn(),
          },
        }),
        {
          ...DEFAULT_PRESSURE_CONFIG,
          cleanupCooldownMs: 0,
          enableExplicitGC: true,
        },
      );

      setMemUsage(14 * 1024 * 1024 * 1024); // critical pressure
      monitor.performCheck();
      await drainCleanupMeasurement();

      expect(clearSpy).toHaveBeenCalled();
      expect(mockDebugLogger.warn).toHaveBeenCalledWith(
        'trigger_gc requested but global.gc is not available; ' +
          'start Node.js with --expose-gc',
      );
    });

    it('runs explicit GC when requested and available', async () => {
      const gcSpy = vi.fn();
      vi.stubGlobal('gc', gcSpy);
      const monitor = new MemoryPressureMonitor(
        createMockConfig({
          fileReadCache: {
            clear: vi.fn(),
            evictNotAccessedSince: vi.fn(),
          },
        }),
        {
          ...DEFAULT_PRESSURE_CONFIG,
          cleanupCooldownMs: 0,
          enableExplicitGC: true,
        },
      );

      setMemUsage(14 * 1024 * 1024 * 1024); // critical pressure
      monitor.performCheck();
      await drainCleanupMeasurement();

      expect(gcSpy).toHaveBeenCalledTimes(1);
      expect(mockDebugLogger.debug).toHaveBeenCalledWith(
        'global.gc() freed 0 bytes',
      );
    });

    it('skips same-priority cleanup while another cleanup is in progress', () => {
      const evictSpy = vi.fn().mockReturnValue(0);
      const monitor = new MemoryPressureMonitor(
        createMockConfig({
          fileReadCache: { evictNotAccessedSince: evictSpy },
        }),
        { ...DEFAULT_PRESSURE_CONFIG, cleanupCooldownMs: 0 },
      );

      setMemUsage(9 * 1024 * 1024 * 1024); // soft pressure
      monitor.performCheck();
      monitor.performCheck();

      expect(evictSpy).toHaveBeenCalledTimes(1);
      expect(mockDebugLogger.debug).toHaveBeenCalledWith(
        'Cleanup already in progress, skipping',
      );
    });

    it('counts cleanup step exceptions as failures', async () => {
      const monitor = new MemoryPressureMonitor(
        createMockConfig({
          fileReadCache: {
            evictNotAccessedSince: vi.fn(() => {
              throw new Error('cache failure');
            }),
          },
        }),
        { ...DEFAULT_PRESSURE_CONFIG, cleanupCooldownMs: 0 },
      );
      const cleanupFailed = vi.fn();
      monitor.on('memory-cleanup-failed', cleanupFailed);

      setMemUsage(9 * 1024 * 1024 * 1024); // soft pressure

      for (let i = 0; i < 3; i++) {
        monitor.performCheck();
        await drainCleanupMeasurement();
      }

      expect(monitor.getConsecutiveFailures()).toBe(3);
      expect(cleanupFailed).toHaveBeenCalledTimes(1);
      expect(cleanupFailed).toHaveBeenCalledWith(
        expect.objectContaining({
          consecutiveFailures: 3,
          error: 'cache failure',
        }),
      );
    });

    it('resets consecutive failures after a successful cleanup', async () => {
      const evictSpy = vi.fn((): number => {
        throw new Error('cache failure');
      });
      const monitor = new MemoryPressureMonitor(
        createMockConfig({
          fileReadCache: {
            evictNotAccessedSince: evictSpy,
          },
        }),
        { ...DEFAULT_PRESSURE_CONFIG, cleanupCooldownMs: 0 },
      );

      setMemUsage(9 * 1024 * 1024 * 1024); // soft pressure
      monitor.performCheck();
      await drainCleanupMeasurement();
      expect(monitor.getConsecutiveFailures()).toBe(1);

      evictSpy.mockReturnValue(0);
      monitor.performCheck();
      await drainCleanupMeasurement();

      expect(monitor.getConsecutiveFailures()).toBe(0);
    });

    it('records cleanup failures when RSS cannot be read', async () => {
      const monitor = new MemoryPressureMonitor(
        createMockConfig({
          fileReadCache: {
            evictNotAccessedSince: vi.fn(() => {
              throw new Error('cache failure');
            }),
          },
        }),
        { ...DEFAULT_PRESSURE_CONFIG, cleanupCooldownMs: 0 },
      );
      vi.spyOn(process, 'memoryUsage')
        .mockReturnValueOnce(createMemUsage(9 * 1024 * 1024 * 1024))
        .mockReturnValueOnce(createMemUsage(9 * 1024 * 1024 * 1024))
        .mockImplementationOnce(() => {
          throw new Error('RSS unavailable');
        });

      monitor.performCheck();
      await drainCleanupMeasurement();

      expect(monitor.getConsecutiveFailures()).toBe(1);
      expect(mockDebugLogger.error).toHaveBeenCalledWith(
        'Failed to read RSS after cleanup failure: RSS unavailable',
      );
      expect(mockDebugLogger.error).toHaveBeenCalledWith(
        'Cleanup "light" failed: cache failure; consecutive failures: 1',
      );
    });

    it('throttles repeated cleanup failure events after the threshold', async () => {
      const monitor = new MemoryPressureMonitor(
        createMockConfig({
          fileReadCache: {
            evictNotAccessedSince: vi.fn(() => {
              throw new Error('cache failure');
            }),
          },
        }),
        { ...DEFAULT_PRESSURE_CONFIG, cleanupCooldownMs: 0 },
      );
      const cleanupFailed = vi.fn();
      monitor.on('memory-cleanup-failed', cleanupFailed);

      setMemUsage(9 * 1024 * 1024 * 1024); // soft pressure

      for (let i = 0; i < 10; i++) {
        monitor.performCheck();
        await drainCleanupMeasurement();
      }

      expect(monitor.getConsecutiveFailures()).toBe(10);
      expect(cleanupFailed).toHaveBeenCalledTimes(2);
      expect(cleanupFailed).toHaveBeenLastCalledWith(
        expect.objectContaining({
          consecutiveFailures: 10,
          error: 'cache failure',
        }),
      );
    });

    it('does not surface listener exceptions as cleanup promise rejections', async () => {
      const monitor = new MemoryPressureMonitor(
        createMockConfig({
          fileReadCache: {
            evictNotAccessedSince: vi.fn(() => {
              throw new Error('cache failure');
            }),
          },
        }),
        { ...DEFAULT_PRESSURE_CONFIG, cleanupCooldownMs: 0 },
      );
      monitor.on('memory-cleanup-failed', () => {
        throw new Error('listener failure');
      });

      setMemUsage(9 * 1024 * 1024 * 1024); // soft pressure

      for (let i = 0; i < 3; i++) {
        monitor.performCheck();
        await drainCleanupMeasurement();
      }

      expect(monitor.getConsecutiveFailures()).toBe(3);
    });
  });

  describe('compact_history step', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('skips compaction when client is not initialized', async () => {
      const setHistory = vi.fn();
      const monitor = new MemoryPressureMonitor(
        createMockConfig({
          geminiClient: {
            isInitialized: () => false,
            getChat: () => ({
              getHistoryShallow: () => [{ role: 'user' }],
              getHistory: () => [{ role: 'user' }],
              setHistory,
            }),
          },
        }),
        { ...DEFAULT_PRESSURE_CONFIG, cleanupCooldownMs: 0 },
      );

      setMemUsage(10 * 1024 * 1024 * 1024); // hard pressure
      monitor.performCheck();
      await drainCleanupMeasurement();

      expect(setHistory).not.toHaveBeenCalled();
    });

    it('runs compaction step without errors when client is initialized', async () => {
      const setHistory = vi.fn();
      const originalHistory = [{ role: 'user', parts: [{ text: 'hello' }] }];
      const monitor = new MemoryPressureMonitor(
        createMockConfig({
          geminiClient: {
            isInitialized: () => true,
            getChat: () => ({
              getHistoryShallow: () => originalHistory,
              getHistory: () => [...originalHistory],
              setHistory,
            }),
          },
        }),
        { ...DEFAULT_PRESSURE_CONFIG, cleanupCooldownMs: 0 },
      );

      setMemUsage(10 * 1024 * 1024 * 1024); // hard pressure
      monitor.performCheck();
      await drainCleanupMeasurement();

      // The step ran without errors — no crash, no failure count
      expect(monitor.getConsecutiveFailures()).toBe(0);
    });

    it('handles empty history without errors', async () => {
      const setHistory = vi.fn();
      const monitor = new MemoryPressureMonitor(
        createMockConfig({
          geminiClient: {
            isInitialized: () => true,
            getChat: () => ({
              getHistoryShallow: () => [],
              getHistory: () => [],
              setHistory,
            }),
          },
        }),
        { ...DEFAULT_PRESSURE_CONFIG, cleanupCooldownMs: 0 },
      );

      setMemUsage(10 * 1024 * 1024 * 1024); // hard pressure
      monitor.performCheck();
      await drainCleanupMeasurement();

      expect(setHistory).not.toHaveBeenCalled();
    });

    it('handles exceptions during compaction gracefully', async () => {
      const monitor = new MemoryPressureMonitor(
        createMockConfig({
          geminiClient: {
            isInitialized: () => true,
            getChat: () => {
              throw new Error('chat unavailable');
            },
          },
        }),
        { ...DEFAULT_PRESSURE_CONFIG, cleanupCooldownMs: 0 },
      );

      setMemUsage(11 * 1024 * 1024 * 1024); // 11/16 = 0.6875 >= 0.65: hard pressure
      monitor.performCheck();
      await drainCleanupMeasurement();

      // compact_history error is caught and logged without propagating,
      // so subsequent cleanup steps (like trigger_gc) can still run.
      expect(monitor.getConsecutiveFailures()).toBe(0);
    });

    it('handles getGeminiClient returning null', async () => {
      const setHistory = vi.fn();
      const monitor = new MemoryPressureMonitor(
        createMockConfig({
          geminiClient: null,
        }),
        { ...DEFAULT_PRESSURE_CONFIG, cleanupCooldownMs: 0 },
      );

      setMemUsage(11 * 1024 * 1024 * 1024); // 11/16 = 0.6875 >= 0.65: hard pressure
      monitor.performCheck();
      await drainCleanupMeasurement();

      expect(setHistory).not.toHaveBeenCalled();
    });

    it('compacts history and clears fileReadCache when meta is non-null', async () => {
      const setHistory = vi.fn();
      const clearCache = vi.fn();
      // Build history with 7 read_file tool results (keep=5, so 2 get cleared)
      const toolHistory: Content[] = [];
      for (let i = 0; i < 7; i++) {
        toolHistory.push(
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  name: 'read_file',
                  args: { path: `/f${i}.ts` },
                },
              },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  name: 'read_file',
                  id: `call_${i}`,
                  response: { output: `content of f${i}` },
                },
              },
            ],
          },
        );
      }
      const monitor = new MemoryPressureMonitor(
        createMockConfig({
          geminiClient: {
            isInitialized: () => true,
            getChat: () => ({
              getHistoryShallow: () => toolHistory,
              setHistory,
            }),
          },
          fileReadCache: {
            clear: clearCache,
            evictNotAccessedSince: vi.fn().mockReturnValue(0),
          },
          clearContextOnIdle: {
            clearContextMinutes: 60,
            toolResultsNumToKeep: 5,
          },
        }),
        { ...DEFAULT_PRESSURE_CONFIG, cleanupCooldownMs: 0 },
      );

      setMemUsage(11 * 1024 * 1024 * 1024); // 11/16 = 0.6875 >= 0.65: hard pressure
      monitor.performCheck();
      await drainCleanupMeasurement();

      expect(setHistory).toHaveBeenCalled();
      expect(clearCache).toHaveBeenCalled();
      const compacted = setHistory.mock.calls[0][0] as Content[];
      // microcompactHistory blanks old tool responses with a cleared message
      // rather than removing entries — verify some were blanked.
      const blankedResponses = compacted.filter((entry) =>
        entry.parts?.some(
          (p) =>
            p.functionResponse?.response?.['output'] ===
            MICROCOMPACT_CLEARED_MESSAGE,
        ),
      );
      expect(blankedResponses.length).toBeGreaterThan(0);
    });

    it('overrides positive toolResultsThresholdMinutes to 0', async () => {
      const setHistory = vi.fn();
      // 7 tool results with threshold=60 → overridden to 0, all get compacted
      const toolHistory: Content[] = [];
      for (let i = 0; i < 7; i++) {
        toolHistory.push(
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  name: 'read_file',
                  args: { path: `/f${i}.ts` },
                },
              },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  name: 'read_file',
                  id: `call_${i}`,
                  response: { output: `content of f${i}` },
                },
              },
            ],
          },
        );
      }
      const monitor = new MemoryPressureMonitor(
        createMockConfig({
          geminiClient: {
            isInitialized: () => true,
            getChat: () => ({
              getHistoryShallow: () => toolHistory,
              setHistory,
            }),
          },
          fileReadCache: {
            clear: vi.fn(),
            evictNotAccessedSince: vi.fn().mockReturnValue(0),
          },
          clearContextOnIdle: {
            clearContextMinutes: 60,
            toolResultsNumToKeep: 5,
            toolResultsThresholdMinutes: 60,
          },
        }),
        { ...DEFAULT_PRESSURE_CONFIG, cleanupCooldownMs: 0 },
      );

      setMemUsage(11 * 1024 * 1024 * 1024);
      monitor.performCheck();
      await drainCleanupMeasurement();

      // Positive value overridden to 0 → compaction runs
      expect(setHistory).toHaveBeenCalled();
    });

    it('preserves negative toolResultsThresholdMinutes (-1), skipping compaction', async () => {
      const setHistory = vi.fn();
      const toolHistory: Content[] = [];
      for (let i = 0; i < 7; i++) {
        toolHistory.push(
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  name: 'read_file',
                  args: { path: `/f${i}.ts` },
                },
              },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  name: 'read_file',
                  id: `call_${i}`,
                  response: { output: `content of f${i}` },
                },
              },
            ],
          },
        );
      }
      const monitor = new MemoryPressureMonitor(
        createMockConfig({
          geminiClient: {
            isInitialized: () => true,
            getChat: () => ({
              getHistoryShallow: () => toolHistory,
              setHistory,
            }),
          },
          fileReadCache: {
            clear: vi.fn(),
            evictNotAccessedSince: vi.fn().mockReturnValue(0),
          },
          clearContextOnIdle: {
            clearContextMinutes: 60,
            toolResultsNumToKeep: 5,
            toolResultsThresholdMinutes: -1,
          },
        }),
        { ...DEFAULT_PRESSURE_CONFIG, cleanupCooldownMs: 0 },
      );

      setMemUsage(11 * 1024 * 1024 * 1024);
      monitor.performCheck();
      await drainCleanupMeasurement();

      // Negative value preserved → microcompactHistory skips compaction
      expect(setHistory).not.toHaveBeenCalled();
    });

    it('defaults undefined toolResultsThresholdMinutes to 0', async () => {
      const setHistory = vi.fn();
      const toolHistory: Content[] = [];
      for (let i = 0; i < 7; i++) {
        toolHistory.push(
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  name: 'read_file',
                  args: { path: `/f${i}.ts` },
                },
              },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  name: 'read_file',
                  id: `call_${i}`,
                  response: { output: `content of f${i}` },
                },
              },
            ],
          },
        );
      }
      const monitor = new MemoryPressureMonitor(
        createMockConfig({
          geminiClient: {
            isInitialized: () => true,
            getChat: () => ({
              getHistoryShallow: () => toolHistory,
              setHistory,
            }),
          },
          fileReadCache: {
            clear: vi.fn(),
            evictNotAccessedSince: vi.fn().mockReturnValue(0),
          },
          clearContextOnIdle: {
            clearContextMinutes: 60,
            toolResultsNumToKeep: 5,
          },
          // toolResultsThresholdMinutes not set → undefined → defaults to 0
        }),
        { ...DEFAULT_PRESSURE_CONFIG, cleanupCooldownMs: 0 },
      );

      setMemUsage(11 * 1024 * 1024 * 1024);
      monitor.performCheck();
      await drainCleanupMeasurement();

      // Undefined defaults to 0 → compaction runs
      expect(setHistory).toHaveBeenCalled();
    });
  });

  describe('getConsecutiveFailures', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('starts at zero', () => {
      setOsTotalmem(16 * 1024 * 1024 * 1024);
      const monitor = new MemoryPressureMonitor(createMockConfig());
      expect(monitor.getConsecutiveFailures()).toBe(0);
    });

    it('can reset consecutive failures', async () => {
      setOsTotalmem(16 * 1024 * 1024 * 1024);
      const monitor = new MemoryPressureMonitor(
        createMockConfig({
          fileReadCache: {
            evictNotAccessedSince: vi.fn(() => {
              throw new Error('cache failure');
            }),
          },
        }),
        { ...DEFAULT_PRESSURE_CONFIG, cleanupCooldownMs: 0 },
      );

      setMemUsage(9 * 1024 * 1024 * 1024);
      monitor.performCheck();
      await drainCleanupMeasurement();

      expect(monitor.getConsecutiveFailures()).toBe(1);
      monitor.resetConsecutiveFailures();
      expect(monitor.getConsecutiveFailures()).toBe(0);
    });

    it('can reset ineffective cleanup diagnostics', async () => {
      setOsTotalmem(16 * 1024 * 1024 * 1024);
      const monitor = new MemoryPressureMonitor(
        createMockConfig({
          fileReadCache: { evictNotAccessedSince: vi.fn().mockReturnValue(0) },
        }),
        { ...DEFAULT_PRESSURE_CONFIG, cleanupCooldownMs: 0 },
      );
      const cleanupIneffective = vi.fn();
      monitor.on('memory-cleanup-ineffective', cleanupIneffective);

      setMemUsage(9 * 1024 * 1024 * 1024);

      for (let i = 0; i < 2; i++) {
        monitor.performCheck();
        await drainCleanupMeasurement();
      }
      monitor.resetConsecutiveFailures();
      for (let i = 0; i < 3; i++) {
        monitor.performCheck();
        await drainCleanupMeasurement();
      }

      expect(cleanupIneffective).toHaveBeenCalledTimes(1);
      expect(cleanupIneffective).toHaveBeenCalledWith(
        expect.objectContaining({
          consecutiveIneffectiveCleanups: 3,
        }),
      );
    });
  });

  describe('global.gc() safety guards', () => {
    it('should not include trigger_gc in soft or hard pressure tiers', () => {
      const monitor = new MemoryPressureMonitor(
        createMockConfig({
          fileReadCache: {
            clear: vi.fn(),
            evictNotAccessedSince: vi.fn(),
          },
        }),
        {
          ...DEFAULT_PRESSURE_CONFIG,
          cleanupCooldownMs: 0,
          enableExplicitGC: true,
        },
      );

      // Soft pressure — should NOT trigger GC
      setMemUsage(9 * 1024 * 1024 * 1024); // 9/16 = 0.5625 >= 0.5 soft
      monitor.performCheck();
      expect(mockDebugLogger.debug).not.toHaveBeenCalledWith(
        expect.stringContaining('global.gc()'),
      );

      // Reset for next check
      mockDebugLogger.debug.mockClear();

      // Hard pressure — should NOT trigger GC
      setMemUsage(11 * 1024 * 1024 * 1024); // 11/16 = 0.6875 >= 0.65 hard
      monitor.performCheck();
      expect(mockDebugLogger.debug).not.toHaveBeenCalledWith(
        expect.stringContaining('global.gc()'),
      );
    });

    it('global.gc() is only called under critical pressure with enableExplicitGC: true', async () => {
      const gcSpy = vi.fn();
      vi.stubGlobal('gc', gcSpy);

      const monitor = new MemoryPressureMonitor(
        createMockConfig({
          fileReadCache: {
            clear: vi.fn(),
            evictNotAccessedSince: vi.fn(),
          },
        }),
        {
          ...DEFAULT_PRESSURE_CONFIG,
          cleanupCooldownMs: 0,
          enableExplicitGC: true,
        },
      );

      // Soft pressure — GC should NOT be called
      setMemUsage(9 * 1024 * 1024 * 1024); // 9/16 = 0.5625 >= 0.5 soft
      monitor.performCheck();
      await drainCleanupMeasurement();
      expect(gcSpy).not.toHaveBeenCalled();

      gcSpy.mockClear();

      // Hard pressure — GC should NOT be called
      setMemUsage(11 * 1024 * 1024 * 1024); // 11/16 = 0.6875 >= 0.65 hard
      monitor.performCheck();
      await drainCleanupMeasurement();
      expect(gcSpy).not.toHaveBeenCalled();

      gcSpy.mockClear();

      // Critical pressure — GC SHOULD be called exactly once
      setMemUsage(14 * 1024 * 1024 * 1024); // 14/16 = 0.875 >= 0.8 critical
      monitor.performCheck();
      await drainCleanupMeasurement();
      expect(gcSpy).toHaveBeenCalledTimes(1);
    });

    it('global.gc() is never called when enableExplicitGC is false', async () => {
      const gcSpy = vi.fn();
      vi.stubGlobal('gc', gcSpy);

      const monitor = new MemoryPressureMonitor(
        createMockConfig({
          fileReadCache: {
            clear: vi.fn(),
            evictNotAccessedSince: vi.fn(),
          },
        }),
        {
          ...DEFAULT_PRESSURE_CONFIG,
          cleanupCooldownMs: 0,
          enableExplicitGC: false,
        },
      );

      // Critical pressure — GC should NOT be called
      setMemUsage(14 * 1024 * 1024 * 1024);
      monitor.performCheck();
      await drainCleanupMeasurement();
      expect(gcSpy).not.toHaveBeenCalled();
    });
  });

  describe('runtime sampling and telemetry', () => {
    beforeEach(() => {
      setOsTotalmem(16 * 1024 * 1024 * 1024);
      mockIsPerformanceMonitoringActive.mockReturnValue(false);
      mockRecordMemoryUsage.mockClear();
      mockRecordCpuUsage.mockClear();
    });

    it('reports memory and CPU metrics when performance monitoring is active', () => {
      mockIsPerformanceMonitoringActive.mockReturnValue(true);
      const rss = 4 * 1024 * 1024 * 1024; // 4/16 = 0.25: normal, no cleanup
      const heapUsed = 256 * 1024 * 1024;
      setMemUsage(rss, heapUsed);
      const monitor = new MemoryPressureMonitor(createMockConfig());

      monitor.performCheck();

      expect(mockRecordMemoryUsage).toHaveBeenCalledTimes(2);
      expect(mockRecordMemoryUsage).toHaveBeenCalledWith(
        expect.anything(),
        rss,
        { memory_type: MemoryMetricType.RSS },
      );
      expect(mockRecordMemoryUsage).toHaveBeenCalledWith(
        expect.anything(),
        heapUsed,
        { memory_type: MemoryMetricType.HEAP_USED },
      );
      expect(mockRecordCpuUsage).toHaveBeenCalledTimes(1);
      expect(mockRecordCpuUsage).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(Number),
        {},
      );
    });

    it('does not report metrics when performance monitoring is inactive', () => {
      setMemUsage(4 * 1024 * 1024 * 1024);
      const monitor = new MemoryPressureMonitor(createMockConfig());

      monitor.performCheck();

      expect(mockRecordMemoryUsage).not.toHaveBeenCalled();
      expect(mockRecordCpuUsage).not.toHaveBeenCalled();
    });

    it('does not throw and skips metric reporting when memory usage cannot be read', () => {
      mockIsPerformanceMonitoringActive.mockReturnValue(true);
      vi.spyOn(process, 'memoryUsage').mockImplementation(() => {
        throw new Error('memory API unavailable');
      });
      const monitor = new MemoryPressureMonitor(createMockConfig());

      expect(() => monitor.performCheck()).not.toThrow();
      expect(mockRecordMemoryUsage).not.toHaveBeenCalled();
      expect(mockRecordCpuUsage).not.toHaveBeenCalled();
      // readMemoryUsage() logs the failure once; getPressureLevel() must be
      // skipped (mem is undefined) so it doesn't fire a second failing syscall
      // and log the same error twice on this cycle.
      expect(mockDebugLogger.error).toHaveBeenCalledTimes(1);
    });

    it('logs first sampling failure at error level and subsequent ones at debug', () => {
      // Make the OTel recording path throw so the sampling try/catch fires.
      mockIsPerformanceMonitoringActive.mockReturnValue(true);
      mockRecordMemoryUsage.mockImplementation(() => {
        throw new Error('OTel export failed');
      });
      setMemUsage(4 * 1024 * 1024 * 1024); // normal pressure, no cleanup

      const monitor = new MemoryPressureMonitor(createMockConfig());
      mockDebugLogger.error.mockClear();
      mockDebugLogger.debug.mockClear();

      // First failure: should log at error level
      monitor.performCheck();
      expect(mockDebugLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('Runtime sampling failed'),
      );
      expect(mockDebugLogger.debug).not.toHaveBeenCalledWith(
        expect.stringContaining('Runtime sampling failed'),
      );

      mockDebugLogger.error.mockClear();
      mockDebugLogger.debug.mockClear();

      // Second failure: should log at debug level (not error)
      monitor.performCheck();
      expect(mockDebugLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Runtime sampling failed'),
      );
      expect(mockDebugLogger.error).not.toHaveBeenCalledWith(
        expect.stringContaining('Runtime sampling failed'),
      );
    });

    it('passes runtime samples to the diagnostics dumper on hard pressure', async () => {
      const dumpSpy = vi
        .spyOn(MemoryDiagnosticsDumper.prototype, 'dump')
        .mockResolvedValue(undefined);
      const rss = 11 * 1024 * 1024 * 1024; // 11/16 = 0.6875: hard
      setMemUsage(rss);
      const monitor = new MemoryPressureMonitor(createMockConfig(), {
        ...DEFAULT_PRESSURE_CONFIG,
        cleanupCooldownMs: 0,
      });
      // Advance the clock past the ring's construction tick so record()
      // sees elapsed > 0 and actually pushes a sample.
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 50);

      monitor.performCheck();
      await drainCleanupMeasurement();

      expect(dumpSpy).toHaveBeenCalledTimes(1);
      expect(dumpSpy).toHaveBeenCalledWith(
        'hard',
        expect.arrayContaining([expect.objectContaining({ rss })]),
      );
    });
  });
});
