/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, expect, it, vi } from 'vitest';
import { SessionPhaseLog } from './sessionPhaseLog.js';

const log = vi.hoisted(() => vi.fn());
vi.mock('@qwen-code/core', () => ({ runLogger: { log } }));
beforeEach(() => log.mockReset());

it('identifies a pending stage and keeps only completed durations in the summary', async () => {
  const phases = new SessionPhaseLog('session-1');
  let release!: () => void;
  const pending = phases.phase(
    '配置加载',
    '读取配置',
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  expect(log).toHaveBeenLastCalledWith(
    '[会话阶段开始] 配置加载',
    expect.objectContaining({ sessionId: 'session-1', event: 'started' }),
  );
  phases.summary('pending');
  expect(log).toHaveBeenLastCalledWith(
    '[会话阶段汇总] pending',
    expect.objectContaining({ 阶段: [] }),
  );
  release();
  await pending;
  expect(log).toHaveBeenLastCalledWith(
    '[会话阶段] 配置加载',
    expect.objectContaining({ status: 'resolved', 耗时ms: expect.any(Number) }),
  );
  phases.summary('done');
  expect(log).toHaveBeenLastCalledWith(
    '[会话阶段汇总] done',
    expect.objectContaining({
      阶段: [expect.stringMatching(/^配置加载=\d+ms$/)],
    }),
  );
});

it('distinguishes async and sync failures while preserving the original error', async () => {
  const phases = new SessionPhaseLog('session-1');
  const failure = new Error('private-detail');
  await expect(
    phases.phase('异步', '工作', async () => {
      throw failure;
    }),
  ).rejects.toBe(failure);
  expect(log).toHaveBeenLastCalledWith(
    '[会话阶段] 异步',
    expect.objectContaining({ status: 'rejected' }),
  );
  expect(() =>
    phases.phaseSync('同步', '工作', () => {
      throw failure;
    }),
  ).toThrow(failure);
  expect(log).toHaveBeenLastCalledWith(
    '[会话阶段] 同步',
    expect.objectContaining({ status: 'rejected' }),
  );
  expect(phases.phaseSync('同步', '工作', () => 42)).toBe(42);
  expect(log).toHaveBeenLastCalledWith(
    '[会话阶段] 同步',
    expect.objectContaining({ status: 'resolved' }),
  );
  expect(JSON.stringify(log.mock.calls)).not.toContain('private-detail');
});

it('preserves results even when the logger fails', async () => {
  try {
    log.mockImplementation(() => {
      throw new Error('logger unavailable');
    });
    const phases = new SessionPhaseLog('session-1');
    expect(phases.phaseSync('同步', '工作', () => 42)).toBe(42);
    const failure = new Error('original');
    await expect(
      phases.phase('异步', '工作', async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  } finally {
    log.mockReset();
  }
});
