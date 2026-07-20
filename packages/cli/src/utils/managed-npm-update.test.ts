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
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, 'package.json'),
    JSON.stringify({ name: '@qwen-code/qwen-code', version }),
  );
  fs.writeFileSync(path.join(packageRoot, 'cli.js'), '');
  fs.writeFileSync(
    path.join(packageRoot, 'cli-entry.js'),
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
  const bootstrap = path.join(packageRoot, 'cli-entry.js');
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
  it('stages an exact version for one launcher', () => {
    const root = makeTemporaryDirectory();
    const update = prepareManagedNpmUpdate(
      '2.0.0',
      writeBaseInstallation(root),
      path.join(root, 'updates'),
    );

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

  it('reclaims staging owned by a terminated process', () => {
    const root = makeTemporaryDirectory();
    const updateRoot = path.join(root, 'updates');
    const bootstrap = writeBaseInstallation(root);
    const first = prepareManagedNpmUpdate('2.0.0', bootstrap, updateRoot);
    const abandoned = path.join(
      path.dirname(first.stagingDir),
      '.2.0.0-999999999-abandoned',
    );
    fs.renameSync(first.stagingDir, abandoned);

    prepareManagedNpmUpdate('2.0.1', bootstrap, updateRoot);

    expect(fs.existsSync(abandoned)).toBe(false);
  });

  it('activates a verified install without changing running files', async () => {
    const root = makeTemporaryDirectory();
    const bootstrap = writeBaseInstallation(root);
    const runningChunk = path.join(root, 'running', 'old.js');
    fs.mkdirSync(path.dirname(runningChunk));
    fs.writeFileSync(runningChunk, 'old chunk');
    const update = prepareManagedNpmUpdate(
      '2.0.0',
      bootstrap,
      path.join(root, 'updates'),
    );
    writeInstallation(update.stagingDir, '2.0.0');

    await activateManagedNpmUpdate(update, '2.0.0', bootstrap);

    expect(fs.existsSync(update.versionDir)).toBe(true);
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

  it.each([
    ['a mismatched package', '2.0.1', undefined, 'did not match'],
    ['a failed smoke test', '2.0.0', 'broken', 'reported version broken'],
  ])('rejects %s', async (_name, installed, reported, error) => {
    const root = makeTemporaryDirectory();
    const bootstrap = writeBaseInstallation(root);
    const update = prepareManagedNpmUpdate(
      '2.0.0',
      bootstrap,
      path.join(root, 'updates'),
    );
    writeInstallation(update.stagingDir, installed);
    if (reported) {
      fs.writeFileSync(
        path.join(
          update.stagingDir,
          'node_modules',
          '@qwen-code',
          'qwen-code',
          'cli-entry.js',
        ),
        `process.stdout.write('${reported}\\n');\n`,
      );
    }

    await expect(
      activateManagedNpmUpdate(update, '2.0.0', bootstrap),
    ).rejects.toThrow(error);
    expect(fs.existsSync(path.join(update.launcherRoot, 'active.json'))).toBe(
      false,
    );
  });

  it('does not mask a global install that changes while staging', async () => {
    const root = makeTemporaryDirectory();
    const bootstrap = writeBaseInstallation(root);
    const update = prepareManagedNpmUpdate(
      '2.0.0',
      bootstrap,
      path.join(root, 'updates'),
    );
    writeInstallation(update.stagingDir, '2.0.0');
    fs.writeFileSync(bootstrap, 'manually reinstalled launcher');

    await expect(
      activateManagedNpmUpdate(update, '2.0.0', bootstrap),
    ).rejects.toThrow('changed during update');
  });

  it('replaces a higher pointer from an older global install', async () => {
    const root = makeTemporaryDirectory();
    const updateRoot = path.join(root, 'updates');
    const bootstrap = writeBaseInstallation(root);
    const oldUpdate = prepareManagedNpmUpdate('3.0.0', bootstrap, updateRoot);
    writeInstallation(oldUpdate.stagingDir, '3.0.0');
    await activateManagedNpmUpdate(oldUpdate, '3.0.0', bootstrap);

    writeBaseInstallation(root, '2.0.0');
    const newUpdate = prepareManagedNpmUpdate('2.1.0', bootstrap, updateRoot);
    writeInstallation(newUpdate.stagingDir, '2.1.0');
    await activateManagedNpmUpdate(newUpdate, '2.1.0', bootstrap);

    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(newUpdate.launcherRoot, 'active.json'),
          'utf8',
        ),
      ),
    ).toMatchObject({ version: '2.1.0', baseVersion: '2.0.0' });
  });

  it('keeps the highest concurrently activated version', async () => {
    const root = makeTemporaryDirectory();
    const updateRoot = path.join(root, 'updates');
    const bootstrap = writeBaseInstallation(root);
    const older = prepareManagedNpmUpdate('2.0.0', bootstrap, updateRoot);
    const newer = prepareManagedNpmUpdate('3.0.0', bootstrap, updateRoot);
    writeInstallation(older.stagingDir, '2.0.0');
    writeInstallation(newer.stagingDir, '3.0.0');

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

  it('isolates payloads for different launchers', async () => {
    const root = makeTemporaryDirectory();
    const updateRoot = path.join(root, 'updates');
    const launcherRoots = new Set<string>();

    for (const bootstrap of [
      writeBaseInstallation(path.join(root, 'node-22')),
      writeBaseInstallation(path.join(root, 'node-24')),
    ]) {
      const update = prepareManagedNpmUpdate('2.0.0', bootstrap, updateRoot);
      writeInstallation(update.stagingDir, '2.0.0');
      await activateManagedNpmUpdate(update, '2.0.0', bootstrap);
      launcherRoots.add(update.launcherRoot);
    }

    expect(launcherRoots).toHaveLength(2);
  });

  it('removes a failed staging directory', async () => {
    const root = makeTemporaryDirectory();
    const update = prepareManagedNpmUpdate(
      '2.0.0',
      writeBaseInstallation(root),
      path.join(root, 'updates'),
    );

    await cleanupManagedNpmUpdate(update);

    expect(fs.existsSync(update.stagingDir)).toBe(false);
  });
});
