/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, expect, it, vi } from 'vitest';
import { logAsyncPhase } from './logAsyncPhase.js';

const log = vi.hoisted(() => vi.fn());
vi.mock('@qwen-code/core', () => ({ runLogger: { log } }));
beforeEach(() => log.mockReset());

it('records a pending phase before completion without logging its result', async () => {
  let release!: (value: string) => void;
  const pending = logAsyncPhase(
    'auth.file',
    () =>
      new Promise<string>((resolve) => {
        release = resolve;
      }),
  );
  expect(log).toHaveBeenCalledTimes(1);
  expect(log).toHaveBeenLastCalledWith(
    '[daemon.phase]',
    expect.objectContaining({ name: 'auth.file', event: 'started' }),
  );
  release('private-token');
  await expect(pending).resolves.toBe('private-token');
  expect(log).toHaveBeenLastCalledWith(
    '[daemon.phase]',
    expect.objectContaining({ event: 'finished', status: 'resolved' }),
  );
  expect(JSON.stringify(log.mock.calls)).not.toContain('private-token');
});

it('preserves the original failure without logging its contents', async () => {
  const failure = new Error('private-token');
  await expect(
    logAsyncPhase('auth.file', async () => {
      throw failure;
    }),
  ).rejects.toBe(failure);
  expect(log).toHaveBeenLastCalledWith(
    '[daemon.phase]',
    expect.objectContaining({ status: 'rejected' }),
  );
  expect(JSON.stringify(log.mock.calls)).not.toContain('private-token');
});

it('does not let a logging failure change execution or errors', async () => {
  try {
    log.mockImplementation(() => {
      throw new Error('logger unavailable');
    });
    await expect(logAsyncPhase('auth.runtime', async () => 42)).resolves.toBe(
      42,
    );
    const failure = new Error('original');
    await expect(
      logAsyncPhase('auth.runtime', () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  } finally {
    log.mockReset();
  }
});
