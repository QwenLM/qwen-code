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
import { content, fnCall, fnResponse } from '../test-utils/model-fixtures.js';

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
      const value =
        path === '/sys/fs/cgroup/memory.max'
          ? cgroupMemoryMax
          : path === '/sys/fs/cgroup/memory/memory.limit_in_bytes'
            ? cgroupV1MemoryLimit
            : undefined;
      if (value === undefined) throw new Error('ENOENT');
      return value;
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

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  totalmem: () => getMockOsTotalmem(),
  cpus: () => [{ model: 'mock', speed: 0, times: {} }],
}));

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
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
    llmClient?: {
      isInitialized?: () => boolean;
      getChat?: () => {
        getHistoryShallow?: () => unknown[];
        getHistory?: () => unknown[];
        setHistory?: (
          h: unknown[],
          completedToolCallIds?: readonly string[],
        ) => void;
        getCompletedToolCallIds?: () => readonly string[] | undefined;
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
    overrides.llmClient === undefined
      ? {
          isInitialized: () => true,
          getChat: () => ({
            getCompletedToolCallIds: () => undefined,
            getHistoryShallow: () => [],
            getHistory: () => [],
            setHistory: vi.fn(),
          }),
        }
      : overrides.llmClient;
  return {
    getProjectRoot: () => '/mock/project',
    getTargetDir: () => '/mock/project',
    getFileReadCache: () =>
      ({
        clear: vi.fn(),
        dropEntries: vi.fn(),
        evictNotAccessedSince: vi.fn().mockReturnValue(0),
        ...overrides.fileReadCache,
      }) as unknown as FileReadCache,
    getLlmClient: () => client as never,
    getMemoryManager: () => ({
      markMemoryBodiesEvictedFromHistory: vi.fn(),
    }),
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
  // Each cleanup step has an await Promise.resolve() boundary; drain enough
  // for up to 4 steps (evict_cold_cache, compact_history, clear_file_cache, trigger_gc).
  for (let i = 0; i < 6; i++) await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await Promise.resolve();
}

const MB = 1024 * 1024;
const GB = 1024 * MB;

type Monitor = InstanceType<typeof MemoryPressureMonitor>;

/** A monitor over createMockConfig(overrides); cleanup cooldown 0 unless overridden. */
function createMonitor(
  overrides: Parameters<typeof createMockConfig>[0] = {},
  pressure: Partial<typeof DEFAULT_PRESSURE_CONFIG> = {},
): Monitor {
  return new MemoryPressureMonitor(createMockConfig(overrides), {
    ...DEFAULT_PRESSURE_CONFIG,
    cleanupCooldownMs: 0,
    ...pressure,
  });
}

function cacheMonitor(
  fileReadCache: Partial<FileReadCache>,
  pressure: Partial<typeof DEFAULT_PRESSURE_CONFIG> = {},
): Monitor {
  return createMonitor({ fileReadCache }, pressure);
}

/** Runs `times` checks, letting each one's cleanup finish. */
async function runChecks(monitor: Monitor, times = 1): Promise<void> {
  for (let i = 0; i < times; i++) {
    monitor.performCheck();
    await drainCleanupMeasurement();
  }
}

async function checkAt(monitor: Monitor, rss: number): Promise<void> {
  setMemUsage(rss);
  await runChecks(monitor);
}

function listen(monitor: Monitor, event: string) {
  const listener = vi.fn();
  monitor.on(event, listener);
  return listener;
}

const throwingEvict = () =>
  vi.fn((): number => {
    throw new Error('cache failure');
  });

/** Runs `times` soft-pressure checks on a monitor whose eviction throws. */
async function runFailingChecks(
  times: number,
  onFailed?: () => void,
): Promise<Monitor> {
  const monitor = cacheMonitor({ evictNotAccessedSince: throwingEvict() });
  if (onFailed) monitor.on('memory-cleanup-failed', onFailed);
  setMemUsage(9 * GB); // soft pressure
  await runChecks(monitor, times);
  return monitor;
}

/** An LLM client whose chat serves `history`; `getHistory` only when `full` is given. */
function chatClient(
  setHistory: ReturnType<typeof vi.fn>,
  history: unknown[],
  opts: {
    initialized?: boolean;
    completed?: readonly string[];
    full?: () => unknown[];
  } = {},
) {
  return {
    isInitialized: () => opts.initialized ?? true,
    getChat: () => ({
      getCompletedToolCallIds: () => opts.completed,
      getHistoryShallow: () => history,
      ...(opts.full && { getHistory: opts.full }),
      setHistory,
    }),
  };
}

/** Seven read_file call/response pairs (call_0..call_6). */
function readFileHistory(): Content[] {
  return Array.from({ length: 7 }, (_, i) => [
    content('model', fnCall('read_file', { path: `/f${i}.ts` })),
    content('user', {
      functionResponse: {
        name: 'read_file',
        id: `call_${i}`,
        response: { output: `content of f${i}` },
      },
    }),
  ]).flat();
}

describe('MemoryPressureMonitor', () => {
  beforeEach(() => {
    mockDebugLogger.debug.mockClear();
    mockDebugLogger.info.mockClear();
    mockDebugLogger.warn.mockClear();
    mockDebugLogger.error.mockClear();
    setCgroupMemoryMax('max');
    setCgroupV1MemoryLimit(undefined);
    setHeapSizeLimit(16 * GB);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe('validateMemoryPressureConfig', () => {
    const RANGE = 'must be a finite ratio in [0.3, 0.98]';
    const validate =
      (soft: number, hard: number, critical: number, cooldown = 5000) =>
      () =>
        validateMemoryPressureConfig({
          softPressureRatio: soft,
          hardPressureRatio: hard,
          criticalRatio: critical,
          cleanupCooldownMs: cooldown,
          enableExplicitGC: false,
        });

    it('accepts valid config', () => {
      expect(validate(0.6, 0.7, 0.8)).not.toThrow();
    });

    it('accepts zero cleanup cooldowns', () => {
      expect(validate(0.6, 0.7, 0.8, 0)).not.toThrow();
    });

    it.each<[string, Parameters<typeof validate>, string]>([
      [
        'rejects soft >= hard',
        [0.8, 0.7, 0.9],
        'softPressureRatio must be < hardPressureRatio',
      ],
      [
        'rejects hard >= critical',
        [0.5, 0.9, 0.9],
        'hardPressureRatio must be < criticalRatio',
      ],
      [
        'rejects ratios below 0.3',
        [0.2, 0.7, 0.9],
        `softPressureRatio ${RANGE}`,
      ],
      ['rejects ratios above 0.98', [0.5, 0.7, 0.99], `criticalRatio ${RANGE}`],
      [
        'rejects negative cleanup cooldowns',
        [0.5, 0.7, 0.9, -1],
        'cleanupCooldownMs must be a non-negative number',
      ],
    ])('%s', (_title, args, message) => {
      expect(validate(...args)).toThrow(message);
    });

    it('rejects non-finite ratios', () => {
      expect(validate(Number.NaN, 0.7, 0.9)).toThrow(
        `softPressureRatio ${RANGE}`,
      );
      expect(validate(0.5, Number.POSITIVE_INFINITY, 0.9)).toThrow(
        `hardPressureRatio ${RANGE}`,
      );
    });
  });

  describe('getPressureLevel', () => {
    let monitor: Monitor;

    beforeEach(() => {
      setOsTotalmem(16 * GB); // 16 GB
      monitor = new MemoryPressureMonitor(createMockConfig());
    });

    /** Sets host total and cgroup v2/v1 limits, then rebuilds the monitor. */
    const withLimits = (total: number, v2: string | undefined, v1?: string) => {
      setOsTotalmem(total);
      setCgroupMemoryMax(v2);
      setCgroupV1MemoryLimit(v1);
      monitor = new MemoryPressureMonitor(createMockConfig());
    };
    const levelAt = (rss: number, heapUsed?: number) => {
      setMemUsage(rss, heapUsed);
      return monitor.getPressureLevel();
    };

    it.each([
      ['returns normal when RSS is low', 1, 'normal'], // 1/16 = 0.0625 < 0.50
      ['returns soft when RSS exceeds soft ratio', 9, 'soft'], // 9/16 = 0.5625 >= 0.50
      ['returns hard when RSS exceeds hard ratio', 11, 'hard'], // 11/16 = 0.6875 >= 0.65
      ['returns critical when RSS exceeds critical ratio', 14, 'critical'], // 14/16 = 0.875 >= 0.80
    ])('%s', (_title, gb, level) => {
      expect(levelAt(gb * GB)).toBe(level);
    });

    it('does not treat a zero effective memory limit as RSS pressure', () => {
      withLimits(0, 'max');

      expect(levelAt(GB, 0)).toBe('normal');
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
      withLimits(16 * GB, String(2 * GB)); // 2 GB

      expect(levelAt(1200 * MB)).toBe('soft'); // 1.2/2 = 0.586 >= 0.50
      expect(mockDebugLogger.info).toHaveBeenCalledWith(
        'Using cgroup v2 memory limit: 2048 MiB',
      );
    });

    it('uses cgroup memory.max even when host total memory is unavailable', () => {
      withLimits(0, String(2 * GB)); // 2 GB

      expect(levelAt(1200 * MB)).toBe('soft'); // 1.2/2 = 0.586 >= 0.50
    });

    it('uses cgroup v1 memory.limit_in_bytes when cgroup v2 is unavailable', () => {
      withLimits(16 * GB, undefined, String(2 * GB)); // 2 GB

      expect(levelAt(1200 * MB)).toBe('soft'); // 1.2/2 = 0.586 >= 0.50
      expect(mockDebugLogger.info).toHaveBeenCalledWith(
        'Using cgroup v1 memory limit: 2048 MiB',
      );
    });

    const V1_UNLIMITED = '9223372036854771712';
    const expectV1SentinelIgnored = (total: number) => {
      withLimits(total, undefined, V1_UNLIMITED);

      expect(levelAt(1200 * MB)).toBe('normal'); // 1.2/16 = 0.073 < 0.50
      expect(mockDebugLogger.warn).not.toHaveBeenCalledWith(
        expect.stringContaining(V1_UNLIMITED),
      );
      expect(mockDebugLogger.debug).toHaveBeenCalledWith(
        'Ignoring unlimited cgroup memory limit from ' +
          `/sys/fs/cgroup/memory/memory.limit_in_bytes: ${V1_UNLIMITED}`,
      );
    };

    it('ignores cgroup v1 unlimited sentinel values', () => {
      expectV1SentinelIgnored(16 * GB);
    });

    it('ignores cgroup v1 unlimited sentinel values when host total is unavailable', () => {
      expectV1SentinelIgnored(0);
    });

    it('ignores malformed cgroup limits without partially parsing them', () => {
      withLimits(16 * GB, '2048garbage');

      expect(levelAt(1200 * MB)).toBe('normal'); // 1.2/16 = 0.073 < 0.50
      expect(mockDebugLogger.warn).toHaveBeenCalledWith(
        'Ignoring non-numeric cgroup memory limit from ' +
          '/sys/fs/cgroup/memory.max: 2048garbage',
      );
      expect(mockDebugLogger.info).toHaveBeenCalledWith(
        'Using host memory limit: 16384 MiB',
      );
    });

    it('logs cgroup read failures before falling back to host memory', () => {
      withLimits(16 * GB, undefined);

      expect(levelAt(1200 * MB)).toBe('normal');
      expect(mockDebugLogger.debug).toHaveBeenCalledWith(
        'Failed to read cgroup memory limit from /sys/fs/cgroup/memory.max: ' +
          'ENOENT',
      );
      expect(mockDebugLogger.info).toHaveBeenCalledWith(
        'Using host memory limit: 16384 MiB',
      );
    });

    it.each([
      ['logs out-of-range cgroup limits distinctly', '0', 'out-of-range'],
      ['ignores negative cgroup limits as out-of-range', '-1', 'out-of-range'],
      [
        'ignores unrealistically small cgroup limits',
        '1',
        'unrealistically small',
      ],
    ])('%s', (_title, limit, kind) => {
      withLimits(16 * GB, limit);

      expect(levelAt(1200 * MB)).toBe('normal'); // 1.2/16 = 0.073 < 0.50
      expect(mockDebugLogger.warn).toHaveBeenCalledWith(
        `Ignoring ${kind} cgroup memory limit from ` +
          `/sys/fs/cgroup/memory.max: ${limit}`,
      );
    });

    it('ignores safe cgroup limits above host total memory', () => {
      withLimits(16 * GB, String(32 * GB));

      expect(levelAt(1200 * MB)).toBe('normal'); // 1.2/16 = 0.073 < 0.50
      expect(mockDebugLogger.debug).toHaveBeenCalledWith(
        'Ignoring cgroup memory limit above host total from ' +
          '/sys/fs/cgroup/memory.max: 34359738368',
      );
    });

    it('does not treat heap usage as pressure when V8 heap limit is zero', () => {
      setHeapSizeLimit(0);
      withLimits(16 * GB, 'max');

      expect(levelAt(512 * MB, 12 * GB)).toBe('normal');
    });

    it('refreshes the V8 heap limit for each pressure check', () => {
      setHeapSizeLimit(GB); // 1 GB at construction
      withLimits(64 * GB, 'max'); // 64 GB

      setHeapSizeLimit(4 * GB); // V8 grew the limit later
      expect(levelAt(512 * MB, 800 * MB)).toBe('normal');
    });

    it('uses V8 heap pressure even when RSS is low versus system memory', () => {
      setHeapSizeLimit(2 * GB); // 2 GB
      withLimits(64 * GB, 'max'); // 64 GB

      expect(levelAt(512 * MB, 1200 * MB)).toBe('soft'); // heap 1.2/2 = 0.586
    });
  });

  describe('scheduleCheck', () => {
    it('only schedules one check per microtask round', async () => {
      setOsTotalmem(16 * GB);
      const evictSpy = vi.fn().mockReturnValue(0);
      const monitor = cacheMonitor({ evictNotAccessedSince: evictSpy });

      // Soft pressure should call evictNotAccessedSince(60).
      vi.spyOn(process, 'memoryUsage').mockReturnValue({
        rss: 9 * GB, // 9/16 = 0.5625 >= 0.50: soft
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
      setOsTotalmem(16 * GB);
    });

    /** dropEntries and evictNotAccessedSince (returning 0) as spies. */
    const spiedMonitor = (cleanupCooldownMs: number) => {
      const clearSpy = vi.fn();
      const evictSpy = vi.fn().mockReturnValue(0);
      const monitor = cacheMonitor(
        { dropEntries: clearSpy, evictNotAccessedSince: evictSpy },
        { cleanupCooldownMs },
      );
      return { monitor, clearSpy, evictSpy };
    };

    const expectEvictionAt = (rss: number, minutes: number) => {
      const evictSpy = vi.fn().mockReturnValue(5);
      const monitor = cacheMonitor({ evictNotAccessedSince: evictSpy });

      setMemUsage(rss);
      monitor.performCheck();
      expect(evictSpy).toHaveBeenCalledWith(minutes);
    };

    it('calls evictNotAccessedSince on soft pressure', () => {
      expectEvictionAt(9 * GB, 60); // 9/16 = 0.5625 >= 0.50: soft
    });

    it('calls evictNotAccessedSince on hard pressure', () => {
      expectEvictionAt(11 * GB, 30); // 11/16 = 0.6875 >= 0.65: hard
    });

    it('drops local entries without clearing remote reads on critical pressure', async () => {
      const clearSpy = vi.fn();
      const clearHistory = vi.fn();
      const monitor = cacheMonitor({
        clear: clearHistory,
        dropEntries: clearSpy,
        evictNotAccessedSince: vi.fn(),
      });

      await checkAt(monitor, 14 * GB); // 14/16 = 0.875 >= 0.80: critical
      expect(clearSpy).toHaveBeenCalled();
      expect(clearHistory).not.toHaveBeenCalled();
    });

    it('runs escalated critical cleanup after lower cleanup finishes', async () => {
      const { monitor, clearSpy, evictSpy } = spiedMonitor(60_000);

      setMemUsage(9 * GB); // soft pressure
      monitor.performCheck();
      expect(evictSpy).toHaveBeenCalledWith(60);

      setMemUsage(14 * GB); // escalates to critical
      monitor.performCheck();
      expect(clearSpy).not.toHaveBeenCalled();

      await drainCleanupMeasurement();
      expect(clearSpy).toHaveBeenCalledTimes(1);
    });

    it('keeps the strongest queued cleanup while cleanup is in progress', async () => {
      const { monitor, clearSpy, evictSpy } = spiedMonitor(60_000);
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
      const { monitor, clearSpy, evictSpy } = spiedMonitor(60_000);
      vi.spyOn(monitor, 'getPressureLevel')
        .mockReturnValueOnce('soft')
        .mockReturnValueOnce('critical')
        .mockReturnValue('critical');
      setMemUsage(14 * GB);

      monitor.performCheck();
      monitor.performCheck();
      monitor.resetForNewSession();
      await drainCleanupMeasurement();

      expect(evictSpy).toHaveBeenCalledWith(60);
      expect(clearSpy).not.toHaveBeenCalled();

      await runChecks(monitor);
      expect(clearSpy).toHaveBeenCalledTimes(1);
    });

    it('blocks same-level cleanup within the cooldown window', async () => {
      const { monitor, evictSpy } = spiedMonitor(60_000);

      setMemUsage(9 * GB); // soft pressure
      await runChecks(monitor, 2);

      expect(evictSpy).toHaveBeenCalledTimes(1);
      expect(evictSpy).toHaveBeenCalledWith(60);
    });

    it('does not count successful cleanup as a failure when RSS does not drop', async () => {
      const monitor = createMonitor();
      const cleanupFailed = listen(monitor, 'memory-cleanup-failed');

      setMemUsage(9 * GB); // soft pressure, unchanged RSS
      await runChecks(monitor, 3);

      expect(monitor.getConsecutiveFailures()).toBe(0);
      expect(cleanupFailed).not.toHaveBeenCalled();
    });

    it.each([
      ['emits a diagnostic event after repeated ineffective cleanups', 3, 1],
      ['throttles diagnostic events for continued ineffective cleanup', 10, 2],
      [
        'emits repeated ineffective cleanup diagnostics at the long interval',
        20,
        3,
      ],
    ])('%s', async (_title, checks, events) => {
      const monitor = createMonitor();
      const cleanupIneffective = listen(monitor, 'memory-cleanup-ineffective');

      setMemUsage(9 * GB); // soft pressure, unchanged RSS
      await runChecks(monitor, checks);

      expect(cleanupIneffective).toHaveBeenCalledTimes(events);
      expect(cleanupIneffective).toHaveBeenLastCalledWith(
        expect.objectContaining({
          consecutiveIneffectiveCleanups: checks,
          freedRatio: 0,
        }),
      );
    });

    it('backs off repeated ineffective aggressive cleanup', async () => {
      let now = 1_000;
      vi.spyOn(Date, 'now').mockImplementation(() => now);
      const clearSpy = vi.fn();
      const monitor = cacheMonitor(
        { dropEntries: clearSpy, evictNotAccessedSince: vi.fn() },
        { cleanupCooldownMs: 1_000 },
      );

      setMemUsage(14 * GB); // critical, unchanged RSS

      for (let i = 0; i < 3; i++) {
        await runChecks(monitor);
        now += 1_000;
      }

      expect(clearSpy).toHaveBeenCalledTimes(3);

      await runChecks(monitor);
      expect(clearSpy).toHaveBeenCalledTimes(3);

      now += 1_000;
      await runChecks(monitor);
      expect(clearSpy).toHaveBeenCalledTimes(4);
    });

    it('measures a cleanup before running a queued escalation', async () => {
      let rss = 9 * GB;
      vi.spyOn(process, 'memoryUsage').mockImplementation(() =>
        createMemUsage(rss),
      );

      const evictSpy = vi.fn(() => {
        rss = 8 * GB;
        return 0;
      });
      const clearSpy = vi.fn(() => {
        rss = 4 * GB;
      });
      const monitor = cacheMonitor(
        { dropEntries: clearSpy, evictNotAccessedSince: evictSpy },
        { cleanupCooldownMs: 60_000 },
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
      let rss = 9 * GB;
      const evictSpy = vi.fn(() => {
        if (evictSpy.mock.calls.length === 3) {
          rss = 8 * GB;
        }
        return 0;
      });
      vi.spyOn(process, 'memoryUsage').mockImplementation(() =>
        createMemUsage(rss),
      );
      const monitor = cacheMonitor({ evictNotAccessedSince: evictSpy });
      const cleanupIneffective = listen(monitor, 'memory-cleanup-ineffective');

      for (let i = 0; i < 3; i++) {
        await runChecks(monitor);
        rss = 9 * GB;
      }
      await runChecks(monitor, 2);

      expect(cleanupIneffective).not.toHaveBeenCalled();
    });

    it('records queued cleanup startup failures', async () => {
      const { monitor } = spiedMonitor(60_000);
      vi.spyOn(monitor, 'getPressureLevel')
        .mockReturnValueOnce('soft')
        .mockReturnValueOnce('critical');
      // Call order: check1 sampling snapshot, light memBefore, check2
      // sampling snapshot, light memAfter, then the dequeued aggressive
      // cleanup's memBefore (the throw under test), then the RSS read in
      // recordCleanupFailure.
      vi.spyOn(process, 'memoryUsage')
        .mockReturnValueOnce(createMemUsage(9 * GB))
        .mockReturnValueOnce(createMemUsage(8 * GB))
        .mockReturnValueOnce(createMemUsage(9 * GB))
        .mockReturnValueOnce(createMemUsage(8 * GB))
        .mockImplementationOnce(() => {
          throw new Error('queued RSS unavailable');
        })
        .mockReturnValueOnce(createMemUsage(8 * GB));

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
      const monitor = cacheMonitor(
        { dropEntries: clearSpy, evictNotAccessedSince: vi.fn() },
        { enableExplicitGC: true },
      );

      await checkAt(monitor, 14 * GB); // critical pressure

      expect(clearSpy).toHaveBeenCalled();
      expect(mockDebugLogger.warn).toHaveBeenCalledWith(
        'trigger_gc requested but global.gc is not available; ' +
          'start Node.js with --expose-gc',
      );
    });

    it('runs explicit GC when requested and available', async () => {
      const gcSpy = vi.fn();
      vi.stubGlobal('gc', gcSpy);
      const monitor = cacheMonitor(
        { evictNotAccessedSince: vi.fn() },
        { enableExplicitGC: true },
      );

      await checkAt(monitor, 14 * GB); // critical pressure

      expect(gcSpy).toHaveBeenCalledTimes(1);
      expect(mockDebugLogger.debug).toHaveBeenCalledWith(
        'global.gc() freed 0 bytes',
      );
    });

    it('skips same-priority cleanup while another cleanup is in progress', () => {
      const { monitor, evictSpy } = spiedMonitor(0);

      setMemUsage(9 * GB); // soft pressure
      monitor.performCheck();
      monitor.performCheck();

      expect(evictSpy).toHaveBeenCalledTimes(1);
      expect(mockDebugLogger.debug).toHaveBeenCalledWith(
        'Cleanup already in progress, skipping',
      );
    });

    it('counts cleanup step exceptions as failures', async () => {
      const cleanupFailed = vi.fn();
      const monitor = await runFailingChecks(3, cleanupFailed);

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
      const evictSpy = throwingEvict();
      const monitor = cacheMonitor({ evictNotAccessedSince: evictSpy });

      await checkAt(monitor, 9 * GB); // soft pressure
      expect(monitor.getConsecutiveFailures()).toBe(1);

      evictSpy.mockReturnValue(0);
      await runChecks(monitor);

      expect(monitor.getConsecutiveFailures()).toBe(0);
    });

    it('records cleanup failures when RSS cannot be read', async () => {
      const monitor = cacheMonitor({ evictNotAccessedSince: throwingEvict() });
      vi.spyOn(process, 'memoryUsage')
        .mockReturnValueOnce(createMemUsage(9 * GB))
        .mockReturnValueOnce(createMemUsage(9 * GB))
        .mockImplementationOnce(() => {
          throw new Error('RSS unavailable');
        });

      await runChecks(monitor);

      expect(monitor.getConsecutiveFailures()).toBe(1);
      expect(mockDebugLogger.error).toHaveBeenCalledWith(
        'Failed to read RSS after cleanup failure: RSS unavailable',
      );
      expect(mockDebugLogger.error).toHaveBeenCalledWith(
        'Cleanup "light" failed: cache failure; consecutive failures: 1',
      );
    });

    it('throttles repeated cleanup failure events after the threshold', async () => {
      const cleanupFailed = vi.fn();
      const monitor = await runFailingChecks(10, cleanupFailed);

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
      const monitor = await runFailingChecks(3, () => {
        throw new Error('listener failure');
      });

      expect(monitor.getConsecutiveFailures()).toBe(3);
    });
  });

  describe('compact_history step', () => {
    it('skips compaction when client is not initialized', async () => {
      const setHistory = vi.fn();
      const monitor = createMonitor({
        llmClient: chatClient(setHistory, [{ role: 'user' }], {
          initialized: false,
          full: () => [{ role: 'user' }],
        }),
      });

      await checkAt(monitor, 10 * GB); // hard pressure

      expect(setHistory).not.toHaveBeenCalled();
    });

    it('runs compaction step without errors when client is initialized', async () => {
      const setHistory = vi.fn();
      const originalHistory = [{ role: 'user', parts: [{ text: 'hello' }] }];
      const monitor = createMonitor({
        llmClient: chatClient(setHistory, originalHistory, {
          full: () => [...originalHistory],
        }),
      });

      await checkAt(monitor, 10 * GB); // hard pressure

      // The step ran without errors — no crash, no failure count
      expect(monitor.getConsecutiveFailures()).toBe(0);
    });

    it('handles empty history without errors', async () => {
      const setHistory = vi.fn();
      const monitor = createMonitor({
        llmClient: chatClient(setHistory, [], { full: () => [] }),
      });

      await checkAt(monitor, 10 * GB); // hard pressure

      expect(setHistory).not.toHaveBeenCalled();
    });

    it('handles exceptions during compaction gracefully', async () => {
      const monitor = createMonitor({
        llmClient: {
          isInitialized: () => true,
          getChat: () => {
            throw new Error('chat unavailable');
          },
        },
      });

      await checkAt(monitor, 11 * GB); // 11/16 = 0.6875 >= 0.65: hard pressure

      // compact_history error is caught and logged without propagating,
      // so subsequent cleanup steps (like trigger_gc) can still run.
      expect(monitor.getConsecutiveFailures()).toBe(0);
    });

    it('handles getLlmClient returning null', async () => {
      const setHistory = vi.fn();
      const monitor = createMonitor({ llmClient: null });

      await checkAt(monitor, 11 * GB); // 11/16 = 0.6875 >= 0.65: hard pressure

      expect(setHistory).not.toHaveBeenCalled();
    });

    it('compacts history and clears fileReadCache when meta is non-null', async () => {
      const setHistory = vi.fn();
      const clearCache = vi.fn();
      // Build history with 7 read_file tool results (keep=5, so 2 get cleared)
      const toolHistory: Content[] = [];
      for (let i = 0; i < 7; i++) {
        const filePath =
          i === 0
            ? '/mock/project/.qwen/team-memory/feedback/testing.md'
            : `/f${i}.ts`;
        toolHistory.push(
          content(
            'model',
            fnCall('read_file', { file_path: filePath }, `call_${i}`),
          ),
          content('user', {
            functionResponse: {
              name: 'read_file',
              id: `call_${i}`,
              response: { output: `content of f${i}` },
            },
          }),
        );
      }
      toolHistory.push(
        content('model', fnCall('update_goal', undefined, 'goal-end')),
        content('user', fnResponse('update_goal', {}, 'goal-end')),
      );
      // Default clearContextOnIdle: keep 5 tool results.
      const monitor = createMonitor({
        llmClient: chatClient(setHistory, toolHistory, {
          completed: ['call_1', 'goal-end'],
        }),
        fileReadCache: { clear: clearCache },
      });

      await checkAt(monitor, 11 * GB); // 11/16 = 0.6875 >= 0.65: hard pressure

      expect(setHistory).toHaveBeenCalled();
      expect(clearCache).toHaveBeenCalled();
      const compacted = setHistory.mock.calls[0][0] as Content[];
      expect(setHistory.mock.calls[0][1]).toEqual(['call_1', 'goal-end']);
      expect(compacted.at(-1)?.parts?.[0]?.functionResponse?.id).toBe(
        'goal-end',
      );
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
      for (const entry of blankedResponses) {
        const index = compacted.indexOf(entry);
        expect(entry).not.toBe(toolHistory[index]);
        expect(entry.parts?.[0]?.functionResponse?.id).toBe(
          toolHistory[index].parts?.[0]?.functionResponse?.id,
        );
      }
      expect(
        blankedResponses
          .flatMap((entry) => entry.parts ?? [])
          .map((part) => part.functionResponse?.id),
      ).toContain('call_1');
      const memoryResult = compacted
        .flatMap((entry) => entry.parts ?? [])
        .find((part) => part.functionResponse?.id === 'call_0');
      expect(memoryResult?.functionResponse?.response?.['output']).toBe(
        'content of f0',
      );
    });

    it('forwards evicted search_memory bodies to the memory manager', async () => {
      const markMemoryBodiesEvictedFromHistory = vi.fn();
      const toolHistory: Content[] = [];
      for (let index = 0; index < 7; index += 1) {
        const callId = `memory_${index}`;
        toolHistory.push(
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: callId,
                  name: 'search_memory',
                  args: { mode: 'fetch', refs: [`project:${index}.md`] },
                },
              },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: callId,
                  name: 'search_memory',
                  response: {
                    output: JSON.stringify({
                      mode: 'fetch',
                      results: [
                        {
                          ref: `project:${index}.md`,
                          version: index + 1,
                          content: `memory body ${index}`,
                          range: { start: 0, end: 13, total: 13 },
                        },
                      ],
                    }),
                  },
                },
              },
            ],
          },
        );
      }
      const config = createMockConfig({
        llmClient: {
          isInitialized: () => true,
          getChat: () => ({
            getHistoryShallow: () => toolHistory,
            setHistory: vi.fn(),
            getCompletedToolCallIds: () => [],
          }),
        },
      });
      vi.spyOn(config, 'getMemoryManager').mockReturnValue({
        markMemoryBodiesEvictedFromHistory,
      } as unknown as ReturnType<Config['getMemoryManager']>);
      const monitor = new MemoryPressureMonitor(config, {
        ...DEFAULT_PRESSURE_CONFIG,
        cleanupCooldownMs: 0,
      });

      setMemUsage(11 * 1024 * 1024 * 1024);
      monitor.performCheck();
      await drainCleanupMeasurement();

      expect(markMemoryBodiesEvictedFromHistory).toHaveBeenCalledWith([
        { memoryRef: 'project:0.md', mtimeMs: 1 },
        { memoryRef: 'project:1.md', mtimeMs: 2 },
      ]);
    });

    it('falls back to the blanket wipe when an evicted memory body is unresolved', async () => {
      const markMemoryBodiesEvictedFromHistory = vi.fn();
      const markAllMemoryBodiesEvictedFromHistory = vi.fn();
      const toolHistory: Content[] = [];
      for (let index = 0; index < 7; index += 1) {
        const callId = `memory_${index}`;
        toolHistory.push(
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: callId,
                  name: 'search_memory',
                  args: { mode: 'fetch', refs: [`project:${index}.md`] },
                },
              },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: callId,
                  name: 'search_memory',
                  response: {
                    // Unparseable output (e.g. scheduler-truncated): the body
                    // refs cannot be recovered, so the eviction is unresolved.
                    output: '{"mode":"fetch","results":[{"ref":"project:0.md"',
                  },
                },
              },
            ],
          },
        );
      }
      const config = createMockConfig({
        llmClient: {
          isInitialized: () => true,
          getChat: () => ({
            getHistoryShallow: () => toolHistory,
            setHistory: vi.fn(),
            getCompletedToolCallIds: () => [],
          }),
        },
      });
      vi.spyOn(config, 'getMemoryManager').mockReturnValue({
        markMemoryBodiesEvictedFromHistory,
        markAllMemoryBodiesEvictedFromHistory,
      } as unknown as ReturnType<Config['getMemoryManager']>);
      const monitor = new MemoryPressureMonitor(config, {
        ...DEFAULT_PRESSURE_CONFIG,
        cleanupCooldownMs: 0,
      });

      setMemUsage(11 * 1024 * 1024 * 1024);
      monitor.performCheck();
      await drainCleanupMeasurement();

      expect(markAllMemoryBodiesEvictedFromHistory).toHaveBeenCalledTimes(1);
      expect(markMemoryBodiesEvictedFromHistory).not.toHaveBeenCalled();
    });

    // 7 tool results, keep=5. A positive threshold is overridden to 0 and
    // an unset one defaults to 0, so compaction runs; a negative one (-1)
    // is preserved and microcompactHistory skips compaction.
    it.each([
      ['overrides positive toolResultsThresholdMinutes to 0', 60, true],
      [
        'preserves negative toolResultsThresholdMinutes (-1), skipping compaction',
        -1,
        false,
      ],
      ['defaults undefined toolResultsThresholdMinutes to 0', undefined, true],
    ])('%s', async (_title, threshold, compacts) => {
      const setHistory = vi.fn();
      const monitor = createMonitor({
        llmClient: chatClient(setHistory, readFileHistory()),
        clearContextOnIdle:
          threshold === undefined
            ? undefined
            : {
                clearContextMinutes: 60,
                toolResultsNumToKeep: 5,
                toolResultsThresholdMinutes: threshold,
              },
      });

      await checkAt(monitor, 11 * GB);

      if (compacts) expect(setHistory).toHaveBeenCalled();
      else expect(setHistory).not.toHaveBeenCalled();
    });
  });

  describe('getConsecutiveFailures', () => {
    it('starts at zero', () => {
      setOsTotalmem(16 * GB);
      const monitor = new MemoryPressureMonitor(createMockConfig());
      expect(monitor.getConsecutiveFailures()).toBe(0);
    });

    it('can reset consecutive failures', async () => {
      setOsTotalmem(16 * GB);
      const monitor = await runFailingChecks(1);

      expect(monitor.getConsecutiveFailures()).toBe(1);
      monitor.resetConsecutiveFailures();
      expect(monitor.getConsecutiveFailures()).toBe(0);
    });

    it('can reset ineffective cleanup diagnostics', async () => {
      setOsTotalmem(16 * GB);
      const monitor = createMonitor();
      const cleanupIneffective = listen(monitor, 'memory-cleanup-ineffective');

      setMemUsage(9 * GB);
      await runChecks(monitor, 2);
      monitor.resetConsecutiveFailures();
      await runChecks(monitor, 3);

      expect(cleanupIneffective).toHaveBeenCalledTimes(1);
      expect(cleanupIneffective).toHaveBeenCalledWith(
        expect.objectContaining({
          consecutiveIneffectiveCleanups: 3,
        }),
      );
    });
  });

  describe('global.gc() safety guards', () => {
    const gcMonitor = (enableExplicitGC: boolean) =>
      cacheMonitor({ evictNotAccessedSince: vi.fn() }, { enableExplicitGC });

    it('should not include trigger_gc in soft or hard pressure tiers', () => {
      const monitor = gcMonitor(true);

      // Soft pressure — should NOT trigger GC
      setMemUsage(9 * GB); // 9/16 = 0.5625 >= 0.5 soft
      monitor.performCheck();
      expect(mockDebugLogger.debug).not.toHaveBeenCalledWith(
        expect.stringContaining('global.gc()'),
      );

      // Reset for next check
      mockDebugLogger.debug.mockClear();

      // Hard pressure — should NOT trigger GC
      setMemUsage(11 * GB); // 11/16 = 0.6875 >= 0.65 hard
      monitor.performCheck();
      expect(mockDebugLogger.debug).not.toHaveBeenCalledWith(
        expect.stringContaining('global.gc()'),
      );
    });

    it('global.gc() is only called under critical pressure with enableExplicitGC: true', async () => {
      const gcSpy = vi.fn();
      vi.stubGlobal('gc', gcSpy);
      const monitor = gcMonitor(true);

      // Soft pressure — GC should NOT be called
      await checkAt(monitor, 9 * GB); // 9/16 = 0.5625 >= 0.5 soft
      expect(gcSpy).not.toHaveBeenCalled();

      gcSpy.mockClear();

      // Hard pressure — GC should NOT be called
      await checkAt(monitor, 11 * GB); // 11/16 = 0.6875 >= 0.65 hard
      expect(gcSpy).not.toHaveBeenCalled();

      gcSpy.mockClear();

      // Critical pressure — GC SHOULD be called exactly once
      await checkAt(monitor, 14 * GB); // 14/16 = 0.875 >= 0.8 critical
      expect(gcSpy).toHaveBeenCalledTimes(1);
    });

    it('global.gc() is never called when enableExplicitGC is false', async () => {
      const gcSpy = vi.fn();
      vi.stubGlobal('gc', gcSpy);
      const monitor = gcMonitor(false);

      // Critical pressure — GC should NOT be called
      await checkAt(monitor, 14 * GB);
      expect(gcSpy).not.toHaveBeenCalled();
    });
  });

  describe('runtime sampling and telemetry', () => {
    beforeEach(() => {
      setOsTotalmem(16 * GB);
      mockIsPerformanceMonitoringActive.mockReturnValue(false);
      mockRecordMemoryUsage.mockClear();
      mockRecordCpuUsage.mockClear();
    });

    it('reports memory and CPU metrics when performance monitoring is active', () => {
      mockIsPerformanceMonitoringActive.mockReturnValue(true);
      const rss = 4 * GB; // 4/16 = 0.25: normal, no cleanup
      const heapUsed = 256 * MB;
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
      setMemUsage(4 * GB);
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
      setMemUsage(4 * GB); // normal pressure, no cleanup

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
      const rss = 11 * GB; // 11/16 = 0.6875: hard
      setMemUsage(rss);
      const monitor = createMonitor();
      // Advance the clock past the ring's construction tick so record()
      // sees elapsed > 0 and actually pushes a sample.
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 50);

      await runChecks(monitor);

      expect(dumpSpy).toHaveBeenCalledTimes(1);
      expect(dumpSpy).toHaveBeenCalledWith(
        'hard',
        expect.arrayContaining([expect.objectContaining({ rss })]),
      );
    });
  });
});
