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
    expect(fs.statSync(result.launcherPath).mode & 0o777).toBe(0o700);
    const launcher = fs.readFileSync(result.launcherPath, 'utf8');
    expect(launcher.startsWith('#!/bin/sh\n')).toBe(true);
    expect(launcher).toContain("'" + fixture.nativeHostPath + "'");
  });

  it('uses the documented Linux user paths and updates idempotently', async () => {
    const fixture = createFixture();
    createBrowserProfile(fixture.homeDir, 'linux', 'chrome');
    createBrowserProfile(fixture.homeDir, 'linux', 'chromium');
    const first = await installChromeNativeHost({
      ...fixture,
      platform: 'linux',
    });
    const second = await installChromeNativeHost({
      ...fixture,
      platform: 'linux',
    });
    expect(second).toEqual(first);
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
): void {
  const roots =
    platform === 'darwin'
      ? {
          chrome: 'Library/Application Support/Google/Chrome',
          'chrome-for-testing':
            'Library/Application Support/Google/ChromeForTesting',
          chromium: 'Library/Application Support/Chromium',
        }
      : {
          chrome: '.config/google-chrome',
          'chrome-for-testing': '.config/google-chrome-for-testing',
          chromium: '.config/chromium',
        };
  fs.mkdirSync(path.join(homeDir, roots[browser]), { recursive: true });
}
