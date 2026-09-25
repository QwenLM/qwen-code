/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const installer = vi.hoisted(() => ({
  ensure: vi.fn(async () => ({
    launcherPath: '/tmp/qwen-home/.qwen/browser-use/host.sh',
    manifestPaths: [] as string[],
    installedPaths: [] as string[],
    ready: true,
    skippedForeignPaths: [] as string[],
  })),
  home: vi.fn(() => '/tmp/qwen-home'),
}));

vi.mock('./native-host-installer.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./native-host-installer.js')>()),
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

  it('sets up the Host without requiring installed extension preferences', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    vi.stubEnv('QWEN_BROWSER_USE_SOCKET_PATH', '');

    await expect(createBrowserBackend()).resolves.toBeDefined();

    expect(installer.ensure).toHaveBeenCalledWith({
      homeDir: '/tmp/qwen-home',
      nativeHostPath: expect.stringMatching(/native-host\.js$/),
    });
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'initializes when Chrome preference files are unreadable',
    async () => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
      vi.stubEnv('QWEN_BROWSER_USE_SOCKET_PATH', '');
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qbu-init-'));
      const profile = path.join(
        home,
        'Library/Application Support/Google/Chrome/Default',
      );
      fs.mkdirSync(profile, { recursive: true });
      const preferences = path.join(profile, 'Secure Preferences');
      fs.writeFileSync(preferences, '{}', { mode: 0o000 });
      installer.home.mockReturnValue(home);
      try {
        expect(() => fs.readFileSync(preferences)).toThrow();
        await expect(createBrowserBackend()).resolves.toBeDefined();
        expect(installer.ensure).toHaveBeenCalledOnce();
      } finally {
        fs.chmodSync(preferences, 0o600);
        fs.rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it('reports a denied Host registration instead of claiming Chrome is missing', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    vi.stubEnv('QWEN_BROWSER_USE_SOCKET_PATH', '');
    const error = Object.assign(new Error('Host manifest access denied'), {
      code: 'EACCES',
    });
    installer.ensure.mockRejectedValueOnce(error);

    await expect(createBrowserBackend()).rejects.toBe(error);
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

      expect(installer.ensure).not.toHaveBeenCalled();
    },
  );
});
