/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import nativeFs, * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSync } from 'esbuild';
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
import * as stdio from './stdioHelpers.js';
import { prepareFileWatchersForProcessExit } from '@qwen-code/qwen-code-core/utils/file-watcher-cleanup.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    statSync: vi.fn(actual.statSync),
    accessSync: vi.fn(actual.accessSync),
  };
});

vi.mock('@qwen-code/qwen-code-core/utils/file-watcher-cleanup.js', () => ({
  prepareFileWatchersForProcessExit: vi.fn(),
}));

describe('processUtils', () => {
  const processExit = vi
    .spyOn(process, 'exit')
    .mockReturnValue(undefined as never);
  const runExitCleanup = vi.spyOn(cleanup, 'runExitCleanup');
  const prepareWatchers = vi.mocked(prepareFileWatchersForProcessExit);
  const originalSend = process.send;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.statSync).mockReset().mockImplementation(nativeFs.statSync);
    vi.mocked(fs.accessSync)
      .mockReset()
      .mockImplementation(nativeFs.accessSync);
  });

  afterEach(() => {
    process.send = originalSend;
  });

  it('should run cleanup and exit with the relaunch code', async () => {
    await relaunchApp();
    expect(prepareWatchers).toHaveBeenCalledTimes(1);
    expect(runExitCleanup).toHaveBeenCalledTimes(1);
    expect(prepareWatchers.mock.invocationCallOrder[0]).toBeLessThan(
      runExitCleanup.mock.invocationCallOrder[0],
    );
    expect(runExitCleanup.mock.invocationCallOrder[0]).toBeLessThan(
      processExit.mock.invocationCallOrder[0],
    );
    expect(processExit).toHaveBeenCalledWith(RELAUNCH_EXIT_CODE);
  });

  it('prepares watchers once for each requested relaunch before its cleanup', async () => {
    await relaunchApp();
    await relaunchApp();
    expect(prepareWatchers).toHaveBeenCalledTimes(2);
    expect(runExitCleanup).toHaveBeenCalledTimes(2);
    for (const index of [0, 1]) {
      expect(prepareWatchers.mock.invocationCallOrder[index]).toBeLessThan(
        runExitCleanup.mock.invocationCallOrder[index],
      );
    }
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

  it.skipIf(
    process.platform === 'win32' || typeof process.execve !== 'function',
  )(
    'exits42 after cleanup when its real owned Node launcher was removed',
    () => {
      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), 'relaunch-node-'),
      );
      const launcher = path.join(directory, 'node');
      const marker = path.join(directory, 'cleanup');
      try {
        const artifact = path.join(directory, 'relaunch.mjs');
        const built = buildSync({
          stdin: {
            contents: `
              export { relaunchApp, superviseInProcess } from './processUtils.ts';
              export { registerCleanup } from './cleanup.ts';
            `,
            resolveDir: fileURLToPath(new URL('.', import.meta.url)),
            loader: 'js',
          },
          bundle: true,
          platform: 'node',
          format: 'esm',
          write: false,
          alias: {
            '@qwen-code/qwen-code-core/utils/file-watcher-cleanup.js':
              fileURLToPath(
                new URL(
                  '../../../core/src/utils/file-watcher-cleanup.ts',
                  import.meta.url,
                ),
              ),
            '@qwen-code/qwen-code-core/utils/textUtils.js': fileURLToPath(
              new URL('../../../core/src/utils/textUtils.ts', import.meta.url),
            ),
          },
          external: [
            fileURLToPath(
              new URL('./deferred-core-runtime.ts', import.meta.url),
            ),
          ],
        });
        expect(built.outputFiles[0].text).not.toContain(
          'deferred-core-runtime',
        );
        fs.writeFileSync(artifact, built.outputFiles[0].contents);
        const utils = pathToFileURL(artifact).href;
        fs.copyFileSync(process.execPath, launcher);
        fs.chmodSync(launcher, 0o755);
        const source = `
          import assert from 'node:assert/strict';
          import { realpathSync, unlinkSync, writeFileSync } from 'node:fs';
          import { relaunchApp, superviseInProcess, registerCleanup } from ${JSON.stringify(utils)};
          assert.equal(typeof process.execve, 'function');
          registerCleanup(() => writeFileSync(${JSON.stringify(marker)}, 'cleaned'));
          superviseInProcess(() => 0);
          assert.equal(realpathSync(process.execPath), realpathSync(${JSON.stringify(launcher)}));
          unlinkSync(process.execPath);
          await relaunchApp();
        `;
        const child = spawnSync(
          '/bin/sh',
          [
            '-c',
            'ulimit -c 0 && exec "$1" --input-type=module --eval "$2"',
            'owned-node',
            launcher,
            source,
          ],
          { encoding: 'utf8', timeout: 15000 },
        );
        expect(child.error).toBeUndefined();
        expect(child.signal).toBeNull();
        expect(child.status).toBe(RELAUNCH_EXIT_CODE);
        expect(fs.readFileSync(marker, 'utf8')).toBe('cleaned');
        expect(fs.existsSync(launcher)).toBe(false);
        expect(child.stderr).toContain('Failed to restart the CLI in place.');
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
    20000,
  );

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
      const stat = vi.mocked(fs.statSync);
      const access = vi.mocked(fs.accessSync);
      try {
        await relaunchApp();
        expect(stat).toHaveBeenCalledWith(process.execPath);
        expect(access).toHaveBeenCalledWith(
          process.execPath,
          fs.constants.X_OK,
        );
        expect(runExitCleanup.mock.invocationCallOrder[0]).toBeLessThan(
          stat.mock.invocationCallOrder[0],
        );
        expect(stat.mock.invocationCallOrder[0]).toBeLessThan(
          access.mock.invocationCallOrder[0],
        );
        expect(access.mock.invocationCallOrder[0]).toBeLessThan(
          execve.mock.invocationCallOrder[0],
        );
      } finally {
        stat.mockReset().mockImplementation(nativeFs.statSync);
        access.mockReset().mockImplementation(nativeFs.accessSync);
      }
      expect(prepareWatchers).toHaveBeenCalledTimes(1);
      expect(runExitCleanup).toHaveBeenCalledTimes(1);
      expect(prepareWatchers.mock.invocationCallOrder[0]).toBeLessThan(
        runExitCleanup.mock.invocationCallOrder[0],
      );
      expect(runExitCleanup.mock.invocationCallOrder[0]).toBeLessThan(
        execve.mock.invocationCallOrder[0],
      );
      expect(execve).toHaveBeenCalledWith(process.execPath, [
        process.execPath,
        ...process.execArgv,
        ...process.argv.slice(1),
      ]);
    });

    it('falls back to exit42 after a catchable JS exec exception without repeating cleanup', async () => {
      const errorLine = vi
        .spyOn(stdio, 'writeStderrLineSafe')
        .mockImplementation(() => {});
      execve.mockImplementationOnce(() => {
        throw new Error('owned exec failure');
      });
      try {
        await expect(relaunchApp()).resolves.toBeUndefined();
        expect(prepareWatchers).toHaveBeenCalledTimes(1);
        expect(runExitCleanup).toHaveBeenCalledTimes(1);
        expect(execve).toHaveBeenCalledTimes(1);
        expect(execve).toHaveBeenCalledWith(process.execPath, [
          process.execPath,
          ...getRelaunchExecArgv(),
          ...process.argv.slice(1),
        ]);
        expect(prepareWatchers.mock.invocationCallOrder[0]).toBeLessThan(
          runExitCleanup.mock.invocationCallOrder[0],
        );
        expect(runExitCleanup.mock.invocationCallOrder[0]).toBeLessThan(
          execve.mock.invocationCallOrder[0],
        );
        expect(errorLine).toHaveBeenCalledExactlyOnceWith(
          'Failed to restart the CLI in place. Exiting; restart manually if no supervisor is running.',
        );
        expect(errorLine.mock.invocationCallOrder[0]).toBeLessThan(
          processExit.mock.invocationCallOrder[0],
        );
        expect(processExit).toHaveBeenCalledExactlyOnceWith(RELAUNCH_EXIT_CODE);
      } finally {
        errorLine.mockRestore();
      }
    });

    it('falls back to exit42 after a catchable JS exec exception even when stderr throws', async () => {
      const stderrWrite = vi
        .spyOn(process.stderr, 'write')
        .mockImplementationOnce(() => {
          throw new Error('owned stderr failure');
        });
      execve.mockImplementationOnce(() => {
        throw new Error('owned exec failure');
      });
      try {
        await expect(relaunchApp()).resolves.toBeUndefined();
        expect(prepareWatchers).toHaveBeenCalledTimes(1);
        expect(runExitCleanup).toHaveBeenCalledTimes(1);
        expect(execve).toHaveBeenCalledTimes(1);
        expect(execve).toHaveBeenCalledWith(process.execPath, [
          process.execPath,
          ...getRelaunchExecArgv(),
          ...process.argv.slice(1),
        ]);
        expect(stderrWrite).toHaveBeenCalledTimes(1);
        expect(processExit).toHaveBeenCalledExactlyOnceWith(RELAUNCH_EXIT_CODE);
      } finally {
        stderrWrite.mockRestore();
      }
    });

    it.each(['missing', 'directory', 'not executable'])(
      'exits42 without exec for a launcher known to be %s',
      async (failure) => {
        const directory = fs.mkdtempSync(
          path.join(os.tmpdir(), 'relaunch-stat-'),
        );
        const stat = vi.mocked(fs.statSync);
        const access = vi.mocked(fs.accessSync);
        const errorLine = vi
          .spyOn(stdio, 'writeStderrLineSafe')
          .mockImplementation(() => {});
        try {
          if (failure === 'missing') {
            stat.mockImplementationOnce(() => {
              throw new Error('owned missing launcher');
            });
          } else if (failure === 'directory') {
            stat.mockReturnValueOnce(nativeFs.statSync(directory));
          } else {
            access.mockImplementationOnce(() => {
              throw new Error('owned permission failure');
            });
          }
          await relaunchApp();
          expect(prepareWatchers).toHaveBeenCalledOnce();
          expect(runExitCleanup).toHaveBeenCalledOnce();
          expect(runExitCleanup.mock.invocationCallOrder[0]).toBeLessThan(
            stat.mock.invocationCallOrder.at(-1)!,
          );
          expect(execve).not.toHaveBeenCalled();
          expect(errorLine).toHaveBeenCalledOnce();
          expect(processExit).toHaveBeenCalledExactlyOnceWith(
            RELAUNCH_EXIT_CODE,
          );
        } finally {
          stat.mockReset().mockImplementation(nativeFs.statSync);
          access.mockReset().mockImplementation(nativeFs.accessSync);
          errorLine.mockRestore();
          fs.rmSync(directory, { recursive: true, force: true });
        }
      },
    );

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
