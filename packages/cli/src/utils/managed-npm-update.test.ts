/**
 * @license
 * Copyright 2026 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  activateManagedNpmUpdate,
  cleanupManagedNpmUpdate,
  installManagedNpmUpdate,
  prepareManagedNpmUpdate,
} from './managed-npm-update.js';
import { EventEmitter } from 'node:events';
import type { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

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
    `if (process.argv.includes('--version')) process.stdout.write('${version}\\n'); else await import('./cli.js');\n`,
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

beforeEach(() => {
  vi.stubEnv('NPM_CONFIG_GLOBALCONFIG', '/global/npmrc');
});

afterEach(() => {
  vi.unstubAllEnvs();
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
      '--globalconfig',
      '/global/npmrc',
      '--prefix',
      update.stagingDir,
      '--global=false',
      '--no-save',
      '--package-lock=false',
      '--no-audit',
      '--no-fund',
      '@qwen-code/qwen-code@2.0.0',
    ]);
    expect(update.versionDir).toBe(
      path.join(update.launcherRoot, 'versions', '2.0.0'),
    );
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

  it('installs and activates inside the managed worker', async () => {
    const root = makeTemporaryDirectory();
    const bootstrap = writeBaseInstallation(root);
    const updateRoot = path.join(root, 'updates');
    vi.stubEnv('NPM_CONFIG_USERCONFIG', 'config/npmrc');
    const spawnFn = vi.fn(
      (
        _command: string,
        args: readonly string[],
        _options: object,
      ): ReturnType<typeof spawn> => {
        const prefix = args[args.indexOf('--prefix') + 1]!;
        writeInstallation(prefix, '2.0.0');
        const child = new EventEmitter();
        queueMicrotask(() => child.emit('close', 0));
        return child as ReturnType<typeof spawn>;
      },
    );

    await installManagedNpmUpdate(
      '2.0.0',
      bootstrap,
      updateRoot,
      spawnFn as unknown as typeof spawn,
    );

    expect(spawnFn).toHaveBeenCalledWith(
      process.execPath,
      [
        expect.stringMatching(/npm-cli\.js$/),
        'install',
        '--globalconfig',
        '/global/npmrc',
        '--prefix',
        expect.any(String),
        '--global=false',
        '--no-save',
        '--package-lock=false',
        '--no-audit',
        '--no-fund',
        '@qwen-code/qwen-code@2.0.0',
      ],
      expect.objectContaining({
        env: expect.objectContaining({
          NPM_CONFIG_USERCONFIG: path.resolve('config/npmrc'),
        }),
        stdio: ['ignore', 'ignore', 'inherit'],
        timeout: 10 * 60_000,
        windowsHide: true,
      }),
    );
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(
            updateRoot,
            createHash('sha256')
              .update(fs.realpathSync(bootstrap))
              .digest('hex')
              .slice(0, 16),
            'active.json',
          ),
          'utf8',
        ),
      ),
    ).toMatchObject({ version: '2.0.0' });
  });

  it.each([
    ['a mismatched package', '2.0.1', false, 'did not match'],
    ['a failed smoke test', '2.0.0', true, 'Command failed'],
  ])('rejects %s', async (_name, installed, brokenBundle, error) => {
    const root = makeTemporaryDirectory();
    const bootstrap = writeBaseInstallation(root);
    const update = prepareManagedNpmUpdate(
      '2.0.0',
      bootstrap,
      path.join(root, 'updates'),
    );
    writeInstallation(update.stagingDir, installed);
    if (brokenBundle) {
      fs.writeFileSync(
        path.join(
          update.stagingDir,
          'node_modules',
          '@qwen-code',
          'qwen-code',
          'cli.js',
        ),
        'this is not valid JavaScript !!!\n',
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
    writeBaseInstallation(root, '1.1.0');

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

  it('reuses a valid payload activated concurrently for the same version', async () => {
    const root = makeTemporaryDirectory();
    const updateRoot = path.join(root, 'updates');
    const bootstrap = writeBaseInstallation(root);
    const first = prepareManagedNpmUpdate('2.0.0', bootstrap, updateRoot);
    const second = prepareManagedNpmUpdate('2.0.0', bootstrap, updateRoot);
    writeInstallation(first.stagingDir, '2.0.0');
    writeInstallation(second.stagingDir, '2.0.0');

    await Promise.all([
      activateManagedNpmUpdate(first, '2.0.0', bootstrap),
      activateManagedNpmUpdate(second, '2.0.0', bootstrap),
    ]);

    expect(
      JSON.parse(
        fs.readFileSync(path.join(first.launcherRoot, 'active.json'), 'utf8'),
      ),
    ).toMatchObject({ version: '2.0.0' });
    expect(fs.existsSync(first.versionDir)).toBe(true);
    expect(fs.existsSync(first.stagingDir)).toBe(false);
    expect(fs.existsSync(second.stagingDir)).toBe(false);
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
