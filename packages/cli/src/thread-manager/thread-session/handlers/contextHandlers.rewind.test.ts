/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { rewindFiles, seedReadState } from './contextHandlers.js';
import type { ThreadCallContext } from '../contract/hostContext.js';
import type { ThreadSessionInternals } from '../contract/handlerContract.js';

it.each([false, true])(
  'reports incomplete file rewind through the existing result (dryRun: %s)',
  async (dryRun) => {
    const failedFiles = [{ path: 'b.ts', error: 'missing backup' }];
    const manager = {
      canRewind: () => true,
      getDiffStats: async () => ({
        filesChanged: ['a.ts'],
        insertions: 1,
        deletions: 0,
        failedFiles,
      }),
      rewindDetailed: vi.fn(async () => ({
        filesChanged: ['a.ts'],
        failedFiles,
      })),
    };
    const cache = new Map([
      ['/project/a.ts', true],
      ['/project/b.ts', true],
    ]);
    const session = {
      requireConfig: () => ({
        getFileHistoryManager: () => manager,
        fileReadState: cache,
        getTargetDir: () => '/project',
      }),
      peekQueryRunner: () => undefined,
    } as unknown as ThreadSessionInternals;
    const result = await rewindFiles(session, {} as ThreadCallContext, {
      userMessageId: 'checkpoint',
      dryRun,
    });
    expect(result).toMatchObject({
      canRewind: false,
      filesChanged: ['a.ts'],
      error: expect.stringContaining('b.ts'),
    });
    expect(manager.rewindDetailed).toHaveBeenCalledTimes(dryRun ? 0 : 1);
    expect(cache.size).toBe(dryRun ? 2 : 0);
  },
);

it('seedReadState keeps the SDK number mtime contract and truncates to integer', async () => {
  const cache = { set: vi.fn() };
  const session = {
    requireConfig: () => ({
      getTargetDir: () => '/project',
      fileReadState: cache,
    }),
    peekQueryRunner: () => undefined,
  } as unknown as ThreadSessionInternals;

  await seedReadState(session, {} as ThreadCallContext, [
    { path: 'a.ts', mtime: 123.9 },
  ]);
  expect(cache.set).toHaveBeenCalledWith(
    path.resolve('/project', 'a.ts'),
    expect.objectContaining({ timestamp: 123 }),
  );

  // SDK 契约是 number；numeric string 不得被 daemon 层悄悄放宽。
  const err = await seedReadState(session, {} as ThreadCallContext, [
    { path: 'a.ts', mtime: '123' as unknown as number },
  ]).catch((error: unknown) => error);
  expect((err as Error).message).toBe('missing or invalid mtime');
});
