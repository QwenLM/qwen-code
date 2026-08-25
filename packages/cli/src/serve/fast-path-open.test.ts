/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const originalQwenHome = process.env['QWEN_HOME'];
const originalSystemSettingsPath =
  process.env['QWEN_CODE_SYSTEM_SETTINGS_PATH'];
const originalSystemDefaultsPath =
  process.env['QWEN_CODE_SYSTEM_DEFAULTS_PATH'];
const originalTrustedFoldersPath =
  process.env['QWEN_CODE_TRUSTED_FOLDERS_PATH'];
const originalServerToken = process.env['QWEN_SERVER_TOKEN'];

describe('serve fast path --open import boundary', () => {
  let tempQwenHome: string | undefined;

  function useTempQwenHome(): void {
    tempQwenHome = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-fast-path-open-')),
    );
    process.env['QWEN_HOME'] = tempQwenHome;
    process.env['QWEN_CODE_SYSTEM_SETTINGS_PATH'] = path.join(
      tempQwenHome,
      'system-settings.json',
    );
    process.env['QWEN_CODE_SYSTEM_DEFAULTS_PATH'] = path.join(
      tempQwenHome,
      'system-defaults.json',
    );
    process.env['QWEN_CODE_TRUSTED_FOLDERS_PATH'] = path.join(
      tempQwenHome,
      'trustedFolders.json',
    );
  }

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('./run-qwen-serve.js');
    vi.doUnmock('../commands/serve.js');
    vi.doUnmock('./open-with-auth.js');
    vi.resetModules();
    if (originalQwenHome === undefined) {
      delete process.env['QWEN_HOME'];
    } else {
      process.env['QWEN_HOME'] = originalQwenHome;
    }
    if (originalSystemSettingsPath === undefined) {
      delete process.env['QWEN_CODE_SYSTEM_SETTINGS_PATH'];
    } else {
      process.env['QWEN_CODE_SYSTEM_SETTINGS_PATH'] =
        originalSystemSettingsPath;
    }
    if (originalSystemDefaultsPath === undefined) {
      delete process.env['QWEN_CODE_SYSTEM_DEFAULTS_PATH'];
    } else {
      process.env['QWEN_CODE_SYSTEM_DEFAULTS_PATH'] =
        originalSystemDefaultsPath;
    }
    if (originalTrustedFoldersPath === undefined) {
      delete process.env['QWEN_CODE_TRUSTED_FOLDERS_PATH'];
    } else {
      process.env['QWEN_CODE_TRUSTED_FOLDERS_PATH'] =
        originalTrustedFoldersPath;
    }
    if (originalServerToken === undefined) {
      delete process.env['QWEN_SERVER_TOKEN'];
    } else {
      process.env['QWEN_SERVER_TOKEN'] = originalServerToken;
    }
    if (tempQwenHome) {
      fs.rmSync(tempQwenHome, { recursive: true, force: true });
      tempQwenHome = undefined;
    }
  });

  it('defers importing the full serve command opener until runtime is ready', async () => {
    useTempQwenHome();

    let resolveRuntime: (() => void) | undefined;
    const runtimeReady = new Promise<void>((resolve) => {
      resolveRuntime = resolve;
    });
    const runQwenServe = vi.fn(async (_options: unknown, _deps?: unknown) => ({
      runtimeReady,
      close: vi.fn().mockResolvedValue(undefined),
    }));
    let serveCommandImported = false;
    const openBrowser = vi.fn(async () => undefined);
    vi.doMock('./run-qwen-serve.js', () => ({ runQwenServe }));
    vi.doMock('../commands/serve.js', () => {
      serveCommandImported = true;
      return { maybeOpenWebShellBrowser: openBrowser };
    });

    const { tryRunServeFastPath } = await import('./fast-path.js');
    void tryRunServeFastPath([
      'serve',
      '--port',
      '0',
      '--hostname',
      '127.0.0.1',
      '--open',
      '--no-web',
    ]);

    await vi.waitFor(() => expect(runQwenServe).toHaveBeenCalledTimes(1));
    expect(runQwenServe).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ deferRuntimeUntilFirstHealth: false }),
    );
    await Promise.resolve();
    expect(serveCommandImported).toBe(false);

    resolveRuntime?.();
    await vi.waitFor(() => expect(openBrowser).toHaveBeenCalledTimes(1));
    expect(serveCommandImported).toBe(true);
  });

  it('does not import the authenticated-open helper for bare --open', async () => {
    useTempQwenHome();

    const runtimeReady = new Promise<void>(() => undefined);
    const runQwenServe = vi.fn(
      async (_options: { token?: string }, _deps?: unknown) => ({
        runtimeReady,
        close: vi.fn().mockResolvedValue(undefined),
      }),
    );
    let openWithAuthImported = false;
    vi.doMock('./run-qwen-serve.js', () => ({ runQwenServe }));
    vi.doMock('./open-with-auth.js', () => {
      openWithAuthImported = true;
      return { applyOpenWithAuth: vi.fn() };
    });

    const { tryRunServeFastPath } = await import('./fast-path.js');
    void tryRunServeFastPath(['serve', '--open', '--no-web']);

    await vi.waitFor(() => expect(runQwenServe).toHaveBeenCalledTimes(1));
    expect(openWithAuthImported).toBe(false);
  });

  it('applies authenticated open before starting the daemon', async () => {
    useTempQwenHome();

    const runtimeReady = new Promise<void>(() => undefined);
    let tokenAtBoot: string | undefined;
    const runQwenServe = vi.fn(
      async (options: { token?: string }, _deps?: unknown) => {
        tokenAtBoot = options.token;
        return {
          runtimeReady,
          close: vi.fn().mockResolvedValue(undefined),
        };
      },
    );
    const applyOpenWithAuth = vi.fn((options: { token?: string }) => {
      options.token = 'generated-token';
    });
    vi.doMock('./run-qwen-serve.js', () => ({ runQwenServe }));
    vi.doMock('./open-with-auth.js', () => ({
      applyOpenWithAuth,
    }));

    const { tryRunServeFastPath } = await import('./fast-path.js');
    void tryRunServeFastPath(['serve', '--open-with-auth']);

    await vi.waitFor(() => expect(runQwenServe).toHaveBeenCalledTimes(1));
    expect(applyOpenWithAuth).toHaveBeenCalledOnce();
    expect(tokenAtBoot).toBe('generated-token');
    expect(runQwenServe).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ deferRuntimeUntilFirstHealth: false }),
    );
  });

  it('loads settings environment before applying authenticated open', async () => {
    useTempQwenHome();
    fs.writeFileSync(
      path.join(tempQwenHome!, 'settings.json'),
      JSON.stringify({ env: { QWEN_SERVER_TOKEN: 'from-settings' } }),
    );
    delete process.env['QWEN_SERVER_TOKEN'];

    const runtimeReady = new Promise<void>(() => undefined);
    const runQwenServe = vi.fn(
      async (_options: { token?: string }, _deps?: unknown) => ({
        runtimeReady,
        close: vi.fn().mockResolvedValue(undefined),
      }),
    );
    const applyOpenWithAuth = vi.fn(() => {
      expect(process.env['QWEN_SERVER_TOKEN']).toBe('from-settings');
    });
    vi.doMock('./run-qwen-serve.js', () => ({ runQwenServe }));
    vi.doMock('./open-with-auth.js', () => ({
      applyOpenWithAuth,
    }));

    const { tryRunServeFastPath } = await import('./fast-path.js');
    void tryRunServeFastPath(['serve', '--open-with-auth']);

    await vi.waitFor(() => expect(runQwenServe).toHaveBeenCalledTimes(1));
    expect(applyOpenWithAuth).toHaveBeenCalledOnce();
  });

  it('exits before listen when authenticated-open preparation fails', async () => {
    useTempQwenHome();

    const runQwenServe = vi.fn();
    vi.doMock('./run-qwen-serve.js', () => ({ runQwenServe }));
    vi.doMock('./open-with-auth.js', () => ({
      applyOpenWithAuth: vi.fn(() => {
        throw new Error('--open-with-auth requires a loopback --hostname.');
      }),
    }));
    const stderrWrites: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrWrites.push(String(chunk));
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation(((code) => {
      throw new Error(`process.exit ${code}`);
    }) as typeof process.exit);

    const { tryRunServeFastPath } = await import('./fast-path.js');
    await expect(
      tryRunServeFastPath(['serve', '--open-with-auth']),
    ).rejects.toThrow('process.exit 1');

    expect(runQwenServe).not.toHaveBeenCalled();
    expect(stderrWrites.join('')).toContain(
      '--open-with-auth requires a loopback --hostname.',
    );
  });

  it('forwards authenticated manual fallback to the browser opener', async () => {
    useTempQwenHome();

    const handle = {
      runtimeReady: Promise.resolve(),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const runQwenServe = vi.fn(async () => handle);
    const openBrowser = vi.fn(async () => undefined);
    vi.doMock('./run-qwen-serve.js', () => ({ runQwenServe }));
    vi.doMock('./open-with-auth.js', () => ({
      applyOpenWithAuth: vi.fn(),
    }));
    vi.doMock('../commands/serve.js', () => ({
      maybeOpenWebShellBrowser: openBrowser,
    }));

    const { tryRunServeFastPath } = await import('./fast-path.js');
    void tryRunServeFastPath(['serve', '--open-with-auth']);

    await vi.waitFor(() =>
      expect(openBrowser).toHaveBeenCalledWith(handle, true, true),
    );
  });

  it('skips importing the full serve command opener when runtime startup fails', async () => {
    useTempQwenHome();

    let rejectRuntime: ((err: Error) => void) | undefined;
    const runtimeReady = new Promise<void>((_resolve, reject) => {
      rejectRuntime = reject;
    });
    const close = vi.fn().mockResolvedValue(undefined);
    const runQwenServe = vi.fn(async () => ({
      runtimeReady,
      close,
    }));
    let serveCommandImported = false;
    const openBrowser = vi.fn(async () => undefined);
    vi.doMock('./run-qwen-serve.js', () => ({ runQwenServe }));
    vi.doMock('../commands/serve.js', () => {
      serveCommandImported = true;
      return { maybeOpenWebShellBrowser: openBrowser };
    });
    vi.spyOn(process, 'exit').mockImplementation(((code) => {
      throw new Error(`process.exit ${code}`);
    }) as typeof process.exit);

    const { tryRunServeFastPath } = await import('./fast-path.js');
    const fastPathPromise = tryRunServeFastPath([
      'serve',
      '--port',
      '0',
      '--hostname',
      '127.0.0.1',
      '--open',
      '--no-web',
    ]);

    await vi.waitFor(() => expect(runQwenServe).toHaveBeenCalledTimes(1));
    expect(runQwenServe).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ deferRuntimeUntilFirstHealth: false }),
    );
    await Promise.resolve();
    expect(serveCommandImported).toBe(false);

    rejectRuntime?.(new Error('runtime boom'));
    await expect(fastPathPromise).rejects.toThrow('process.exit 1');
    expect(openBrowser).not.toHaveBeenCalled();
    expect(serveCommandImported).toBe(false);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
