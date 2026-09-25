/**
 * @license
 * Copyright 2026 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// The heal reports a chmod failure through the debug logger, which writes
// nowhere unless a session is bound — and the update worker binds none. Spy on
// it so both halves of the contract ("did not block the update" and "was
// reported") are assertable.
const { mockDebugLogger } = vi.hoisted(() => ({
  mockDebugLogger: {
    isEnabled: vi.fn().mockReturnValue(false),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock('@qwen-code/qwen-code-core/utils/debugLogger.js', () => ({
  createDebugLogger: () => mockDebugLogger,
}));

import {
  activateManagedNpmUpdate,
  cleanupManagedNpmUpdate,
  installManagedNpmUpdate,
  prepareManagedNpmUpdate,
} from './managed-npm-update.js';
import { EventEmitter } from 'node:events';
import type { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mockCompromisedLock } from '../test-utils/mock-compromised-lock.js';

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

function vendoredRipgrepDir(prefix: string): string {
  return path.join(
    prefix,
    'node_modules',
    '@qwen-code',
    'qwen-code',
    'vendor',
    'ripgrep',
  );
}

// Mirror the published tarball: pnpm pack normalizes every non-`bin` file to
// 0644, including the vendored ripgrep binaries (#12668). The win32 directory
// ships rg.exe instead of rg and must not fail activation, and COPYING is the
// non-directory entry the real tree carries beside the platform directories.
function writeVendoredRipgrep(prefix: string): string {
  const ripgrepDir = vendoredRipgrepDir(prefix);
  for (const platform of ['x64-linux', 'arm64-darwin', 'x64-win32']) {
    fs.mkdirSync(path.join(ripgrepDir, platform), { recursive: true });
  }
  for (const binary of ['x64-linux/rg', 'arm64-darwin/rg']) {
    const filePath = path.join(ripgrepDir, binary);
    fs.writeFileSync(filePath, 'fake rg');
    fs.chmodSync(filePath, 0o644);
  }
  fs.writeFileSync(path.join(ripgrepDir, 'x64-win32', 'rg.exe'), 'fake');
  fs.writeFileSync(path.join(ripgrepDir, 'COPYING'), 'license');
  return ripgrepDir;
}

// Windows has no POSIX mode bits; stat reports 0o666 for a writable regular
// file, so the exec-bit assertion is only meaningful on the POSIX installs
// this heals. Guarding the assertion rather than the case keeps the win32
// fixture above — the only coverage of the ENOENT swallow — running everywhere.
function expectExecBit(filePath: string): void {
  if (process.platform !== 'win32') {
    expect(fs.statSync(filePath).mode & 0o111).not.toBe(0);
  }
}

// Rewind an activated payload to the state a build without the heal leaves it
// in, so the heal of an already-adopted version directory is observable.
function clearVendoredRipgrepExecBits(prefix: string): void {
  for (const binary of ['x64-linux/rg', 'arm64-darwin/rg']) {
    fs.chmodSync(path.join(vendoredRipgrepDir(prefix), binary), 0o644);
  }
}

beforeEach(() => {
  vi.stubEnv('NPM_CONFIG_GLOBALCONFIG', '/global/npmrc');
  mockDebugLogger.warn.mockClear();
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
      path.resolve('/global/npmrc'),
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

  it('restores the exec bit on vendored ripgrep binaries during activation', async () => {
    const root = makeTemporaryDirectory();
    const bootstrap = writeBaseInstallation(root);
    const update = prepareManagedNpmUpdate(
      '2.0.0',
      bootstrap,
      path.join(root, 'updates'),
    );
    writeInstallation(update.stagingDir, '2.0.0');
    writeVendoredRipgrep(update.stagingDir);

    await activateManagedNpmUpdate(update, '2.0.0', bootstrap);

    const activatedRipgrep = vendoredRipgrepDir(update.versionDir);
    for (const binary of ['x64-linux/rg', 'arm64-darwin/rg']) {
      expectExecBit(path.join(activatedRipgrep, binary));
    }
    // COPYING is the non-directory entry the published tree carries beside the
    // platform directories, and the heal must skip it: chmod'ing `COPYING/rg`
    // fails ENOTDIR, which is not the ENOENT the win32 layout produces, so it
    // takes the reporting branch.
    expect(mockDebugLogger.warn).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === 'win32')(
    'still activates when restoring the exec bit fails with a non-ENOENT error',
    async () => {
      const root = makeTemporaryDirectory();
      const bootstrap = writeBaseInstallation(root);
      const update = prepareManagedNpmUpdate(
        '2.0.0',
        bootstrap,
        path.join(root, 'updates'),
      );
      writeInstallation(update.stagingDir, '2.0.0');
      const stagedRipgrep = writeVendoredRipgrep(update.stagingDir);
      // A self-referential symlink makes chmod fail ELOOP: a non-ENOENT errno
      // that needs neither a read-only mount nor a non-root uid, so it behaves
      // the same on a laptop and on CI.
      const looped = path.join(stagedRipgrep, 'x64-linux', 'rg');
      fs.rmSync(looped);
      fs.symlinkSync('rg', looped);

      // A binary that cannot be chmod'ed must not turn into a failed
      // self-update: a non-zero worker exit is reported as `update-failed`.
      await expect(
        activateManagedNpmUpdate(update, '2.0.0', bootstrap),
      ).resolves.toBeUndefined();

      expect(
        JSON.parse(
          fs.readFileSync(
            path.join(update.launcherRoot, 'active.json'),
            'utf8',
          ),
        ),
      ).toMatchObject({ version: '2.0.0' });
      const activatedRipgrep = vendoredRipgrepDir(update.versionDir);
      // Reported rather than swallowed, and the loop still heals the rest.
      expect(mockDebugLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to chmod'),
        expect.objectContaining({ code: 'ELOOP' }),
      );
      expectExecBit(path.join(activatedRipgrep, 'arm64-darwin', 'rg'));
    },
  );

  it('heals the payload it adopts when the rename collides', async () => {
    const root = makeTemporaryDirectory();
    const bootstrap = writeBaseInstallation(root);
    const updateRoot = path.join(root, 'updates');
    const adopted = prepareManagedNpmUpdate('2.0.0', bootstrap, updateRoot);
    writeInstallation(adopted.versionDir, '2.0.0');
    writeVendoredRipgrep(adopted.versionDir);
    const staged = prepareManagedNpmUpdate('2.0.0', bootstrap, updateRoot);
    writeInstallation(staged.stagingDir, '2.0.0');
    writeVendoredRipgrep(staged.stagingDir);

    await activateManagedNpmUpdate(staged, '2.0.0', bootstrap);

    // The freshly healed staging tree is discarded, so the surviving payload
    // has to be healed in its place — otherwise the pointer keeps naming a
    // 0644 tree and no further update fires for this version.
    expect(staged.versionDir).toBe(adopted.versionDir);
    expect(fs.existsSync(staged.stagingDir)).toBe(false);
    expect(
      JSON.parse(
        fs.readFileSync(path.join(staged.launcherRoot, 'active.json'), 'utf8'),
      ),
    ).toMatchObject({ version: '2.0.0' });
    expectExecBit(
      path.join(vendoredRipgrepDir(staged.versionDir), 'x64-linux', 'rg'),
    );
  });

  it('heals the higher version it keeps pointing at', async () => {
    const root = makeTemporaryDirectory();
    const bootstrap = writeBaseInstallation(root);
    const updateRoot = path.join(root, 'updates');
    const newer = prepareManagedNpmUpdate('3.0.0', bootstrap, updateRoot);
    writeInstallation(newer.stagingDir, '3.0.0');
    writeVendoredRipgrep(newer.stagingDir);
    await activateManagedNpmUpdate(newer, '3.0.0', bootstrap);
    clearVendoredRipgrepExecBits(newer.versionDir);

    const older = prepareManagedNpmUpdate('2.0.0', bootstrap, updateRoot);
    writeInstallation(older.stagingDir, '2.0.0');
    await activateManagedNpmUpdate(older, '2.0.0', bootstrap);

    // The pointer stays on 3.0.0 and that directory is what the launcher runs,
    // so it is the one that has to come out healed.
    expect(
      JSON.parse(
        fs.readFileSync(path.join(older.launcherRoot, 'active.json'), 'utf8'),
      ),
    ).toMatchObject({ version: '3.0.0' });
    expectExecBit(
      path.join(vendoredRipgrepDir(newer.versionDir), 'x64-linux', 'rg'),
    );
  });

  it('still activates when the lock is compromised during activation', async () => {
    const root = makeTemporaryDirectory();
    const bootstrap = writeBaseInstallation(root);
    const update = prepareManagedNpmUpdate(
      '2.0.0',
      bootstrap,
      path.join(root, 'updates'),
    );
    writeInstallation(update.stagingDir, '2.0.0');

    const { lockSpy, getOnCompromised } = mockCompromisedLock();

    try {
      await expect(
        activateManagedNpmUpdate(update, '2.0.0', bootstrap),
      ).resolves.toBeUndefined();
      expect(getOnCompromised()).toBeTypeOf('function');
      expect(
        JSON.parse(
          fs.readFileSync(
            path.join(update.launcherRoot, 'active.json'),
            'utf8',
          ),
        ),
      ).toMatchObject({ version: '2.0.0' });
    } finally {
      lockSpy.mockRestore();
    }
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
        path.resolve('/global/npmrc'),
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

  it('removes only orphaned managed update artifacts before staging', () => {
    const root = makeTemporaryDirectory();
    const bootstrap = writeBaseInstallation(root);
    const updateRoot = path.join(root, 'updates');
    const current = prepareManagedNpmUpdate('2.0.0', bootstrap, updateRoot);
    const versionsDir = path.dirname(current.stagingDir);
    const missingPid = 999999999;
    const staleStagingDir = fs.mkdtempSync(
      path.join(versionsDir, `.2.1.0-${missingPid}-`),
    );
    const staleActiveFile = path.join(
      current.launcherRoot,
      `active.json.${missingPid}`,
    );
    const activeStagingDir = fs.mkdtempSync(
      path.join(versionsDir, `.2.2.0-${process.pid}-`),
    );
    const activeTemporaryFile = path.join(
      current.launcherRoot,
      `active.json.${process.pid}`,
    );
    const versionDir = path.join(versionsDir, '1.0.0');
    const unknownDir = path.join(versionsDir, 'unrelated');
    const nonSemverDir = path.join(
      versionsDir,
      `.not-semver-${missingPid}-abc123`,
    );
    const stagingSymlink = path.join(
      versionsDir,
      `.2.3.0-${missingPid}-abcdef`,
    );
    fs.writeFileSync(staleActiveFile, 'stale');
    fs.writeFileSync(activeTemporaryFile, 'active');
    fs.mkdirSync(versionDir);
    fs.mkdirSync(unknownDir);
    fs.mkdirSync(nonSemverDir);
    fs.symlinkSync(
      versionDir,
      stagingSymlink,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid) => {
      if (pid === missingPid) {
        const error = new Error('process not found') as NodeJS.ErrnoException;
        error.code = 'ESRCH';
        throw error;
      }
      return true;
    });
    try {
      prepareManagedNpmUpdate('3.0.0', bootstrap, updateRoot);

      expect(fs.existsSync(staleStagingDir)).toBe(false);
      expect(fs.existsSync(staleActiveFile)).toBe(false);
      expect(fs.existsSync(current.stagingDir)).toBe(true);
      expect(fs.existsSync(activeStagingDir)).toBe(true);
      expect(fs.existsSync(activeTemporaryFile)).toBe(true);
      expect(fs.existsSync(versionDir)).toBe(true);
      expect(fs.existsSync(unknownDir)).toBe(true);
      expect(fs.existsSync(nonSemverDir)).toBe(true);
      expect(fs.existsSync(stagingSymlink)).toBe(true);
    } finally {
      kill.mockRestore();
    }
  });

  it('keeps artifacts when process liveness is uncertain', () => {
    const root = makeTemporaryDirectory();
    const bootstrap = writeBaseInstallation(root);
    const updateRoot = path.join(root, 'updates');
    const current = prepareManagedNpmUpdate('2.0.0', bootstrap, updateRoot);
    const versionsDir = path.dirname(current.stagingDir);
    const inaccessiblePid = 888888888;
    const stagingDir = fs.mkdtempSync(
      path.join(versionsDir, `.2.1.0-${inaccessiblePid}-`),
    );
    const temporaryActiveFile = path.join(
      current.launcherRoot,
      `active.json.${inaccessiblePid}`,
    );
    fs.writeFileSync(temporaryActiveFile, 'unverified');
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      const error = new Error('permission denied') as NodeJS.ErrnoException;
      error.code = 'EPERM';
      throw error;
    });
    try {
      prepareManagedNpmUpdate('3.0.0', bootstrap, updateRoot);

      expect(fs.existsSync(stagingDir)).toBe(true);
      expect(fs.existsSync(temporaryActiveFile)).toBe(true);
    } finally {
      kill.mockRestore();
    }
  });
});
