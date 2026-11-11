/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { performance } from 'node:perf_hooks';
import { isMainThread, threadId } from 'node:worker_threads';
import { runLogger } from './runLogger.js';
import {
  beginStartupStep,
  clearStartupMilestones,
  getStartupMilestone,
  markStartupMilestone,
  onStartupMilestone,
  resetStartupMilestonesForTesting,
  STARTUP_MILESTONE_MARK_PREFIX,
  traceStartupStep,
  traceStartupStepAsync,
} from './startupTrace.js';

vi.mock('./runLogger.js', () => ({ runLogger: { log: vi.fn() } }));

describe('startup breadcrumbs', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(performance, 'now').mockImplementation(() => Date.now());
    vi.mocked(runLogger.log).mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('correlates overlapping steps and reports a pending step only once', async () => {
    const first = beginStartupStep('same.phase', true);
    const second = beginStartupStep('same.phase', true);
    const firstId = (vi.mocked(runLogger.log).mock.calls[0][1] as { observation_id: number }).observation_id;
    const secondId = (vi.mocked(runLogger.log).mock.calls[1][1] as { observation_id: number }).observation_id;
    expect(firstId).not.toBe(secondId);
    first('resolved');
    await vi.advanceTimersByTimeAsync(60_000);
    const pending = vi.mocked(runLogger.log).mock.calls.filter(([line]) => String(line).includes('state=still_pending'));
    expect(pending).toHaveLength(1);
    expect(pending[0][1]).toMatchObject({ observation_id: secondId, pid: process.pid, thread_id: threadId, is_main_thread: isMainThread, duration_ms: 5000 });
    second('rejected');
    second('resolved');
    expect(vi.mocked(runLogger.log).mock.calls.at(-1)?.[1]).toMatchObject({ observation_id: secondId, status: 'rejected', duration_ms: 60_000 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('writes a breadcrumb immediately and does not keep the process alive', () => {
    const timers = vi.spyOn(globalThis, 'setTimeout');
    const done = beginStartupStep('synchronous.phase', true);
    expect(runLogger.log).toHaveBeenCalledWith('[startup-trace] step=synchronous.phase state=started', expect.any(Object));
    expect((timers.mock.results[0].value as NodeJS.Timeout).hasRef()).toBe(false);
    done();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not let logger failures escape from start, pending or finish', async () => {
    vi.mocked(runLogger.log).mockImplementation(() => { throw new Error('writer unavailable'); });
    const done = beginStartupStep('failed.writer', true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(() => done('rejected')).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('closes synchronous failures and preserves the original error', async () => {
    const error = new Error('acquire failed');
    expect(() => traceStartupStep('acquire', () => { throw error; })).toThrow(error);
    expect(runLogger.log).toHaveBeenLastCalledWith('[startup-trace] step=acquire state=finished', expect.objectContaining({ status: 'rejected' }));
    await vi.advanceTimersByTimeAsync(6000);
    expect(runLogger.log).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves async promise identity and closes rejection without pending noise', async () => {
    const error = new Error('framework failed');
    const promise = Promise.reject(error);
    const observed = traceStartupStepAsync('framework', () => promise);
    expect(observed).toBe(promise);
    await expect(observed).rejects.toBe(error);
    await vi.advanceTimersByTimeAsync(6000);
    expect(runLogger.log).toHaveBeenCalledTimes(2);
    expect(runLogger.log).toHaveBeenLastCalledWith('[startup-trace] step=framework state=finished', expect.objectContaining({ status: 'rejected' }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('closes synchronous throws from async factories and successful results', async () => {
    const error = new Error('import failed');
    expect(() => traceStartupStepAsync('import', () => { throw error; })).toThrow(error);
    const value = {};
    expect(traceStartupStep('sync', () => value)).toBe(value);
    await expect(traceStartupStepAsync('async', () => Promise.resolve(value))).resolves.toBe(value);
    expect(runLogger.log).toHaveBeenLastCalledWith('[startup-trace] step=async state=finished', expect.objectContaining({ status: 'resolved' }));
    expect(vi.getTimerCount()).toBe(0);
  });

});

describe('startup milestones', () => {
  beforeEach(() => {
    resetStartupMilestonesForTesting();
    vi.mocked(runLogger.log).mockReset();
    vi.spyOn(performance, 'now').mockReturnValue(100.4);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    resetStartupMilestonesForTesting();
  });

  it('records only the first arrival and returns its time afterwards', () => {
    expect(markStartupMilestone('tui_first_frame', undefined, { alternate_buffer: true })).toBe(100);
    vi.mocked(performance.now).mockReturnValue(900);
    expect(markStartupMilestone('tui_first_frame')).toBe(100);
    expect(getStartupMilestone('tui_first_frame')).toBe(100);
    expect(runLogger.log).toHaveBeenCalledExactlyOnceWith('[startup-trace] milestone=tui_first_frame', {
      pid: process.pid,
      elapsed_ms: 100,
      alternate_buffer: true,
    });
    expect(performance.getEntriesByName(`${STARTUP_MILESTONE_MARK_PREFIX}tui_first_frame`)).toHaveLength(1);
  });

  it('keeps scoped milestones independent and clears only the given scope', () => {
    markStartupMilestone('session_opened', 'a');
    vi.mocked(performance.now).mockReturnValue(250);
    markStartupMilestone('session_opened', 'b');
    markStartupMilestone('mcp_manager_ready');
    expect(getStartupMilestone('session_opened', 'a')).toBe(100);
    expect(getStartupMilestone('session_opened', 'b')).toBe(250);
    clearStartupMilestones('a');
    expect(getStartupMilestone('session_opened', 'a')).toBeUndefined();
    expect(getStartupMilestone('session_opened', 'b')).toBe(250);
    expect(getStartupMilestone('mcp_manager_ready')).toBe(250);
    vi.mocked(performance.now).mockReturnValue(400);
    expect(markStartupMilestone('session_opened', 'a')).toBe(400);
  });

  it('notifies listeners once per arrival and isolates listener and writer failures', () => {
    const seen: string[] = [];
    const unsubscribe = onStartupMilestone((name, key) => seen.push(`${name}|${key}`));
    onStartupMilestone(() => { throw new Error('observer failed'); });
    vi.mocked(runLogger.log).mockImplementation(() => { throw new Error('writer unavailable'); });
    expect(markStartupMilestone('session_initialized', 's1')).toBe(100);
    markStartupMilestone('session_initialized', 's1');
    unsubscribe();
    markStartupMilestone('first_text', 's1');
    expect(seen).toEqual(['session_initialized|session_initialized:s1']);
  });
});
