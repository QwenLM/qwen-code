/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeAll, beforeEach, vi } from 'vitest';
import {
  RELAUNCH_EXIT_CODE,
  UPDATE_ON_EXIT_MESSAGE,
  UPDATE_RELAUNCH_EXIT_CODE,
  relaunchApp,
  relaunchForUpdate,
  requestUpdateOnExit,
  superviseInProcess,
} from './processUtils.js';
import * as cleanup from './cleanup.js';

describe('processUtils', () => {
  const processExit = vi
    .spyOn(process, 'exit')
    .mockReturnValue(undefined as never);
  const runExitCleanup = vi.spyOn(cleanup, 'runExitCleanup');
  const originalSend = process.send;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.send = originalSend;
  });

  it('should run cleanup and exit with the relaunch code', async () => {
    await relaunchApp();
    expect(runExitCleanup).toHaveBeenCalledTimes(1);
    expect(processExit).toHaveBeenCalledWith(RELAUNCH_EXIT_CODE);
  });

  it('should run cleanup and exit with the update relaunch code', async () => {
    await relaunchForUpdate();
    expect(runExitCleanup).toHaveBeenCalledTimes(1);
    expect(processExit).toHaveBeenCalledWith(UPDATE_RELAUNCH_EXIT_CODE);
  });

  it('requests a deferred update from the parent process', () => {
    const send = vi.fn();
    process.send = send;

    expect(requestUpdateOnExit()).toBe(true);
    expect(send).toHaveBeenCalledWith({ type: UPDATE_ON_EXIT_MESSAGE });
  });

  it('does not request a deferred update without a parent process', () => {
    process.send = undefined;

    expect(requestUpdateOnExit()).toBe(false);
  });

  // Last: superviseInProcess switches module state for the rest of the file.
  describe('without a supervising parent', () => {
    const onUpdateRelaunch = vi.fn().mockResolvedValue(44);
    const execve = vi.fn();
    const originalExecve = process.execve;

    beforeAll(() => {
      superviseInProcess(onUpdateRelaunch);
    });

    beforeEach(() => {
      process.execve = execve as unknown as typeof process.execve;
    });

    afterEach(() => {
      process.execve = originalExecve;
    });

    it('re-execs this process in place after cleanup', async () => {
      await relaunchApp();
      expect(runExitCleanup).toHaveBeenCalledTimes(1);
      expect(execve).toHaveBeenCalledWith(process.execPath, [
        process.execPath,
        ...process.execArgv,
        ...process.argv.slice(1),
      ]);
    });

    it('runs the update here and exits with its code', async () => {
      await relaunchForUpdate();
      expect(runExitCleanup).toHaveBeenCalledTimes(1);
      expect(onUpdateRelaunch).toHaveBeenCalledWith(true);
      expect(processExit).toHaveBeenCalledWith(44);
    });
  });
});
