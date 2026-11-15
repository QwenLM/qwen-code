/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEBUG_LOG_DEADLINE_MS,
  DEBUG_LOG_QUIET_MS,
  readSettledDebugLog,
} from './settled-debug-log.js';

describe('readSettledDebugLog', () => {
  let runtimeDir: string;
  let logFile: string;

  beforeEach(() => {
    vi.useFakeTimers();
    runtimeDir = mkdtempSync(join(tmpdir(), 'qwen-settled-debug-log-'));
    mkdirSync(join(runtimeDir, 'debug'));
    logFile = join(runtimeDir, 'debug', 'run.log');
    writeFileSync(logFile, 'marker-1\n');
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(runtimeDir, { recursive: true, force: true });
  });

  it('reads a marker appended after the first poll', async () => {
    const settled = readSettledDebugLog(runtimeDir);
    await vi.advanceTimersByTimeAsync(100);
    appendFileSync(logFile, 'marker-2\n');
    await vi.advanceTimersByTimeAsync(DEBUG_LOG_QUIET_MS + 100);
    await expect(settled).resolves.toBe('marker-1\nmarker-2\n');
  });

  it('restarts the quiet window on every write', async () => {
    const settled = readSettledDebugLog(runtimeDir);
    await vi.advanceTimersByTimeAsync(100);
    appendFileSync(logFile, 'marker-2\n');
    // Without the reset, the quiet window that began with marker-1 expires
    // here and the helper returns before marker-3 is written.
    await vi.advanceTimersByTimeAsync(150);
    appendFileSync(logFile, 'marker-3\n');
    await vi.advanceTimersByTimeAsync(DEBUG_LOG_QUIET_MS + 100);
    await expect(settled).resolves.toBe('marker-1\nmarker-2\nmarker-3\n');
  });

  it('returns the log after one quiet window without writes', async () => {
    const settled = readSettledDebugLog(runtimeDir);
    await vi.advanceTimersByTimeAsync(DEBUG_LOG_QUIET_MS + 100);
    await expect(settled).resolves.toBe('marker-1\n');
  });

  it(
    'returns at the deadline while writes keep coming',
    { timeout: 10_000 },
    async () => {
      let written = 1;
      const appends = setInterval(() => {
        written += 1;
        appendFileSync(logFile, `marker-${written}\n`);
      }, 10);
      try {
        const settled = readSettledDebugLog(runtimeDir);
        await vi.advanceTimersByTimeAsync(DEBUG_LOG_DEADLINE_MS + 100);
        await expect(settled).resolves.toContain('marker-2\n');
        expect(written).toBeGreaterThan(1);
      } finally {
        clearInterval(appends);
      }
    },
  );
});
