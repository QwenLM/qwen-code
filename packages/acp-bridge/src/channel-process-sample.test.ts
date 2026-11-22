/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  parseProcStat,
  sampleChannelProcess,
} from './channel-process-sample.js';

// Field layout after "<pid> (<comm>) ": state=0, utime=11, stime=12.
const STAT_PLAIN =
  '1234 (node) R 1 1234 1234 0 -1 4194560 100 200 0 0 11 22 0 0 20 0 1 0 500';
const STAT_TRICKY_COMM =
  '1234 (my ) proc) S 1 1234 1234 0 -1 4194560 100 200 0 0 5 7 0 0 20 0 1 0 500';

describe('parseProcStat', () => {
  it('reads state and utime+stime after a plain comm', () => {
    expect(parseProcStat(STAT_PLAIN)).toEqual({ state: 'R', cpuTicks: 33 });
  });

  it('anchors on the last ) when comm contains spaces and parens', () => {
    expect(parseProcStat(STAT_TRICKY_COMM)).toEqual({
      state: 'S',
      cpuTicks: 12,
    });
  });

  it('rejects a line without a comm terminator', () => {
    expect(parseProcStat('1234 node R 1 2 3')).toBeUndefined();
  });

  it('rejects a truncated field list', () => {
    expect(parseProcStat('1234 (node) R 1 2 3')).toBeUndefined();
  });

  it('rejects non-numeric CPU fields', () => {
    const raw =
      '1234 (node) R 1 1234 1234 0 -1 4194560 100 200 0 0 x 22 0 0 20 0 1 0 500';
    expect(parseProcStat(raw)).toBeUndefined();
  });
});

describe('sampleChannelProcess', () => {
  it('returns undefined for invalid pids on every platform', () => {
    expect(sampleChannelProcess(undefined)).toBeUndefined();
    expect(sampleChannelProcess(0)).toBeUndefined();
    expect(sampleChannelProcess(-1)).toBeUndefined();
    expect(sampleChannelProcess(1.5)).toBeUndefined();
    expect(sampleChannelProcess(Number.NaN)).toBeUndefined();
  });

  it('returns undefined off Linux', () => {
    const spy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    try {
      expect(sampleChannelProcess(process.pid)).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it.runIf(process.platform === 'linux')(
    'returns undefined for a pid that does not exist',
    () => {
      expect(sampleChannelProcess(999_999_999)).toBeUndefined();
    },
  );

  it.runIf(process.platform === 'linux')(
    'samples the calling process with plausible fields',
    () => {
      const sample = sampleChannelProcess(process.pid);
      expect(sample).toBeDefined();
      expect(sample!.state).toMatch(/^[RSDTZ]$/);
      expect(Number.isFinite(sample!.cpuTicks)).toBe(true);
      expect(sample!.cpuTicks).toBeGreaterThanOrEqual(0);
      expect(sample!.rssBytes).toBeGreaterThan(0);
      expect(typeof sample!.wchan).toBe('string');
    },
  );
});
