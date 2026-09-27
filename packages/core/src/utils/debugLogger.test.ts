/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Storage } from '../config/storage.js';
import { sessionIdContext } from './sessionIdContext.js';
import {
  createDebugLogger,
  resetDebugLoggingState,
  runWithDebugLogSession,
  runWithoutDebugLogSession,
  setDebugLogSession,
} from './debugLogger.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    promises: {
      ...actual.promises,
      mkdir: vi.fn().mockResolvedValue(undefined),
      appendFile: vi.fn().mockResolvedValue(undefined),
    },
  };
});
vi.mock('./symlink.js', () => ({
  updateSymlink: vi.fn().mockResolvedValue(true),
}));
vi.mock('../telemetry/trace-context.js', () => ({
  getTraceContext: vi.fn().mockReturnValue(null),
}));

describe('debug log session ownership', () => {
  beforeEach(async () => {
    vi.stubEnv('QWEN_DEBUG_LOG_FILE', '1');
    vi.useFakeTimers();
    Storage.setRuntimeBaseDir(null);
    resetDebugLoggingState();
    setDebugLogSession({ getSessionId: () => 'global-B' });
    await vi.runAllTimersAsync();
    vi.clearAllMocks();
  });
  afterEach(async () => {
    setDebugLogSession(null);
    await vi.runAllTimersAsync();
    resetDebugLoggingState();
    Storage.setRuntimeBaseDir(null);
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it.each([
    { mode: 'session', owner: 'session-A' },
    { mode: 'override', owner: 'override-C' },
    { mode: 'suppressed', owner: undefined },
  ])(
    'keeps async $mode writes in their owning context',
    async ({ mode, owner }) => {
      const logger = createDebugLogger();
      const log = async () => {
        logger.info('before await');
        await Promise.resolve();
        logger.info('after await');
      };
      await sessionIdContext.run('session-A', async () => {
        if (mode === 'override')
          await runWithDebugLogSession(
            { getSessionId: () => 'override-C' },
            log,
          );
        else if (mode === 'suppressed') await runWithoutDebugLogSession(log);
        else await log();
      });
      await vi.runAllTimersAsync();
      if (owner) {
        expect(
          vi.mocked(fs.appendFile).mock.calls.map(([file]) => file),
        ).toEqual([
          Storage.getDebugLogPath(owner),
          Storage.getDebugLogPath(owner),
        ]);
      } else {
        expect(fs.appendFile).not.toHaveBeenCalled();
        expect(fs.mkdir).not.toHaveBeenCalled();
      }
      vi.mocked(fs.appendFile).mockClear();
      logger.info('outside context');
      await vi.runAllTimersAsync();
      expect(fs.appendFile).toHaveBeenCalledExactlyOnceWith(
        Storage.getDebugLogPath('global-B'),
        expect.stringContaining('outside context'),
        'utf8',
      );
    },
  );

  it.each([undefined, '0', 'false'])(
    'requires log-file opt-in (%s)',
    async (setting) => {
      vi.stubEnv('QWEN_DEBUG_LOG_FILE', setting);
      createDebugLogger().info('private text');
      await vi.runAllTimersAsync();
      expect(fs.appendFile).not.toHaveBeenCalled();
    },
  );
});
