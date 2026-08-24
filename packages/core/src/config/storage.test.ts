/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import * as path from 'node:path';
import { Storage } from './storage.js';

const mockRealpathSync = vi.hoisted(() =>
  // Default to the identity so isTempDirPath/realpathNearestExisting
  // behave normally; individual tests override via mockRealpath().
  vi.fn((p: unknown) => p?.toString()),
);

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const mocked = {
    ...actual,
    realpathSync: mockRealpathSync,
  };
  return {
    ...mocked,
    default: mocked,
  };
});

const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');

function createEnoent(pathToResolve: string): NodeJS.ErrnoException {
  const error = new Error(
    `ENOENT: no such file or directory, realpath '${pathToResolve}'`,
  ) as NodeJS.ErrnoException;
  error.code = 'ENOENT';
  return error;
}

function mockRealpath(
  resolutions: Map<string, string>,
  missingPaths = new Set<string>(),
): void {
  mockRealpathSync.mockImplementation((pathToResolve) => {
    const resolvedPath = String(pathToResolve);
    if (missingPaths.has(resolvedPath)) {
      throw createEnoent(resolvedPath);
    }
    return resolutions.get(resolvedPath) ?? resolvedPath;
  });
}

describe('Storage – getGlobalSettingsPath', () => {
  it('returns path to ~/.qwen/settings.json', () => {
    const expected = path.join(os.homedir(), '.qwen', 'settings.json');
    expect(Storage.getGlobalSettingsPath()).toBe(expected);
  });
});

describe('Storage – additional helpers', () => {
  const projectRoot = '/tmp/project';
  const storage = new Storage(projectRoot);

  it('getWorkspaceSettingsPath returns project/.qwen/settings.json', () => {
    const expected = path.join(projectRoot, '.qwen', 'settings.json');
    expect(storage.getWorkspaceSettingsPath()).toBe(expected);
  });

  it('getUserCommandsDir returns ~/.qwen/commands', () => {
    const expected = path.join(os.homedir(), '.qwen', 'commands');
    expect(Storage.getUserCommandsDir()).toBe(expected);
  });

  it('getProjectCommandsDir returns project/.qwen/commands', () => {
    const expected = path.join(projectRoot, '.qwen', 'commands');
    expect(storage.getProjectCommandsDir()).toBe(expected);
  });

  it('getMcpOAuthTokensPath returns ~/.qwen/mcp-oauth-tokens.json', () => {
    const expected = path.join(os.homedir(), '.qwen', 'mcp-oauth-tokens.json');
    expect(Storage.getMcpOAuthTokensPath()).toBe(expected);
  });
});

describe('Storage – getRuntimeBaseDir / setRuntimeBaseDir', () => {
  const originalEnv = process.env['QWEN_RUNTIME_DIR'];

  beforeEach(() => {
    // Reset state before each test
    Storage.setRuntimeBaseDir(null);
    delete process.env['QWEN_RUNTIME_DIR'];
  });

  afterEach(() => {
    // Restore original env
    Storage.setRuntimeBaseDir(null);
    if (originalEnv !== undefined) {
      process.env['QWEN_RUNTIME_DIR'] = originalEnv;
    } else {
      delete process.env['QWEN_RUNTIME_DIR'];
    }
  });

  it('defaults to getGlobalQwenDir() when nothing is configured', () => {
    expect(Storage.getRuntimeBaseDir()).toBe(Storage.getGlobalQwenDir());
  });

  it('uses setRuntimeBaseDir value when set with absolute path', () => {
    const runtimeDir = path.resolve('custom', 'runtime');
    Storage.setRuntimeBaseDir(runtimeDir);
    expect(Storage.getRuntimeBaseDir()).toBe(runtimeDir);
  });

  it('env var QWEN_RUNTIME_DIR takes priority over setRuntimeBaseDir', () => {
    const settingsDir = path.resolve('from-settings');
    const envDir = path.resolve('from-env');
    Storage.setRuntimeBaseDir(settingsDir);
    process.env['QWEN_RUNTIME_DIR'] = envDir;
    expect(Storage.getRuntimeBaseDir()).toBe(envDir);
  });

  it('expands tilde (~) in setRuntimeBaseDir', () => {
    Storage.setRuntimeBaseDir('~/custom-runtime');
    const expected = path.join(os.homedir(), 'custom-runtime');
    expect(Storage.getRuntimeBaseDir()).toBe(expected);
  });

  it('expands Windows-style tilde paths in setRuntimeBaseDir', () => {
    Storage.setRuntimeBaseDir('~\\custom-runtime');
    const expected = path.join(os.homedir(), 'custom-runtime');
    expect(Storage.getRuntimeBaseDir()).toBe(expected);
  });

  it('expands tilde (~) in QWEN_RUNTIME_DIR env var', () => {
    process.env['QWEN_RUNTIME_DIR'] = '~/env-runtime';
    const expected = path.join(os.homedir(), 'env-runtime');
    expect(Storage.getRuntimeBaseDir()).toBe(expected);
  });

  it('resolves relative paths in setRuntimeBaseDir using process.cwd by default', () => {
    Storage.setRuntimeBaseDir('relative/path');
    const expected = path.resolve('relative/path');
    expect(Storage.getRuntimeBaseDir()).toBe(expected);
  });

  it('resolves relative paths in setRuntimeBaseDir using explicit cwd', () => {
    const cwd = path.resolve('workspace', 'projectA');
    Storage.setRuntimeBaseDir('.qwen', cwd);
    expect(Storage.getRuntimeBaseDir()).toBe(path.join(cwd, '.qwen'));
  });

  it('ignores cwd when path is absolute', () => {
    const absolutePath = path.resolve('absolute', 'path');
    const cwd = path.resolve('workspace', 'projectA');
    Storage.setRuntimeBaseDir(absolutePath, cwd);
    expect(Storage.getRuntimeBaseDir()).toBe(absolutePath);
  });

  it('ignores cwd when path starts with tilde', () => {
    Storage.setRuntimeBaseDir(
      '~/runtime',
      path.resolve('workspace', 'projectA'),
    );
    const expected = path.join(os.homedir(), 'runtime');
    expect(Storage.getRuntimeBaseDir()).toBe(expected);
  });

  it('resolves relative paths in QWEN_RUNTIME_DIR env var', () => {
    process.env['QWEN_RUNTIME_DIR'] = 'relative/env-path';
    const expected = path.resolve('relative/env-path');
    expect(Storage.getRuntimeBaseDir()).toBe(expected);
  });

  it('resets to default when setRuntimeBaseDir is called with null', () => {
    const customDir = path.resolve('custom');
    Storage.setRuntimeBaseDir(customDir);
    expect(Storage.getRuntimeBaseDir()).toBe(customDir);

    Storage.setRuntimeBaseDir(null);
    expect(Storage.getRuntimeBaseDir()).toBe(Storage.getGlobalQwenDir());
  });

  it('resets to default when setRuntimeBaseDir is called with undefined', () => {
    Storage.setRuntimeBaseDir(path.resolve('custom'));
    Storage.setRuntimeBaseDir(undefined);
    expect(Storage.getRuntimeBaseDir()).toBe(Storage.getGlobalQwenDir());
  });

  it('resets to default when setRuntimeBaseDir is called with empty string', () => {
    Storage.setRuntimeBaseDir(path.resolve('custom'));
    Storage.setRuntimeBaseDir('');
    expect(Storage.getRuntimeBaseDir()).toBe(Storage.getGlobalQwenDir());
  });

  it('handles bare tilde (~) as home directory', () => {
    Storage.setRuntimeBaseDir('~');
    expect(Storage.getRuntimeBaseDir()).toBe(path.normalize(os.homedir()));
  });
});

describe('Storage – getPlansDir', () => {
  const projectRoot = path.resolve('workspace', 'project');

  beforeEach(() => {
    mockRealpathSync.mockImplementation((pathToResolve) =>
      actualFs.realpathSync(String(pathToResolve)),
    );
  });

  afterEach(() => {
    mockRealpathSync.mockReset();
  });

  it('defaults to ~/.qwen/plans when plansDirectory is not configured', () => {
    expect(Storage.getPlansDir(projectRoot)).toBe(
      path.join(Storage.getGlobalQwenDir(), 'plans'),
    );
  });

  it('resolves relative plansDirectory values against the project root', () => {
    expect(Storage.getPlansDir(projectRoot, './project-plans')).toBe(
      path.join(projectRoot, 'project-plans'),
    );
  });

  it('allows project subdirectories whose names start with two dots', () => {
    expect(Storage.getPlansDir(projectRoot, './..plans')).toBe(
      path.join(projectRoot, '..plans'),
    );
  });

  it('expands tilde in configured plansDirectory values', () => {
    const projectInHome = path.join(os.homedir(), 'workspace', 'project');
    expect(
      Storage.getPlansDir(projectInHome, '~/workspace/project/plans'),
    ).toBe(path.join(projectInHome, 'plans'));
  });

  it('allows absolute plansDirectory values inside the project root', () => {
    const plansDir = path.join(projectRoot, 'nested', 'plans');
    expect(Storage.getPlansDir(projectRoot, plansDir)).toBe(plansDir);
  });

  it('rejects relative plansDirectory values that escape the project root', () => {
    expect(() => Storage.getPlansDir(projectRoot, '../plans')).toThrow(
      'plansDirectory must resolve within the project root',
    );
  });

  it('rejects absolute plansDirectory values outside the project root', () => {
    const outsideProject = path.join(path.dirname(projectRoot), 'plans');
    expect(() => Storage.getPlansDir(projectRoot, outsideProject)).toThrow(
      'plansDirectory must resolve within the project root',
    );
  });

  it('requires projectRoot when plansDirectory is configured', () => {
    expect(() => Storage.getPlansDir(undefined, './plans')).toThrow(
      'projectRoot is required when plansDirectory is configured',
    );
    expect(() => Storage.getPlansDir(null, './plans')).toThrow(
      'projectRoot is required when plansDirectory is configured',
    );
  });

  it('rejects Windows-style absolute path outside the project root', () => {
    // Simulate project root on C: drive and plansDirectory on D: drive
    const projectOnC = path.resolve('C:', 'work', 'project');
    const plansOnD = path.resolve('D:', 'plans');
    expect(() => Storage.getPlansDir(projectOnC, plansOnD)).toThrow(
      'plansDirectory must resolve within the project root',
    );
  });

  it('rejects path with mixed separators that escapes project root', () => {
    // On Windows, path.resolve normalizes backslashes as path separators.
    // On POSIX, backslashes are literal characters, so this traversal
    // is inherently Windows-specific and should be guarded.
    if (process.platform !== 'win32') {
      return;
    }
    const tricky = '..\\..\\plans'; // backslashes with traversal
    expect(() => Storage.getPlansDir(projectRoot, tricky)).toThrow(
      'plansDirectory must resolve within the project root',
    );
  });

  it('rejects symlink pointing outside the project root', () => {
    const project = path.resolve('tmp', 'project');
    const outside = path.resolve('tmp', 'outside');
    const symlink = path.join(project, 'escape-link');
    mockRealpath(
      new Map([
        [project, project],
        [symlink, outside],
      ]),
    );

    expect(() => Storage.getPlansDir(project, './escape-link')).toThrow(
      'plansDirectory must resolve within the project root',
    );
  });

  it('allows legitimate symlink that stays within project root', () => {
    const project = path.resolve('tmp', 'project');
    const target = path.join(project, 'plans-target');
    const symlink = path.join(project, 'plans-link');
    mockRealpath(
      new Map([
        [project, project],
        [symlink, target],
      ]),
    );

    const result = Storage.getPlansDir(project, './plans-link');
    // The configured symlink path is accepted as long as it stays inside
    // the project root.
    expect(result).toBe(symlink);
  });

  it('rejects missing nested path under symlink that escapes project root', () => {
    const project = path.resolve('tmp', 'project');
    const outside = path.resolve('tmp', 'outside');
    const dataSymlink = path.join(project, 'data');
    const missingSubdir = path.join(dataSymlink, 'subdir');
    const missingPlans = path.join(missingSubdir, 'plans');
    mockRealpath(
      new Map([
        [project, project],
        [dataSymlink, outside],
      ]),
      new Set([missingPlans, missingSubdir]),
    );

    expect(() => Storage.getPlansDir(project, './data/subdir/plans')).toThrow(
      'plansDirectory must resolve within the project root',
    );
  });

  it('uses configured plansDirectory when building plan file paths', () => {
    expect(Storage.getPlanFilePath('session-123', projectRoot, './plans')).toBe(
      path.join(projectRoot, 'plans', 'session-123.md'),
    );
  });

  it('sanitizes session IDs when building plan file paths', () => {
    expect(
      Storage.getPlanFilePath('../../../escape', projectRoot, './plans'),
    ).toBe(path.join(projectRoot, 'plans', 'escape.md'));
  });
});

describe('Storage – runtime path methods use getRuntimeBaseDir', () => {
  const originalEnv = process.env['QWEN_RUNTIME_DIR'];

  beforeEach(() => {
    Storage.setRuntimeBaseDir(null);
    delete process.env['QWEN_RUNTIME_DIR'];
  });

  afterEach(() => {
    Storage.setRuntimeBaseDir(null);
    if (originalEnv !== undefined) {
      process.env['QWEN_RUNTIME_DIR'] = originalEnv;
    } else {
      delete process.env['QWEN_RUNTIME_DIR'];
    }
  });

  it('getGlobalTempDir uses custom runtime base dir', () => {
    const customDir = path.resolve('custom');
    Storage.setRuntimeBaseDir(customDir);
    expect(Storage.getGlobalTempDir()).toBe(path.join(customDir, 'tmp'));
  });

  it('getGlobalDebugDir uses custom runtime base dir', () => {
    const customDir = path.resolve('custom');
    Storage.setRuntimeBaseDir(customDir);
    expect(Storage.getGlobalDebugDir()).toBe(path.join(customDir, 'debug'));
  });

  it('getDebugLogPath uses custom runtime base dir', () => {
    const customDir = path.resolve('custom');
    Storage.setRuntimeBaseDir(customDir);
    expect(Storage.getDebugLogPath('session-123')).toBe(
      path.join(customDir, 'debug', 'session-123.txt'),
    );
  });

  it('getGlobalIdeDir is anchored to the global Qwen dir, not runtime base dir', () => {
    const customDir = path.resolve('custom');
    Storage.setRuntimeBaseDir(customDir);
    // IDE lock files are discovery anchors shared with the VS Code companion,
    // which can only see env vars (not settings-based runtimeOutputDir), so
    // getGlobalIdeDir must follow getGlobalQwenDir to keep both sides aligned.
    expect(Storage.getGlobalIdeDir()).toBe(
      path.join(Storage.getGlobalQwenDir(), 'ide'),
    );
  });

  it('getProjectDir uses custom runtime base dir', () => {
    const customDir = path.resolve('custom');
    Storage.setRuntimeBaseDir(customDir);
    const storage = new Storage('/tmp/project');
    expect(storage.getProjectDir()).toContain(path.join(customDir, 'projects'));
  });

  it('getProjectTempDir uses custom runtime base dir', () => {
    const customDir = path.resolve('custom');
    Storage.setRuntimeBaseDir(customDir);
    const storage = new Storage('/tmp/project');
    expect(storage.getProjectTempDir()).toContain(path.join(customDir, 'tmp'));
  });

  it('getProjectTempCheckpointsDir uses custom runtime base dir', () => {
    const customDir = path.resolve('custom');
    Storage.setRuntimeBaseDir(customDir);
    const storage = new Storage('/tmp/project');
    expect(storage.getProjectTempCheckpointsDir()).toContain(
      path.join(customDir, 'tmp'),
    );
    expect(storage.getProjectTempCheckpointsDir()).toMatch(/checkpoints$/);
  });

  it('getHistoryFilePath uses custom runtime base dir', () => {
    const customDir = path.resolve('custom');
    Storage.setRuntimeBaseDir(customDir);
    const storage = new Storage('/tmp/project');
    expect(storage.getHistoryFilePath()).toContain(path.join(customDir, 'tmp'));
    expect(storage.getHistoryFilePath()).toMatch(/shell_history$/);
  });
});

describe('Storage – config paths remain at ~/.qwen regardless of runtime dir', () => {
  const originalEnv = process.env['QWEN_RUNTIME_DIR'];
  const globalQwenDir = Storage.getGlobalQwenDir();

  beforeEach(() => {
    Storage.setRuntimeBaseDir(path.resolve('custom-runtime'));
    process.env['QWEN_RUNTIME_DIR'] = path.resolve('env-runtime');
  });

  afterEach(() => {
    Storage.setRuntimeBaseDir(null);
    if (originalEnv !== undefined) {
      process.env['QWEN_RUNTIME_DIR'] = originalEnv;
    } else {
      delete process.env['QWEN_RUNTIME_DIR'];
    }
  });

  it('getGlobalSettingsPath still uses ~/.qwen', () => {
    expect(Storage.getGlobalSettingsPath()).toBe(
      path.join(globalQwenDir, 'settings.json'),
    );
  });

  it('getInstallationIdPath still uses ~/.qwen', () => {
    expect(Storage.getInstallationIdPath()).toBe(
      path.join(globalQwenDir, 'installation_id'),
    );
  });

  it('getGoogleAccountsPath still uses ~/.qwen', () => {
    expect(Storage.getGoogleAccountsPath()).toBe(
      path.join(globalQwenDir, 'google_accounts.json'),
    );
  });

  it('getMcpOAuthTokensPath still uses ~/.qwen', () => {
    expect(Storage.getMcpOAuthTokensPath()).toBe(
      path.join(globalQwenDir, 'mcp-oauth-tokens.json'),
    );
  });

  it('getOAuthCredsPath still uses ~/.qwen', () => {
    expect(Storage.getOAuthCredsPath()).toBe(
      path.join(globalQwenDir, 'oauth_creds.json'),
    );
  });

  it('getUserCommandsDir still uses ~/.qwen', () => {
    expect(Storage.getUserCommandsDir()).toBe(
      path.join(globalQwenDir, 'commands'),
    );
  });

  it('getGlobalMemoryFilePath still uses ~/.qwen', () => {
    expect(Storage.getGlobalMemoryFilePath()).toBe(
      path.join(globalQwenDir, 'memory.md'),
    );
  });

  it('getGlobalBinDir still uses ~/.qwen', () => {
    expect(Storage.getGlobalBinDir()).toBe(path.join(globalQwenDir, 'bin'));
  });

  it('getUserSkillsDirs still includes ~/.qwen/skills', () => {
    const storage = new Storage('/tmp/project');
    const skillsDirs = storage.getUserSkillsDirs();
    expect(
      skillsDirs.some((dir) => dir === path.join(globalQwenDir, 'skills')),
    ).toBe(true);
  });
});

describe('Storage – QWEN_HOME env var', () => {
  const originalEnv = process.env['QWEN_HOME'];

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env['QWEN_HOME'] = originalEnv;
    } else {
      delete process.env['QWEN_HOME'];
    }
  });

  it('defaults to ~/.qwen when QWEN_HOME is not set', () => {
    delete process.env['QWEN_HOME'];
    const expected = path.join(os.homedir(), '.qwen');
    expect(Storage.getGlobalQwenDir()).toBe(expected);
  });

  it('uses QWEN_HOME when set to absolute path', () => {
    const configDir = path.resolve('/tmp/custom-qwen');
    process.env['QWEN_HOME'] = configDir;
    expect(Storage.getGlobalQwenDir()).toBe(configDir);
  });

  it('resolves relative QWEN_HOME to absolute path', () => {
    process.env['QWEN_HOME'] = 'relative/config';
    const expected = path.resolve('relative/config');
    expect(Storage.getGlobalQwenDir()).toBe(expected);
  });

  it('config paths follow QWEN_HOME', () => {
    const configDir = path.resolve('/tmp/custom-qwen');
    process.env['QWEN_HOME'] = configDir;
    expect(Storage.getGlobalSettingsPath()).toBe(
      path.join(configDir, 'settings.json'),
    );
    expect(Storage.getInstallationIdPath()).toBe(
      path.join(configDir, 'installation_id'),
    );
    expect(Storage.getUserCommandsDir()).toBe(path.join(configDir, 'commands'));
    expect(Storage.getMcpOAuthTokensPath()).toBe(
      path.join(configDir, 'mcp-oauth-tokens.json'),
    );
    expect(Storage.getOAuthCredsPath()).toBe(
      path.join(configDir, 'oauth_creds.json'),
    );
    expect(Storage.getGlobalBinDir()).toBe(path.join(configDir, 'bin'));
    expect(Storage.getGlobalMemoryFilePath()).toBe(
      path.join(configDir, 'memory.md'),
    );
  });

  it('project-level paths are NOT affected by QWEN_HOME', () => {
    const configDir = path.resolve('/tmp/custom-qwen');
    const projectDir = path.resolve('/tmp/project');
    process.env['QWEN_HOME'] = configDir;
    const storage = new Storage(projectDir);
    expect(storage.getWorkspaceSettingsPath()).toBe(
      path.join(projectDir, '.qwen', 'settings.json'),
    );
    expect(storage.getProjectCommandsDir()).toBe(
      path.join(projectDir, '.qwen', 'commands'),
    );
  });

  it('expands tilde (~) in QWEN_HOME', () => {
    process.env['QWEN_HOME'] = '~/custom-qwen';
    const expected = path.join(os.homedir(), 'custom-qwen');
    expect(Storage.getGlobalQwenDir()).toBe(expected);
  });

  it('expands Windows-style tilde in QWEN_HOME', () => {
    process.env['QWEN_HOME'] = '~\\custom-qwen';
    const expected = path.join(os.homedir(), 'custom-qwen');
    expect(Storage.getGlobalQwenDir()).toBe(expected);
  });

  it('handles bare tilde (~) as home directory in QWEN_HOME', () => {
    process.env['QWEN_HOME'] = '~';
    expect(Storage.getGlobalQwenDir()).toBe(path.normalize(os.homedir()));
  });

  it('QWEN_HOME and QWEN_RUNTIME_DIR are independent', () => {
    const configDir = path.resolve('/tmp/config');
    const runtimeDir = path.resolve('/tmp/runtime');
    process.env['QWEN_HOME'] = configDir;
    process.env['QWEN_RUNTIME_DIR'] = runtimeDir;
    expect(Storage.getGlobalQwenDir()).toBe(configDir);
    expect(Storage.getRuntimeBaseDir()).toBe(runtimeDir);
    expect(Storage.getGlobalSettingsPath()).toBe(
      path.join(configDir, 'settings.json'),
    );
    expect(Storage.getGlobalTempDir()).toBe(path.join(runtimeDir, 'tmp'));
    expect(Storage.getGlobalDebugDir()).toBe(path.join(runtimeDir, 'debug'));
    delete process.env['QWEN_RUNTIME_DIR'];
  });
});

describe('Storage – runtime base dir async context isolation', () => {
  const originalEnv = process.env['QWEN_RUNTIME_DIR'];

  beforeEach(() => {
    Storage.setRuntimeBaseDir(null);
    delete process.env['QWEN_RUNTIME_DIR'];
  });

  afterEach(() => {
    Storage.setRuntimeBaseDir(null);
    if (originalEnv !== undefined) {
      process.env['QWEN_RUNTIME_DIR'] = originalEnv;
    } else {
      delete process.env['QWEN_RUNTIME_DIR'];
    }
  });

  it('uses contextual runtime dir inside runWithRuntimeBaseDir', async () => {
    Storage.setRuntimeBaseDir(path.resolve('global-runtime'));
    const cwd = path.resolve('workspace', 'project-a');

    await Storage.runWithRuntimeBaseDir('.qwen', cwd, async () => {
      expect(Storage.getRuntimeBaseDir()).toBe(path.join(cwd, '.qwen'));
    });
  });

  it('keeps concurrent contexts isolated', async () => {
    const cwdA = path.resolve('workspace', 'a');
    const cwdB = path.resolve('workspace', 'b');

    const runA = Storage.runWithRuntimeBaseDir('.qwen-a', cwdA, async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return Storage.getRuntimeBaseDir();
    });

    const runB = Storage.runWithRuntimeBaseDir('.qwen-b', cwdB, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return Storage.getRuntimeBaseDir();
    });

    const [a, b] = await Promise.all([runA, runB]);
    expect(a).toBe(path.join(cwdA, '.qwen-a'));
    expect(b).toBe(path.join(cwdB, '.qwen-b'));
  });

  it('lets a resolved runtime pin override later process env changes', async () => {
    const pinned = path.resolve('workspace', 'pinned-runtime');
    process.env['QWEN_RUNTIME_DIR'] = path.resolve(
      'workspace',
      'ambient-runtime',
    );

    await Storage.runWithResolvedRuntimeBaseDir(pinned, async () => {
      expect(Storage.getRuntimeBaseDir()).toBe(pinned);
      await Promise.resolve();
      expect(new Storage('/workspace').getRuntimeBaseDir()).toBe(pinned);
    });
  });

  it('keeps a resolved runtime pin across nested configurable contexts', () => {
    const pinned = path.resolve('workspace', 'pinned-runtime');

    Storage.runWithResolvedRuntimeBaseDir(pinned, () => {
      Storage.runWithRuntimeBaseDir(
        path.resolve('workspace', 'nested-runtime'),
        undefined,
        () => {
          expect(Storage.getRuntimeBaseDir()).toBe(pinned);
          expect(new Storage('/workspace').getRuntimeBaseDir()).toBe(pinned);
        },
      );
    });
  });

  it('pins an instance to the runtime dir where it was created', () => {
    const cwd = path.resolve('workspace', 'pinned');
    const runtimeDir = path.join(cwd, '.qwen-a');
    const storage = Storage.runWithRuntimeBaseDir(
      '.qwen-a',
      cwd,
      () => new Storage(cwd),
    );

    Storage.runWithRuntimeBaseDir('.qwen-b', cwd, () => {
      expect(storage.getRuntimeBaseDir()).toBe(runtimeDir);
      expect(storage.getProjectDir()).toContain(
        path.join(runtimeDir, 'projects'),
      );
      expect(storage.getProjectTempDir()).toContain(
        path.join(runtimeDir, 'tmp'),
      );
    });
  });
});

describe('Storage – cleanOrphanProjectDirs', () => {
  let baseDir: string;
  let projectsDir: string;
  let aliveCwd: string;
  /** A non-temp cwd that never exists (baseDir sits under os.tmpdir(),
   * which would classify entries as all-temp instead of gone). */
  let goneCwd: string;
  let tmpdirSpy: ReturnType<typeof vi.spyOn> | undefined;

  const STALE_AGE_MS = 2 * 24 * 60 * 60 * 1000;
  /** A long-dead pid: kill(pid, 0) fails with ESRCH/EINVAL, not EPERM. */
  const DEAD_PID = 2_000_000_000;

  const writeSession = (entry: string, cwd: string) => {
    const chats = path.join(projectsDir, entry, 'chats');
    actualFs.mkdirSync(chats, { recursive: true });
    actualFs.writeFileSync(
      path.join(chats, 'session-1.jsonl'),
      JSON.stringify({ cwd, type: 'user' }) + '\n',
    );
  };

  /** Ages an entry — directory and every file under it — past the 24 h
   * grace window. Files matter because the sweep gates on the newest
   * file mtime, not the entry dir's own mtime. */
  const ageEntry = (entry: string) => {
    const past = new Date(Date.now() - STALE_AGE_MS);
    const root = path.join(projectsDir, entry);
    const age = (dir: string) => {
      for (const dirent of actualFs.readdirSync(dir, { withFileTypes: true })) {
        const child = path.join(dir, dirent.name);
        if (dirent.isDirectory()) age(child);
        actualFs.utimesSync(child, past, past);
      }
      actualFs.utimesSync(dir, past, past);
    };
    age(root);
  };

  /** Ages a single file past the grace window. */
  const ageFile = (filePath: string) => {
    const past = new Date(Date.now() - STALE_AGE_MS);
    actualFs.utimesSync(filePath, past, past);
  };

  /**
   * Runs the full disappearance-grace cycle for a gone non-temp entry:
   * first sweep writes the marker, then age it and sweep again to reach
   * the deletion. Returns the second sweep's result.
   */
  const sweepPastMarkerGrace = async (
    entry: string,
    onBeforeRemove?: (entryPath: string) => Promise<void>,
  ) => {
    await Storage.cleanOrphanProjectDirs('current', onBeforeRemove);
    ageFile(path.join(projectsDir, entry, '.qwen-orphan-since'));
    return Storage.cleanOrphanProjectDirs('current', onBeforeRemove);
  };

  // The env var beats setRuntimeBaseDir() in getRuntimeBaseDir():
  // leaving an ambient QWEN_RUNTIME_DIR exported would aim every
  // deletion-capable sweep at the user's real runtime tree instead of
  // the fixture — the same isolation every other runtime-dir suite in
  // this file applies.
  const originalRuntimeEnv = process.env['QWEN_RUNTIME_DIR'];

  beforeEach(() => {
    delete process.env['QWEN_RUNTIME_DIR'];
    // Pin the temp root: the merge-queue legs put the ambient temp root
    // outside the allowlist (POSIX exports TMPDIR=$RUNNER_TEMP; the
    // Windows runner action overrides TEMP/TMP the same way), which would
    // flip every temp-classification fixture here. POSIX pins /var/tmp,
    // not /tmp: macOS symlinks /tmp -> /private/tmp, and with the mocked
    // identity realpathSync the root and fixture realpaths would
    // diverge. Windows pins C:\Windows\Temp, an OS-known location the
    // distrust guard accepts.
    tmpdirSpy = vi
      .spyOn(os, 'tmpdir')
      .mockReturnValue(
        process.platform === 'win32' ? 'C:\\Windows\\Temp' : '/var/tmp',
      );
    baseDir = actualFs.mkdtempSync(path.join(os.tmpdir(), 'storage-orphan-'));
    projectsDir = path.join(baseDir, 'projects');
    actualFs.mkdirSync(projectsDir, { recursive: true });
    aliveCwd = actualFs.mkdtempSync(path.join(os.tmpdir(), 'alive-cwd-'));
    goneCwd = path.join(
      process.cwd(),
      `qwen-orphan-gone-${Math.random().toString(36).slice(2)}`,
    );
    Storage.setRuntimeBaseDir(baseDir);
  });

  afterEach(() => {
    tmpdirSpy?.mockRestore();
    Storage.setRuntimeBaseDir(null);
    if (originalRuntimeEnv !== undefined) {
      process.env['QWEN_RUNTIME_DIR'] = originalRuntimeEnv;
    } else {
      delete process.env['QWEN_RUNTIME_DIR'];
    }
    actualFs.rmSync(baseDir, { recursive: true, force: true });
    actualFs.rmSync(aliveCwd, { recursive: true, force: true });
  });

  it('removes stale entries whose recorded cwd no longer exists', async () => {
    writeSession('-tmp-gone-sess', goneCwd);
    ageEntry('-tmp-gone-sess');
    const result = await sweepPastMarkerGrace('-tmp-gone-sess');
    expect(actualFs.existsSync(path.join(projectsDir, '-tmp-gone-sess'))).toBe(
      false,
    );
    expect(result.removed).toContain('-tmp-gone-sess');
    expect(result.errors).toEqual([]);
  });

  it('keeps fresh entries even when their cwd is gone (grace window)', async () => {
    writeSession('-fresh-gone-sess', goneCwd);
    await Storage.cleanOrphanProjectDirs('current');
    expect(
      actualFs.existsSync(path.join(projectsDir, '-fresh-gone-sess')),
    ).toBe(true);
  });

  it('keeps fresh gone-cwd entries without any runtime sidecar (R2-1)', async () => {
    // Headless/ACP/SDK/serve sessions never write a sidecar; a running
    // one stays protected through its ongoing appends alone.
    writeSession('-headless-live', goneCwd);
    ageEntry('-headless-live');
    // Simulate an in-progress append: the transcript is fresh again.
    actualFs.utimesSync(
      path.join(projectsDir, '-headless-live', 'chats', 'session-1.jsonl'),
      new Date(),
      new Date(),
    );
    await Storage.cleanOrphanProjectDirs('current');
    expect(actualFs.existsSync(path.join(projectsDir, '-headless-live'))).toBe(
      true,
    );
  });

  it('keeps entries whose recorded cwd still exists', async () => {
    writeSession('-alive-proj', aliveCwd);
    await Storage.cleanOrphanProjectDirs('current');
    expect(actualFs.existsSync(path.join(projectsDir, '-alive-proj'))).toBe(
      true,
    );
  });

  it('keeps stale entries where any recorded cwd still exists', async () => {
    // `/cd` relocation keeps the old cwd on line 1 and appends records
    // under the new one — deletion needs EVERY recorded cwd gone, so a
    // live cwd in the tail line must veto removal.
    const chats = path.join(projectsDir, '-multi-cwd', 'chats');
    actualFs.mkdirSync(chats, { recursive: true });
    actualFs.writeFileSync(
      path.join(chats, 'session-1.jsonl'),
      JSON.stringify({ cwd: goneCwd, type: 'user' }) +
        '\n' +
        JSON.stringify({ cwd: process.cwd(), type: 'model' }) +
        '\n',
    );
    ageEntry('-multi-cwd');
    await Storage.cleanOrphanProjectDirs('current');
    expect(actualFs.existsSync(path.join(projectsDir, '-multi-cwd'))).toBe(
      true,
    );
    // Kept via the live-cwd veto, not via the marker branch: no marker
    // may be written, or a later disappearance would lose its grace.
    expect(
      actualFs.existsSync(
        path.join(projectsDir, '-multi-cwd', '.qwen-orphan-since'),
      ),
    ).toBe(false);
  });

  it('keeps stale entries owned by a live session (runtime sidecar pid)', async () => {
    writeSession('-live-sess', goneCwd);
    actualFs.writeFileSync(
      path.join(projectsDir, '-live-sess', 'chats', 'session-1.runtime.json'),
      JSON.stringify({
        pid: process.pid,
        work_dir: goneCwd,
      }),
    );
    ageEntry('-live-sess');
    // The session is still running: its sidecar was just refreshed.
    actualFs.utimesSync(
      path.join(projectsDir, '-live-sess', 'chats', 'session-1.runtime.json'),
      new Date(),
      new Date(),
    );
    await Storage.cleanOrphanProjectDirs('current');
    expect(actualFs.existsSync(path.join(projectsDir, '-live-sess'))).toBe(
      true,
    );
  });

  it('removes stale entries whose runtime sidecar pid is dead', async () => {
    writeSession('-dead-sess', goneCwd);
    actualFs.writeFileSync(
      path.join(projectsDir, '-dead-sess', 'chats', 'session-1.runtime.json'),
      JSON.stringify({
        pid: DEAD_PID,
        work_dir: goneCwd,
      }),
    );
    ageEntry('-dead-sess');
    await sweepPastMarkerGrace('-dead-sess');
    expect(actualFs.existsSync(path.join(projectsDir, '-dead-sess'))).toBe(
      false,
    );
  });

  it('reads cwds from sidecars and archived transcripts', async () => {
    // No top-level chat log at all — only sidecar and archive forms. If
    // the sweep ignored those shapes, cwds would be empty and the
    // non-empty entry would survive.
    const entry = path.join(projectsDir, '-sidecar-sess');
    const chats = path.join(entry, 'chats');
    const archive = path.join(chats, 'archive');
    actualFs.mkdirSync(archive, { recursive: true });
    actualFs.writeFileSync(
      path.join(chats, 'session-1.runtime.json'),
      JSON.stringify({ pid: DEAD_PID, work_dir: `${goneCwd}-1` }),
    );
    actualFs.writeFileSync(
      path.join(archive, 'session-0.jsonl'),
      JSON.stringify({ cwd: `${goneCwd}-3` }) + '\n',
    );
    ageEntry('-sidecar-sess');
    await sweepPastMarkerGrace('-sidecar-sess');
    expect(actualFs.existsSync(entry)).toBe(false);
  });

  it('keeps stale entries when a sidecar-recorded cwd still exists', async () => {
    const entry = path.join(projectsDir, '-sidecar-alive');
    const chats = path.join(entry, 'chats');
    actualFs.mkdirSync(chats, { recursive: true });
    actualFs.writeFileSync(
      path.join(chats, 'session-1.runtime.json'),
      JSON.stringify({ pid: DEAD_PID, work_dir: process.cwd() }),
    );
    ageEntry('-sidecar-alive');
    await Storage.cleanOrphanProjectDirs('current');
    expect(actualFs.existsSync(entry)).toBe(true);
  });

  it('removes stale entries whose only surviving cwds sit under temp roots', async () => {
    // Crashed temp session whose temp dir survived: it gets the same
    // marker grace as any other gone-cwd entry — a live-but-idle temp
    // session must not die on a single sweep — but removal follows once
    // the marker ages.
    const survived = actualFs.mkdtempSync(
      path.join(os.tmpdir(), 'qwen-temp-survived-'),
    );
    writeSession('-temp-crash', survived);
    ageEntry('-temp-crash');
    await sweepPastMarkerGrace('-temp-crash');
    expect(actualFs.existsSync(path.join(projectsDir, '-temp-crash'))).toBe(
      false,
    );
  });

  it('keeps a live-but-idle temp session at the deletion gate (R11-1)', async () => {
    // Idle >24 h: the sidecar aged past the trust window and there were
    // no appends, so the entry gate lets the marker flow run. The
    // deletion gate must still re-check pid liveness without that
    // window — the process is provably alive.
    const survived = actualFs.mkdtempSync(
      path.join(os.tmpdir(), 'qwen-idle-live-'),
    );
    const entry = path.join(projectsDir, '-idle-live');
    const chats = path.join(entry, 'chats');
    actualFs.mkdirSync(chats, { recursive: true });
    actualFs.writeFileSync(
      path.join(chats, 'session-1.jsonl'),
      JSON.stringify({ cwd: survived, type: 'user' }) + '\n',
    );
    actualFs.writeFileSync(
      path.join(chats, 'session-1.runtime.json'),
      JSON.stringify({ pid: process.pid, work_dir: survived }),
    );
    ageEntry('-idle-live');
    await sweepPastMarkerGrace('-idle-live');
    expect(actualFs.existsSync(entry)).toBe(true);
    expect(actualFs.existsSync(path.join(entry, '.qwen-orphan-since'))).toBe(
      false,
    );
  });

  it('recovers cwds from `}{`-glued records (crash mid-append)', async () => {
    const chats = path.join(projectsDir, '-glued', 'chats');
    actualFs.mkdirSync(chats, { recursive: true });
    actualFs.writeFileSync(
      path.join(chats, 'session-1.jsonl'),
      JSON.stringify({ cwd: `${goneCwd}-a` }) +
        JSON.stringify({ cwd: `${goneCwd}-b` }) +
        '\n',
    );
    ageEntry('-glued');
    await sweepPastMarkerGrace('-glued');
    expect(actualFs.existsSync(path.join(projectsDir, '-glued'))).toBe(false);
  });

  it('treats an unterminated final record as torn residue (R4-5, R10-11)', async () => {
    // Crash-mid-append residue: every writer terminates records with
    // '\n', so a missing terminator means the append was killed — even
    // if the tail happens to parse, the writer may have been cut off
    // mid-record. Fail closed: the entry survives without a marker.
    const chats = path.join(projectsDir, '-no-newline', 'chats');
    actualFs.mkdirSync(chats, { recursive: true });
    actualFs.writeFileSync(
      path.join(chats, 'session-1.jsonl'),
      JSON.stringify({ cwd: goneCwd }),
    );
    ageEntry('-no-newline');
    await Storage.cleanOrphanProjectDirs('current');
    expect(actualFs.existsSync(path.join(projectsDir, '-no-newline'))).toBe(
      true,
    );
    expect(
      actualFs.existsSync(
        path.join(projectsDir, '-no-newline', '.qwen-orphan-since'),
      ),
    ).toBe(false);
  });

  it('recovers a live cwd from a record straddling a chunk boundary (R4-5)', async () => {
    // The second record starts before the 64 KB read boundary and ends
    // past it; broken chunk stitching would drop the live cwd and the
    // entry would be marked for removal.
    const chats = path.join(projectsDir, '-boundary', 'chats');
    actualFs.mkdirSync(chats, { recursive: true });
    const rec2 = JSON.stringify({ cwd: process.cwd() });
    // Size rec1's pad from the real string lengths so rec2 genuinely
    // straddles byte 65536 — the previous fixed pad left it entirely
    // inside the second chunk.
    const skeleton = JSON.stringify({ cwd: goneCwd, pad: '' });
    const padLen = 65536 - (skeleton.length + 1) - Math.floor(rec2.length / 2);
    const rec1 = JSON.stringify({ cwd: goneCwd, pad: 'x'.repeat(padLen) });
    expect(rec1.length + 1).toBeLessThan(65536);
    expect(rec1.length + 1 + rec2.length).toBeGreaterThan(65536);
    actualFs.writeFileSync(
      path.join(chats, 'session-1.jsonl'),
      rec1 + '\n' + rec2 + '\n',
    );
    ageEntry('-boundary');
    await Storage.cleanOrphanProjectDirs('current');
    expect(actualFs.existsSync(path.join(projectsDir, '-boundary'))).toBe(true);
    expect(
      actualFs.existsSync(
        path.join(projectsDir, '-boundary', '.qwen-orphan-since'),
      ),
    ).toBe(false);
  });

  it('cleans entries whose only artifact is a sidecar pointing at a gone worktree (R5-1)', async () => {
    // A worktree session killed before its first record leaves only
    // the .worktree.json sidecar — the exact orphan shape from #7906.
    // Without a worktreePath read such an entry never reaches the
    // marker flow (the sidecar itself defeats the empty-entry branch).
    const chats = path.join(projectsDir, '-sidecar-only', 'chats');
    actualFs.mkdirSync(chats, { recursive: true });
    actualFs.writeFileSync(
      path.join(chats, 'session-1.worktree.json'),
      JSON.stringify({ slug: 'feat-x', worktreePath: goneCwd }),
    );
    ageEntry('-sidecar-only');
    await sweepPastMarkerGrace('-sidecar-only');
    expect(actualFs.existsSync(path.join(projectsDir, '-sidecar-only'))).toBe(
      false,
    );
  });

  it('removes an entry reduced to just the orphan marker (R7-1)', async () => {
    // A marked entry whose records /cd moved elsewhere: the marker is
    // sweep bookkeeping, not content — counting it would block the
    // empty-entry branch forever.
    const entry = path.join(projectsDir, '-marker-only');
    actualFs.mkdirSync(path.join(entry, 'chats'), { recursive: true });
    actualFs.writeFileSync(
      path.join(entry, '.qwen-orphan-since'),
      String(Date.now() - STALE_AGE_MS),
    );
    ageEntry('-marker-only');
    await Storage.cleanOrphanProjectDirs('current');
    expect(actualFs.existsSync(entry)).toBe(false);
  });

  it('keeps an entry reduced to workflow residue (R9-1)', async () => {
    // Workflow snapshots and journals carry no cwd proving their source
    // project is gone (chat recording disabled + workflows enabled is a
    // real configuration), so residue must fail closed: leaked, never
    // deleted.
    const entry = path.join(projectsDir, '-workflow-residue');
    actualFs.mkdirSync(path.join(entry, 'chats'), { recursive: true });
    actualFs.mkdirSync(path.join(entry, 'workflows', 'run-1'), {
      recursive: true,
    });
    actualFs.writeFileSync(
      path.join(entry, 'workflows', 'run-1.json'),
      JSON.stringify({ runId: 'run-1' }),
    );
    actualFs.writeFileSync(
      path.join(entry, 'workflows', 'run-1', 'journal.jsonl'),
      JSON.stringify({ step: 1 }) + '\n',
    );
    ageEntry('-workflow-residue');
    await Storage.cleanOrphanProjectDirs('current');
    expect(actualFs.existsSync(entry)).toBe(true);
  });

  // chmod 0o000 only blocks reads on non-root POSIX: on Windows libuv
  // maps it to the read-only attribute (still readable) and root
  // bypasses it outright — the merge-queue Windows leg would fail.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'keeps an entry when a record is unreadable (R9-5)',
    async () => {
      // Mixed evidence: one transcript records a gone cwd, another cannot
      // be opened. The unreadable one might hold a live cwd, so the scan
      // is incomplete and must veto deletion — no marker either.
      const entry = path.join(projectsDir, '-incomplete-scan');
      actualFs.mkdirSync(path.join(entry, 'chats'), { recursive: true });
      actualFs.writeFileSync(
        path.join(entry, 'chats', 'a.jsonl'),
        JSON.stringify({ cwd: goneCwd, type: 'qwen' }) + '\n',
      );
      const unreadable = path.join(entry, 'chats', 'b.jsonl');
      actualFs.writeFileSync(
        unreadable,
        JSON.stringify({ cwd: '/real/project', type: 'qwen' }) + '\n',
      );
      actualFs.chmodSync(unreadable, 0o000);
      ageEntry('-incomplete-scan');
      await Storage.cleanOrphanProjectDirs('current');
      expect(actualFs.existsSync(entry)).toBe(true);
      expect(actualFs.existsSync(path.join(entry, '.qwen-orphan-since'))).toBe(
        false,
      );
    },
  );

  it('treats a torn final record as incomplete evidence (R10-11)', async () => {
    // All writers terminate records with '\n', so a non-terminated tail
    // at EOF is a torn write (kill -9 mid-append). Its cwd — possibly
    // the only live one — was cut off, so the sibling's gone cwd alone
    // must not start the marker flow.
    const entry = path.join(projectsDir, '-torn-tail');
    actualFs.mkdirSync(path.join(entry, 'chats'), { recursive: true });
    actualFs.writeFileSync(
      path.join(entry, 'chats', 'torn.jsonl'),
      JSON.stringify({ cwd: goneCwd, type: 'qwen' }) +
        '\n' +
        '{"cwd":"/live/proj',
    );
    ageEntry('-torn-tail');
    await Storage.cleanOrphanProjectDirs('current');
    expect(actualFs.existsSync(entry)).toBe(true);
    expect(actualFs.existsSync(path.join(entry, '.qwen-orphan-since'))).toBe(
      false,
    );
  });

  it('treats a torn sidecar as incomplete evidence (self-review)', async () => {
    // Sidecars are rewritten in place on runtime status updates; a
    // kill -9 mid-write leaves torn JSON. Its work_dir — possibly the
    // only live cwd — is lost, so the sibling's gone cwd alone must
    // not start the marker flow. (Torn JSON, not chmod, so the test is
    // platform- and uid-independent.)
    const entry = path.join(projectsDir, '-torn-sidecar');
    actualFs.mkdirSync(path.join(entry, 'chats'), { recursive: true });
    actualFs.writeFileSync(
      path.join(entry, 'chats', 'gone.jsonl'),
      JSON.stringify({ cwd: goneCwd, type: 'qwen' }) + '\n',
    );
    actualFs.writeFileSync(
      path.join(entry, 'chats', 'sess-1.runtime.json'),
      '{"work_dir":"/live/proj',
    );
    ageEntry('-torn-sidecar');
    await Storage.cleanOrphanProjectDirs('current');
    expect(actualFs.existsSync(entry)).toBe(true);
    expect(actualFs.existsSync(path.join(entry, '.qwen-orphan-since'))).toBe(
      false,
    );
  });

  it('keeps an entry whose marker vanished during salvage (R9-4)', async () => {
    // Sweep A passes the expired-marker check and awaits salvage; in
    // that window the entry becomes current for a new session, whose
    // own sweep clears the marker. Sweep A must see the absence and
    // bail out before rmSync — the marker's absence is the newest
    // ownership signal.
    writeSession('-marker-cleared', goneCwd);
    ageEntry('-marker-cleared');
    await Storage.cleanOrphanProjectDirs('current');
    ageFile(path.join(projectsDir, '-marker-cleared', '.qwen-orphan-since'));
    await Storage.cleanOrphanProjectDirs('current', async (entryPath) => {
      actualFs.rmSync(path.join(entryPath, '.qwen-orphan-since'));
    });
    expect(actualFs.existsSync(path.join(projectsDir, '-marker-cleared'))).toBe(
      true,
    );
  });

  it('treats an over-budget transcript as incomplete evidence (R9-7)', async () => {
    // A single record longer than the scan budget aborts the scan. The
    // sibling transcript records a gone cwd, which alone would start the
    // marker flow — but the over-budget one could hide a live cwd, so
    // partial evidence must veto: no marker, no deletion.
    const entry = path.join(projectsDir, '-over-budget');
    actualFs.mkdirSync(path.join(entry, 'chats'), { recursive: true });
    actualFs.writeFileSync(
      path.join(entry, 'chats', 'huge.jsonl'),
      'x'.repeat(8 * 1024 * 1024 + 1),
    );
    actualFs.writeFileSync(
      path.join(entry, 'chats', 'gone.jsonl'),
      JSON.stringify({ cwd: goneCwd, type: 'qwen' }) + '\n',
    );
    ageEntry('-over-budget');
    await Storage.cleanOrphanProjectDirs('current');
    expect(actualFs.existsSync(entry)).toBe(true);
    expect(actualFs.existsSync(path.join(entry, '.qwen-orphan-since'))).toBe(
      false,
    );
  });

  describe('containsOnlySessionArtifacts', () => {
    it('requires exact artifact names, not prefixes or suffixes (R9-2, R10-1)', () => {
      const dir = actualFs.mkdtempSync(path.join(projectsDir, 'ownership-'));
      actualFs.mkdirSync(path.join(dir, 'chats'));
      actualFs.writeFileSync(path.join(dir, 'chats', 'sess-1.jsonl'), '');
      expect(Storage.containsOnlySessionArtifacts(dir, 'sess-1')).toBe(true);
      // A sibling session whose id extends ours (`sess-1.b`) shares the
      // `sess-1.` prefix — a startsWith check would claim its files.
      actualFs.writeFileSync(path.join(dir, 'chats', 'sess-1.b.jsonl'), '');
      expect(Storage.containsOnlySessionArtifacts(dir, 'sess-1')).toBe(false);
      actualFs.rmSync(path.join(dir, 'chats', 'sess-1.b.jsonl'));
      actualFs.rmSync(path.join(dir, 'chats', 'sess-1.jsonl'));
      // The reverse direction: our id is a strict suffix of a sibling's
      // (`team-worker-1`) — an endsWith check would claim its files.
      actualFs.writeFileSync(
        path.join(dir, 'chats', 'team-worker-1.jsonl'),
        '',
      );
      expect(Storage.containsOnlySessionArtifacts(dir, 'worker-1')).toBe(false);
    });

    it('treats the sweep orphan marker as bookkeeping, not foreign content (R13-3)', () => {
      // Another session's sweep can mark a live session's entry; the
      // shutdown leg must still pass this guard on exit. The marker is
      // the sweep's own intermediate state — newestFileMtimeMs and
      // countFiles skip it, so must this walker.
      const dir = actualFs.mkdtempSync(path.join(projectsDir, 'marked-'));
      actualFs.mkdirSync(path.join(dir, 'chats'));
      actualFs.writeFileSync(path.join(dir, 'chats', 'sess-1.jsonl'), '');
      actualFs.writeFileSync(
        path.join(dir, '.qwen-orphan-since'),
        String(Date.now()),
      );
      expect(Storage.containsOnlySessionArtifacts(dir, 'sess-1')).toBe(true);
    });

    it('accepts independent runtime claims only for the same session id', () => {
      const dir = actualFs.mkdtempSync(path.join(projectsDir, 'claims-'));
      const chatsDir = path.join(dir, 'chats');
      actualFs.mkdirSync(chatsDir);
      actualFs.writeFileSync(path.join(chatsDir, 'sess-1.jsonl'), '');
      actualFs.writeFileSync(
        path.join(chatsDir, 'sess-1.claim-token.runtime.json'),
        JSON.stringify({ session_id: 'sess-1', pid: process.pid }),
      );
      expect(Storage.containsOnlySessionArtifacts(dir, 'sess-1')).toBe(true);

      actualFs.writeFileSync(
        path.join(chatsDir, 'foreign.claim-token.runtime.json'),
        JSON.stringify({ session_id: 'foreign', pid: process.pid }),
      );
      expect(Storage.containsOnlySessionArtifacts(dir, 'sess-1')).toBe(false);
    });
  });

  it('keeps an entry reduced to subagent transcripts of a live cwd (R7-2)', async () => {
    // Subagent records carry their launch cwd: a live project must veto
    // exactly like chat records do.
    const entry = path.join(projectsDir, '-subagent-live');
    actualFs.mkdirSync(path.join(entry, 'subagents', 'sess-1'), {
      recursive: true,
    });
    actualFs.writeFileSync(
      path.join(entry, 'subagents', 'sess-1', 'agent-1.jsonl'),
      JSON.stringify({ cwd: process.cwd(), type: 'agent' }) + '\n',
    );
    ageEntry('-subagent-live');
    await Storage.cleanOrphanProjectDirs('current');
    expect(actualFs.existsSync(entry)).toBe(true);
  });

  it('removes an entry reduced to subagent transcripts of a gone cwd (R7-2)', async () => {
    // The scan must reach subagents/: without it the residue blocks the
    // empty-entry branch forever and the entry never enters the marker
    // flow.
    const entry = path.join(projectsDir, '-subagent-gone');
    actualFs.mkdirSync(path.join(entry, 'subagents', 'sess-1'), {
      recursive: true,
    });
    actualFs.writeFileSync(
      path.join(entry, 'subagents', 'sess-1', 'agent-1.jsonl'),
      JSON.stringify({ cwd: goneCwd, type: 'agent' }) + '\n',
    );
    ageEntry('-subagent-gone');
    await sweepPastMarkerGrace('-subagent-gone');
    expect(actualFs.existsSync(entry)).toBe(false);
  });

  it('marks gone non-temp entries first and removes only once the marker ages (R2-2)', async () => {
    // A vanished non-temp cwd may be a transiently absent mount, so the
    // first sweep writes a marker instead of deleting; removal happens
    // only once the marker itself is past the grace window.
    writeSession('-marked-gone', goneCwd);
    ageEntry('-marked-gone');
    const marker = path.join(projectsDir, '-marked-gone', '.qwen-orphan-since');

    await Storage.cleanOrphanProjectDirs('current');
    expect(actualFs.existsSync(path.join(projectsDir, '-marked-gone'))).toBe(
      true,
    );
    expect(actualFs.existsSync(marker)).toBe(true);
    // Write-once invariant: the marker's mtime is the grace anchor, so
    // the second pass must not rewrite it.
    const graceAnchor = actualFs.statSync(marker).mtimeMs;

    // Second pass: marker is still fresh — still kept.
    await Storage.cleanOrphanProjectDirs('current');
    expect(actualFs.existsSync(path.join(projectsDir, '-marked-gone'))).toBe(
      true,
    );
    expect(actualFs.statSync(marker).mtimeMs).toBe(graceAnchor);

    ageFile(marker);
    await Storage.cleanOrphanProjectDirs('current');
    expect(actualFs.existsSync(path.join(projectsDir, '-marked-gone'))).toBe(
      false,
    );
  });

  it('runs the salvage hook before removal and reports it (R2-3)', async () => {
    writeSession('-hooked', goneCwd);
    ageEntry('-hooked');
    const seen: string[] = [];
    const hook = async (entryPath: string) => {
      // Ordering: salvage must run BEFORE the deletion, so the entry is
      // still readable when the hook fires.
      expect(actualFs.existsSync(entryPath)).toBe(true);
      seen.push(entryPath);
    };
    await sweepPastMarkerGrace('-hooked', hook);
    expect(seen).toEqual([path.join(projectsDir, '-hooked')]);
  });

  it('aborts removal when the entry becomes fresh during salvage (R4-1)', async () => {
    // The salvage await widens the check-then-delete window: a new
    // session may start writing into the doomed entry in that time, and
    // the re-check before rmSync must abort.
    writeSession('-raced', goneCwd);
    ageEntry('-raced');
    const hook = async (entryPath: string) => {
      actualFs.writeFileSync(
        path.join(entryPath, 'chats', 'session-1.jsonl'),
        JSON.stringify({ cwd: goneCwd }) + '\n',
      );
    };
    await sweepPastMarkerGrace('-raced', hook);
    expect(actualFs.existsSync(path.join(projectsDir, '-raced'))).toBe(true);
  });

  it('aborts removal when a gone cwd reappears during salvage (R4-1)', async () => {
    // The salvage await also widens the window for a vanished cwd to
    // come back (ejected media plugged in again); the cwd re-check
    // before rmSync must abort and clear the marker.
    writeSession('-cwd-back', goneCwd);
    ageEntry('-cwd-back');
    const hook = async () => {
      actualFs.mkdirSync(goneCwd, { recursive: true });
    };
    try {
      await sweepPastMarkerGrace('-cwd-back', hook);
      expect(actualFs.existsSync(path.join(projectsDir, '-cwd-back'))).toBe(
        true,
      );
      expect(
        actualFs.existsSync(
          path.join(projectsDir, '-cwd-back', '.qwen-orphan-since'),
        ),
      ).toBe(false);
    } finally {
      actualFs.rmSync(goneCwd, { recursive: true, force: true });
    }
  });

  it('keeps stale entries with files but no readable cwd records', async () => {
    const entry = path.join(projectsDir, '-unparsable');
    actualFs.mkdirSync(path.join(entry, 'chats'), { recursive: true });
    actualFs.writeFileSync(
      path.join(entry, 'chats', 'state.txt'),
      'no cwd record here',
    );
    ageEntry('-unparsable');
    await Storage.cleanOrphanProjectDirs('current');
    expect(actualFs.existsSync(entry)).toBe(true);
  });

  it('never touches the current project entry', async () => {
    writeSession('current', goneCwd);
    ageEntry('current');
    await Storage.cleanOrphanProjectDirs('current');
    expect(actualFs.existsSync(path.join(projectsDir, 'current'))).toBe(true);
    // Self-skip must not even write a marker: the active session's own
    // entry getting GC'd would delete its transcripts mid-run.
    expect(
      actualFs.existsSync(
        path.join(projectsDir, 'current', '.qwen-orphan-since'),
      ),
    ).toBe(false);
  });

  it('removes empty record-less entries older than one day', async () => {
    const stale = path.join(projectsDir, '-stale-empty');
    actualFs.mkdirSync(stale, { recursive: true });
    const past = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    actualFs.utimesSync(stale, past, past);
    await Storage.cleanOrphanProjectDirs('current');
    expect(actualFs.existsSync(stale)).toBe(false);
  });

  it('keeps fresh empty record-less entries (concurrent session guard)', async () => {
    const fresh = path.join(projectsDir, '-fresh-empty');
    actualFs.mkdirSync(path.join(fresh, 'chats'), { recursive: true });
    await Storage.cleanOrphanProjectDirs('current');
    expect(actualFs.existsSync(fresh)).toBe(true);
  });

  it('is a no-op when the projects dir does not exist', async () => {
    actualFs.rmSync(projectsDir, { recursive: true, force: true });
    await expect(Storage.cleanOrphanProjectDirs('current')).resolves.toEqual({
      removed: [],
      errors: [],
    });
  });
});

describe('Storage – listTranscriptPaths', () => {
  let dir: string;

  beforeEach(() => {
    dir = actualFs.mkdtempSync(path.join(os.tmpdir(), 'storage-transcripts-'));
  });

  afterEach(() => {
    actualFs.rmSync(dir, { recursive: true, force: true });
  });

  it('lists jsonl transcripts including archived ones, not sidecars', () => {
    const chats = path.join(dir, 'chats');
    const archive = path.join(chats, 'archive');
    actualFs.mkdirSync(archive, { recursive: true });
    actualFs.writeFileSync(path.join(chats, 's1.jsonl'), '{}\n');
    actualFs.writeFileSync(path.join(chats, 's1.runtime.json'), '{}');
    actualFs.writeFileSync(path.join(archive, 's0.jsonl'), '{}\n');
    expect(Storage.listTranscriptPaths(dir).sort()).toEqual(
      [path.join(chats, 's1.jsonl'), path.join(archive, 's0.jsonl')].sort(),
    );
  });
});
