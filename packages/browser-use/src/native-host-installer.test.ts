/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import {
  describeChromeProfiles,
  ensureChromeNativeHost,
  installChromeNativeHost,
  NativeHostNewerError,
  nativeHostInstallHome,
  statusChromeNativeHost,
  uninstallChromeNativeHost,
} from './native-host-installer.js';
import {
  CHROME_BRIDGE_PROTOCOL_VERSION,
  CHROME_EXTENSION_ID,
  CHROME_EXTENSION_IDS,
  CHROME_NATIVE_HOST_NAME,
  CHROME_NATIVE_HOST_REVISION,
} from './bridge/protocol.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const LEGACY_LAUNCHER =
  '#!/bin/sh\n# qwen-browser-use native host\nexec /old/node /old/host.js\n';

describe('Chrome Native Host installer', () => {
  it.skipIf(process.platform === 'win32')(
    'keeps installed and running Hosts independent of CLI files and updates',
    async () => {
      const fixture = createFixture();
      createBrowserProfile(fixture.homeDir, 'linux', 'chrome');
      const options = {
        ...fixture,
        nodePath: process.execPath,
        platform: 'linux' as const,
      };
      const host = (version: string) =>
        `import process from 'node:process'; console.log('${version}'); process.stdin.on('data', () => console.log('${version}'));`;
      fs.writeFileSync(fixture.nativeHostPath, host('first'));
      const first = await installChromeNativeHost(options);
      const launch = (launcherPath: string) => {
        const child = spawn(launcherPath);
        onTestFinished(async () => {
          const exited = once(child, 'exit');
          child.kill();
          await exited;
        });
        return child;
      };
      const running = launch(first.launcherPath);
      expect(String((await once(running.stdout, 'data'))[0]).trim()).toBe(
        'first',
      );
      fs.writeFileSync(fixture.nativeHostPath, host('second'));
      const second = await installChromeNativeHost(options);
      expect(second.nativeHostPath).not.toBe(first.nativeHostPath);
      fs.rmSync(path.dirname(fixture.nativeHostPath), { recursive: true });
      expect(fs.existsSync(first.nativeHostPath!)).toBe(true);
      expect((await statusChromeNativeHost(options)).ready).toBe(true);
      const oldReply = once(running.stdout, 'data');
      running.stdin.write('still alive\n');
      expect(String((await oldReply)[0]).trim()).toBe('first');
      const fresh = launch(second.launcherPath);
      expect(String((await once(fresh.stdout, 'data'))[0]).trim()).toBe(
        'second',
      );
    },
  );

  it('reports legacy, missing and incompatible installation metadata without rewriting files', async () => {
    const fixture = createFixture();
    createBrowserProfile(fixture.homeDir, 'linux', 'chrome');
    const options = { ...fixture, platform: 'linux' as const };
    const installed = await installChromeNativeHost(options);
    const launcher = fs.readFileSync(installed.launcherPath, 'utf8');
    fs.writeFileSync(
      installed.launcherPath,
      launcher.replace(
        `"protocolVersion":${CHROME_BRIDGE_PROTOCOL_VERSION}`,
        '"protocolVersion":1',
      ),
    );
    expect((await statusChromeNativeHost(options)).protocolVersion).toBe(1);
    fs.writeFileSync(installed.launcherPath, LEGACY_LAUNCHER);
    const before = fs.statSync(installed.launcherPath);
    expect(await statusChromeNativeHost(options)).toMatchObject({
      ready: false,
      protocolVersion: null,
    });
    expect(fs.statSync(installed.launcherPath).mtimeMs).toBe(before.mtimeMs);
    fs.writeFileSync(installed.launcherPath, launcher);
    fs.rmSync(installed.nativeHostPath!);
    expect((await statusChromeNativeHost(options)).ready).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'requires an executable launcher and the installed Node interpreter',
    async () => {
      const fixture = createFixture();
      createBrowserProfile(fixture.homeDir, 'linux', 'chrome');
      const options = { ...fixture, platform: 'linux' as const };
      const installed = await installChromeNativeHost(options);
      fs.chmodSync(installed.launcherPath, 0o600);
      expect((await statusChromeNativeHost(options)).ready).toBe(false);
      fs.chmodSync(installed.launcherPath, 0o700);
      expect((await statusChromeNativeHost(options)).ready).toBe(true);
      fs.rmSync(fixture.nodePath);
      expect((await statusChromeNativeHost(options)).ready).toBe(false);
    },
  );

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
        'Library/Application Support/Google/Chrome/NativeMessagingHosts/com.qwen.browser_use.json',
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
      allowed_origins: CHROME_EXTENSION_IDS.map(
        (id) => 'chrome-extension://' + id + '/',
      ),
    });
    if (process.platform !== 'win32') {
      expect(fs.statSync(result.launcherPath).mode & 0o777).toBe(0o700);
    }
    const launcher = fs.readFileSync(result.launcherPath, 'utf8');
    expect(launcher.startsWith('#!/bin/sh\n')).toBe(true);
    expect(launcher).toContain(
      "'" + result.nativeHostPath!.replaceAll("'", "'\\''") + "'",
    );
    expect(result.nativeHostPath).toMatch(
      /hosts[\\/][a-f0-9]{64}[\\/]native-host\.mjs$/,
    );
    expect(fs.readFileSync(result.nativeHostPath!, 'utf8')).toBe('# host');
    expect(result.protocolVersion).toBe(CHROME_BRIDGE_PROTOCOL_VERSION);
  });

  it('registers the documented macOS Chrome for Testing profile', async () => {
    const fixture = createFixture();
    createBrowserProfile(fixture.homeDir, 'darwin', 'chrome-for-testing');
    const options = { ...fixture, platform: 'darwin' as const };
    await installChromeNativeHost(options);
    expect((await statusChromeNativeHost(options)).installedPaths).toContain(
      path.join(
        fixture.homeDir,
        'Library/Application Support/Google/Chrome for Testing/NativeMessagingHosts/com.qwen.browser_use.json',
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
          '.config/google-chrome/NativeMessagingHosts/com.qwen.browser_use.json',
        ),
        path.join(
          fixture.homeDir,
          '.config/google-chrome-for-testing/NativeMessagingHosts/com.qwen.browser_use.json',
        ),
        path.join(
          fixture.homeDir,
          '.config/chromium/NativeMessagingHosts/com.qwen.browser_use.json',
        ),
      ]),
    );
    expect(second.installedPaths).toEqual([
      second.manifestPaths[0],
      second.manifestPaths[2],
      second.launcherPath,
    ]);
    expect(fs.existsSync(second.manifestPaths[1]!)).toBe(false);
    const status = await statusChromeNativeHost({
      ...fixture,
      platform: 'linux',
    });
    expect(status.installedPaths).toEqual(second.installedPaths);
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
      const updatedNode = path.join(
        path.dirname(fixture.nodePath),
        'updated-node',
      );
      fs.copyFileSync(fixture.nodePath, updatedNode);
      const updated = { ...options, nodePath: updatedNode };
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
        "exec '" + updatedNode + "'",
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
      'Library/Application Support/Google/Chrome/NativeMessagingHosts/com.qwen.browser_use.json',
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
      'Library/Application Support/Google/Chrome/NativeMessagingHosts/com.qwen.browser_use.json',
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

  it('leaves a registration naming another extension alone', async () => {
    const fixture = createFixture();
    createBrowserProfile(fixture.homeDir, 'darwin', 'chrome');
    const options = { ...fixture, platform: 'darwin' as const };
    const installed = await installChromeNativeHost(options);
    const manifestPath = installed.manifestPaths[0]!;
    const foreign = JSON.stringify({
      name: CHROME_NATIVE_HOST_NAME,
      description: 'Qwen Browser Use',
      path: installed.launcherPath,
      type: 'stdio',
      allowed_origins: [
        'chrome-extension://' + CHROME_EXTENSION_ID + '/',
        'chrome-extension://' + 'c'.repeat(32) + '/',
      ],
    });
    fs.writeFileSync(manifestPath, foreign);

    const result = await ensureChromeNativeHost(options);

    expect(result.skippedForeignPaths).toContain(manifestPath);
    expect(fs.readFileSync(manifestPath, 'utf8')).toBe(foreign);
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

  it('requires an absolute Node path', async () => {
    const fixture = createFixture();
    await expect(
      installChromeNativeHost({
        ...fixture,
        nodePath: 'node',
        platform: 'linux',
      }),
    ).rejects.toThrow('must be absolute');
    expect(fs.existsSync(path.join(fixture.homeDir, '.qwen'))).toBe(false);
  });

  it('rejects a missing Native Host before writing anything', async () => {
    const fixture = createFixture();
    createBrowserProfile(fixture.homeDir, 'linux', 'chrome');
    await expect(
      installChromeNativeHost({
        ...fixture,
        nativeHostPath: path.join(fixture.homeDir, 'missing/native-host.js'),
        platform: 'linux',
      }),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(fs.existsSync(path.join(fixture.homeDir, '.qwen'))).toBe(false);
    expect(
      fs.existsSync(
        path.join(
          fixture.homeDir,
          '.config/google-chrome/NativeMessagingHosts',
        ),
      ),
    ).toBe(false);
  });

  it('refuses unsupported platforms without writing anything', async () => {
    const fixture = createFixture();
    await expect(
      installChromeNativeHost({ ...fixture, platform: 'win32' }),
    ).rejects.toThrow(
      'Automatic Native Messaging installation supports macOS and Linux',
    );
    expect(fs.existsSync(fixture.homeDir)).toBe(false);
  });

  it('refuses to replace a foreign launcher and skips it afterwards', async () => {
    const fixture = createFixture();
    createBrowserProfile(fixture.homeDir, 'darwin', 'chrome');
    const options = { ...fixture, platform: 'darwin' as const };
    const launcherPath = path.join(
      fixture.homeDir,
      '.qwen/browser-use/host.sh',
    );
    // A different program's launcher: a shell script without the owned marker.
    const foreign = '#!/bin/sh\nexec /other/tool "$@"\n';
    fs.mkdirSync(path.dirname(launcherPath), { recursive: true });
    fs.writeFileSync(launcherPath, foreign, { mode: 0o755 });
    const manifestDirectory = path.join(
      fixture.homeDir,
      'Library/Application Support/Google/Chrome/NativeMessagingHosts',
    );

    await expect(installChromeNativeHost(options)).rejects.toThrow(
      'Refusing to replace a foreign Native Host launcher: ' + launcherPath,
    );
    expect(fs.readFileSync(launcherPath, 'utf8')).toBe(foreign);
    expect(fs.existsSync(manifestDirectory)).toBe(false);

    const status = await statusChromeNativeHost(options);
    expect(status.installedPaths).toEqual([]);
    expect(status.skippedForeignPaths).toEqual([launcherPath]);

    const uninstalled = await uninstallChromeNativeHost(options);
    expect(uninstalled.skippedForeignPaths).toEqual([launcherPath]);
    expect(fs.readFileSync(launcherPath, 'utf8')).toBe(foreign);
  });

  it('removes every owned manifest on uninstall', async () => {
    const fixture = createFixture();
    createBrowserProfile(fixture.homeDir, 'linux', 'chrome');
    createBrowserProfile(fixture.homeDir, 'linux', 'chromium');
    const options = { ...fixture, platform: 'linux' as const };
    const installed = await installChromeNativeHost(options);
    expect(installed.installedPaths).toHaveLength(3);
    for (const file of installed.installedPaths) {
      expect(fs.existsSync(file)).toBe(true);
    }

    const result = await uninstallChromeNativeHost(options);

    expect(result.skippedForeignPaths).toEqual([]);
    for (const file of installed.installedPaths) {
      expect(fs.existsSync(file)).toBe(false);
    }
    expect((await statusChromeNativeHost(options)).installedPaths).toEqual([]);
    expect(fs.existsSync(path.dirname(installed.nativeHostPath!))).toBe(false);
  });

  it('removes every installed Host copy on uninstall', async () => {
    const fixture = createFixture();
    createBrowserProfile(fixture.homeDir, 'linux', 'chrome');
    const options = { ...fixture, platform: 'linux' as const };
    const first = await installChromeNativeHost(options);
    fs.appendFileSync(fixture.nativeHostPath, '\n// a later build\n');
    const second = await installChromeNativeHost(options);
    expect(second.nativeHostPath).not.toBe(first.nativeHostPath);
    const store = path.join(path.dirname(first.launcherPath), 'hosts');
    expect(fs.readdirSync(store)).toHaveLength(2);

    await uninstallChromeNativeHost(options);

    expect(fs.existsSync(store)).toBe(false);
  });

  it('keeps a same-name manifest for another launcher on uninstall', async () => {
    const fixture = createFixture();
    createBrowserProfile(fixture.homeDir, 'darwin', 'chrome');
    const options = { ...fixture, platform: 'darwin' as const };
    const installed = await installChromeNativeHost(options);
    const manifestPath = installed.manifestPaths[0]!;
    const other = JSON.stringify({
      name: CHROME_NATIVE_HOST_NAME,
      description: 'Qwen Browser Use',
      path: path.join(fixture.homeDir, 'other-launcher.sh'),
      type: 'stdio',
      allowed_origins: ['chrome-extension://' + CHROME_EXTENSION_ID + '/'],
    });
    fs.writeFileSync(manifestPath, other);

    const result = await uninstallChromeNativeHost(options);

    expect(result.skippedForeignPaths).toEqual([manifestPath]);
    expect(fs.readFileSync(manifestPath, 'utf8')).toBe(other);
    expect(fs.existsSync(installed.launcherPath)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'quotes the interpreter and an apostrophe-bearing host path in the launcher',
    async () => {
      const fixture = createFixture();
      createBrowserProfile(fixture.homeDir, 'linux', 'chrome');
      const nativeHostPath = path.join(
        path.dirname(fixture.nativeHostPath),
        "it's here/native-host.js",
      );
      fs.mkdirSync(path.dirname(nativeHostPath), { recursive: true });
      fs.writeFileSync(nativeHostPath, '# host');
      // A stand-in interpreter that echoes its operands one per line.
      fs.writeFileSync(fixture.nodePath, '#!/bin/sh\nprintf "%s\\n" "$@"\n', {
        mode: 0o755,
      });

      const installed = await installChromeNativeHost({
        ...fixture,
        nativeHostPath,
        platform: 'linux',
      });

      const launcher = fs.readFileSync(installed.launcherPath, 'utf8');
      expect(launcher).toContain(
        "exec '" +
          fixture.nodePath +
          "' '" +
          installed.nativeHostPath!.replace("'", "'\\''") +
          '\' "$@"',
      );
      const output = execFileSync(installed.launcherPath, ['--stdio'], {
        encoding: 'utf8',
      });
      expect(output.split('\n')).toEqual([
        installed.nativeHostPath,
        '--stdio',
        '',
      ]);
    },
  );
});

describe('first-use Native Host setup', () => {
  it('installs once, then reuses a same-protocol Host without repointing it', async () => {
    const fixture = createFixture();
    createBrowserProfile(fixture.homeDir, 'linux', 'chrome');
    const options = { ...fixture, platform: 'linux' as const };

    const first = await ensureChromeNativeHost(options);
    expect(first).toMatchObject({ action: 'installed', ready: true });
    const launcher = fs.readFileSync(first.launcherPath, 'utf8');

    // Another checkout of the same protocol bundles a different Host build,
    // and a second browser appeared since.
    fs.writeFileSync(fixture.nativeHostPath, '# another checkout');
    const chromium = path.join(
      createBrowserProfile(fixture.homeDir, 'linux', 'chromium'),
      'NativeMessagingHosts',
      CHROME_NATIVE_HOST_NAME + '.json',
    );
    const second = await ensureChromeNativeHost(options);
    expect(second).toMatchObject({
      action: 'reused',
      ready: true,
      nativeHostPath: first.nativeHostPath,
    });
    expect(second.installedPaths).toContain(chromium);
    expect(fs.readFileSync(first.launcherPath, 'utf8')).toBe(launcher);
  });

  const bump = (field: 'protocolVersion' | 'revision', delta: number) => {
    const current =
      field === 'revision'
        ? CHROME_NATIVE_HOST_REVISION
        : CHROME_BRIDGE_PROTOCOL_VERSION;
    return (launcher: string) =>
      launcher.replace(
        `"${field}":${current}`,
        `"${field}":${current + delta}`,
      );
  };
  it.each([
    ['upgrades an older protocol', bump('protocolVersion', -1), 'installed'],
    ['upgrades a lower Host revision', bump('revision', -1), 'installed'],
    [
      'upgrades a launcher without an installation record',
      () => LEGACY_LAUNCHER,
      'installed',
    ],
    ['reuses a higher Host revision', bump('revision', 1), 'reused'],
    [
      'never downgrades a newer protocol',
      bump('protocolVersion', 1),
      'refused',
    ],
  ] as const)('%s', async (_label, edit, outcome) => {
    const fixture = createFixture();
    createBrowserProfile(fixture.homeDir, 'linux', 'chrome');
    const options = { ...fixture, platform: 'linux' as const };
    const installed = await installChromeNativeHost(options);
    const launcher = fs.readFileSync(installed.launcherPath, 'utf8');
    const edited = edit(launcher);
    expect(edited).not.toBe(launcher);
    fs.writeFileSync(installed.launcherPath, edited);

    const result = await ensureChromeNativeHost(options).catch(
      (error: unknown) => error,
    );

    if (outcome === 'refused') {
      expect(result).toBeInstanceOf(NativeHostNewerError);
      expect(result).toMatchObject({
        installedProtocolVersion: CHROME_BRIDGE_PROTOCOL_VERSION + 1,
        message: expect.stringContaining('Update Qwen Code'),
      });
    } else {
      expect(result).toMatchObject({
        action: outcome,
        ready: true,
        protocolVersion: CHROME_BRIDGE_PROTOCOL_VERSION,
      });
    }
    expect(fs.readFileSync(installed.launcherPath, 'utf8') === edited).toBe(
      outcome !== 'installed',
    );
  });

  it('is unaffected by the protocol 2 registration older Qwen Code rewrites', async () => {
    const fixture = createFixture();
    const browserRoot = createBrowserProfile(
      fixture.homeDir,
      'linux',
      'chrome',
    );
    const options = { ...fixture, platform: 'linux' as const };
    // What a protocol 2 CLI writes on every first use.
    const legacyLauncher = path.join(
      fixture.homeDir,
      '.qwen/browser-use/native-host.sh',
    );
    const legacyManifest = path.join(
      browserRoot,
      'NativeMessagingHosts',
      'com.qwen.browser.json',
    );
    const writeLegacy = (host: string) => {
      fs.mkdirSync(path.dirname(legacyLauncher), { recursive: true });
      fs.writeFileSync(
        legacyLauncher,
        `#!/bin/sh\n# qwen-browser-use native host\nexec /old/node ${host} "$@"\n`,
        { mode: 0o700 },
      );
      fs.mkdirSync(path.dirname(legacyManifest), { recursive: true });
      fs.writeFileSync(
        legacyManifest,
        JSON.stringify({
          name: 'com.qwen.browser',
          description: 'Qwen Browser Use',
          path: legacyLauncher,
          type: 'stdio',
          allowed_origins: [`chrome-extension://${CHROME_EXTENSION_ID}/`],
        }),
      );
    };
    writeLegacy('/old/checkout-a/native-host.js');

    const installed = await ensureChromeNativeHost(options);
    expect(CHROME_NATIVE_HOST_NAME).not.toBe('com.qwen.browser');
    expect(installed.launcherPath).not.toBe(legacyLauncher);
    expect(installed.installedPaths).not.toContain(legacyManifest);
    const launcher = fs.readFileSync(installed.launcherPath, 'utf8');

    // An older CLI runs again and repoints its own registration.
    writeLegacy('/old/checkout-b/native-host.js');

    await expect(statusChromeNativeHost(options)).resolves.toMatchObject({
      ready: true,
      protocolVersion: CHROME_BRIDGE_PROTOCOL_VERSION,
      skippedForeignPaths: [],
    });
    expect(fs.readFileSync(installed.launcherPath, 'utf8')).toBe(launcher);
    await expect(ensureChromeNativeHost(options)).resolves.toMatchObject({
      action: 'reused',
    });
    expect(fs.readFileSync(legacyLauncher, 'utf8')).toContain('checkout-b');
  });
});

describe('Chrome profile descriptions', () => {
  function seedProfile(
    browserRoot: string,
    directory: string,
    storedId: string | undefined,
    file = '000003.log',
  ) {
    const storage = path.join(
      browserRoot,
      directory,
      'Local Extension Settings',
      CHROME_EXTENSION_ID,
    );
    fs.mkdirSync(storage, { recursive: true });
    if (storedId !== undefined)
      fs.writeFileSync(
        path.join(storage, file),
        Buffer.concat([
          Buffer.from([1, 0, 0, 0, 0x1a]),
          Buffer.from('browserUseInstanceId"' + storedId + '"'),
        ]),
      );
  }

  it('names profiles from Local State and marks the last used one', async () => {
    const fixture = createFixture();
    const chrome = createBrowserProfile(fixture.homeDir, 'linux', 'chrome');
    const chromium = createBrowserProfile(fixture.homeDir, 'linux', 'chromium');
    fs.writeFileSync(
      path.join(chrome, 'Local State'),
      JSON.stringify({
        profile: {
          last_used: 'Profile 1',
          info_cache: { Default: { name: 'Work' }, 'Profile 1': { name: '' } },
        },
      }),
    );
    fs.writeFileSync(
      path.join(chromium, 'Local State'),
      JSON.stringify({
        profile: {
          last_used: 'Default',
          info_cache: { Default: { name: 'Lab' } },
        },
      }),
    );
    seedProfile(chrome, 'Default', 'id-work');
    seedProfile(chrome, 'Profile 1', 'id-personal', '000005.ldb');
    seedProfile(chromium, 'Default', 'id-lab');

    const described = await describeChromeProfiles(
      { homeDir: fixture.homeDir, platform: 'linux' },
      ['id-work', 'id-personal', 'id-lab', 'id-unknown'],
    );

    expect(Object.fromEntries(described)).toEqual({
      'id-work': { name: 'Chrome · Work', lastUsed: false },
      'id-personal': { name: 'Chrome · Profile 1', lastUsed: true },
      'id-lab': { name: 'Chromium · Lab', lastUsed: true },
    });
  });

  it('describes nothing without Local State or extension storage', async () => {
    const fixture = createFixture();
    const chrome = createBrowserProfile(fixture.homeDir, 'darwin', 'chrome');
    seedProfile(chrome, 'Default', 'id-a');
    await expect(
      describeChromeProfiles({ homeDir: fixture.homeDir, platform: 'darwin' }, [
        'id-a',
      ]),
    ).resolves.toEqual(new Map());
    fs.writeFileSync(
      path.join(chrome, 'Local State'),
      JSON.stringify({ profile: { info_cache: { Default: { name: 'A' } } } }),
    );
    await expect(
      describeChromeProfiles({ homeDir: fixture.homeDir, platform: 'darwin' }, [
        'id-b',
      ]),
    ).resolves.toEqual(new Map());
  });
});

describe('nativeHostInstallHome', () => {
  it('resolves a configured install home', () => {
    expect(
      nativeHostInstallHome({ QWEN_BROWSER_USE_INSTALL_HOME: '/custom/home' }),
    ).toBe(path.resolve('/custom/home'));
  });

  it.each(['', '   '])(
    'treats a blank QWEN_BROWSER_USE_INSTALL_HOME (%j) as unset',
    (value) => {
      expect(
        nativeHostInstallHome({ QWEN_BROWSER_USE_INSTALL_HOME: value }),
      ).toBe(path.resolve(os.homedir()));
    },
  );

  it('falls back to the home directory when unset', () => {
    expect(nativeHostInstallHome({})).toBe(path.resolve(os.homedir()));
  });
});

function createFixture(): {
  homeDir: string;
  nativeHostPath: string;
  nodePath: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qbu-install-'));
  roots.push(root);
  const homeDir = path.join(root, "user's home");
  const nativeHostPath = path.join(
    root,
    'extension with spaces/native-host.js',
  );
  fs.mkdirSync(path.dirname(nativeHostPath), { recursive: true });
  fs.writeFileSync(nativeHostPath, '# host');
  const nodePath = path.join(root, 'node with spaces');
  fs.writeFileSync(nodePath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return { homeDir, nativeHostPath, nodePath };
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
