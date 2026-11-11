/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import {
  DEFAULT_OOM_DIAG_THRESHOLDS_MB,
  parseOomDiagnosticThresholds,
  startOomDiagnostics,
  stopOomDiagnostics,
} from './oom-diagnostics.js';
import { runLogger } from './runLogger.js';

describe('OOM diagnostics', () => {
  afterEach(() => {
    stopOomDiagnostics();
    vi.restoreAllMocks();
  });

  describe('parseOomDiagnosticThresholds', () => {
    it('uses defaults when unset', () => {
      expect(parseOomDiagnosticThresholds(undefined)).toEqual([
        ...DEFAULT_OOM_DIAG_THRESHOLDS_MB,
      ]);
    });

    it('accepts one or two thresholds and normalizes their order', () => {
      expect(parseOomDiagnosticThresholds('7168, 6144')).toEqual([
        6144, 7168,
      ]);
      expect(parseOomDiagnosticThresholds('6144')).toEqual([6144]);
      expect(parseOomDiagnosticThresholds('6144,6144')).toEqual([6144]);
    });

    it.each(['0', '-1,100', 'abc', '100,', '1.5', '1,2,3'])(
      'falls back to defaults for invalid value %s',
      (raw) => {
        expect(parseOomDiagnosticThresholds(raw)).toEqual([
          ...DEFAULT_OOM_DIAG_THRESHOLDS_MB,
        ]);
      },
    );
  });

  it('does nothing unless explicitly enabled', () => {
    const setInterval = vi.fn();

    startOomDiagnostics({
      env: {},
      setInterval,
    });

    expect(setInterval).not.toHaveBeenCalled();
  });

  it('skips Bun without starting the collector', () => {
    const setInterval = vi.fn();

    startOomDiagnostics({
      env: { QWEN_OOM_DIAG: '1' },
      isBun: true,
      setInterval,
    });

    expect(setInterval).not.toHaveBeenCalled();
  });

  it('does not fail CLI startup when heap inspection fails', () => {
    const setInterval = vi.fn();
    const mkdirSync = vi.fn();
    const warnSpy = vi
      .spyOn(runLogger, 'warn')
      .mockImplementation(() => {});

    expect(() =>
      startOomDiagnostics({
        env: { QWEN_OOM_DIAG: '1' },
        isBun: false,
        homeDir: '/home/test',
        pid: 42,
        getHeapStatistics: () => {
          throw new Error('heap inspection failed');
        },
        mkdirSync,
        setInterval,
      }),
    ).not.toThrow();

    const slug = process.env['BRAND_TEMP_PATH_SLUG'] || 'qwen-code';
    expect(mkdirSync).toHaveBeenCalledWith(
      path.join('/home/test', `${slug}-oom-diag`, 'run-42'),
      { recursive: true },
    );
    expect(setInterval).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      '[oom-diag] Failed to read heap statistics: Error: heap inspection failed',
    );
  });

  it('writes at most one snapshot per poll and one per threshold', () => {
    let checkAndDump: (() => void) | undefined;
    let heapUsedMb = 250;
    const interval = {
      unref: vi.fn(),
    } as unknown as NodeJS.Timeout;
    const setInterval = vi.fn((callback: () => void) => {
      checkAndDump = callback;
      return interval;
    });
    const clearInterval = vi.fn();
    const writeHeapSnapshot = vi
      .fn()
      .mockImplementation((target: string) => target);
    const appendFileSync = vi.fn();
    const writeFileSync = vi.fn();

    startOomDiagnostics({
      env: {
        QWEN_OOM_DIAG: '1',
        QWEN_OOM_DIAG_THRESHOLDS_MB: '100,200',
        QWEN_OOM_DIAG_DIR: '/diag/run-1',
        NODE_OPTIONS: '--max-old-space-size=512',
      },
      isBun: false,
      pid: 42,
      platform: 'win32',
      arch: 'x64',
      nodeVersion: '22.22.1',
      cliVersion: '1.2.3',
      memoryUsage: () =>
        ({
          heapUsed: heapUsedMb * 1024 * 1024,
          heapTotal: 300 * 1024 * 1024,
          rss: 350 * 1024 * 1024,
          external: 0,
          arrayBuffers: 0,
        }),
      getHeapStatistics: () =>
        ({
          heap_size_limit: 512 * 1024 * 1024,
        }) as ReturnType<typeof import('node:v8').getHeapStatistics>,
      writeHeapSnapshot,
      mkdirSync: vi.fn(),
      writeFileSync,
      appendFileSync,
      setInterval,
      clearInterval,
      getProcessLogPath: () => 'C:\\logs\\qwen.log',
      now: () => new Date('2026-07-24T01:02:03.456Z'),
    });

    expect(interval.unref).toHaveBeenCalledOnce();
    expect(writeFileSync).toHaveBeenCalledWith(
      '/diag/run-1/oom-diag-info.txt',
      expect.stringContaining('thresholds: 100,200MB'),
    );

    checkAndDump?.();
    expect(writeHeapSnapshot).toHaveBeenCalledTimes(1);
    expect(writeHeapSnapshot).toHaveBeenLastCalledWith(
      '/diag/run-1/snapshot1-250MB-1784854923456.heapsnapshot',
    );

    checkAndDump?.();
    expect(writeHeapSnapshot).toHaveBeenCalledTimes(1);

    heapUsedMb = 260;
    checkAndDump?.();
    expect(writeHeapSnapshot).toHaveBeenCalledTimes(2);
    expect(writeHeapSnapshot).toHaveBeenLastCalledWith(
      '/diag/run-1/snapshot2-260MB-1784854923456.heapsnapshot',
    );

    checkAndDump?.();
    expect(writeHeapSnapshot).toHaveBeenCalledTimes(2);
    expect(appendFileSync).toHaveBeenCalledTimes(2);

    stopOomDiagnostics();
    expect(clearInterval).toHaveBeenCalledWith(interval);
  });
});
