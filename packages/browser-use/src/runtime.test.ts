/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const installer = vi.hoisted(() => ({
  extensionInstalled: vi.fn(async () => true),
  install: vi.fn(async () => undefined),
  home: vi.fn(() => '/tmp/qwen-home'),
}));

vi.mock('./native-host-installer.js', () => ({
  isChromeExtensionInstalled: installer.extensionInstalled,
  installChromeNativeHost: installer.install,
  nativeHostInstallHome: installer.home,
}));

import { createBrowserBackend } from './runtime.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('createBrowserBackend', () => {
  it('checks extension installation before registering the Native Host', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    vi.stubEnv('QWEN_BROWSER_USE_SOCKET_PATH', '');

    await createBrowserBackend();

    expect(installer.extensionInstalled).toHaveBeenCalledWith({
      homeDir: '/tmp/qwen-home',
      nativeHostPath: expect.stringMatching(/native-host\.js$/),
    });
    expect(
      installer.extensionInstalled.mock.invocationCallOrder[0],
    ).toBeLessThan(installer.install.mock.invocationCallOrder[0]!);
    expect(installer.install).toHaveBeenCalledWith({
      homeDir: '/tmp/qwen-home',
      nativeHostPath: expect.stringMatching(/native-host\.js$/),
    });
    expect(installer.extensionInstalled).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits for Chrome to persist a freshly installed extension', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    vi.stubEnv('QWEN_BROWSER_USE_SOCKET_PATH', '');
    installer.extensionInstalled.mockResolvedValue(false);
    const pending = createBrowserBackend();

    await vi.advanceTimersByTimeAsync(10_999);

    expect(installer.install).not.toHaveBeenCalled();
    expect(installer.extensionInstalled).toHaveBeenCalledTimes(11);
    installer.extensionInstalled.mockResolvedValue(true);
    await vi.advanceTimersByTimeAsync(1);
    await pending;

    expect(installer.install).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports an undetected extension after 30 seconds without registering', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    vi.stubEnv('QWEN_BROWSER_USE_SOCKET_PATH', '');
    installer.extensionInstalled.mockResolvedValue(false);
    const pending = createBrowserBackend().catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(installer.extensionInstalled).toHaveBeenCalledTimes(30);
    expect(installer.install).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({
      message: expect.stringContaining(
        'Could not detect the Qwen Code Chrome extension after waiting 30 seconds. ' +
          'If you just installed it, wait a few seconds and retry Browser Use. ' +
          'If it is not installed, install it at chrome://extensions',
      ),
    });

    expect(installer.extensionInstalled).toHaveBeenCalledTimes(31);
    expect(installer.install).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('accepts an installation detected on the final check', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    vi.stubEnv('QWEN_BROWSER_USE_SOCKET_PATH', '');
    installer.extensionInstalled.mockResolvedValue(false);
    const pending = createBrowserBackend();

    await vi.advanceTimersByTimeAsync(29_999);
    installer.extensionInstalled.mockResolvedValue(true);
    await vi.advanceTimersByTimeAsync(1);
    await pending;

    expect(installer.install).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('propagates a read failure while retrying without registering', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    vi.stubEnv('QWEN_BROWSER_USE_SOCKET_PATH', '');
    installer.extensionInstalled
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error('read failed'));
    const pending = createBrowserBackend().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pending).toEqual(new Error('read failed'));

    expect(installer.install).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not register when extension detection fails', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    vi.stubEnv('QWEN_BROWSER_USE_SOCKET_PATH', '');
    installer.extensionInstalled.mockRejectedValueOnce(
      new Error('read failed'),
    );

    await expect(createBrowserBackend()).rejects.toThrow('read failed');
    expect(installer.install).not.toHaveBeenCalled();
  });

  it('does not install when a managed socket is configured', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    vi.stubEnv('QWEN_BROWSER_USE_SOCKET_PATH', '/tmp/managed.sock');

    await createBrowserBackend();

    expect(installer.extensionInstalled).not.toHaveBeenCalled();
    expect(installer.install).not.toHaveBeenCalled();
  });
});
