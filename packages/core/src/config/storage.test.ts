/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { Storage } from './storage.js';
import { FatalConfigError } from '../utils/errors.js';

const mockRealpathSync = vi.hoisted(() => vi.fn());
const mockReaddirSync = vi.hoisted(() => vi.fn());
const mockMkdirSync = vi.hoisted(() => vi.fn());

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const mocked = {
    ...actual,
    realpathSync: mockRealpathSync,
    readdirSync: mockReaddirSync,
    mkdirSync: mockMkdirSync,
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
    const resolvedPath = pathToResolve.toString();
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
      actualFs.realpathSync(pathToResolve),
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

describe('Storage – ensureAuditFallbackDir', () => {
  const originalEnv = process.env['QWEN_HOME'];
  let home: string;

  beforeEach(() => {
    home = actualFs.mkdtempSync(path.join(os.tmpdir(), 'qwen-home-test-'));
    process.env['QWEN_HOME'] = home;
    // The file-wide mock replaces realpathSync with a bare vi.fn(), which
    // answers `undefined`. Give it the real function's contract instead:
    // production code must not carry a branch that exists only to tolerate a
    // test double.
    mockRealpathSync.mockImplementation((p: unknown) =>
      actualFs.realpathSync(String(p)),
    );
    // Same for readdirSync, which individual tests below restub to reach
    // shapes real tmpfs dirents never have (untyped entries, EACCES).
    mockReaddirSync.mockImplementation((dir: unknown) =>
      actualFs.readdirSync(String(dir), { withFileTypes: true }),
    );
    // Same for mkdirSync, which the race tests below also restub as a
    // deterministic injection seam.
    mockMkdirSync.mockImplementation(
      (...args: Parameters<typeof actualFs.mkdirSync>) =>
        actualFs.mkdirSync(...args),
    );
  });

  afterEach(() => {
    actualFs.rmSync(home, { recursive: true, force: true });
    if (originalEnv === undefined) {
      delete process.env['QWEN_HOME'];
    } else {
      process.env['QWEN_HOME'] = originalEnv;
    }
  });

  it('lands under QWEN_HOME/audits/<project hash>', () => {
    const dir = Storage.ensureAuditFallbackDir('/some/project');
    expect(path.dirname(path.dirname(dir))).toBe(home);
    expect(path.basename(path.dirname(dir))).toBe('audits');
    expect(path.basename(dir)).toMatch(/^[0-9a-f]{64}$/);
    expect(actualFs.statSync(dir).isDirectory()).toBe(true);
  });

  it('creates the landing 0700 so quoted module content stays private', () => {
    const mode = actualFs.statSync(Storage.ensureAuditFallbackDir('/p')).mode;
    // On Windows mkdirSync's mode is a no-op and libuv emulates permission
    // bits by duplicating owner bits to group/other.
    if (process.platform !== 'win32') {
      expect(mode & 0o077).toBe(0);
      expect(mode & 0o700).toBe(0o700);
    }
  });

  it('separates projects and is idempotent', () => {
    const first = Storage.ensureAuditFallbackDir('/project/a');
    const second = Storage.ensureAuditFallbackDir('/project/b');
    expect(first).not.toBe(second);
    expect(Storage.ensureAuditFallbackDir('/project/a')).toBe(first);
  });

  it('creates a missing QWEN_HOME base instead of failing with ENOENT', () => {
    const base = path.join(home, 'not-created-yet', 'nested');
    process.env['QWEN_HOME'] = base;
    const dir = Storage.ensureAuditFallbackDir('/fresh-home');
    expect(path.dirname(path.dirname(dir))).toBe(base);
    expect(actualFs.statSync(dir).isDirectory()).toBe(true);
  });

  it('refuses a landing that resolves inside the audited repository', () => {
    const repo = actualFs.mkdtempSync(path.join(os.tmpdir(), 'audit-repo-'));
    try {
      process.env['QWEN_HOME'] = path.join(repo, '.qwen-state');
      expect(() => Storage.ensureAuditFallbackDir(repo)).toThrow(
        /resolves inside the audited/,
      );
      // Refused before creating anything inside the working tree.
      expect(actualFs.existsSync(path.join(repo, '.qwen-state'))).toBe(false);
    } finally {
      actualFs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a landing planted as a symlink instead of adopting it',
    () => {
      const decoy = actualFs.mkdtempSync(
        path.join(os.tmpdir(), 'audit-decoy-'),
      );
      const audits = path.join(home, 'audits');
      actualFs.mkdirSync(audits, { recursive: true });
      // Predict the leaf the way the audited agent can: the hash is a pure
      // function of the project root.
      const leaf = Storage.ensureAuditFallbackDir('/predictable');
      actualFs.rmSync(leaf, { recursive: true, force: true });
      actualFs.symlinkSync(decoy, leaf);
      try {
        expect(() => Storage.ensureAuditFallbackDir('/predictable')).toThrow(
          /not a directory/,
        );
      } finally {
        actualFs.rmSync(leaf, { force: true });
        actualFs.rmSync(decoy, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'refuses an audits PARENT planted as a symlink, which relocates the whole landing',
    () => {
      // mkdirSync(recursive) follows symlinks in every component ABOVE the
      // leaf, and lstat refuses to follow only the FINAL one — so a
      // leaf-only check cannot see a redirected parent. Planting `audits`
      // is one `ln -s` with no race: ~/.qwen exists long before `audits`.
      const attacker = actualFs.mkdtempSync(
        path.join(os.tmpdir(), 'audit-attacker-'),
      );
      actualFs.symlinkSync(attacker, path.join(home, 'audits'));
      try {
        expect(() => Storage.ensureAuditFallbackDir('/any/project')).toThrow(
          /audit artifact directory .* is not a directory/,
        );
        // Nothing was created inside the planter's directory.
        expect(actualFs.readdirSync(attacker)).toEqual([]);
      } finally {
        actualFs.rmSync(path.join(home, 'audits'), { force: true });
        actualFs.rmSync(attacker, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'refuses a landing holding a symlink child, which redirects writes out of it',
    () => {
      // Validating the leaf alone leaves the escape open: artifacts land
      // BELOW it, and mkdirSync treats a symlink-to-directory as the
      // directory, so everything written "inside" goes wherever the link
      // points while the leaf keeps passing every check.
      const escape = actualFs.mkdtempSync(path.join(os.tmpdir(), 'audit-out-'));
      const leaf = Storage.ensureAuditFallbackDir('/with-child');
      actualFs.symlinkSync(escape, path.join(leaf, 'audit-2026-01-01.sidecar'));
      try {
        expect(() => Storage.ensureAuditFallbackDir('/with-child')).toThrow(
          /contains a symlink/,
        );
      } finally {
        actualFs.rmSync(escape, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'refuses a landing holding a hardlinked file',
    () => {
      const leaf = Storage.ensureAuditFallbackDir('/with-hardlink');
      const twin = path.join(home, 'twin.md');
      actualFs.writeFileSync(twin, 'planted\n');
      actualFs.linkSync(twin, path.join(leaf, '2026-01-01-000000-mod.md'));
      expect(() => Storage.ensureAuditFallbackDir('/with-hardlink')).toThrow(
        /hardlinked file/,
      );
    },
  );

  it('keeps adopting a landing that holds a previous run own artifacts', () => {
    // The landing is REUSED: the report and its sidecar are the durable
    // artifacts, so refusing a non-empty landing would refuse every run
    // after the first.
    const leaf = Storage.ensureAuditFallbackDir('/reused');
    actualFs.writeFileSync(
      path.join(leaf, '2026-01-01-000000-mod.md'),
      '# r\n',
    );
    actualFs.mkdirSync(path.join(leaf, 'audit-2026-01-01.sidecar'), {
      recursive: true,
    });
    expect(Storage.ensureAuditFallbackDir('/reused')).toBe(leaf);
  });

  it.skipIf(process.platform === 'win32')(
    'is stable across symlink spellings of the same directory',
    () => {
      // macOS `/var` → `/private/var`: plan-files and guard-check must hash
      // the same logical directory to the same fallback root whichever
      // spelling arrives, or the relocation-containment check spuriously
      // fails.
      const real = actualFs.mkdtempSync(path.join(os.tmpdir(), 'audit-real-'));
      const link = path.join(os.tmpdir(), `audit-link-${Date.now()}`);
      try {
        actualFs.symlinkSync(real, link);
        expect(Storage.ensureAuditFallbackDir(link)).toBe(
          Storage.ensureAuditFallbackDir(actualFs.realpathSync(real)),
        );
      } finally {
        actualFs.rmSync(link, { force: true });
        actualFs.rmSync(real, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'adopts a pre-existing loose-mode directory and tightens it to 0700',
    () => {
      const audits = path.join(home, 'audits');
      actualFs.mkdirSync(audits);
      actualFs.chmodSync(audits, 0o755);
      Storage.ensureAuditFallbackDir('/loose-mode');
      expect(actualFs.statSync(audits).mode & 0o777).toBe(0o700);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'repairs a 0300-planted landing to readable and catches its planted symlink',
    () => {
      // Listing needs r while creating entries needs only w+x, so a 0300
      // landing still accepts writes: adoption must restore owner-read and
      // then validate, not skip validation because listing failed.
      const leaf = Storage.ensureAuditFallbackDir('/planted-0300');
      actualFs.rmSync(leaf, { recursive: true, force: true });
      actualFs.mkdirSync(leaf);
      actualFs.chmodSync(leaf, 0o300);
      const escape = actualFs.mkdtempSync(path.join(os.tmpdir(), 'audit-300-'));
      actualFs.symlinkSync(escape, path.join(leaf, 'audit-2026-01-01.sidecar'));
      try {
        expect(() => Storage.ensureAuditFallbackDir('/planted-0300')).toThrow(
          /contains a symlink/,
        );
        expect(actualFs.statSync(leaf).mode & 0o777).toBe(0o700);
      } finally {
        actualFs.chmodSync(leaf, 0o700);
        actualFs.rmSync(escape, { recursive: true, force: true });
      }
    },
  );

  it('refuses a landing it cannot list for validation', () => {
    Storage.ensureAuditFallbackDir('/unlistable');
    mockReaddirSync.mockImplementationOnce(() => {
      const err = new Error(
        'EACCES: permission denied',
      ) as NodeJS.ErrnoException;
      err.code = 'EACCES';
      throw err;
    });
    expect(() => Storage.ensureAuditFallbackDir('/unlistable')).toThrow(
      /could not be listed for validation/,
    );
  });

  it.skipIf(process.platform === 'win32')(
    'falls back to lstat when a dirent arrives untyped',
    () => {
      const leaf = Storage.ensureAuditFallbackDir('/untyped-dirent');
      const escape = actualFs.mkdtempSync(path.join(os.tmpdir(), 'audit-dt-'));
      actualFs.symlinkSync(escape, path.join(leaf, 'audit-2026-01-01.sidecar'));
      mockReaddirSync.mockImplementationOnce(() => [
        {
          name: 'audit-2026-01-01.sidecar',
          isSymbolicLink: () => false,
          isFile: () => false,
          isDirectory: () => false,
        },
      ]);
      try {
        expect(() => Storage.ensureAuditFallbackDir('/untyped-dirent')).toThrow(
          /contains a symlink/,
        );
      } finally {
        actualFs.rmSync(escape, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'refuses a QWEN_HOME tail raced into a repo symlink between the containment check and the base creation',
    () => {
      // The pre-creation containment check resolves through the deepest
      // EXISTING ancestor, so a not-yet-existing QWEN_HOME passes it. Plant
      // the tail at the mkdirSync seam — the window a same-UID process wins
      // — and the re-check after the base creation must catch it.
      const repo = actualFs.mkdtempSync(path.join(os.tmpdir(), 'audit-repo-'));
      const target = path.join(repo, 'evil');
      actualFs.mkdirSync(target);
      const base = path.join(home, 'not-yet');
      process.env['QWEN_HOME'] = base;
      let planted = false;
      mockMkdirSync.mockImplementation(
        (...args: Parameters<typeof actualFs.mkdirSync>) => {
          if (!planted && String(args[0]) === base) {
            planted = true;
            actualFs.symlinkSync(target, base);
          }
          return actualFs.mkdirSync(...args);
        },
      );
      try {
        // The audited root IS the repo the tail now points into.
        expect(() => Storage.ensureAuditFallbackDir(repo)).toThrow(
          /resolves inside the audited/,
        );
        // Refused before anything was created inside the working tree.
        expect(actualFs.existsSync(path.join(target, 'audits'))).toBe(false);
      } finally {
        actualFs.rmSync(repo, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'refuses audits raced into a repo symlink between the two adoption checks',
    () => {
      // The first adoption validates `audits`; the second creates the leaf
      // THROUGH it. Swapping `audits` for a symlink into the audited repo in
      // that window relocates the whole landing past every check that
      // already ran, so the pre-return re-validation must catch it.
      const repo = actualFs.mkdtempSync(path.join(os.tmpdir(), 'audit-repo-'));
      const stolen = path.join(repo, 'stolen');
      actualFs.mkdirSync(stolen);
      const audits = path.join(home, 'audits');
      let swapped = false;
      mockMkdirSync.mockImplementation(
        (...args: Parameters<typeof actualFs.mkdirSync>) => {
          if (!swapped && String(args[0]).startsWith(audits + path.sep)) {
            swapped = true;
            actualFs.rmSync(audits, { recursive: true, force: true });
            actualFs.symlinkSync(stolen, audits);
          }
          return actualFs.mkdirSync(...args);
        },
      );
      try {
        expect(() => Storage.ensureAuditFallbackDir('/raced-audits')).toThrow(
          /audit artifact directory .* is not a directory/,
        );
        expect(actualFs.lstatSync(audits).isSymbolicLink()).toBe(true);
      } finally {
        actualFs.rmSync(repo, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'refuses a leaf raced into a symlink after its own adoption',
    () => {
      const leaf = Storage.ensureAuditFallbackDir('/raced-leaf');
      const decoy = actualFs.mkdtempSync(
        path.join(os.tmpdir(), 'audit-decoy-'),
      );
      // Inject at the content check: the leaf's own lstat has already
      // passed, so only the pre-return re-validation can still see the swap.
      mockReaddirSync.mockImplementationOnce((dir: unknown) => {
        actualFs.rmSync(leaf, { recursive: true, force: true });
        actualFs.symlinkSync(decoy, leaf);
        return actualFs.readdirSync(String(dir), { withFileTypes: true });
      });
      try {
        expect(() => Storage.ensureAuditFallbackDir('/raced-leaf')).toThrow(
          /fallback landing .* is not a directory/,
        );
        expect(actualFs.lstatSync(leaf).isSymbolicLink()).toBe(true);
      } finally {
        actualFs.rmSync(decoy, { recursive: true, force: true });
      }
    },
  );

  it('surfaces the actionable refusal when audits is planted as a regular file', () => {
    // A non-directory `audits` makes the containment check's realpath fail
    // with ENOTDIR; that must fall through to the adoption checks and their
    // actionable message instead of escaping as a raw errno.
    actualFs.writeFileSync(path.join(home, 'audits'), 'planted\n');
    expect(() => Storage.ensureAuditFallbackDir('/audits-as-file')).toThrow(
      /audit artifact directory .* is not a directory/,
    );
  });

  it('refuses a containment violation as FatalConfigError rather than a bare crash', () => {
    const repo = actualFs.mkdtempSync(path.join(os.tmpdir(), 'audit-repo-'));
    try {
      process.env['QWEN_HOME'] = path.join(repo, '.qwen-state');
      expect(() => Storage.ensureAuditFallbackDir(repo)).toThrow(
        FatalConfigError,
      );
    } finally {
      actualFs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a planted landing as FatalConfigError rather than a bare crash',
    () => {
      const decoy = actualFs.mkdtempSync(
        path.join(os.tmpdir(), 'audit-decoy-'),
      );
      const leaf = Storage.ensureAuditFallbackDir('/fatal-class');
      actualFs.rmSync(leaf, { recursive: true, force: true });
      actualFs.symlinkSync(decoy, leaf);
      try {
        expect(() => Storage.ensureAuditFallbackDir('/fatal-class')).toThrow(
          FatalConfigError,
        );
      } finally {
        actualFs.rmSync(leaf, { force: true });
        actualFs.rmSync(decoy, { recursive: true, force: true });
      }
    },
  );
});
