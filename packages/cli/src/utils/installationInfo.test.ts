/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getInstallationInfo, PackageManager } from './installationInfo.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';
import { isGitRepository } from '@qwen-code/qwen-code-core';

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...actual,
    isGitRepository: vi.fn(),
  };
});

vi.mock('fs', async (importOriginal) => {
  const actualFs = await importOriginal<typeof fs>();
  return {
    ...actualFs,
    realpathSync: vi.fn(),
    existsSync: vi.fn(),
    lstatSync: vi.fn(),
    readFileSync: vi.fn(),
    accessSync: vi.fn(),
  };
});

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execSync: vi.fn(),
  };
});

const mockedIsGitRepository = vi.mocked(isGitRepository);
const mockedRealPathSync = vi.mocked(fs.realpathSync);
const mockedExistsSync = vi.mocked(fs.existsSync);
const mockedLstatSync = vi.mocked(fs.lstatSync);
const mockedReadFileSync = vi.mocked(fs.readFileSync);
const mockedExecSync = vi.mocked(childProcess.execSync);

describe('getInstallationInfo', () => {
  const projectRoot = '/path/to/project';
  let originalArgv: string[];
  let originalPlatform: PropertyDescriptor | undefined;

  const setPlatform = (platform: NodeJS.Platform) => {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: platform,
    });
  };

  const fileStats = (mode = 0o755): fs.Stats =>
    ({
      isFile: () => true,
      isSymbolicLink: () => false,
      mode,
    }) as fs.Stats;

  const symlinkStats = (): fs.Stats =>
    ({
      isFile: () => true,
      isSymbolicLink: () => true,
      mode: 0o755,
    }) as fs.Stats;

  beforeEach(() => {
    vi.resetAllMocks();
    originalArgv = [...process.argv];
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    // Mock process.cwd() for isGitRepository
    vi.spyOn(process, 'cwd').mockReturnValue(projectRoot);
  });

  afterEach(() => {
    process.argv = originalArgv;
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform);
    }
  });

  it('should return UNKNOWN when cliPath is not available', () => {
    process.argv[1] = '';
    const info = getInstallationInfo(projectRoot, false);
    expect(info.packageManager).toBe(PackageManager.UNKNOWN);
  });

  it('should return UNKNOWN if realpathSync fails', () => {
    process.argv[1] = '/path/to/cli';
    const error = new Error('realpath failed');
    mockedRealPathSync.mockImplementation(() => {
      throw error;
    });

    const info = getInstallationInfo(projectRoot, false);

    expect(info.packageManager).toBe(PackageManager.UNKNOWN);
  });

  it('should detect running from a local git clone', () => {
    process.argv[1] = `${projectRoot}/packages/cli/dist/index.js`;
    mockedRealPathSync.mockReturnValue(
      `${projectRoot}/packages/cli/dist/index.js`,
    );
    mockedIsGitRepository.mockReturnValue(true);

    const info = getInstallationInfo(projectRoot, false);

    expect(info.packageManager).toBe(PackageManager.UNKNOWN);
    expect(info.isGlobal).toBe(false);
    expect(info.updateMessage).toBe(
      'Running from a local git clone. Please update with "git pull".',
    );
  });

  it('should detect running via npx', () => {
    const npxPath = `/Users/test/.npm/_npx/12345/bin/gemini`;
    process.argv[1] = npxPath;
    mockedRealPathSync.mockReturnValue(npxPath);

    const info = getInstallationInfo(projectRoot, false);

    expect(info.packageManager).toBe(PackageManager.NPX);
    expect(info.isGlobal).toBe(false);
    expect(info.updateMessage).toBe('Running via npx, update not applicable.');
  });

  it('should detect running via pnpx', () => {
    const pnpxPath = `/Users/test/.pnpm/_pnpx/12345/bin/gemini`;
    process.argv[1] = pnpxPath;
    mockedRealPathSync.mockReturnValue(pnpxPath);

    const info = getInstallationInfo(projectRoot, false);

    expect(info.packageManager).toBe(PackageManager.PNPX);
    expect(info.isGlobal).toBe(false);
    expect(info.updateMessage).toBe('Running via pnpx, update not applicable.');
  });

  it('should detect running via bunx', () => {
    const bunxPath = `/Users/test/.bun/install/cache/12345/bin/gemini`;
    process.argv[1] = bunxPath;
    mockedRealPathSync.mockReturnValue(bunxPath);
    mockedExecSync.mockImplementation(() => {
      throw new Error('Command failed');
    });

    const info = getInstallationInfo(projectRoot, false);

    expect(info.packageManager).toBe(PackageManager.BUNX);
    expect(info.isGlobal).toBe(false);
    expect(info.updateMessage).toBe('Running via bunx, update not applicable.');
  });

  it('should detect standalone installs and avoid npm auto-update', () => {
    setPlatform('linux');
    const installDir = '/Users/test/.local/lib/qwen-code';
    const cliPath = `${installDir}/lib/cli.js`;
    process.argv[1] = cliPath;
    mockedRealPathSync.mockReturnValue(cliPath);
    mockedExistsSync.mockImplementation((candidate) =>
      [
        path.join(installDir, 'manifest.json'),
        path.join(installDir, 'bin', 'qwen'),
        path.join(installDir, 'node', 'bin', 'node'),
      ].includes(String(candidate)),
    );
    mockedReadFileSync.mockImplementation((candidate) => {
      if (candidate === path.join(installDir, 'manifest.json')) {
        return JSON.stringify({
          name: '@qwen-code/qwen-code',
          target: 'linux-x64',
        });
      }
      throw new Error(`Unexpected read: ${candidate}`);
    });
    mockedLstatSync.mockImplementation((candidate) => {
      if (
        [
          path.join(installDir, 'bin', 'qwen'),
          path.join(installDir, 'node', 'bin', 'node'),
        ].includes(String(candidate))
      ) {
        return fileStats();
      }
      throw new Error(`Unexpected lstat: ${candidate}`);
    });

    const info = getInstallationInfo(projectRoot, true);

    expect(info.packageManager).toBe(PackageManager.STANDALONE);
    expect(info.isGlobal).toBe(true);
    expect(info.isStandalone).toBe(true);
    expect(info.standaloneDir).toBe(installDir);
    expect(info.updateCommand).toBeUndefined();
    expect(info.updateMessage).toContain('Standalone install detected');
    expect(info.updateMessage).not.toContain('npm install');
  });

  it('should detect Windows standalone installs and avoid npm auto-update', () => {
    setPlatform('win32');
    const installDir = 'C:/Users/test/AppData/Local/qwen-code';
    const cliPath = `${installDir}/lib/cli.js`;
    process.argv[1] = cliPath;
    mockedRealPathSync.mockReturnValue(cliPath);
    mockedExistsSync.mockImplementation((candidate) =>
      [
        `${installDir}/manifest.json`,
        `${installDir}/bin/qwen.cmd`,
        `${installDir}/node/node.exe`,
      ].includes(String(candidate).replace(/\\/g, '/')),
    );
    mockedReadFileSync.mockImplementation((candidate) => {
      if (
        String(candidate).replace(/\\/g, '/') === `${installDir}/manifest.json`
      ) {
        return JSON.stringify({
          name: '@qwen-code/qwen-code',
          target: 'win-x64',
        });
      }
      throw new Error(`Unexpected read: ${candidate}`);
    });
    mockedLstatSync.mockImplementation((candidate) => {
      if (
        [`${installDir}/bin/qwen.cmd`, `${installDir}/node/node.exe`].includes(
          String(candidate).replace(/\\/g, '/'),
        )
      ) {
        return fileStats(0o644);
      }
      throw new Error(`Unexpected lstat: ${candidate}`);
    });

    const info = getInstallationInfo(projectRoot, true);

    expect(info.packageManager).toBe(PackageManager.STANDALONE);
    expect(info.isStandalone).toBe(true);
    expect(info.standaloneDir).toBe(installDir);
    expect(info.updateCommand).toBeUndefined();
    expect(info.updateMessage).toContain('Standalone install detected');
    expect(info.updateMessage).not.toContain('npm install');
  });

  it('should detect macOS standalone installs and avoid npm auto-update', () => {
    setPlatform('darwin');
    const installDir = '/Users/test/.local/lib/qwen-code';
    const cliPath = `${installDir}/lib/cli.js`;
    process.argv[1] = cliPath;
    mockedRealPathSync.mockReturnValue(cliPath);
    mockedExistsSync.mockImplementation((candidate) =>
      [
        path.join(installDir, 'manifest.json'),
        path.join(installDir, 'bin', 'qwen'),
        path.join(installDir, 'node', 'bin', 'node'),
      ].includes(String(candidate)),
    );
    mockedReadFileSync.mockImplementation((candidate) => {
      if (candidate === path.join(installDir, 'manifest.json')) {
        return JSON.stringify({
          name: '@qwen-code/qwen-code',
          target: 'darwin-arm64',
        });
      }
      throw new Error(`Unexpected read: ${candidate}`);
    });
    mockedLstatSync.mockImplementation((candidate) => {
      if (
        [
          path.join(installDir, 'bin', 'qwen'),
          path.join(installDir, 'node', 'bin', 'node'),
        ].includes(String(candidate))
      ) {
        return fileStats();
      }
      throw new Error(`Unexpected lstat: ${candidate}`);
    });

    const info = getInstallationInfo(projectRoot, true);

    expect(info.packageManager).toBe(PackageManager.STANDALONE);
    expect(info.isGlobal).toBe(true);
    expect(info.isStandalone).toBe(true);
    expect(info.standaloneDir).toBe(installDir);
    expect(info.updateMessage).toContain('Standalone install detected');
  });

  it('should fall back to npm when manifest.json is malformed', () => {
    setPlatform('linux');
    const installDir = '/Users/test/.local/lib/qwen-code';
    const cliPath = `${installDir}/lib/cli.js`;
    process.argv[1] = cliPath;
    mockedRealPathSync.mockReturnValue(cliPath);
    mockedExistsSync.mockImplementation((candidate) =>
      [
        path.join(installDir, 'manifest.json'),
        path.join(installDir, 'bin', 'qwen'),
        path.join(installDir, 'node', 'bin', 'node'),
      ].includes(String(candidate)),
    );
    mockedReadFileSync.mockReturnValue('{invalid json');
    mockedLstatSync.mockReturnValue(fileStats());

    const info = getInstallationInfo(projectRoot, true);

    expect(info.packageManager).toBe(PackageManager.NPM);
    expect(info.updateCommand).toBe(
      'npm install -g @qwen-code/qwen-code@latest',
    );
  });

  it('should ignore standalone-like installs for the wrong target', () => {
    setPlatform('linux');
    const installDir = '/Users/test/.local/lib/qwen-code';
    const cliPath = `${installDir}/lib/cli.js`;
    process.argv[1] = cliPath;
    mockedRealPathSync.mockReturnValue(cliPath);
    mockedExistsSync.mockImplementation((candidate) =>
      [
        path.join(installDir, 'manifest.json'),
        path.join(installDir, 'bin', 'qwen'),
        path.join(installDir, 'node', 'bin', 'node'),
      ].includes(String(candidate)),
    );
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        name: '@qwen-code/qwen-code',
        target: 'win-x64',
      }),
    );
    mockedLstatSync.mockReturnValue(fileStats());

    const info = getInstallationInfo(projectRoot, true);

    expect(info.packageManager).toBe(PackageManager.NPM);
    expect(info.updateCommand).toBe(
      'npm install -g @qwen-code/qwen-code@latest',
    );
  });

  it('should ignore standalone-like installs with symlinked runtime files', () => {
    setPlatform('linux');
    const installDir = '/Users/test/.local/lib/qwen-code';
    const cliPath = `${installDir}/lib/cli.js`;
    process.argv[1] = cliPath;
    mockedRealPathSync.mockReturnValue(cliPath);
    mockedExistsSync.mockImplementation((candidate) =>
      [
        path.join(installDir, 'manifest.json'),
        path.join(installDir, 'bin', 'qwen'),
        path.join(installDir, 'node', 'bin', 'node'),
      ].includes(String(candidate)),
    );
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        name: '@qwen-code/qwen-code',
        target: 'linux-x64',
      }),
    );
    mockedLstatSync.mockImplementation((candidate) => {
      if (candidate === path.join(installDir, 'bin', 'qwen')) {
        return symlinkStats();
      }
      return fileStats();
    });

    const info = getInstallationInfo(projectRoot, true);

    expect(info.packageManager).toBe(PackageManager.NPM);
  });

  it('should ignore Unix standalone-like installs with non-executable runtime files', () => {
    setPlatform('linux');
    const installDir = '/Users/test/.local/lib/qwen-code';
    const cliPath = `${installDir}/lib/cli.js`;
    process.argv[1] = cliPath;
    mockedRealPathSync.mockReturnValue(cliPath);
    mockedExistsSync.mockImplementation((candidate) =>
      [
        path.join(installDir, 'manifest.json'),
        path.join(installDir, 'bin', 'qwen'),
        path.join(installDir, 'node', 'bin', 'node'),
      ].includes(String(candidate)),
    );
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        name: '@qwen-code/qwen-code',
        target: 'linux-x64',
      }),
    );
    mockedLstatSync.mockImplementation((candidate) => {
      if (candidate === path.join(installDir, 'bin', 'qwen')) {
        return fileStats(0o644);
      }
      return fileStats();
    });

    const info = getInstallationInfo(projectRoot, true);

    expect(info.packageManager).toBe(PackageManager.NPM);
  });

  it('should detect Homebrew installation via execSync', () => {
    setPlatform('darwin');
    const cliPath = '/usr/local/bin/gemini';
    process.argv[1] = cliPath;
    mockedRealPathSync.mockReturnValue(cliPath);
    mockedExecSync.mockReturnValue(Buffer.from('gemini-cli')); // Simulate successful command

    const info = getInstallationInfo(projectRoot, false);

    expect(mockedExecSync).toHaveBeenCalledWith(
      'brew list -1 | grep -q "^qwen-code$"',
      { stdio: 'ignore' },
    );
    expect(info.packageManager).toBe(PackageManager.HOMEBREW);
    expect(info.isGlobal).toBe(true);
    expect(info.updateMessage).toContain('brew upgrade');
  });

  it('should fall through if brew command fails', () => {
    setPlatform('darwin');
    const cliPath = '/usr/local/bin/gemini';
    process.argv[1] = cliPath;
    mockedRealPathSync.mockReturnValue(cliPath);
    mockedExecSync.mockImplementation(() => {
      throw new Error('Command failed');
    });

    const info = getInstallationInfo(projectRoot, false);

    expect(mockedExecSync).toHaveBeenCalledWith(
      'brew list -1 | grep -q "^qwen-code$"',
      { stdio: 'ignore' },
    );
    // Should fall back to default global npm
    expect(info.packageManager).toBe(PackageManager.NPM);
    expect(info.isGlobal).toBe(true);
  });

  it('should detect global pnpm installation', () => {
    const pnpmPath = `/Users/test/.pnpm/global/5/node_modules/.pnpm/some-hash/node_modules/@qwen-code/qwen-code/dist/index.js`;
    process.argv[1] = pnpmPath;
    mockedRealPathSync.mockReturnValue(pnpmPath);
    mockedExecSync.mockImplementation(() => {
      throw new Error('Command failed');
    });

    // isAutoUpdateEnabled = true -> "Attempting to automatically update"
    const info = getInstallationInfo(projectRoot, true);
    expect(info.packageManager).toBe(PackageManager.PNPM);
    expect(info.isGlobal).toBe(true);
    expect(info.updateCommand).toBe('pnpm add -g @qwen-code/qwen-code@latest');
    expect(info.updateMessage).toContain('Attempting to automatically update');

    // isAutoUpdateEnabled = false -> "Please run..."
    const infoDisabled = getInstallationInfo(projectRoot, false);
    expect(infoDisabled.updateMessage).toContain('Please run pnpm add');
  });

  it('should detect global yarn installation', () => {
    const yarnPath = `/Users/test/.yarn/global/node_modules/@qwen-code/qwen-code/dist/index.js`;
    process.argv[1] = yarnPath;
    mockedRealPathSync.mockReturnValue(yarnPath);
    mockedExecSync.mockImplementation(() => {
      throw new Error('Command failed');
    });

    // isAutoUpdateEnabled = true -> "Attempting to automatically update"
    const info = getInstallationInfo(projectRoot, true);
    expect(info.packageManager).toBe(PackageManager.YARN);
    expect(info.isGlobal).toBe(true);
    expect(info.updateCommand).toBe(
      'yarn global add @qwen-code/qwen-code@latest',
    );
    expect(info.updateMessage).toContain('Attempting to automatically update');

    // isAutoUpdateEnabled = false -> "Please run..."
    const infoDisabled = getInstallationInfo(projectRoot, false);
    expect(infoDisabled.updateMessage).toContain('Please run yarn global add');
  });

  it('should detect global bun installation', () => {
    const bunPath = `/Users/test/.bun/bin/gemini`;
    process.argv[1] = bunPath;
    mockedRealPathSync.mockReturnValue(bunPath);
    mockedExecSync.mockImplementation(() => {
      throw new Error('Command failed');
    });

    // isAutoUpdateEnabled = true -> "Attempting to automatically update"
    const info = getInstallationInfo(projectRoot, true);
    expect(info.packageManager).toBe(PackageManager.BUN);
    expect(info.isGlobal).toBe(true);
    expect(info.updateCommand).toBe('bun add -g @qwen-code/qwen-code@latest');
    expect(info.updateMessage).toContain('Attempting to automatically update');

    // isAutoUpdateEnabled = false -> "Please run..."
    const infoDisabled = getInstallationInfo(projectRoot, false);
    expect(infoDisabled.updateMessage).toContain('Please run bun add');
  });

  it('should detect local installation and identify yarn from lockfile', () => {
    const localPath = `${projectRoot}/node_modules/.bin/gemini`;
    process.argv[1] = localPath;
    mockedRealPathSync.mockReturnValue(localPath);
    mockedExecSync.mockImplementation(() => {
      throw new Error('Command failed');
    });
    mockedExistsSync.mockImplementation(
      (p) => p === path.join(projectRoot, 'yarn.lock'),
    );

    const info = getInstallationInfo(projectRoot, false);

    expect(info.packageManager).toBe(PackageManager.YARN);
    expect(info.isGlobal).toBe(false);
    expect(info.updateMessage).toContain('Locally installed');
  });

  it('should detect local installation and identify pnpm from lockfile', () => {
    const localPath = `${projectRoot}/node_modules/.bin/gemini`;
    process.argv[1] = localPath;
    mockedRealPathSync.mockReturnValue(localPath);
    mockedExecSync.mockImplementation(() => {
      throw new Error('Command failed');
    });
    mockedExistsSync.mockImplementation(
      (p) => p === path.join(projectRoot, 'pnpm-lock.yaml'),
    );

    const info = getInstallationInfo(projectRoot, false);

    expect(info.packageManager).toBe(PackageManager.PNPM);
    expect(info.isGlobal).toBe(false);
  });

  it('should detect local installation and identify bun from lockfile', () => {
    const localPath = `${projectRoot}/node_modules/.bin/gemini`;
    process.argv[1] = localPath;
    mockedRealPathSync.mockReturnValue(localPath);
    mockedExecSync.mockImplementation(() => {
      throw new Error('Command failed');
    });
    mockedExistsSync.mockImplementation(
      (p) => p === path.join(projectRoot, 'bun.lockb'),
    );

    const info = getInstallationInfo(projectRoot, false);

    expect(info.packageManager).toBe(PackageManager.BUN);
    expect(info.isGlobal).toBe(false);
  });

  it('should default to local npm installation if no lockfile is found', () => {
    const localPath = `${projectRoot}/node_modules/.bin/gemini`;
    process.argv[1] = localPath;
    mockedRealPathSync.mockReturnValue(localPath);
    mockedExecSync.mockImplementation(() => {
      throw new Error('Command failed');
    });
    mockedExistsSync.mockReturnValue(false); // No lockfiles

    const info = getInstallationInfo(projectRoot, false);

    expect(info.packageManager).toBe(PackageManager.NPM);
    expect(info.isGlobal).toBe(false);
  });

  it('should default to global npm installation for unrecognized paths', () => {
    const globalPath = `/usr/local/bin/gemini`;
    process.argv[1] = globalPath;
    mockedRealPathSync.mockReturnValue(globalPath);
    mockedExecSync.mockImplementation(() => {
      throw new Error('Command failed');
    });

    // isAutoUpdateEnabled = true -> "Attempting to automatically update"
    const info = getInstallationInfo(projectRoot, true);
    expect(info.packageManager).toBe(PackageManager.NPM);
    expect(info.isGlobal).toBe(true);
    expect(info.updateCommand).toBe(
      'npm install -g @qwen-code/qwen-code@latest',
    );
    expect(info.updateMessage).toContain('Attempting to automatically update');

    // isAutoUpdateEnabled = false -> "Please run..."
    const infoDisabled = getInstallationInfo(projectRoot, false);
    expect(infoDisabled.updateMessage).toContain('Please run npm install');
  });

  it('should ask for sudo and NOT migrate to standalone when the npm global prefix is not writable', () => {
    const globalPath = `/usr/lib/node_modules/@qwen-code/qwen-code/cli-entry.js`;
    process.argv[1] = globalPath;
    mockedRealPathSync.mockReturnValue(globalPath);
    mockedExecSync.mockImplementation(() => {
      throw new Error('Command failed');
    });
    // npm global package dir is not writable -> `npm install -g` would need sudo.
    vi.mocked(fs.accessSync).mockImplementation(() => {
      throw Object.assign(new Error('EACCES: permission denied'), {
        code: 'EACCES',
      });
    });

    const info = getInstallationInfo(projectRoot, true);

    expect(info.packageManager).toBe(PackageManager.NPM);
    expect(info.isGlobal).toBe(true);
    // Must NOT silently migrate to the standalone installer (bundled Node can be
    // incompatible with the host, e.g. an older glibc).
    expect(info.isStandalone).toBeUndefined();
    expect(info.standaloneDir).toBeUndefined();
    // No updateCommand -> the auto-updater won't attempt an unattended sudo.
    expect(info.updateCommand).toBeUndefined();
    expect(info.updateMessage).toContain('sudo');
  });
});
