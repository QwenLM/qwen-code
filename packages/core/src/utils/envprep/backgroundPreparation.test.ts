/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
vi.mock('../paths.js', () => ({
  getConfigHomeDir: vi.fn(),
}));
vi.mock('../windowsExecutableProbe.js', () => ({
  runWindowsExecutableProbe: vi.fn(async () => ''),
}));
vi.mock('./validation.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./validation.js')>();
  // Installer fixtures contain fake binaries; functional validation has its own tests.
  return {
    ...actual,
    validateGitBashInstallation: actual.validateGitBashFiles,
  };
});

import { Downloader } from '../downloader.js';
import { getConfigHomeDir } from '../paths.js';
import { getGitBashPreparationState } from './index.js';
import { runWindowsExecutableProbe } from '../windowsExecutableProbe.js';
import { ENV_BASH_PATH, ENV_GIT_BASH_PATH } from '../../config/brand.js';
import { scheduleBackgroundPreparation } from './backgroundPreparation.js';
import { PrepareManager } from './manager.js';
import { Extractor } from './extractor.js';
import { SevenZrPreparer } from './sevenZrPreparer.js';
import { LockManager } from './lock.js';
import { GitBashPreparer } from './gitBashPreparer.js';
import { getWindowsEnvironmentUrls } from './urls.js';
import type { WindowsEnvironmentUrls } from './types.js';

const CRITICAL_GIT_FILES = [
  'bin/bash.exe',
  'usr/bin/msys-2.0.dll',
  'usr/bin/msys-intl-8.dll',
  'cmd/git.exe',
];

describe('scheduleBackgroundPreparation', () => {
  let baseDir: string;
  let gitDir: string;
  let stop: (() => Promise<void>) | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-envprep-'));
    gitDir = path.join(baseDir, 'bin', 'git');
    vi.mocked(getConfigHomeDir).mockReturnValue(baseDir);
  });

  afterEach(async () => {
    await stop?.();
    stop = undefined;
    vi.useRealTimers();
    fs.rmSync(baseDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('sets succeeded immediately when managed Git already validates', () => {
    for (const relPath of CRITICAL_GIT_FILES) {
      const fullPath = path.join(gitDir, relPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, 'fake');
    }

    stop = scheduleBackgroundPreparation();

    expect(getGitBashPreparationState()).toEqual({
      status: 'succeeded',
      bashPath: path.join(gitDir, 'bin', 'bash.exe'),
    });
  });

  it.each([
    undefined,
    {
      gitBashPrimaryUrl: 'https://example.com/PortableGit.7z.exe',
      gitBashFallbackUrl: 'https://example.com/fallback/PortableGit.7z.exe',
      sevenZrPrimaryUrl: 'https://example.com/7zr.exe',
      sevenZrFallbackUrl: 'https://example.com/fallback/7zr.exe',
    },
  ] satisfies Array<WindowsEnvironmentUrls | undefined>)(
    'installs 7zr before Git with the selected sources (%s)',
    async (sources) => {
      vi.spyOn(SevenZrPreparer.prototype, 'isRequired').mockResolvedValue(true);
      vi.spyOn(GitBashPreparer.prototype, 'isRequired').mockResolvedValue(true);
      const download = vi
        .spyOn(Downloader.prototype, 'download')
        .mockImplementation(async (_url, destination) => {
          fs.writeFileSync(destination, Buffer.alloc(128 * 1024, 1));
        });
      vi.spyOn(Extractor.prototype, 'extract').mockImplementation(
        async (_archive, destination) => {
          for (const file of CRITICAL_GIT_FILES) {
            const target = path.join(destination, file);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, 'extracted file');
          }
        },
      );

      stop = scheduleBackgroundPreparation(sources);
      await vi.advanceTimersByTimeAsync(2000);

      const urls = sources ?? getWindowsEnvironmentUrls();
      expect(download.mock.calls.map(([url]) => url)).toEqual([
        urls.sevenZrPrimaryUrl,
        urls.gitBashPrimaryUrl,
      ]);
      expect(getGitBashPreparationState()).toEqual({
        status: 'succeeded',
        bashPath: path.join(gitDir, 'bin', 'bash.exe'),
      });
      expect(fs.existsSync(path.join(gitDir, 'cmd', 'git.exe'))).toBe(true);
      expect(fs.readdirSync(path.join(baseDir, 'bin', '.locks'))).toEqual([]);
    },
  );

  it('transitions from running to succeeded', async () => {
    vi.spyOn(PrepareManager.prototype, 'prepareAll').mockResolvedValue({
      ok: true,
    });

    stop = scheduleBackgroundPreparation();
    expect(getGitBashPreparationState().status).toBe('running');

    await vi.runOnlyPendingTimersAsync();

    expect(getGitBashPreparationState()).toEqual({
      status: 'succeeded',
      bashPath: path.join(gitDir, 'bin', 'bash.exe'),
    });
  });

  it('transitions from running to failed', async () => {
    vi.spyOn(PrepareManager.prototype, 'prepareAll').mockResolvedValue({
      ok: false,
      component: 'git-bash',
      error: 'network failed',
    });

    stop = scheduleBackgroundPreparation();
    expect(getGitBashPreparationState().status).toBe('running');

    await vi.runOnlyPendingTimersAsync();

    expect(getGitBashPreparationState()).toEqual({
      status: 'failed',
      lastError: 'network failed',
    });
  });

  it('settles delayed preparation without starting it during cleanup', async () => {
    const prepare = vi.spyOn(PrepareManager.prototype, 'prepareAll');
    stop = scheduleBackgroundPreparation();
    const state = getGitBashPreparationState();
    if (state.status !== 'running')
      throw new Error('preparation did not start');
    let settled = false;
    void state.promise.then(() => {
      settled = true;
    });

    await stop();
    expect(settled).toBe(true);
    await expect(state.promise).resolves.toMatchObject({ ok: false });
    await vi.runOnlyPendingTimersAsync();
    expect(prepare).not.toHaveBeenCalled();
  });

  it('waits for an active installer to finish before detaching its state', async () => {
    let finish!: () => void;
    vi.spyOn(PrepareManager.prototype, 'prepareAll').mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ ok: true });
        }),
    );
    stop = scheduleBackgroundPreparation();
    await vi.advanceTimersByTimeAsync(2000);
    const disposing = stop();
    expect(getGitBashPreparationState().status).toBe('running');
    finish();
    await disposing;
    expect(getGitBashPreparationState().status).toBe('idle');
  });

  it('cancels the delay as soon as the parent signal aborts, before cleanup', async () => {
    const parent = new AbortController();
    const prepare = vi.spyOn(PrepareManager.prototype, 'prepareAll');
    stop = scheduleBackgroundPreparation(undefined, parent.signal);
    const state = getGitBashPreparationState();
    if (state.status !== 'running')
      throw new Error('preparation did not start');
    const reason = new Error('startup cancelled');

    parent.abort(reason);
    await expect(state.promise).resolves.toEqual({
      ok: false,
      error: reason.message,
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(prepare).not.toHaveBeenCalled();
    expect(getGitBashPreparationState()).toEqual({
      status: 'failed',
      lastError: reason.message,
    });
  });

  it('aborts an active installer immediately and waits for it to stop before unregistering', async () => {
    const parent = new AbortController();
    let installerSignal: AbortSignal | undefined;
    let finish!: () => void;
    vi.spyOn(PrepareManager.prototype, 'prepareAll').mockImplementation(
      (signal) => {
        installerSignal = signal;
        return new Promise((resolve) => {
          finish = () => resolve({ ok: true });
        });
      },
    );
    stop = scheduleBackgroundPreparation(undefined, parent.signal);
    await vi.advanceTimersByTimeAsync(2000);
    const reason = new Error('startup cancelled during installation');

    parent.abort(reason);
    expect(installerSignal?.aborted).toBe(true);
    expect(installerSignal?.reason).toBe(reason);
    const closing = stop();
    expect(getGitBashPreparationState().status).toBe('running');
    finish();
    await closing;
    expect(getGitBashPreparationState()).toEqual({ status: 'idle' });
  });

  it('rejects an already aborted parent without registering state', () => {
    const parent = new AbortController();
    parent.abort(new Error('already stopped'));
    expect(() =>
      scheduleBackgroundPreparation(undefined, parent.signal),
    ).toThrow(parent.signal.reason);
    expect(getGitBashPreparationState()).toEqual({ status: 'idle' });
  });

  it('removes the parent abort listener during cleanup', async () => {
    const parent = new AbortController();
    const add = vi.spyOn(parent.signal, 'addEventListener');
    const remove = vi.spyOn(parent.signal, 'removeEventListener');
    stop = scheduleBackgroundPreparation(undefined, parent.signal);
    const handler = add.mock.calls[0][1];
    expect(add).toHaveBeenCalledExactlyOnceWith('abort', handler, {
      once: true,
    });

    await stop();
    expect(remove).toHaveBeenCalledExactlyOnceWith('abort', handler);
  });

  it('does not keep one-shot processes alive while preparation is delayed', () => {
    const timeout = setTimeout(() => undefined, 2000);
    const unref = vi.spyOn(timeout, 'unref');
    vi.spyOn(globalThis, 'setTimeout').mockReturnValue(timeout);

    stop = scheduleBackgroundPreparation();

    expect(unref).toHaveBeenCalledOnce();
  });
});

describe('GitBashPreparer', () => {
  const managedEnvNames = [
    ENV_GIT_BASH_PATH,
    ENV_BASH_PATH,
    'GIT_BASH',
    'BASH_PATH',
  ] as const;
  const originalEnv = new Map(
    managedEnvNames.map((name) => [name, process.env[name]]),
  );
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-git-bash-'));
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    for (const name of managedEnvNames) delete process.env[name];
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    for (const [name, value] of originalEnv) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  it.each(['download', 'probe', 'probe-eof', 'probe-timeout'] as const)(
    'cancels preparation during %s without starting fallback or installing',
    async (stage) => {
      const controller = new AbortController();
      const preparer = new GitBashPreparer(tempDir);
      // Exercise the real manager -> download -> extractor -> probe chain.
      vi.spyOn(preparer, 'isRequired').mockResolvedValue(true);
      let finishDownload!: () => void;
      let finishProbe: ((value: string) => void) | undefined;
      let abortProbe!: () => void;
      let probeStarted = false;
      let downloadCount = 0;
      const download = vi
        .spyOn(Downloader.prototype, 'download')
        .mockImplementation(async (_url, destination) => {
          fs.writeFileSync(destination, 'archive');
          downloadCount++;
          if (stage === 'download' && downloadCount === 1)
            await new Promise<void>((resolve) => {
              finishDownload = resolve;
            });
        });
      const probe = vi
        .mocked(runWindowsExecutableProbe)
        .mockReset()
        .mockResolvedValue('');
      probe.mockImplementationOnce(async (_name, signal) => {
        probeStarted = true;
        return new Promise<string>((resolve, reject) => {
          finishProbe = resolve;
          abortProbe = () =>
            reject(
              stage === 'probe-timeout'
                ? new DOMException('where.exe 7z timed out', 'TimeoutError')
                : new DOMException('Input closed', 'AbortError'),
            );
          signal?.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        });
      });
      const manager = new PrepareManager(tempDir);
      manager.registerPreparer(preparer);
      let settled = false;
      const outcome = manager.prepareAll(controller.signal).then(
        (value) => {
          settled = true;
          return value;
        },
        (error) => {
          settled = true;
          return error;
        },
      );
      try {
        await vi.waitFor(() =>
          expect(
            stage === 'download' ? finishDownload : probeStarted,
          ).toBeTruthy(),
        );
        if (stage === 'probe-eof' || stage === 'probe-timeout') abortProbe();
        else controller.abort();
        finishDownload?.();
        await vi.waitFor(() => expect(settled).toBe(true), { timeout: 500 });
        expect(await outcome).toMatchObject(
          stage === 'probe-timeout'
            ? { ok: false, error: 'where.exe 7z timed out' }
            : stage === 'probe-eof'
              ? { ok: false, error: 'Input closed' }
              : { name: 'AbortError' },
        );
        expect(download).toHaveBeenCalledTimes(1);
        if (stage === 'download') expect(probe).not.toHaveBeenCalled();
        expect(fs.existsSync(preparer.getEnvironment().installPath)).toBe(
          false,
        );
        expect(
          fs.existsSync(path.join(tempDir, '.locks', 'git-bash.lock')),
        ).toBe(false);
      } finally {
        finishDownload?.();
        finishProbe?.('');
        await outcome;
        probe.mockReset().mockResolvedValue('');
      }
    },
  );

  it.each(['git', '7z'] as const)(
    'does not treat a %s requirement probe timeout as a missing installation',
    async (target) => {
      const error = new DOMException(
        `where.exe ${target} timed out`,
        'TimeoutError',
      );
      const probe = vi
        .mocked(runWindowsExecutableProbe)
        .mockRejectedValue(error);
      const download = vi
        .spyOn(Downloader.prototype, 'download')
        .mockRejectedValue(new Error('must not download'));
      const manager = new PrepareManager(tempDir);
      manager.registerPreparer(
        target === 'git'
          ? new GitBashPreparer(tempDir)
          : new SevenZrPreparer(tempDir),
      );
      try {
        await expect(manager.prepareAll()).rejects.toBe(error);
        expect(download).not.toHaveBeenCalled();
      } finally {
        probe.mockReset().mockResolvedValue('');
      }
    },
  );

  it('retains fallback download and installation after an ordinary primary failure', async () => {
    const download = vi
      .spyOn(Downloader.prototype, 'download')
      .mockRejectedValueOnce(new Error('primary unavailable'))
      .mockImplementation(async (_url, destination) => {
        fs.writeFileSync(destination, 'archive');
      });
    vi.spyOn(Extractor.prototype, 'extract').mockImplementation(
      async (_archive, destination) => {
        for (const file of CRITICAL_GIT_FILES) {
          const target = path.join(destination, file);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, 'extracted file');
        }
      },
    );
    const preparer = new GitBashPreparer(tempDir);
    await preparer.prepare();
    expect(download).toHaveBeenCalledTimes(2);
    expect(preparer.isInstalled()).toBe(true);
  });

  it('cleans up a cancelled 7zr download without trying the fallback', async () => {
    const controller = new AbortController();
    const download = vi
      .spyOn(Downloader.prototype, 'download')
      .mockImplementation(async (_url, destination, signal) => {
        fs.writeFileSync(destination, 'partial download');
        controller.abort();
        signal?.throwIfAborted();
      });
    await expect(
      new SevenZrPreparer(tempDir).prepare(controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(download).toHaveBeenCalledOnce();
    expect(fs.readdirSync(tempDir)).toEqual([]);
  });

  it('does not let a script wrapper suppress managed Git Bash preparation', async () => {
    const wrapperPath = path.join(tempDir, 'bash.cmd');
    fs.writeFileSync(wrapperPath, '@echo off');
    process.env[ENV_GIT_BASH_PATH] = wrapperPath;

    const preparer = new GitBashPreparer(path.join(tempDir, 'managed-git'));

    await expect(preparer.isRequired()).resolves.toBe(true);
  });

  it('still accepts a native executable as an installed system shell', async () => {
    const nativePath = path.join(tempDir, 'bash.exe');
    fs.writeFileSync(nativePath, 'fake executable');
    process.env[ENV_GIT_BASH_PATH] = nativePath;

    const preparer = new GitBashPreparer(path.join(tempDir, 'managed-git'));

    await expect(preparer.isRequired()).resolves.toBe(false);
  });
});

describe('PrepareManager asynchronous requirements', () => {
  it('cancels a lock wait without installing or removing the other owner lock', async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-prep-lock-'));
    const owner = new LockManager(baseDir).acquireLock('git-bash');
    const manager = new PrepareManager(baseDir);
    const preparer = new GitBashPreparer(baseDir);
    vi.spyOn(preparer, 'isRequired').mockResolvedValue(true);
    const prepare = vi.spyOn(preparer, 'prepare');
    manager.registerPreparer(preparer);
    const controller = new AbortController();
    try {
      const pending = manager.prepareAll(controller.signal);
      await Promise.resolve(); // Let the manager enter the lock wait.
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      expect(prepare).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(baseDir, '.locks', 'git-bash.lock'))).toBe(
        true,
      );
    } finally {
      owner.release();
      vi.restoreAllMocks();
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it('does not install a component that an asynchronous probe says is unnecessary', async () => {
    const baseDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'qwen-prep-manager-'),
    );
    try {
      const manager = new PrepareManager(baseDir);
      manager.registerPreparer({
        name: () => 'unused',
        isRequired: async () => false,
        isInstalled: () => false,
        prepare: async () => {
          throw new Error('must not install');
        },
        getEnvironment: () => {
          throw new Error('unused');
        },
      });
      await expect(manager.prepareAll()).resolves.toEqual({ ok: true });
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
