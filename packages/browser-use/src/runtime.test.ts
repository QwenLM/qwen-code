/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const installer = vi.hoisted(() => ({
  install: vi.fn(async () => undefined),
  home: vi.fn(() => '/tmp/qwen-home'),
}));

vi.mock('./native-host-installer.js', () => ({
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
  it('registers the Native Host before creating the default backend', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    vi.stubEnv('QWEN_BROWSER_USE_SOCKET_PATH', '');

    await createBrowserBackend();

    expect(installer.install).toHaveBeenCalledWith({
      homeDir: '/tmp/qwen-home',
      nativeHostPath: expect.stringMatching(/native-host\.js$/),
    });
  });

  it('does not install when a managed socket is configured', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    vi.stubEnv('QWEN_BROWSER_USE_SOCKET_PATH', '/tmp/managed.sock');

    await createBrowserBackend();

    expect(installer.install).not.toHaveBeenCalled();
  });
});
