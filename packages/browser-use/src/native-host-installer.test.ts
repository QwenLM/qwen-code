/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  installChromeNativeHost,
  isChromeExtensionInstalled,
  statusChromeNativeHost,
  uninstallChromeNativeHost,
} from './native-host-installer.js';
import {
  CHROME_EXTENSION_ID,
  CHROME_NATIVE_HOST_NAME,
} from './bridge/protocol.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('Chrome extension installation detection', () => {
  it.each(['darwin', 'linux'] as const)(
    'finds packaged extensions in a secondary profile on %s',
    async (platform) => {
      const fixture = createFixture();
      const browserRoot = createBrowserProfile(
        fixture.homeDir,
        platform,
        'chrome',
      );
      const profile = path.join(browserRoot, 'Profile 2');
      const extensionPath = path.join(CHROME_EXTENSION_ID, '1.0.0_0');
      writeExtensionPreferences(profile, 'Secure Preferences', extensionPath);
      const installedPath = path.join(profile, 'Extensions', extensionPath);
      fs.mkdirSync(installedPath, { recursive: true });
      fs.writeFileSync(path.join(installedPath, 'manifest.json'), '{}');

      await expect(
        isChromeExtensionInstalled({ ...fixture, platform }),
      ).resolves.toBe(true);
      expect(fs.existsSync(path.join(fixture.homeDir, '.qwen'))).toBe(false);
      expect(
        fs.existsSync(path.join(browserRoot, 'NativeMessagingHosts')),
      ).toBe(false);
    },
  );

  it.each(['chrome', 'chrome-for-testing', 'chromium'] as const)(
    'finds an unpacked extension through %s preferences',
    async (browser) => {
      const fixture = createFixture();
      const browserRoot = createBrowserProfile(
        fixture.homeDir,
        'darwin',
        browser,
      );
      const extensionPath = path.join(fixture.homeDir, 'unpacked extension');
      fs.mkdirSync(extensionPath, { recursive: true });
      fs.writeFileSync(path.join(extensionPath, 'manifest.json'), '{}');
      writeExtensionPreferences(
        path.join(browserRoot, 'Default'),
        'Preferences',
        extensionPath,
      );

      await expect(
        isChromeExtensionInstalled({ ...fixture, platform: 'darwin' }),
      ).resolves.toBe(true);
    },
  );

  it.each([
    'no profile',
    'no extension',
    'other extension',
    'leftover files',
    'missing files',
    'invalid preferences',
  ])('does not confirm installation with %s', async (scenario) => {
    const fixture = createFixture();
    if (scenario !== 'no profile') {
      const browserRoot = createBrowserProfile(
        fixture.homeDir,
        'darwin',
        'chrome',
      );
      const profile = path.join(browserRoot, 'Default');
      const extensionPath = path.join(fixture.homeDir, 'unpacked extension');
      fs.mkdirSync(extensionPath, { recursive: true });
      if (scenario !== 'missing files') {
        fs.writeFileSync(path.join(extensionPath, 'manifest.json'), '{}');
      }
      writeExtensionPreferences(profile, 'Preferences', extensionPath);
      if (scenario === 'no extension' || scenario === 'leftover files') {
        fs.writeFileSync(path.join(profile, 'Preferences'), '{}');
      }
      if (scenario === 'leftover files') {
        const leftover = path.join(
          profile,
          'Extensions',
          CHROME_EXTENSION_ID,
          '1.0.0_0',
        );
        fs.mkdirSync(leftover, { recursive: true });
        fs.writeFileSync(path.join(leftover, 'manifest.json'), '{}');
      }
      if (scenario === 'other extension') {
        fs.writeFileSync(
          path.join(profile, 'Preferences'),
          JSON.stringify({
            extensions: { settings: { other: { path: extensionPath } } },
          }),
        );
      }
      if (scenario === 'invalid preferences') {
        fs.writeFileSync(path.join(profile, 'Preferences'), '{');
      }
    }

    await expect(
      isChromeExtensionInstalled({ ...fixture, platform: 'darwin' }),
    ).resolves.toBe(false);
  });

  it('uses Secure Preferences ahead of an older Preferences entry', async () => {
    const fixture = createFixture();
    const profile = path.join(
      createBrowserProfile(fixture.homeDir, 'darwin', 'chrome'),
      'Default',
    );
    const extensionPath = path.join(fixture.homeDir, 'old extension');
    fs.mkdirSync(extensionPath, { recursive: true });
    fs.writeFileSync(path.join(extensionPath, 'manifest.json'), '{}');
    writeExtensionPreferences(profile, 'Preferences', extensionPath);
    writeExtensionPreferences(
      profile,
      'Secure Preferences',
      '/missing/extension',
    );

    await expect(
      isChromeExtensionInstalled({ ...fixture, platform: 'darwin' }),
    ).resolves.toBe(false);
  });
});

function writeExtensionPreferences(
  profile: string,
  file: string,
  extensionPath: string,
): void {
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(
    path.join(profile, file),
    JSON.stringify({
      extensions: {
        settings: { [CHROME_EXTENSION_ID]: { path: extensionPath } },
      },
    }),
  );
}

describe('Chrome Native Host installer', () => {
  it('installs the manifest for an existing macOS Chrome profile', async () => {
    const fixture = createFixture();
    createBrowserProfile(fixture.homeDir, 'darwin', 'chrome');
    const result = await installChromeNativeHost({
      ...fixture,
      platform: 'darwin',
    });
    expect(result.manifestPaths).toHaveLength(3);
    expect(result.manifestPaths).toContain(
      path.join(
        fixture.homeDir,
        'Library/Application Support/Google/Chrome/NativeMessagingHosts/com.qwen.browser.json',
      ),
    );
    const manifest = JSON.parse(
      fs.readFileSync(result.manifestPaths[0]!, 'utf8'),
    ) as Record<string, unknown>;
    expect(manifest).toEqual({
      name: CHROME_NATIVE_HOST_NAME,
      description: 'Qwen Browser Use',
      path: result.launcherPath,
      type: 'stdio',
      allowed_origins: ['chrome-extension://' + CHROME_EXTENSION_ID + '/'],
    });
    if (process.platform !== 'win32') {
      expect(fs.statSync(result.launcherPath).mode & 0o777).toBe(0o700);
    }
    const launcher = fs.readFileSync(result.launcherPath, 'utf8');
    expect(launcher.startsWith('#!/bin/sh\n')).toBe(true);
    expect(launcher).toContain("'" + fixture.nativeHostPath + "'");
  });

  it('registers the documented macOS Chrome for Testing profile', async () => {
    const fixture = createFixture();
    createBrowserProfile(fixture.homeDir, 'darwin', 'chrome-for-testing');
    const options = { ...fixture, platform: 'darwin' as const };
    await installChromeNativeHost(options);
    expect((await statusChromeNativeHost(options)).installedPaths).toContain(
      path.join(
        fixture.homeDir,
        'Library/Application Support/Google/Chrome for Testing/NativeMessagingHosts/com.qwen.browser.json',
      ),
    );
  });

  it
    .skipIf(process.platform === 'win32' || process.getuid?.() === 0)
    .each(['launcher', 'manifest'])(
    'preserves an unreadable %s during install, status and uninstall',
    async (kind) => {
      const fixture = createFixture();
      createBrowserProfile(fixture.homeDir, 'darwin', 'chrome');
      const options = { ...fixture, platform: 'darwin' as const };
      const installed = await installChromeNativeHost(options);
      const target =
        kind === 'launcher'
          ? installed.launcherPath
          : installed.manifestPaths[0]!;
      fs.writeFileSync(target, 'foreign file');
      fs.chmodSync(target, 0);
      try {
        for (const operation of [
          installChromeNativeHost,
          statusChromeNativeHost,
          uninstallChromeNativeHost,
        ]) {
          await expect(operation(options)).rejects.toMatchObject({
            code: 'EACCES',
          });
          expect(fs.statSync(target).mode & 0o777).toBe(0);
        }
      } finally {
        fs.chmodSync(target, 0o600);
      }
      expect(fs.readFileSync(target, 'utf8')).toBe('foreign file');
    },
  );

  it('uses the documented Linux user paths and updates idempotently', async () => {
    const fixture = createFixture();
    createBrowserProfile(fixture.homeDir, 'linux', 'chrome');
    createBrowserProfile(fixture.homeDir, 'linux', 'chromium');
    const first = await installChromeNativeHost({
      ...fixture,
      platform: 'linux',
    });
    const files = [
      first.launcherPath,
      ...first.manifestPaths.filter((file) => fs.existsSync(file)),
    ];
    const before = files.map((file) => fs.statSync(file));
    const second = await installChromeNativeHost({
      ...fixture,
      platform: 'linux',
    });
    expect(second).toEqual(first);
    expect(files.map((file) => fs.statSync(file).ino)).toEqual(
      before.map((file) => file.ino),
    );
    expect(files.map((file) => fs.statSync(file).mtimeMs)).toEqual(
      before.map((file) => file.mtimeMs),
    );
    expect(second.manifestPaths).toEqual(
      expect.arrayContaining([
        path.join(
          fixture.homeDir,
          '.config/google-chrome/NativeMessagingHosts/com.qwen.browser.json',
        ),
        path.join(
          fixture.homeDir,
          '.config/google-chrome-for-testing/NativeMessagingHosts/com.qwen.browser.json',
        ),
        path.join(
          fixture.homeDir,
          '.config/chromium/NativeMessagingHosts/com.qwen.browser.json',
        ),
      ]),
    );
    expect(fs.existsSync(second.manifestPaths[0]!)).toBe(true);
    expect(fs.existsSync(second.manifestPaths[1]!)).toBe(false);
    expect(fs.existsSync(second.manifestPaths[2]!)).toBe(true);
    const status = await statusChromeNativeHost({
      ...fixture,
      platform: 'linux',
    });
    expect(status.installedPaths).toHaveLength(3);
  });

  it
    .skipIf(process.platform === 'win32' || process.getuid?.() === 0)
    .each(['launcher', 'manifest'] as const)(
    'keeps a correct %s usable in a read-only directory',
    async (kind) => {
      const fixture = createFixture();
      createBrowserProfile(fixture.homeDir, 'darwin', 'chrome');
      const options = { ...fixture, platform: 'darwin' as const };
      const installed = await installChromeNativeHost(options);
      const target =
        kind === 'launcher'
          ? installed.launcherPath
          : installed.manifestPaths[0]!;
      const before = fs.statSync(target);
      const directory = path.dirname(target);
      fs.chmodSync(directory, 0o500);
      try {
        await expect(installChromeNativeHost(options)).resolves.toEqual(
          installed,
        );
        expect(fs.statSync(target)).toMatchObject({
          ino: before.ino,
          mtimeMs: before.mtimeMs,
          mode: before.mode,
        });
      } finally {
        fs.chmodSync(directory, 0o700);
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'repairs permissions on unchanged owned files',
    async () => {
      const fixture = createFixture();
      createBrowserProfile(fixture.homeDir, 'darwin', 'chrome');
      const options = { ...fixture, platform: 'darwin' as const };
      const installed = await installChromeNativeHost(options);
      const manifest = installed.manifestPaths[0]!;
      fs.chmodSync(installed.launcherPath, 0o600);
      fs.chmodSync(manifest, 0o644);

      await installChromeNativeHost(options);

      expect(fs.statSync(installed.launcherPath).mode & 0o777).toBe(0o700);
      expect(fs.statSync(manifest).mode & 0o777).toBe(0o600);
    },
  );

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'propagates a required launcher update failure and updates when writable',
    async () => {
      const fixture = createFixture();
      createBrowserProfile(fixture.homeDir, 'darwin', 'chrome');
      const options = { ...fixture, platform: 'darwin' as const };
      const installed = await installChromeNativeHost(options);
      const before = fs.readFileSync(installed.launcherPath, 'utf8');
      const updated = { ...options, nodePath: '/updated/node' };
      const directory = path.dirname(installed.launcherPath);
      fs.chmodSync(directory, 0o500);
      try {
        await expect(installChromeNativeHost(updated)).rejects.toMatchObject({
          code: 'EACCES',
        });
        expect(fs.readFileSync(installed.launcherPath, 'utf8')).toBe(before);
      } finally {
        fs.chmodSync(directory, 0o700);
      }

      await installChromeNativeHost(updated);

      expect(fs.readFileSync(installed.launcherPath, 'utf8')).toContain(
        "exec '/updated/node'",
      );
    },
  );

  it('uninstalls owned files without deleting a foreign manifest', async () => {
    const fixture = createFixture();
    createBrowserProfile(fixture.homeDir, 'darwin', 'chrome');
    const installed = await installChromeNativeHost({
      ...fixture,
      platform: 'darwin',
    });
    const foreign = installed.manifestPaths[0]!;
    fs.writeFileSync(foreign, JSON.stringify({ name: 'foreign.host' }));
    const result = await uninstallChromeNativeHost({
      ...fixture,
      platform: 'darwin',
    });
    expect(result.skippedForeignPaths).toEqual([foreign]);
    expect(fs.existsSync(foreign)).toBe(true);
    expect(fs.existsSync(result.launcherPath)).toBe(false);
    for (const manifestPath of installed.manifestPaths.slice(1)) {
      expect(fs.existsSync(manifestPath)).toBe(false);
    }
  });

  it('does not overwrite a foreign manifest during install', async () => {
    const fixture = createFixture();
    const manifestPath = path.join(
      fixture.homeDir,
      'Library/Application Support/Google/Chrome/NativeMessagingHosts/com.qwen.browser.json',
    );
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify({ name: 'foreign.host' }));
    const result = await installChromeNativeHost({
      ...fixture,
      platform: 'darwin',
    });
    expect(result.skippedForeignPaths).toEqual([manifestPath]);
    expect(fs.readFileSync(manifestPath, 'utf8')).toContain('foreign.host');
  });

  it('does not claim a matching host manifest for another launcher', async () => {
    const fixture = createFixture();
    const manifestPath = path.join(
      fixture.homeDir,
      'Library/Application Support/Google/Chrome/NativeMessagingHosts/com.qwen.browser.json',
    );
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        name: CHROME_NATIVE_HOST_NAME,
        path: path.join(fixture.homeDir, 'other-launcher.sh'),
        type: 'stdio',
        allowed_origins: ['chrome-extension://' + CHROME_EXTENSION_ID + '/'],
      }),
    );

    const result = await installChromeNativeHost({
      ...fixture,
      platform: 'darwin',
    });

    expect(result.skippedForeignPaths).toContain(manifestPath);
  });

  it('requires absolute executable paths', async () => {
    const fixture = createFixture();
    await expect(
      installChromeNativeHost({
        ...fixture,
        nativeHostPath: 'native-host.js',
        platform: 'linux',
      }),
    ).rejects.toThrow('must be absolute');
  });
});

function createFixture(): {
  homeDir: string;
  nativeHostPath: string;
  nodePath: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qbu-install-'));
  roots.push(root);
  const homeDir = path.join(root, 'home');
  const nativeHostPath = path.join(
    root,
    'extension with spaces/native-host.js',
  );
  fs.mkdirSync(path.dirname(nativeHostPath), { recursive: true });
  fs.writeFileSync(nativeHostPath, '# host');
  return {
    homeDir,
    nativeHostPath,
    nodePath: path.join(root, 'node with spaces'),
  };
}

function createBrowserProfile(
  homeDir: string,
  platform: 'darwin' | 'linux',
  browser: 'chrome' | 'chrome-for-testing' | 'chromium',
): string {
  const roots =
    platform === 'darwin'
      ? {
          chrome: 'Library/Application Support/Google/Chrome',
          'chrome-for-testing':
            'Library/Application Support/Google/Chrome for Testing',
          chromium: 'Library/Application Support/Chromium',
        }
      : {
          chrome: '.config/google-chrome',
          'chrome-for-testing': '.config/google-chrome-for-testing',
          chromium: '.config/chromium',
        };
  const root = path.join(homeDir, roots[browser]);
  fs.mkdirSync(root, { recursive: true });
  return root;
}
