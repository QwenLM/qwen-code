/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ENV_STARTUP_TRACE } from '../config/brand.js';
import {
  markStartupMilestone,
  resetStartupMilestonesForTesting,
} from '../utils/startupTrace.js';
import {
  installStartupTraceRecorder,
  STARTUP_TRACE_FILE_NAME,
  type StartupTraceFile,
  type StartupTraceRecorder,
} from './startupTraceRecorder.js';

vi.mock('../utils/runLogger.js', () => ({
  runLogger: { log: vi.fn(), warn: vi.fn(), getDebugLogPath: vi.fn(() => undefined) },
}));

const enabled = { [ENV_STARTUP_TRACE]: '1' };

describe('startup trace recorder', () => {
  let dir: string;
  let recorder: StartupTraceRecorder | undefined;
  const traceFile = () => path.join(dir, STARTUP_TRACE_FILE_NAME);
  const readTrace = () =>
    JSON.parse(readFileSync(traceFile(), 'utf8')) as StartupTraceFile;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'startup-trace-'));
    resetStartupMilestonesForTesting();
    performance.clearMarks();
    performance.clearMeasures();
  });
  afterEach(() => {
    recorder?.dispose();
    recorder = undefined;
    resetStartupMilestonesForTesting();
    rmSync(dir, { recursive: true, force: true });
  });

  it('is not installed unless the environment variable is 1', () => {
    expect(installStartupTraceRecorder({ mode: 'tui', flushOn: [], outputDir: dir }, {})).toBeUndefined();
    expect(
      installStartupTraceRecorder({ mode: 'tui', flushOn: [], outputDir: dir }, { [ENV_STARTUP_TRACE]: 'true' }),
    ).toBeUndefined();
  });

  it('keeps marks created before install and entries later cleared by the profiler', () => {
    performance.mark('startup:early:start');
    recorder = installStartupTraceRecorder({ mode: 'headless', flushOn: [], outputDir: dir }, enabled)!;
    performance.mark('startup:load:start');
    performance.mark('startup:load:end');
    performance.measure('load', 'startup:load:start', 'startup:load:end');
    performance.clearMarks();
    performance.clearMeasures();
    recorder.writeSync();
    const trace = readTrace();
    expect(trace).toMatchObject({ version: 1, mode: 'headless', flushReason: 'exit', pid: process.pid });
    expect(trace.entries.map((e) => `${e.type}:${e.name}`)).toEqual(
      expect.arrayContaining(['mark:startup:early:start', 'mark:startup:load:start', 'measure:load']),
    );
    expect(trace.entries.find((e) => e.name === 'load')?.duration).toEqual(expect.any(Number));
  });

  it('captures memory at milestones and writes once a flush milestone is reached', async () => {
    recorder = installStartupTraceRecorder(
      { mode: 'tui', flushOn: ['tui_first_turn_ready'], outputDir: dir },
      enabled,
    )!;
    markStartupMilestone('tui_first_frame');
    expect(existsSync(traceFile())).toBe(false);
    markStartupMilestone('tui_first_turn_ready');
    await vi.waitFor(() => expect(existsSync(traceFile())).toBe(true));
    const trace = readTrace();
    expect(trace).toMatchObject({ flushReason: 'tui_first_turn_ready' });
    expect(Object.keys(trace.memory)).toEqual([
      'tui_first_frame',
      'tui_first_turn_ready',
    ]);
    expect(trace.entries.map((e) => e.name)).toContain(
      'qwen:milestone:tui_first_frame',
    );
  });

  it('stops observing after dispose', () => {
    recorder = installStartupTraceRecorder({ mode: 'daemon', flushOn: [], outputDir: dir }, enabled)!;
    recorder.dispose();
    markStartupMilestone('session_opened', 's1');
    recorder.writeSync();
    expect(existsSync(traceFile())).toBe(false);
    expect(recorder.snapshot('exit').memory).toEqual({});
  });
});
