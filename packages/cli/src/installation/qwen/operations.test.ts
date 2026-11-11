/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mkdtemp,
  mkdir,
  writeFile,
  symlink,
  rm,
  readFile,
  realpath,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createQwenInstallation } from './operations.js';

const mocks = vi.hoisted(() => ({
  directory: '',
  manager: 'binary',
  running: '1.0.0',
  native: vi.fn(),
  install: vi.fn(),
  update: vi.fn(),
  rollback: vi.fn(),
  cleanup: vi.fn(),
  acquire: vi.fn(),
  release: vi.fn(),
  probe: vi.fn(),
  pathDenied: false,
  windowsPath: vi.fn(),
  unixPath: vi.fn(),
}));
vi.mock('@qwen-code/core', async (original) => ({
  ...(await original<typeof import('@qwen-code/core')>()),
  getVersion: async () => mocks.running,
  isStandaloneBinary: () => true,
}));
vi.mock('../source.js', async (original) => ({
  ...(await original<typeof import('../source.js')>()),
  createInstallationSource: () => ({
    getInstallationInfo: async () => ({ packageManager: mocks.manager }),
  }),
}));
vi.mock('../update/updateLock.js', () => ({
  createUpdateLock: () => ({
    acquireLock: mocks.acquire,
    releaseLock: mocks.release,
  }),
}));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return {
    ...fs,
    realpath: async (path: string) => {
      if (
        mocks.pathDenied &&
        path === join(mocks.directory, 'versions/qwen.exe')
      )
        throw Object.assign(new Error('entry access denied'), {
          code: 'EACCES',
        });
      return fs.realpath(path);
    },
  };
});
vi.mock('node:child_process', async (original) => {
  const { promisify } = await import('node:util');
  return {
    ...(await original<typeof import('node:child_process')>()),
    execFile: Object.assign(vi.fn(), { [promisify.custom]: mocks.probe }),
  };
});
vi.mock('../install/pathConfigWindows.js', () => ({
  configurePATHWindows: mocks.windowsPath,
}));
vi.mock('../install/pathConfig.js', () => ({
  configurePATHUnix: mocks.unixPath,
}));
vi.mock('../nativeInstallationService.js', () => ({
  createNativeInstallation: mocks.native,
}));
vi.mock('./paths.js', () => ({
  getQwenReleaseBaseURL: () => 'https://qwen.example.test/1.x',
  getQwenPaths: () => ({
    dataDir: mocks.directory,
    binaryName: 'qwen',
    binDir: join(mocks.directory, 'versions'),
    linkPath:
      process.platform === 'win32'
        ? join(mocks.directory, 'versions/qwen.exe')
        : join(mocks.directory, 'bin/qwen'),
    pauseFile: join(mocks.directory, 'pause'),
    lockFile: join(mocks.directory, 'lock'),
  }),
}));
vi.mock('../update/manifest.js', async (original) => ({
  ...(await original<typeof import('../update/manifest.js')>()),
  fetchManifest: async () => ({
    latest: '1.0.1',
    files: [
      {
        os: process.platform === 'win32' ? 'windows' : process.platform,
        arch: process.arch,
        runtime: 'bun',
        url: 'https://qwen.example.test/1.x/releases/1.0.1/qwen.tar.gz',
        sha256: 'a'.repeat(64),
      },
    ],
  }),
}));
const originalPlatform = process.platform;
beforeEach(async () => {
  mocks.directory = await mkdtemp(join(tmpdir(), 'qwen-operations-'));
  await mkdir(join(mocks.directory, 'bin'));
  await mkdir(join(mocks.directory, 'versions'));
  mocks.manager = 'binary';
  mocks.running = '1.0.0';
  mocks.pathDenied = false;
  mocks.probe.mockResolvedValue({ stdout: '1.0.0\n', stderr: '' });
  mocks.windowsPath.mockResolvedValue({ modified: true, method: 'registry' });
  mocks.unixPath.mockResolvedValue({ modified: false });
  mocks.acquire.mockResolvedValue('lock');
  mocks.native.mockReturnValue({
    install: mocks.install,
    update: mocks.update,
    rollback: mocks.rollback,
    cleanup: mocks.cleanup,
  });
  mocks.install.mockResolvedValue({ version: '1.0.1', reused: false });
  mocks.rollback.mockResolvedValue({ version: '1.0.0', reused: true });
});
afterEach(async () => {
  Object.defineProperty(process, 'platform', { value: originalPlatform });
  await rm(mocks.directory, { recursive: true, force: true });
  vi.clearAllMocks();
});
describe('Qwen product orchestration', () => {
  it('reports the version selected under the lock and forwards native events', async () => {
    const onUpdateAvailable = vi.fn();
    const onNativeEvent = vi.fn();
    const event = { stage: 'download', phase: 'start' };
    mocks.update.mockImplementationOnce(async () => {
      expect(onUpdateAvailable).toHaveBeenCalledWith('1.0.0', '1.0.1');
      mocks.native.mock.calls[0][0].events(event);
    });
    await createQwenInstallation().update({
      onUpdateAvailable,
      onNativeEvent,
    });
    expect(onNativeEvent).toHaveBeenCalledWith(event);
  });

  it('uses the previous local version and pauses updates for a bare rollback', async () => {
    const installation = createQwenInstallation();
    await expect(installation.rollback()).resolves.toMatchObject({
      version: '1.0.0',
    });
    expect(mocks.rollback).toHaveBeenCalledWith({ previous: true });
    expect(await installation.isPaused()).toBe(true);
  });

  it('rolls back to an older prerelease and writes the pause', async () => {
    mocks.running = '1.0.0';
    const target = '1.0.0-nightly.20261104.9.gffffffffffff';
    mocks.rollback.mockResolvedValueOnce({ version: target, reused: true });
    const installation = createQwenInstallation();
    await expect(installation.rollback(target)).resolves.toMatchObject({
      version: target,
    });
    expect(await installation.isPaused()).toBe(true);
    const policy = mocks.native.mock.calls[0][0].policy;
    expect(policy.allows(target, 'rollback')).toBe(true);
    await expect(installation.rollback('1.0.0')).rejects.toThrow('older');
    expect(mocks.native).toHaveBeenCalledOnce();
  });
  it('does not take over a package-manager installation and always releases the lock', async () => {
    mocks.manager = 'npm';
    await expect(createQwenInstallation().update()).rejects.toThrow(
      'Native updates require a native installation (detected: npm). Use the original package manager, or reinstall with the Qwen native installer.',
    );
    expect(mocks.native).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledWith('lock');
  });
  it('does not let an old running session replace an already newer entry', async () => {
    const active = join(mocks.directory, 'versions/qwen-1.0.2');
    await writeFile(active, 'fixture');
    await symlink(active, join(mocks.directory, 'bin/qwen'));
    const onUpdateAvailable = vi.fn();
    await expect(
      createQwenInstallation().update({ onUpdateAvailable }),
    ).resolves.toEqual({
      version: '1.0.2',
      changed: false,
    });
    expect(onUpdateAvailable).not.toHaveBeenCalled();
    expect(mocks.native).not.toHaveBeenCalled();
  });
  it('allows rollback to a 0.x native version if the service finds it', async () => {
    const target = '0.26.9';
    mocks.rollback.mockResolvedValueOnce({ version: target, reused: true });
    await expect(createQwenInstallation().rollback(target)).resolves.toEqual({
      version: target,
      reused: true,
    });
    expect(mocks.native.mock.calls[0][0].policy.allows(target, 'rollback')).toBe(
      true,
    );
  });
  it('only updates to a higher version by SemVer precedence', async () => {
    mocks.running = '1.0.0-beta.9+old';
    const installation = createQwenInstallation();
    await expect(
      installation.update({ version: '1.0.0-beta.9+different' }),
    ).resolves.toEqual({ version: mocks.running, changed: false });
    await expect(
      installation.update({ version: '1.0.0-beta.10' }),
    ).resolves.toEqual({ version: '1.0.0-beta.10', changed: true });
    expect(mocks.update).toHaveBeenCalledOnce();
  });
  it('passes a lazy verified bootstrap to the common service and skips PATH when requested', async () => {
    await createQwenInstallation().install({
      version: '1.0.1',
      skipPath: true,
    });
    const options = mocks.install.mock.calls[0][0];
    expect(options.sourceMarker).toBe('curl-bash');
    await expect(options.bootstrap()).resolves.toEqual({
      version: '1.0.0',
      binaryPath: process.execPath,
    });
    expect(mocks.cleanup).toHaveBeenCalledWith('1.0.1');
  });
  it('clears a rollback pause after an explicit successful update', async () => {
    await writeFile(
      join(mocks.directory, 'pause'),
      new Date(Date.now() + 3600000).toISOString(),
    );
    const installation = createQwenInstallation();
    expect(await installation.isPaused()).toBe(true);
    await expect(installation.update()).resolves.toEqual({
      version: '1.0.1',
      changed: true,
    });
    expect(mocks.update).toHaveBeenCalledOnce();
    await expect(
      readFile(join(mocks.directory, 'pause')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('rechecks rollback pause after obtaining the installation lock', async () => {
    mocks.acquire.mockImplementationOnce(async () => {
      await writeFile(
        join(mocks.directory, 'pause'),
        new Date(Date.now() + 3600000).toISOString(),
      );
      return 'lock';
    });
    await expect(
      createQwenInstallation().update({ version: '1.0.1', automatic: true }),
    ).resolves.toEqual({ version: '1.0.0', changed: false });
    expect(mocks.native).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledWith('lock');
  });
});

describe('Qwen Windows product orchestration', () => {
  beforeEach(() =>
    Object.defineProperty(process, 'platform', { value: 'win32' }),
  );
  async function entry(version: string) {
    const binary = join(mocks.directory, 'versions/qwen.exe');
    await writeFile(binary, 'fixture');
    mocks.probe.mockResolvedValue({ stdout: version + '\n', stderr: '' });
    return binary;
  }
  it('installs through the public service and configures only the Windows user PATH', async () => {
    await createQwenInstallation().install({ version: '1.0.1' });
    expect(mocks.native.mock.calls[0][0].paths.linkPath).toBe(
      join(mocks.directory, 'versions/qwen.exe'),
    );
    expect(mocks.install.mock.calls[0][0].sourceMarker).toBe('curl-bash');
    expect(mocks.windowsPath).toHaveBeenCalledWith(
      join(mocks.directory, 'versions'),
      undefined,
    );
    expect(mocks.unixPath).not.toHaveBeenCalled();
  });
  it('honors skip-path and configures the registry for manual repair', async () => {
    const installation = createQwenInstallation();
    await installation.install({ skipPath: true });
    expect(mocks.windowsPath).not.toHaveBeenCalled();
    await expect(installation.configurePath()).resolves.toMatchObject({
      method: 'registry',
    });
    expect(mocks.windowsPath).toHaveBeenCalledOnce();
    expect(mocks.windowsPath).toHaveBeenCalledWith(
      join(mocks.directory, 'versions'),
      { rebroadcast: true },
    );
  });
  it('does not overwrite a newer copied entry from an older running process', async () => {
    const binary = await entry('1.0.2');
    await expect(createQwenInstallation().update()).resolves.toEqual({
      version: '1.0.2',
      changed: false,
    });
    expect(mocks.native).not.toHaveBeenCalled();
    expect(mocks.probe).toHaveBeenCalledWith(
      await realpath(binary),
      ['--version'],
      expect.objectContaining({ timeout: 10000, windowsHide: true }),
    );
  });
  it('updates a copied entry through the common service', async () => {
    await entry('1.0.0');
    await expect(createQwenInstallation().update()).resolves.toEqual({
      version: '1.0.1',
      changed: true,
    });
    expect(mocks.update).toHaveBeenCalledOnce();
  });
  it('compares rollback with the activated entry and preserves the pause', async () => {
    await entry('1.0.3');
    mocks.rollback.mockResolvedValueOnce({ version: '1.0.2', reused: true });
    const installation = createQwenInstallation();
    await expect(installation.rollback('1.0.2')).resolves.toMatchObject({
      version: '1.0.2',
    });
    expect(await installation.isPaused()).toBe(true);
    expect(mocks.rollback).toHaveBeenCalledOnce();
  });
  it('does not turn rollback into an upgrade after another process has rolled back', async () => {
    mocks.running = '1.0.3';
    await entry('1.0.1');
    await expect(createQwenInstallation().rollback('1.0.2')).rejects.toThrow(
      'older',
    );
    expect(mocks.native).not.toHaveBeenCalled();
  });
  it.each(['../0.26.9', 'garbage'])(
    'rejects an invalid activated version %s',
    async (version) => {
      await entry(version);
      await expect(createQwenInstallation().update()).rejects.toThrow();
      expect(mocks.native).not.toHaveBeenCalled();
      expect(mocks.release).toHaveBeenCalledWith('lock');
    },
  );
  it('aborts changes and releases the lock if the activated program cannot be queried', async () => {
    await entry('1.0.0');
    mocks.probe.mockRejectedValueOnce(new Error('probe timed out'));
    await expect(createQwenInstallation().update()).rejects.toThrow(
      'probe timed out',
    );
    expect(mocks.native).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledWith('lock');
  });
  it('does not fall back to the running version when the Windows entry is unreadable', async () => {
    await entry('1.0.2');
    mocks.pathDenied = true;
    await expect(createQwenInstallation().update()).rejects.toThrow(
      'entry access denied',
    );
    expect(mocks.probe).not.toHaveBeenCalled();
    expect(mocks.native).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledWith('lock');
  });
  it('does not execute an entry redirected outside the managed directory', async () => {
    const foreign = join(mocks.directory, 'foreign.exe');
    await writeFile(foreign, 'fixture');
    await symlink(foreign, join(mocks.directory, 'versions/qwen.exe'));
    await expect(createQwenInstallation().update()).rejects.toThrow('outside');
    expect(mocks.probe).not.toHaveBeenCalled();
  });
});
