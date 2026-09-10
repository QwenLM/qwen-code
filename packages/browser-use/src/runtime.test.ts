/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

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

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
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
  });

  it('asks to install the extension without registering the Native Host', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    vi.stubEnv('QWEN_BROWSER_USE_SOCKET_PATH', '');
    installer.extensionInstalled.mockResolvedValueOnce(false);

    await expect(createBrowserBackend()).rejects.toThrow(
      'Install the Qwen Code Chrome extension at chrome://extensions',
    );
    expect(installer.install).not.toHaveBeenCalled();
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
