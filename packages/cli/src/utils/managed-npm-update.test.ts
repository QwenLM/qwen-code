/**
 * @license
 * Copyright 2026 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  activateManagedNpmUpdate,
  cleanupManagedNpmUpdate,
  prepareManagedNpmUpdate,
} from './managed-npm-update.js';

const temporaryDirectories: string[] = [];

function makeTemporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-npm-update-'));
  temporaryDirectories.push(directory);
  return directory;
}

function writeInstallation(prefix: string, version: string): void {
  const packageRoot = path.join(
    prefix,
    'node_modules',
    '@qwen-code',
    'qwen-code',
  );
  fs.mkdirSync(path.join(packageRoot, 'dist'), { recursive: true });
  fs.mkdirSync(path.join(packageRoot, 'scripts'), { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, 'package.json'),
    JSON.stringify({ name: '@qwen-code/qwen-code', version }),
  );
  fs.writeFileSync(path.join(packageRoot, 'dist', 'cli.js'), '');
  fs.writeFileSync(
    path.join(packageRoot, 'scripts', 'cli-entry.js'),
    `process.stdout.write('${version}\\n');\n`,
  );
}

function writeBaseInstallation(root: string, version = '1.0.0'): string {
  const packageRoot = path.join(
    root,
    'global',
    'node_modules',
    '@qwen-code',
    'qwen-code',
  );
  const bootstrap = path.join(packageRoot, 'scripts', 'cli-entry.js');
  fs.mkdirSync(path.dirname(bootstrap), { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, 'package.json'),
    JSON.stringify({ name: '@qwen-code/qwen-code', version }),
  );
  fs.writeFileSync(bootstrap, 'global launcher');
  return bootstrap;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('managed npm update', () => {
  it('stages an exact package version for one global launcher', () => {
    const root = makeTemporaryDirectory();
    const updateRoot = path.join(root, 'updates');
    const bootstrap = writeBaseInstallation(root);
    const update = prepareManagedNpmUpdate('2.0.0', bootstrap, updateRoot);

    expect(update.installArgs).toEqual([
      'install',
      '--prefix',
      update.stagingDir,
      '--no-save',
      '--package-lock=false',
      '@qwen-code/qwen-code@2.0.0',
    ]);
    expect(update.versionDir).toBe(
      path.join(update.launcherRoot, 'versions', '2.0.0'),
    );
  });

  it('activates only a complete matching installation', async () => {
    const root = makeTemporaryDirectory();
    const updateRoot = path.join(root, 'updates');
    const bootstrap = writeBaseInstallation(root);
    const runningChunk = path.join(root, 'running', 'chunks', 'old.js');
    fs.mkdirSync(path.dirname(runningChunk), { recursive: true });
    fs.writeFileSync(runningChunk, 'old chunk');
    const update = prepareManagedNpmUpdate('2.0.0', bootstrap, updateRoot);
    writeInstallation(update.stagingDir, '2.0.0');

    await activateManagedNpmUpdate(update, '2.0.0', bootstrap);

    expect(fs.existsSync(update.stagingDir)).toBe(false);
    expect(
      fs.existsSync(
        path.join(
          update.versionDir,
          'node_modules',
          '@qwen-code',
          'qwen-code',
          'dist',
          'cli.js',
        ),
      ),
    ).toBe(true);
    expect(
      JSON.parse(
        fs.readFileSync(path.join(update.launcherRoot, 'active.json'), 'utf8'),
      ),
    ).toMatchObject({
      version: '2.0.0',
      bootstrap: fs.realpathSync(bootstrap),
      baseVersion: '1.0.0',
    });
    expect(fs.readFileSync(bootstrap, 'utf8')).toBe('global launcher');
    expect(fs.readFileSync(runningChunk, 'utf8')).toBe('old chunk');
  });

  it('does not activate a mismatched package', async () => {
    const root = makeTemporaryDirectory();
    const updateRoot = path.join(root, 'updates');
    const bootstrap = writeBaseInstallation(root);
    const update = prepareManagedNpmUpdate('2.0.0', bootstrap, updateRoot);
    writeInstallation(update.stagingDir, '2.0.1');

    await expect(
      activateManagedNpmUpdate(update, '2.0.0', bootstrap),
    ).rejects.toThrow('Installed package did not match');
    expect(fs.existsSync(path.join(update.launcherRoot, 'active.json'))).toBe(
      false,
    );
  });

  it('does not activate a package that fails its version smoke test', async () => {
    const root = makeTemporaryDirectory();
    const updateRoot = path.join(root, 'updates');
    const bootstrap = writeBaseInstallation(root);
    const update = prepareManagedNpmUpdate('2.0.0', bootstrap, updateRoot);
    writeInstallation(update.stagingDir, '2.0.0');
    fs.writeFileSync(
      path.join(
        update.stagingDir,
        'node_modules',
        '@qwen-code',
        'qwen-code',
        'scripts',
        'cli-entry.js',
      ),
      "process.stdout.write('broken\\n');\n",
    );

    await expect(
      activateManagedNpmUpdate(update, '2.0.0', bootstrap),
    ).rejects.toThrow('Installed package reported version broken');
    expect(fs.existsSync(path.join(update.launcherRoot, 'active.json'))).toBe(
      false,
    );
  });

  it('does not mask a global install that changes while staging', async () => {
    const root = makeTemporaryDirectory();
    const updateRoot = path.join(root, 'updates');
    const bootstrap = writeBaseInstallation(root);
    const update = prepareManagedNpmUpdate('2.0.0', bootstrap, updateRoot);
    writeInstallation(update.stagingDir, '2.0.0');
    fs.writeFileSync(bootstrap, 'manually reinstalled launcher');

    await expect(
      activateManagedNpmUpdate(update, '2.0.0', bootstrap),
    ).rejects.toThrow('changed during update');
    expect(fs.existsSync(path.join(update.launcherRoot, 'active.json'))).toBe(
      false,
    );
  });

  it('does not replace a newer active version from another session', async () => {
    const root = makeTemporaryDirectory();
    const updateRoot = path.join(root, 'updates');
    const bootstrap = writeBaseInstallation(root);
    const newer = prepareManagedNpmUpdate('3.0.0', bootstrap, updateRoot);
    writeInstallation(newer.stagingDir, '3.0.0');
    await activateManagedNpmUpdate(newer, '3.0.0', bootstrap);
    const older = prepareManagedNpmUpdate('2.0.0', bootstrap, updateRoot);
    writeInstallation(older.stagingDir, '2.0.0');

    await activateManagedNpmUpdate(older, '2.0.0', bootstrap);

    expect(
      JSON.parse(
        fs.readFileSync(path.join(older.launcherRoot, 'active.json'), 'utf8'),
      ),
    ).toMatchObject({ version: '3.0.0' });
    expect(fs.existsSync(older.versionDir)).toBe(false);
  });

  it('publishes an existing payload during concurrent activation', async () => {
    const root = makeTemporaryDirectory();
    const updateRoot = path.join(root, 'updates');
    const bootstrap = writeBaseInstallation(root);
    const older = prepareManagedNpmUpdate('2.0.0', bootstrap, updateRoot);
    const newer = prepareManagedNpmUpdate('3.0.0', bootstrap, updateRoot);
    writeInstallation(older.stagingDir, '2.0.0');
    writeInstallation(newer.stagingDir, '3.0.0');
    const staleLock = path.join(older.launcherRoot, 'activation.lock');
    fs.mkdirSync(staleLock);
    fs.writeFileSync(
      path.join(staleLock, 'owner.json'),
      JSON.stringify({ pid: 999999, token: 'stale-owner' }),
    );
    const staleTime = new Date(Date.now() - 2 * 60 * 1000);
    fs.utimesSync(staleLock, staleTime, staleTime);

    await Promise.all([
      activateManagedNpmUpdate(older, '2.0.0', bootstrap),
      activateManagedNpmUpdate(newer, '3.0.0', bootstrap),
    ]);

    const active = JSON.parse(
      fs.readFileSync(path.join(newer.launcherRoot, 'active.json'), 'utf8'),
    ) as { version: string };
    expect(active.version).toBe('3.0.0');
    expect(
      fs.existsSync(path.join(newer.launcherRoot, 'versions', active.version)),
    ).toBe(true);
  });

  it('isolates version payloads for different global launchers', async () => {
    const root = makeTemporaryDirectory();
    const updateRoot = path.join(root, 'updates');
    const firstBootstrap = writeBaseInstallation(path.join(root, 'node-22'));
    const secondBootstrap = writeBaseInstallation(path.join(root, 'node-24'));
    const launcherRoots = new Set<string>();

    for (const bootstrap of [firstBootstrap, secondBootstrap]) {
      const update = prepareManagedNpmUpdate('2.0.0', bootstrap, updateRoot);
      writeInstallation(update.stagingDir, '2.0.0');
      await activateManagedNpmUpdate(update, '2.0.0', bootstrap);
      launcherRoots.add(update.launcherRoot);
      expect(fs.existsSync(update.versionDir)).toBe(true);
    }

    expect(launcherRoots).toHaveLength(2);
  });

  it('keeps leased versions and removes them after their process exits', async () => {
    const root = makeTemporaryDirectory();
    const updateRoot = path.join(root, 'updates');
    const bootstrap = writeBaseInstallation(root);
    const first = prepareManagedNpmUpdate('2.0.0', bootstrap, updateRoot);
    writeInstallation(first.stagingDir, '2.0.0');
    await activateManagedNpmUpdate(first, '2.0.0', bootstrap);
    const leasesDir = path.join(first.versionDir, '.leases');
    fs.mkdirSync(leasesDir);
    fs.writeFileSync(path.join(leasesDir, String(process.pid)), '');

    const second = prepareManagedNpmUpdate('3.0.0', bootstrap, updateRoot);
    writeInstallation(second.stagingDir, '3.0.0');
    await activateManagedNpmUpdate(second, '3.0.0', bootstrap);

    expect(fs.existsSync(first.versionDir)).toBe(true);
    fs.rmSync(path.join(leasesDir, String(process.pid)));

    const third = prepareManagedNpmUpdate('4.0.0', bootstrap, updateRoot);
    writeInstallation(third.stagingDir, '4.0.0');
    await activateManagedNpmUpdate(third, '4.0.0', bootstrap);

    expect(fs.existsSync(first.versionDir)).toBe(false);
    expect(fs.existsSync(second.versionDir)).toBe(false);
    expect(fs.existsSync(third.versionDir)).toBe(true);
  });

  it('retries cleanup of abandoned staging and trash directories', async () => {
    const root = makeTemporaryDirectory();
    const updateRoot = path.join(root, 'updates');
    const bootstrap = writeBaseInstallation(root);
    const update = prepareManagedNpmUpdate('2.0.0', bootstrap, updateRoot);
    writeInstallation(update.stagingDir, '2.0.0');
    const abandoned = path.join(update.launcherRoot, 'versions', '.abandoned');
    fs.mkdirSync(abandoned);
    fs.writeFileSync(path.join(abandoned, '.qwen-update-owner'), '999999');
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(abandoned, old, old);
    const trash = path.join(update.launcherRoot, '.trash-old');
    fs.mkdirSync(trash);

    await activateManagedNpmUpdate(update, '2.0.0', bootstrap);

    expect(fs.existsSync(abandoned)).toBe(false);
    expect(fs.existsSync(trash)).toBe(false);
  });

  it('removes a failed staging directory', async () => {
    const root = makeTemporaryDirectory();
    const updateRoot = path.join(root, 'updates');
    const bootstrap = writeBaseInstallation(root);
    const update = prepareManagedNpmUpdate('2.0.0', bootstrap, updateRoot);

    await cleanupManagedNpmUpdate(update);

    expect(fs.existsSync(update.stagingDir)).toBe(false);
  });
});
