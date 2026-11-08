/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { Storage } from './storage.js';
import { FatalConfigError } from '../utils/errors.js';

const mockRealpathSync = vi.hoisted(() => vi.fn());
const mockReaddirSync = vi.hoisted(() => vi.fn());
const mockMkdirSync = vi.hoisted(() => vi.fn());

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  // Default the mocks this file adds to the real implementations: a bare
  // vi.fn() returns undefined, silently turning fs reads and writes into
  // no-ops for every describe that does not restub them.
  mockReaddirSync.mockImplementation((dir: unknown) =>
    actual.readdirSync(String(dir), { withFileTypes: true }),
  );
  mockMkdirSync.mockImplementation(
    (...args: Parameters<typeof actual.mkdirSync>) => actual.mkdirSync(...args),
  );
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

const errnoError = (code: string, message: string) =>
  Object.assign(new Error(message), { code }) as NodeJS.ErrnoException;

function mockRealpath(
  resolutions: Map<string, string>,
  missingPaths = new Set<string>(),
): void {
  mockRealpathSync.mockImplementation((pathToResolve) => {
    const resolvedPath = pathToResolve.toString();
    if (missingPaths.has(resolvedPath)) {
      throw errnoError(
        'ENOENT',
        `ENOENT: no such file or directory, realpath '${resolvedPath}'`,
      );
    }
    return resolutions.get(resolvedPath) ?? resolvedPath;
  });
}

const itPosix = it.skipIf(process.platform === 'win32');
const underHome = (...segments: string[]) =>
  path.join(os.homedir(), ...segments);

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function resetRuntimeDir(): void {
  Storage.setRuntimeBaseDir(null);
  delete process.env['QWEN_RUNTIME_DIR'];
}

/** Runs `setup` before each case, then clears the runtime dir and env. */
function isolateRuntimeDir(setup: () => void = resetRuntimeDir): void {
  const originalEnv = process.env['QWEN_RUNTIME_DIR'];
  beforeEach(setup);
  afterEach(() => {
    Storage.setRuntimeBaseDir(null);
    restoreEnv('QWEN_RUNTIME_DIR', originalEnv);
  });
}

const GLOBAL_CONFIG_PATHS = [
  ['getGlobalSettingsPath', 'settings.json'],
  ['getInstallationIdPath', 'installation_id'],
  ['getMcpOAuthTokensPath', 'mcp-oauth-tokens.json'],
  ['getOAuthCredsPath', 'oauth_creds.json'],
  ['getUserCommandsDir', 'commands'],
  ['getGlobalMemoryFilePath', 'memory.md'],
  ['getGlobalBinDir', 'bin'],
] as const;

describe('Storage – getGlobalSettingsPath', () => {
  it('returns path to ~/.qwen/settings.json', () => {
    expect(Storage.getGlobalSettingsPath()).toBe(
      underHome('.qwen', 'settings.json'),
    );
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
    expect(Storage.getUserCommandsDir()).toBe(underHome('.qwen', 'commands'));
  });

  it('getProjectCommandsDir returns project/.qwen/commands', () => {
    const expected = path.join(projectRoot, '.qwen', 'commands');
    expect(storage.getProjectCommandsDir()).toBe(expected);
  });

  it('getMcpOAuthTokensPath returns ~/.qwen/mcp-oauth-tokens.json', () => {
    const expected = underHome('.qwen', 'mcp-oauth-tokens.json');
    expect(Storage.getMcpOAuthTokensPath()).toBe(expected);
  });
});

describe('Storage – getRuntimeBaseDir / setRuntimeBaseDir', () => {
  isolateRuntimeDir();

  it('defaults to getGlobalQwenDir() when nothing is configured', () => {
    expect(Storage.getRuntimeBaseDir()).toBe(Storage.getGlobalQwenDir());
  });

  it('uses setRuntimeBaseDir value when set with absolute path', () => {
    const runtimeDir = path.resolve('custom', 'runtime');
    Storage.setRuntimeBaseDir(runtimeDir);
    expect(Storage.getRuntimeBaseDir()).toBe(runtimeDir);
  });

  it('env var QWEN_RUNTIME_DIR takes priority over setRuntimeBaseDir', () => {
    const envDir = path.resolve('from-env');
    Storage.setRuntimeBaseDir(path.resolve('from-settings'));
    process.env['QWEN_RUNTIME_DIR'] = envDir;
    expect(Storage.getRuntimeBaseDir()).toBe(envDir);
  });

  it('expands tilde (~) in setRuntimeBaseDir', () => {
    Storage.setRuntimeBaseDir('~/custom-runtime');
    expect(Storage.getRuntimeBaseDir()).toBe(underHome('custom-runtime'));
  });

  it('expands Windows-style tilde paths in setRuntimeBaseDir', () => {
    Storage.setRuntimeBaseDir('~\\custom-runtime');
    expect(Storage.getRuntimeBaseDir()).toBe(underHome('custom-runtime'));
  });

  it('expands tilde (~) in QWEN_RUNTIME_DIR env var', () => {
    process.env['QWEN_RUNTIME_DIR'] = '~/env-runtime';
    expect(Storage.getRuntimeBaseDir()).toBe(underHome('env-runtime'));
  });

  it('resolves relative paths in setRuntimeBaseDir using process.cwd by default', () => {
    Storage.setRuntimeBaseDir('relative/path');
    expect(Storage.getRuntimeBaseDir()).toBe(path.resolve('relative/path'));
  });

  it('resolves relative paths in setRuntimeBaseDir using explicit cwd', () => {
    const cwd = path.resolve('workspace', 'projectA');
    Storage.setRuntimeBaseDir('.qwen', cwd);
    expect(Storage.getRuntimeBaseDir()).toBe(path.join(cwd, '.qwen'));
  });

  it('ignores cwd when path is absolute', () => {
    const absolutePath = path.resolve('absolute', 'path');
    Storage.setRuntimeBaseDir(
      absolutePath,
      path.resolve('workspace', 'projectA'),
    );
    expect(Storage.getRuntimeBaseDir()).toBe(absolutePath);
  });

  it('ignores cwd when path starts with tilde', () => {
    Storage.setRuntimeBaseDir(
      '~/runtime',
      path.resolve('workspace', 'projectA'),
    );
    expect(Storage.getRuntimeBaseDir()).toBe(underHome('runtime'));
  });

  it('resolves relative paths in QWEN_RUNTIME_DIR env var', () => {
    process.env['QWEN_RUNTIME_DIR'] = 'relative/env-path';
    expect(Storage.getRuntimeBaseDir()).toBe(path.resolve('relative/env-path'));
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
  const ESCAPES = 'plansDirectory must resolve within the project root';
  const project = path.resolve('tmp', 'project');

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
    const projectInHome = underHome('workspace', 'project');
    expect(
      Storage.getPlansDir(projectInHome, '~/workspace/project/plans'),
    ).toBe(path.join(projectInHome, 'plans'));
  });

  it('allows absolute plansDirectory values inside the project root', () => {
    const plansDir = path.join(projectRoot, 'nested', 'plans');
    expect(Storage.getPlansDir(projectRoot, plansDir)).toBe(plansDir);
  });

  it('rejects relative plansDirectory values that escape the project root', () => {
    expect(() => Storage.getPlansDir(projectRoot, '../plans')).toThrow(ESCAPES);
  });

  it('rejects absolute plansDirectory values outside the project root', () => {
    const outsideProject = path.join(path.dirname(projectRoot), 'plans');
    expect(() => Storage.getPlansDir(projectRoot, outsideProject)).toThrow(
      ESCAPES,
    );
  });

  it('requires projectRoot when plansDirectory is configured', () => {
    const required =
      'projectRoot is required when plansDirectory is configured';
    expect(() => Storage.getPlansDir(undefined, './plans')).toThrow(required);
    expect(() => Storage.getPlansDir(null, './plans')).toThrow(required);
  });

  it('rejects Windows-style absolute path outside the project root', () => {
    // Project root on the C: drive, plansDirectory on D:.
    const projectOnC = path.resolve('C:', 'work', 'project');
    const plansOnD = path.resolve('D:', 'plans');
    expect(() => Storage.getPlansDir(projectOnC, plansOnD)).toThrow(ESCAPES);
  });

  it('rejects path with mixed separators that escapes project root', () => {
    // Windows-only: path.resolve treats backslashes as separators there,
    // while on POSIX they are literal characters and cannot traverse.
    if (process.platform !== 'win32') {
      return;
    }
    const tricky = '..\\..\\plans'; // backslashes with traversal
    expect(() => Storage.getPlansDir(projectRoot, tricky)).toThrow(ESCAPES);
  });

  it('rejects symlink pointing outside the project root', () => {
    const symlink = path.join(project, 'escape-link');
    mockRealpath(
      new Map([
        [project, project],
        [symlink, path.resolve('tmp', 'outside')],
      ]),
    );

    expect(() => Storage.getPlansDir(project, './escape-link')).toThrow(
      ESCAPES,
    );
  });

  it('allows legitimate symlink that stays within project root', () => {
    const symlink = path.join(project, 'plans-link');
    mockRealpath(
      new Map([
        [project, project],
        [symlink, path.join(project, 'plans-target')],
      ]),
    );

    // The configured symlink path is accepted as long as it stays inside
    // the project root.
    expect(Storage.getPlansDir(project, './plans-link')).toBe(symlink);
  });

  it('rejects missing nested path under symlink that escapes project root', () => {
    const dataSymlink = path.join(project, 'data');
    const missingSubdir = path.join(dataSymlink, 'subdir');
    mockRealpath(
      new Map([
        [project, project],
        [dataSymlink, path.resolve('tmp', 'outside')],
      ]),
      new Set([path.join(missingSubdir, 'plans'), missingSubdir]),
    );

    expect(() => Storage.getPlansDir(project, './data/subdir/plans')).toThrow(
      ESCAPES,
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
  const customDir = path.resolve('custom');
  // Every case runs against the custom runtime base dir.
  isolateRuntimeDir(() => {
    resetRuntimeDir();
    Storage.setRuntimeBaseDir(customDir);
  });

  it('getGlobalTempDir uses custom runtime base dir', () => {
    expect(Storage.getGlobalTempDir()).toBe(path.join(customDir, 'tmp'));
  });

  it('getGlobalDebugDir uses custom runtime base dir', () => {
    expect(Storage.getGlobalDebugDir()).toBe(path.join(customDir, 'debug'));
  });

  it('getDebugLogPath uses custom runtime base dir', () => {
    expect(Storage.getDebugLogPath('session-123')).toBe(
      path.join(customDir, 'debug', 'session-123.txt'),
    );
  });

  it('getGlobalIdeDir is anchored to the global Qwen dir, not runtime base dir', () => {
    // IDE lock files are discovery anchors shared with the VS Code companion,
    // which can only see env vars (not settings-based runtimeOutputDir), so
    // getGlobalIdeDir must follow getGlobalQwenDir to keep both sides aligned.
    expect(Storage.getGlobalIdeDir()).toBe(
      path.join(Storage.getGlobalQwenDir(), 'ide'),
    );
  });

  it('getProjectDir uses custom runtime base dir', () => {
    const storage = new Storage('/tmp/project');
    expect(storage.getProjectDir()).toContain(path.join(customDir, 'projects'));
  });

  it('getGeneratedWorkflowsDir sits under the project workflow runs dir', () => {
    const storage = new Storage('/tmp/project');
    expect(storage.getGeneratedWorkflowsDir()).toBe(
      path.join(storage.getWorkflowRunsDir(), 'generated'),
    );
    expect(storage.getGeneratedWorkflowsDir()).toContain(
      path.join(customDir, 'projects'),
    );
  });

  it('getProjectTempDir uses custom runtime base dir', () => {
    const storage = new Storage('/tmp/project');
    expect(storage.getProjectTempDir()).toContain(path.join(customDir, 'tmp'));
  });

  it('getProjectTempCheckpointsDir uses custom runtime base dir', () => {
    const storage = new Storage('/tmp/project');
    expect(storage.getProjectTempCheckpointsDir()).toContain(
      path.join(customDir, 'tmp'),
    );
    expect(storage.getProjectTempCheckpointsDir()).toMatch(/checkpoints$/);
  });

  it('getHistoryFilePath uses custom runtime base dir', () => {
    const storage = new Storage('/tmp/project');
    expect(storage.getHistoryFilePath()).toContain(path.join(customDir, 'tmp'));
    expect(storage.getHistoryFilePath()).toMatch(/shell_history$/);
  });
});

describe('Storage – config paths remain at ~/.qwen regardless of runtime dir', () => {
  const globalQwenDir = Storage.getGlobalQwenDir();
  isolateRuntimeDir(() => {
    Storage.setRuntimeBaseDir(path.resolve('custom-runtime'));
    process.env['QWEN_RUNTIME_DIR'] = path.resolve('env-runtime');
  });

  it.each([
    ...GLOBAL_CONFIG_PATHS,
    ['getGoogleAccountsPath', 'google_accounts.json'] as const,
  ])('%s still uses ~/.qwen', (method, file) => {
    expect(Storage[method]()).toBe(path.join(globalQwenDir, file));
  });

  it('getUserSkillsDirs still includes ~/.qwen/skills', () => {
    const skillsDirs = new Storage('/tmp/project').getUserSkillsDirs();
    expect(
      skillsDirs.some((dir) => dir === path.join(globalQwenDir, 'skills')),
    ).toBe(true);
  });
});

describe('Storage – QWEN_HOME env var', () => {
  const originalEnv = process.env['QWEN_HOME'];
  const configDir = path.resolve('/tmp/custom-qwen');

  afterEach(() => {
    restoreEnv('QWEN_HOME', originalEnv);
  });

  it('defaults to ~/.qwen when QWEN_HOME is not set', () => {
    delete process.env['QWEN_HOME'];
    expect(Storage.getGlobalQwenDir()).toBe(underHome('.qwen'));
  });

  it('uses QWEN_HOME when set to absolute path', () => {
    process.env['QWEN_HOME'] = configDir;
    expect(Storage.getGlobalQwenDir()).toBe(configDir);
  });

  it('resolves relative QWEN_HOME to absolute path', () => {
    process.env['QWEN_HOME'] = 'relative/config';
    expect(Storage.getGlobalQwenDir()).toBe(path.resolve('relative/config'));
  });

  it('config paths follow QWEN_HOME', () => {
    process.env['QWEN_HOME'] = configDir;
    for (const [method, file] of GLOBAL_CONFIG_PATHS) {
      expect(Storage[method]()).toBe(path.join(configDir, file));
    }
  });

  it('project-level paths are NOT affected by QWEN_HOME', () => {
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
    expect(Storage.getGlobalQwenDir()).toBe(underHome('custom-qwen'));
  });

  it('expands Windows-style tilde in QWEN_HOME', () => {
    process.env['QWEN_HOME'] = '~\\custom-qwen';
    expect(Storage.getGlobalQwenDir()).toBe(underHome('custom-qwen'));
  });

  it('handles bare tilde (~) as home directory in QWEN_HOME', () => {
    process.env['QWEN_HOME'] = '~';
    expect(Storage.getGlobalQwenDir()).toBe(path.normalize(os.homedir()));
  });

  it('QWEN_HOME and QWEN_RUNTIME_DIR are independent', () => {
    const qwenHome = path.resolve('/tmp/config');
    const runtimeDir = path.resolve('/tmp/runtime');
    process.env['QWEN_HOME'] = qwenHome;
    process.env['QWEN_RUNTIME_DIR'] = runtimeDir;
    expect(Storage.getGlobalQwenDir()).toBe(qwenHome);
    expect(Storage.getRuntimeBaseDir()).toBe(runtimeDir);
    expect(Storage.getGlobalSettingsPath()).toBe(
      path.join(qwenHome, 'settings.json'),
    );
    expect(Storage.getGlobalTempDir()).toBe(path.join(runtimeDir, 'tmp'));
    expect(Storage.getGlobalDebugDir()).toBe(path.join(runtimeDir, 'debug'));
    delete process.env['QWEN_RUNTIME_DIR'];
  });
});

describe('Storage – runtime base dir async context isolation', () => {
  isolateRuntimeDir();

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
  const SIDECAR = 'audit-2026-01-01.sidecar';
  const REPORT = '2026-01-01-000000-mod.md';
  const SYMLINK_CHILD = /contains a symlink/;
  const AUDITS_NOT_DIR = /audit artifact directory .* is not a directory/;
  const INSIDE_REPO = /resolves inside the audited/;
  const LEAF_NOT_DIR = /fallback landing .* is not a directory/;
  let home: string;

  const ensure = (root: string) => Storage.ensureAuditFallbackDir(root);
  const expectRefused = (
    root: string,
    ...errors: Array<RegExp | typeof FatalConfigError>
  ) => {
    for (const error of errors) expect(() => ensure(root)).toThrow(error);
  };
  const rmrf = (p: string) =>
    actualFs.rmSync(p, { recursive: true, force: true });
  const realReaddir = (dir: unknown) =>
    actualFs.readdirSync(String(dir), { withFileTypes: true });
  const dirent = (name: string, isFile: boolean) => ({
    name,
    isSymbolicLink: () => false,
    isFile: () => isFile,
    isDirectory: () => false,
  });

  function withTemp(prefix: string, fn: (dir: string) => void): void {
    const dir = actualFs.mkdtempSync(path.join(os.tmpdir(), prefix));
    try {
      fn(dir);
    } finally {
      rmrf(dir);
    }
  }

  function asDarwin(fn: () => void): void {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    try {
      fn();
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    }
  }

  function withPlantedLanding(root: string, check: () => void): void {
    withTemp('audit-decoy-', (decoy) => {
      const leaf = ensure(root);
      rmrf(leaf);
      actualFs.symlinkSync(decoy, leaf);
      try {
        check();
      } finally {
        actualFs.rmSync(leaf, { force: true });
      }
    });
  }

  /** The `n`th mkdirSync of `target` (or a path it accepts) runs `race` first. */
  function raceMkdir(
    target: string | ((dir: string) => boolean),
    n: number,
    race: () => void,
  ): void {
    let seen = 0;
    mockMkdirSync.mockImplementation(
      (...args: Parameters<typeof actualFs.mkdirSync>) => {
        const dir = String(args[0]);
        const hit = typeof target === 'string' ? dir === target : target(dir);
        if (hit && ++seen === n) race();
        return actualFs.mkdirSync(...args);
      },
    );
  }

  /** Like raceMkdir for readdirSync of `target`; `listFirst` lists first. */
  function raceReaddir(
    target: string,
    n: number,
    race: () => void,
    listFirst = false,
  ): void {
    let seen = 0;
    mockReaddirSync.mockImplementation((dir: unknown) => {
      const listed = listFirst ? realReaddir(dir) : undefined;
      if (String(dir) === target && ++seen === n) race();
      return listFirst ? listed : realReaddir(dir);
    });
  }

  beforeEach(() => {
    home = actualFs.mkdtempSync(path.join(os.tmpdir(), 'qwen-home-test-'));
    process.env['QWEN_HOME'] = home;
    // Give the file-wide fs mocks the real contracts again: production code
    // must not carry a branch that exists only to tolerate a test double.
    // Tests below restub readdirSync to reach shapes real tmpfs dirents never
    // have (untyped entries, EACCES) and mkdirSync as a race-injection seam.
    mockRealpathSync.mockImplementation((p: unknown) =>
      actualFs.realpathSync(String(p)),
    );
    mockReaddirSync.mockImplementation(realReaddir);
    mockMkdirSync.mockImplementation(
      (...args: Parameters<typeof actualFs.mkdirSync>) =>
        actualFs.mkdirSync(...args),
    );
  });

  afterEach(() => {
    rmrf(home);
    restoreEnv('QWEN_HOME', originalEnv);
  });

  it('lands under QWEN_HOME/audits/<project hash>', () => {
    const dir = ensure('/some/project');
    expect(path.dirname(path.dirname(dir))).toBe(home);
    expect(path.basename(path.dirname(dir))).toBe('audits');
    expect(path.basename(dir)).toMatch(/^[0-9a-f]{64}$/);
    expect(actualFs.statSync(dir).isDirectory()).toBe(true);
  });

  it('creates the landing 0700 so quoted module content stays private', () => {
    const mode = actualFs.statSync(ensure('/p')).mode;
    // On Windows mkdirSync's mode is a no-op and libuv emulates permission
    // bits by duplicating owner bits to group/other.
    if (process.platform !== 'win32') {
      expect(mode & 0o077).toBe(0);
      expect(mode & 0o700).toBe(0o700);
    }
  });

  it('separates projects and is idempotent', () => {
    const first = ensure('/project/a');
    const second = ensure('/project/b');
    expect(first).not.toBe(second);
    expect(ensure('/project/a')).toBe(first);
  });

  it('creates a missing QWEN_HOME base instead of failing with ENOENT', () => {
    const base = path.join(home, 'not-created-yet', 'nested');
    process.env['QWEN_HOME'] = base;
    const dir = ensure('/fresh-home');
    expect(path.dirname(path.dirname(dir))).toBe(base);
    expect(actualFs.statSync(dir).isDirectory()).toBe(true);
  });

  itPosix(
    'refuses an uncreatable QWEN_HOME tail with an actionable refusal',
    () => {
      // A dangling, looping, or file-targeting symlink tail fails the base
      // creation before any adoption check owns the state; the refusal must
      // be classified like its siblings, not escape as a raw errno trace.
      const tail = path.join(home, 'tail');
      const shapes = {
        dangling: () => actualFs.symlinkSync(path.join(home, 'nowhere'), tail),
        loop: () => actualFs.symlinkSync(tail, tail),
        'file-link': () => {
          actualFs.writeFileSync(path.join(home, 'regular'), 'x\n');
          actualFs.symlinkSync(path.join(home, 'regular'), tail);
        },
      };
      for (const [shape, plant] of Object.entries(shapes)) {
        actualFs.rmSync(tail, { force: true });
        plant();
        process.env['QWEN_HOME'] = tail;
        const attempt = () => ensure(`/tail-${shape}`);
        expect(attempt, `tail shape: ${shape}`).toThrow(FatalConfigError);
        expect(attempt, `tail shape: ${shape}`).toThrow(/could not be created/);
      }
    },
  );

  it('refuses a landing that resolves inside the audited repository', () =>
    withTemp('audit-repo-', (repo) => {
      process.env['QWEN_HOME'] = path.join(repo, '.qwen-state');
      expectRefused(repo, INSIDE_REPO);
      // Refused before creating anything inside the working tree.
      expect(actualFs.existsSync(path.join(repo, '.qwen-state'))).toBe(false);
    }));

  it('refuses a case-variant spelling of the audited root on case-insensitive platforms', () => {
    // Darwin volumes equate case-only spellings and realpath keeps the given
    // one, so a repo can be the audited root in one spelling and hold
    // QWEN_HOME in another. A byte-wise comparison misses that containment
    // and lands inside the working tree; the refusal must hold anyway.
    asDarwin(() =>
      withTemp('audit-CaseRepo-', (repo) => {
        const variant = repo.replace('audit-CaseRepo-', 'audit-caserepo-');
        try {
          process.env['QWEN_HOME'] = path.join(variant, '.qwen-state');
          expectRefused(repo, INSIDE_REPO);
          // Refused before creating anything inside the working tree.
          expect(actualFs.existsSync(path.join(variant, '.qwen-state'))).toBe(
            false,
          );
        } finally {
          rmrf(variant);
        }
      }),
    );
  });

  it('lands case-variant spellings of one root at one leaf on case-insensitive platforms', () => {
    // Two spellings of the same physical repository must hash to one leaf,
    // or plan-files, guard-check, and relocation split across two roots.
    asDarwin(() =>
      withTemp('audit-CaseRepo-', (repo) => {
        const variant = repo.replace('audit-CaseRepo-', 'audit-caserepo-');
        expect(ensure(variant)).toBe(ensure(repo));
      }),
    );
  });

  itPosix(
    'refuses a landing planted as a symlink instead of adopting it',
    () => {
      actualFs.mkdirSync(path.join(home, 'audits'), { recursive: true });
      // Predict the leaf the way the audited agent can: the hash is a pure
      // function of the project root.
      withPlantedLanding('/predictable', () =>
        expectRefused('/predictable', /not a directory/),
      );
    },
  );

  itPosix(
    'refuses an audits PARENT planted as a symlink, which relocates the whole landing',
    () => {
      // mkdirSync(recursive) follows symlinks ABOVE the leaf and lstat skips
      // only the FINAL one, so a leaf-only check misses a redirected parent.
      // Planting `audits` is one raceless `ln -s`: ~/.qwen predates it.
      withTemp('audit-attacker-', (attacker) => {
        actualFs.symlinkSync(attacker, path.join(home, 'audits'));
        try {
          expectRefused('/any/project', AUDITS_NOT_DIR);
          // Nothing was created inside the planter's directory.
          expect(actualFs.readdirSync(attacker)).toEqual([]);
        } finally {
          actualFs.rmSync(path.join(home, 'audits'), { force: true });
        }
      });
    },
  );

  itPosix(
    'refuses a landing holding a symlink child, which redirects writes out of it',
    () => {
      // Validating the leaf alone leaves the escape open: artifacts land
      // BELOW it and mkdirSync treats a symlink-to-directory as a directory,
      // so writes "inside" follow the link while the leaf passes every check.
      withTemp('audit-out-', (escape) => {
        const leaf = ensure('/with-child');
        actualFs.symlinkSync(escape, path.join(leaf, SIDECAR));
        expectRefused('/with-child', SYMLINK_CHILD, FatalConfigError);
      });
    },
  );

  itPosix(
    'refuses a symlink planted inside a child directory of the landing',
    () => {
      // Artifacts nest BELOW the leaf (audit-<ts>.sidecar/sidecar.json), so a
      // real subdirectory holding a symlinked file is the same escape as a
      // symlink child — validation must recurse, not stop at the leaf level.
      const leaf = ensure('/nested-symlink');
      const victim = path.join(home, 'victim.md');
      actualFs.writeFileSync(victim, 'user content\n');
      const sidecar = path.join(leaf, SIDECAR);
      actualFs.mkdirSync(sidecar);
      actualFs.symlinkSync(victim, path.join(sidecar, 'sidecar.json'));
      expectRefused('/nested-symlink', SYMLINK_CHILD, FatalConfigError);
    },
  );

  itPosix('refuses a landing holding a hardlinked file', () => {
    const leaf = ensure('/with-hardlink');
    const twin = path.join(home, 'twin.md');
    actualFs.writeFileSync(twin, 'planted\n');
    actualFs.linkSync(twin, path.join(leaf, REPORT));
    expectRefused('/with-hardlink', /hardlinked file/, FatalConfigError);
  });

  itPosix('refuses a landing holding a special file such as a FIFO', () => {
    // A FIFO/socket/device child fails every typing predicate; opening it
    // would block or stream content to the other end, so refuse it like a
    // symlink. A FIFO plants the same shape without a socket's sun_path
    // cap, which the 64-char hash leaf exceeds (bind truncates on Linux,
    // fails on macOS).
    const leaf = ensure('/with-special-file');
    const fifoPath = path.join(leaf, REPORT);
    const result = spawnSync('mkfifo', [fifoPath], { stdio: 'inherit' });
    expect(result.status).toBe(0);
    expectRefused(
      '/with-special-file',
      /contains a special file/,
      FatalConfigError,
    );
  });

  it('keeps adopting a landing that holds a previous run own artifacts', () => {
    // The landing is REUSED (report and sidecar are durable), so refusing
    // a non-empty landing would refuse every run after the first.
    const leaf = ensure('/reused');
    actualFs.writeFileSync(path.join(leaf, REPORT), '# r\n');
    actualFs.mkdirSync(path.join(leaf, SIDECAR), { recursive: true });
    expect(ensure('/reused')).toBe(leaf);
  });

  itPosix('is stable across symlink spellings of the same directory', () => {
    // macOS `/var` → `/private/var`: plan-files and guard-check must hash
    // either spelling to one fallback root, or the relocation-containment
    // check spuriously fails.
    withTemp('audit-real-', (real) => {
      const link = path.join(os.tmpdir(), `audit-link-${Date.now()}`);
      try {
        actualFs.symlinkSync(real, link);
        expect(ensure(link)).toBe(ensure(actualFs.realpathSync(real)));
      } finally {
        actualFs.rmSync(link, { force: true });
      }
    });
  });

  itPosix(
    'adopts a pre-existing loose-mode directory and tightens it to 0700',
    () => {
      const audits = path.join(home, 'audits');
      actualFs.mkdirSync(audits);
      actualFs.chmodSync(audits, 0o755);
      ensure('/loose-mode');
      expect(actualFs.statSync(audits).mode & 0o777).toBe(0o700);
    },
  );

  itPosix(
    'repairs a 0300-planted landing to readable and catches its planted symlink',
    () => {
      // Listing needs r while creating entries needs only w+x, so a 0300
      // landing still accepts writes: adoption must restore owner-read and
      // then validate, not skip validation because listing failed.
      const leaf = ensure('/planted-0300');
      rmrf(leaf);
      actualFs.mkdirSync(leaf);
      actualFs.chmodSync(leaf, 0o300);
      withTemp('audit-300-', (escape) => {
        actualFs.symlinkSync(escape, path.join(leaf, SIDECAR));
        try {
          expectRefused('/planted-0300', SYMLINK_CHILD);
          expect(actualFs.statSync(leaf).mode & 0o777).toBe(0o700);
        } finally {
          actualFs.chmodSync(leaf, 0o700);
        }
      });
    },
  );

  it('refuses a landing it cannot list for validation', () => {
    ensure('/unlistable');
    mockReaddirSync.mockImplementation(() => {
      throw errnoError('EACCES', 'EACCES: permission denied');
    });
    expectRefused(
      '/unlistable',
      /could not be listed for validation/,
      FatalConfigError,
    );
  });

  itPosix('falls back to lstat when a dirent arrives untyped', () => {
    const leaf = ensure('/untyped-dirent');
    withTemp('audit-dt-', (escape) => {
      actualFs.symlinkSync(escape, path.join(leaf, SIDECAR));
      mockReaddirSync.mockImplementationOnce(() => [dirent(SIDECAR, false)]);
      expectRefused('/untyped-dirent', SYMLINK_CHILD);
    });
  });

  itPosix(
    'refuses a QWEN_HOME tail raced into a repo symlink between the containment check and the base creation',
    () => {
      // The pre-creation containment check resolves the deepest EXISTING
      // ancestor, so a missing QWEN_HOME passes it. A tail planted at the
      // mkdirSync seam (a same-UID race) must be caught by the re-check.
      withTemp('audit-repo-', (repo) => {
        const target = path.join(repo, 'evil');
        actualFs.mkdirSync(target);
        const base = path.join(home, 'not-yet');
        process.env['QWEN_HOME'] = base;
        raceMkdir(base, 1, () => actualFs.symlinkSync(target, base));
        // The audited root IS the repo the tail now points into.
        expectRefused(repo, INSIDE_REPO);
        // Refused before anything was created inside the working tree.
        expect(actualFs.existsSync(path.join(target, 'audits'))).toBe(false);
      });
    },
  );

  itPosix(
    'refuses audits raced into a repo symlink between the two adoption checks',
    () => {
      // The first adoption validates `audits`, the second creates the leaf
      // THROUGH it: a swap in between relocates the landing past every check
      // that ran, so the pre-return re-validation must catch it.
      withTemp('audit-repo-', (repo) => {
        const stolen = path.join(repo, 'stolen');
        actualFs.mkdirSync(stolen);
        const audits = path.join(home, 'audits');
        raceMkdir(
          (dir) => dir.startsWith(audits + path.sep),
          1,
          () => {
            rmrf(audits);
            actualFs.symlinkSync(stolen, audits);
          },
        );
        expectRefused('/raced-audits', AUDITS_NOT_DIR);
        expect(actualFs.lstatSync(audits).isSymbolicLink()).toBe(true);
      });
    },
  );

  itPosix(
    'refuses an ancestor raced into a repo symlink above the adoption checks',
    () => {
      // Swapping a QWEN_HOME component ABOVE `audits` relocates the landing
      // while the re-adoption lstats still pass (both stay real dirs); only
      // the pre-return containment re-check sees the move.
      withTemp('audit-repo-', (repo) => {
        const stolen = path.join(repo, 'stolen');
        actualFs.mkdirSync(stolen);
        const inner = path.join(home, 'inner');
        process.env['QWEN_HOME'] = inner;
        const audits = path.join(inner, 'audits');
        raceMkdir(audits, 1, () => {
          rmrf(inner);
          actualFs.symlinkSync(stolen, inner);
        });
        // The audited root IS the repo the ancestor now points into.
        expectRefused(repo, INSIDE_REPO);
      });
    },
  );

  itPosix('refuses a leaf raced into a symlink after its own adoption', () => {
    const leaf = ensure('/raced-leaf');
    withTemp('audit-decoy-', (decoy) => {
      // Inject at the content check: the leaf's own lstat has already
      // passed, so only the pre-return re-validation can still see the swap.
      mockReaddirSync.mockImplementationOnce((dir: unknown) => {
        rmrf(leaf);
        actualFs.symlinkSync(decoy, leaf);
        return realReaddir(dir);
      });
      expectRefused('/raced-leaf', LEAF_NOT_DIR);
      expect(actualFs.lstatSync(leaf).isSymbolicLink()).toBe(true);
    });
  });

  itPosix(
    'refuses a symlink child planted after the content check snapshot',
    () => {
      // The content check's snapshot precedes the pre-return re-validation;
      // a child planted in between passes the leaf-only re-adoption lstats,
      // so the re-validation must re-run the content check.
      const leaf = ensure('/raced-child');
      withTemp('audit-race-', (escape) => {
        const audits = path.join(home, 'audits');
        raceMkdir(audits, 2, () =>
          actualFs.symlinkSync(escape, path.join(leaf, 'pwn')),
        );
        expectRefused('/raced-child', SYMLINK_CHILD);
      });
    },
  );

  itPosix(
    'refuses a listed file raced into a symlink inside the re-run content check',
    () => {
      // The re-run content check types entries from its own readdir
      // snapshot; a same-UID process can swap a listed file for a symlink
      // before the loop reaches it (the reused landing's names are
      // predictable). Every arm must decide from a fresh lstat instead.
      const leaf = ensure('/raced-swap');
      actualFs.writeFileSync(path.join(leaf, REPORT), '# report\n');
      withTemp('audit-swap-', (escape) => {
        const audits = path.join(home, 'audits');
        raceMkdir(audits, 2, () => {
          // The swap, plus a stale snapshot still typing it a regular
          // file: the exact state the race leaves behind.
          actualFs.rmSync(path.join(leaf, REPORT));
          actualFs.symlinkSync(escape, path.join(leaf, REPORT));
          mockReaddirSync.mockImplementationOnce(() => [dirent(REPORT, true)]);
        });
        expectRefused('/raced-swap', SYMLINK_CHILD);
      });
    },
  );

  it('surfaces the actionable refusal when audits is planted as a regular file', () => {
    // A non-directory `audits` makes the containment check's realpath fail
    // with ENOTDIR; that must fall through to the adoption checks and their
    // actionable message instead of escaping as a raw errno.
    actualFs.writeFileSync(path.join(home, 'audits'), 'planted\n');
    expectRefused('/audits-as-file', AUDITS_NOT_DIR);
  });

  it('fails closed when the final containment re-check cannot resolve the landing', () => {
    // At the pre-return site nothing downstream owns a resolution failure:
    // a swap that makes realpath fail (EACCES/ELOOP/ENOTDIR) must fail
    // closed, not be swallowed into returning an unvalidated landing.
    mockRealpathSync.mockImplementation((p: unknown) => {
      const target = String(p);
      if (target.startsWith(home)) {
        throw errnoError(
          'EACCES',
          `EACCES: permission denied, realpath '${target}'`,
        );
      }
      return actualFs.realpathSync(target);
    });
    expectRefused('/final-check', FatalConfigError, /could not be validated/);
  });

  it('refuses a containment violation as FatalConfigError rather than a bare crash', () =>
    withTemp('audit-repo-', (repo) => {
      process.env['QWEN_HOME'] = path.join(repo, '.qwen-state');
      expectRefused(repo, FatalConfigError);
    }));

  itPosix(
    'refuses a planted landing as FatalConfigError rather than a bare crash',
    () => {
      withPlantedLanding('/fatal-class', () =>
        expectRefused('/fatal-class', FatalConfigError),
      );
    },
  );
  itPosix(
    'refuses a directory child swapped for a symlink inside the final content check',
    () => {
      // The directory arm lstats, then recurses via a readdir that FOLLOWS
      // symlinks: swapping the child for a link to a clean dir in between
      // validates the target and keeps the link. The arm must re-lstat the
      // child after the recursion returns.
      const leaf = ensure('/raced-dir-child');
      const sidecar = path.join(leaf, SIDECAR);
      actualFs.mkdirSync(sidecar);
      withTemp('audit-clean-', (cleanTarget) => {
        raceReaddir(sidecar, 2, () => {
          rmrf(sidecar);
          actualFs.symlinkSync(cleanTarget, sidecar);
        });
        expectRefused('/raced-dir-child', SYMLINK_CHILD);
        expect(actualFs.lstatSync(sidecar).isSymbolicLink()).toBe(true);
      });
    },
  );

  itPosix(
    'tolerates a directory child that vanishes during the final content check',
    () => {
      // The post-recursion re-lstat races a landing reused across runs: a
      // child removed between the recursive walk and that re-lstat leaves
      // nothing to validate and must not fail the adoption.
      const leaf = ensure('/vanished-dir-child');
      const sidecar = path.join(leaf, SIDECAR);
      actualFs.mkdirSync(sidecar);
      raceReaddir(sidecar, 2, () => rmrf(sidecar), true);
      expect(ensure('/vanished-dir-child')).toBe(leaf);
    },
  );

  itPosix(
    'refuses a leaf raced into a symlink inside the final content check',
    () => {
      // The final content and containment re-checks FOLLOW the leaf, so a
      // swap inside either returns a symlinked landing; the re-adoption
      // lstats must run again after them. (The earlier leaf race injects at
      // the FIRST content check, before the re-adoption lstats.)
      const leaf = ensure('/raced-leaf-late');
      withTemp('audit-attacker-', (attacker) => {
        raceReaddir(leaf, 2, () => {
          rmrf(leaf);
          actualFs.symlinkSync(attacker, leaf);
        });
        expectRefused('/raced-leaf-late', LEAF_NOT_DIR);
        expect(actualFs.lstatSync(leaf).isSymbolicLink()).toBe(true);
      });
    },
  );

  itPosix(
    'refuses audits raced into a symlink inside the final content check',
    () => {
      // Swapping the `audits` parent relocates the whole landing while the
      // final content and containment checks FOLLOW the new root and pass;
      // only a re-adoption lstat after those checks can still see the swap.
      const leaf = ensure('/raced-audits-late');
      withTemp('audit-attacker-', (attacker) => {
        // The relocation target must hold the predictable leaf name, or the
        // follow-based checks would fail ENOENT instead of passing the swap.
        actualFs.mkdirSync(path.join(attacker, path.basename(leaf)));
        const audits = path.join(home, 'audits');
        raceReaddir(leaf, 2, () => {
          rmrf(audits);
          actualFs.symlinkSync(attacker, audits);
        });
        expectRefused('/raced-audits-late', AUDITS_NOT_DIR);
        expect(actualFs.lstatSync(audits).isSymbolicLink()).toBe(true);
      });
    },
  );
});
