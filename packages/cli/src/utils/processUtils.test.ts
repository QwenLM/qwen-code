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
  exitCleanly,
  getRelaunchExecArgv,
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

  describe('getRelaunchExecArgv', () => {
    const originalGc = globalThis.gc;
    const originalExecArgv = [...process.execArgv];

    afterEach(() => {
      globalThis.gc = originalGc;
      process.execArgv = [...originalExecArgv];
    });

    it('adds --expose-gc when gc was exposed at runtime', () => {
      process.execArgv = ['--trace-warnings'];
      globalThis.gc = vi.fn() as unknown as typeof globalThis.gc;
      expect(getRelaunchExecArgv()).toEqual([
        '--trace-warnings',
        '--expose-gc',
      ]);
    });

    it('does not repeat --expose-gc from the command line', () => {
      process.execArgv = ['--expose-gc'];
      globalThis.gc = vi.fn() as unknown as typeof globalThis.gc;
      expect(getRelaunchExecArgv()).toEqual(['--expose-gc']);
    });

    it('keeps the flags as they are when gc is not exposed', () => {
      process.execArgv = ['--trace-warnings'];
      globalThis.gc = undefined;
      expect(getRelaunchExecArgv()).toEqual(['--trace-warnings']);
    });
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

    it('keeps gc the launcher exposed at runtime across the restart', async () => {
      const originalGc = globalThis.gc;
      globalThis.gc = vi.fn() as unknown as typeof globalThis.gc;
      try {
        await relaunchApp();
        expect(execve).toHaveBeenCalledWith(process.execPath, [
          process.execPath,
          ...process.execArgv,
          '--expose-gc',
          ...process.argv.slice(1),
        ]);
      } finally {
        globalThis.gc = originalGc;
      }
    });

    it('runs the update here and exits with its code', async () => {
      await relaunchForUpdate();
      expect(runExitCleanup).toHaveBeenCalledTimes(1);
      expect(onUpdateRelaunch).toHaveBeenCalledWith(true);
      expect(processExit).toHaveBeenCalledWith(44);
    });

    it('exits without updating when no update was requested', async () => {
      await exitCleanly(0);
      expect(onUpdateRelaunch).not.toHaveBeenCalled();
      expect(processExit).toHaveBeenCalledWith(0);
    });

    it('keeps a requested update for a clean exit only', async () => {
      expect(requestUpdateOnExit()).toBe(true);
      await exitCleanly(130);
      expect(onUpdateRelaunch).not.toHaveBeenCalled();
      expect(processExit).toHaveBeenCalledWith(130);
    });

    it('installs the kept update once, after the first clean exit', async () => {
      let finishInstall!: (code: number) => void;
      onUpdateRelaunch.mockImplementationOnce(
        () =>
          new Promise<number>((resolve) => {
            finishInstall = resolve;
          }),
      );
      const firstExit = exitCleanly(0);
      void exitCleanly(0);
      expect(onUpdateRelaunch).toHaveBeenCalledWith(false);
      expect(processExit).not.toHaveBeenCalled();

      finishInstall(44);
      await firstExit;
      expect(onUpdateRelaunch).toHaveBeenCalledTimes(1);
      expect(processExit).toHaveBeenCalledTimes(1);
      expect(processExit).toHaveBeenCalledWith(44);
    });
  });
});
