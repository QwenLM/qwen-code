/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const installer = vi.hoisted(() => ({
  extensionInstalled: vi.fn(async () => true),
  ensure: vi.fn(async () => ({
    launcherPath: '/tmp/qwen-home/.qwen/browser-use/host.sh',
    manifestPaths: [] as string[],
    installedPaths: [] as string[],
    ready: true,
    skippedForeignPaths: [] as string[],
  })),
  home: vi.fn(() => '/tmp/qwen-home'),
}));

vi.mock('./native-host-installer.js', () => ({
  isChromeExtensionInstalled: installer.extensionInstalled,
  ensureChromeNativeHost: installer.ensure,
  describeChromeProfiles: vi.fn(async () => new Map()),
  nativeHostInstallHome: installer.home,
}));

import { createBrowserBackend } from './runtime.js';

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv('QWEN_BROWSER_USE_DISCOVERY_DIR', '');
});

afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('createBrowserBackend', () => {
  it('sets up the Host when managed endpoint overrides contain only whitespace', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    vi.stubEnv('QWEN_BROWSER_USE_SOCKET_PATH', ' \t ');
    vi.stubEnv('QWEN_BROWSER_USE_DISCOVERY_DIR', ' \t ');
    await createBrowserBackend();
    expect(installer.ensure).toHaveBeenCalledOnce();
  });
  it('reports a Chrome without any profile root instead of timing out later', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    vi.stubEnv('QWEN_BROWSER_USE_SOCKET_PATH', '');
    installer.ensure.mockResolvedValue({
      ...(await installer.ensure()),
      ready: false,
    });
    await expect(createBrowserBackend()).rejects.toThrow(
      /could not register its Native Host.*Start Chrome once/,
    );
  });

  it('surfaces a refused downgrade of a newer installed Host', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    vi.stubEnv('QWEN_BROWSER_USE_SOCKET_PATH', '');
    installer.ensure.mockRejectedValueOnce(
      new Error('The installed Browser Use Native Host speaks protocol 4'),
    );
    await expect(createBrowserBackend()).rejects.toThrow(/protocol 4/);
  });

  it('checks extension installation before setting up the Native Host', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    vi.stubEnv('QWEN_BROWSER_USE_SOCKET_PATH', '');
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    await createBrowserBackend();

    expect(stderr).not.toHaveBeenCalled();

    expect(installer.extensionInstalled).toHaveBeenCalledWith({
      homeDir: '/tmp/qwen-home',
      nativeHostPath: expect.stringMatching(/native-host\.js$/),
    });
    expect(
      installer.extensionInstalled.mock.invocationCallOrder[0],
    ).toBeLessThan(installer.ensure.mock.invocationCallOrder[0]!);
    expect(installer.ensure).toHaveBeenCalledWith({
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

    expect(installer.ensure).not.toHaveBeenCalled();
    expect(installer.extensionInstalled).toHaveBeenCalledTimes(11);
    installer.extensionInstalled.mockResolvedValue(true);
    await vi.advanceTimersByTimeAsync(1);
    await pending;

    expect(installer.ensure).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports an undetected extension after 30 seconds without setting up the Host', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    vi.stubEnv('QWEN_BROWSER_USE_SOCKET_PATH', '');
    installer.extensionInstalled.mockResolvedValue(false);
    const pending = createBrowserBackend().catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(installer.extensionInstalled).toHaveBeenCalledTimes(30);
    expect(installer.ensure).not.toHaveBeenCalled();
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
    expect(installer.ensure).not.toHaveBeenCalled();
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

    expect(installer.ensure).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('propagates a read failure while retrying without setting up the Host', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    vi.stubEnv('QWEN_BROWSER_USE_SOCKET_PATH', '');
    installer.extensionInstalled
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error('read failed'));
    const pending = createBrowserBackend().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pending).toEqual(new Error('read failed'));

    expect(installer.ensure).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not set up the Host when extension detection fails', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    vi.stubEnv('QWEN_BROWSER_USE_SOCKET_PATH', '');
    installer.extensionInstalled.mockRejectedValueOnce(
      new Error('read failed'),
    );

    await expect(createBrowserBackend()).rejects.toThrow('read failed');
    expect(installer.ensure).not.toHaveBeenCalled();
  });

  it('warns about a skipped foreign manifest without aborting', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    vi.stubEnv('QWEN_BROWSER_USE_SOCKET_PATH', '');
    const foreign =
      '/tmp/qwen-home/.config/google-chrome/NativeMessagingHosts/com.qwen.browser_use.json';
    installer.ensure.mockResolvedValue({
      ...(await installer.ensure()),
      skippedForeignPaths: [foreign],
    });
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    await expect(createBrowserBackend()).resolves.toBeDefined();

    expect(stderr).toHaveBeenCalledTimes(1);
    expect(stderr.mock.calls[0]![0]).toContain(foreign);
    expect(stderr.mock.calls[0]![0]).toContain(
      'another program owns the Chrome Native Messaging manifest',
    );
  });

  it('identifies a foreign manifest when it prevents installation from being ready', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    vi.stubEnv('QWEN_BROWSER_USE_SOCKET_PATH', '');
    const foreign = '/tmp/other-owned/com.qwen.browser_use.json';
    installer.ensure.mockResolvedValue({
      ...(await installer.ensure()),
      ready: false,
      skippedForeignPaths: [foreign],
    });
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    await expect(createBrowserBackend()).rejects.toThrow(
      new RegExp('Another program owns ' + foreign + '; remove or move it'),
    );
    expect(stderr.mock.calls[0]![0]).toContain(foreign);
  });

  it.each([
    ['QWEN_BROWSER_USE_SOCKET_PATH', '/tmp/managed.sock'],
    ['QWEN_BROWSER_USE_DISCOVERY_DIR', '/tmp/managed-discovery'],
  ])(
    'does not install when a managed %s is configured',
    async (name, value) => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
      vi.stubEnv('QWEN_BROWSER_USE_SOCKET_PATH', '');
      vi.stubEnv(name, value);

      await createBrowserBackend();

      expect(installer.extensionInstalled).not.toHaveBeenCalled();
      expect(installer.ensure).not.toHaveBeenCalled();
    },
  );
});
