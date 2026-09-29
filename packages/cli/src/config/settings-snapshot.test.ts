/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ENV_CORRUPTED_PATH,
  ENV_WAS_RECOVERED,
  readSettingsSnapshot,
  SettingScope,
} from './settings.js';

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof os>();
  return { ...actual, homedir: vi.fn(actual.homedir) };
});

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof fs>()),
}));

function environmentDigest(): string {
  return createHash('sha256')
    .update(JSON.stringify(Object.entries(process.env).sort()))
    .digest('hex');
}

describe('readSettingsSnapshot with real settings files', () => {
  let root: string;
  let home: string;
  let workspace: string;
  let settingsPaths: Record<
    'system' | 'defaults' | 'user' | 'workspace',
    string
  >;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-settings-snapshot-'));
    home = path.join(root, 'home');
    workspace = path.join(root, 'workspace');
    fs.mkdirSync(home);
    fs.mkdirSync(workspace);
    vi.mocked(os.homedir).mockReturnValue(home);
    settingsPaths = {
      system: path.join(root, 'system', 'settings.json'),
      defaults: path.join(root, 'system', 'system-defaults.json'),
      user: path.join(home, '.qwen', 'settings.json'),
      workspace: path.join(workspace, '.qwen', 'settings.json'),
    };
    vi.stubEnv('QWEN_HOME', path.dirname(settingsPaths.user));
    vi.stubEnv('QWEN_RUNTIME_DIR', path.join(root, 'runtime'));
    vi.stubEnv('QWEN_CODE_SYSTEM_SETTINGS_PATH', settingsPaths.system);
    vi.stubEnv('QWEN_CODE_SYSTEM_DEFAULTS_PATH', settingsPaths.defaults);
    vi.stubEnv(ENV_CORRUPTED_PATH, undefined);
    vi.stubEnv(ENV_WAS_RECOVERED, undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function write(filePath: string, contents: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents);
  }

  function readSnapshot(
    workspaceTrusted = true,
    runtimeEnvironment: Readonly<NodeJS.ProcessEnv> = Object.freeze({}),
  ) {
    const before = environmentDigest();
    try {
      return readSettingsSnapshot(workspace, {
        runtimeEnvironment,
        workspaceTrusted,
      });
    } finally {
      expect(environmentDigest()).toBe(before);
    }
  }

  it('merges defaults, user, workspace and system with their existing precedence', () => {
    write(
      settingsPaths.defaults,
      JSON.stringify({
        $version: 4,
        model: { name: 'defaults', maxSessionTurns: 7 },
        ui: { theme: 'defaults', hideWindowTitle: true },
        general: { preferredEditor: 'defaults', vimMode: true },
      }),
    );
    write(
      settingsPaths.user,
      JSON.stringify({
        $version: 4,
        model: { name: 'user' },
        ui: { theme: 'user' },
        general: { preferredEditor: 'user' },
      }),
    );
    write(
      settingsPaths.workspace,
      JSON.stringify({
        $version: 4,
        model: { name: 'workspace' },
        ui: { theme: 'workspace' },
      }),
    );
    write(
      settingsPaths.system,
      JSON.stringify({ $version: 4, model: { name: 'system' } }),
    );

    const snapshot = readSnapshot();

    expect(snapshot.merged).toMatchObject({
      model: { name: 'system', maxSessionTurns: 7 },
      ui: { theme: 'workspace', hideWindowTitle: true },
      general: { preferredEditor: 'user', vimMode: true },
    });
    expect(snapshot.system.settings.model?.name).toBe('system');
    expect(snapshot.systemDefaults.settings.model?.name).toBe('defaults');
    expect(snapshot.user.settings.model?.name).toBe('user');
    expect(snapshot.workspace.settings.model?.name).toBe('workspace');
    expect(snapshot.migratedInMemoryScopes.size).toBe(0);
    expect(snapshot.workspaceSettingsActive).toBe(true);
    expect(snapshot.isTrusted).toBe(true);
  });

  it('resolves only the supplied environment without loading env files or consuming recovery markers', () => {
    vi.stubEnv('SETTINGS_SNAPSHOT_VALUE', 'ambient');
    vi.stubEnv('SETTINGS_SNAPSHOT_AMBIENT_ONLY', 'ambient-only');
    vi.stubEnv('SETTINGS_SNAPSHOT_HOME_ONLY', undefined);
    vi.stubEnv('SETTINGS_SNAPSHOT_WORKSPACE_ONLY', undefined);
    vi.stubEnv(ENV_CORRUPTED_PATH, `${settingsPaths.user}.corrupted`);
    vi.stubEnv(ENV_WAS_RECOVERED, '1');
    write(path.join(home, '.env'), 'SETTINGS_SNAPSHOT_HOME_ONLY=from-home\n');
    write(
      path.join(workspace, '.env'),
      'SETTINGS_SNAPSHOT_WORKSPACE_ONLY=from-workspace\n',
    );
    const source = JSON.stringify({
      $version: 4,
      model: { name: '${SETTINGS_SNAPSHOT_VALUE}' },
      general: { preferredEditor: '$SETTINGS_SNAPSHOT_AMBIENT_ONLY' },
      ui: { theme: '${SETTINGS_SNAPSHOT_HOME_ONLY}' },
      proxy: '${SETTINGS_SNAPSHOT_WORKSPACE_ONLY}',
    });
    for (const filePath of Object.values(settingsPaths))
      write(filePath, source);
    const environment = Object.freeze({ SETTINGS_SNAPSHOT_VALUE: 'runtime' });

    const snapshot = readSnapshot(true, environment);

    for (const scope of [
      snapshot.system,
      snapshot.systemDefaults,
      snapshot.user,
      snapshot.workspace,
    ]) {
      expect(scope.settings.model?.name).toBe('runtime');
      expect(scope.settings.general?.preferredEditor).toBe(
        '$SETTINGS_SNAPSHOT_AMBIENT_ONLY',
      );
      expect(scope.settings.ui?.theme).toBe('${SETTINGS_SNAPSHOT_HOME_ONLY}');
      expect(scope.settings.proxy).toBe('${SETTINGS_SNAPSHOT_WORKSPACE_ONLY}');
      expect(scope.originalSettings.model?.name).toBe(
        '${SETTINGS_SNAPSHOT_VALUE}',
      );
      expect(fs.readFileSync(scope.path, 'utf8')).toBe(source);
    }
    expect(snapshot.corruptedPath).toBeUndefined();
    expect(snapshot.wasRecovered).toBe(false);
    expect(environment).toEqual({ SETTINGS_SNAPSHOT_VALUE: 'runtime' });
    expect(process.env[ENV_CORRUPTED_PATH]).toBe(
      `${settingsPaths.user}.corrupted`,
    );
    expect(process.env[ENV_WAS_RECOVERED]).toBe('1');
    expect(process.env['SETTINGS_SNAPSHOT_HOME_ONLY']).toBeUndefined();
    expect(process.env['SETTINGS_SNAPSHOT_WORKSPACE_ONLY']).toBeUndefined();
  });

  it('migrates a supported old version in memory while preserving the original JSONC and directory', () => {
    const source = `{
  // Keep this user comment and formatting.
  "$version": 2,
  "general": { "disableAutoUpdate": true, "gitCoAuthor": false },
  "model": { "name": "\${SETTINGS_SNAPSHOT_VALUE}" }
}\n`;
    write(settingsPaths.user, source);
    const beforeEntries = fs.readdirSync(path.dirname(settingsPaths.user));

    const snapshot = readSnapshot(true, {
      SETTINGS_SNAPSHOT_VALUE: 'migrated-model',
    });

    expect(snapshot.user.settings).toMatchObject({
      $version: 4,
      general: {
        enableAutoUpdate: false,
        gitCoAuthor: { commit: false, pr: false },
      },
      model: { name: 'migrated-model' },
    });
    expect(snapshot.user.settings.general).not.toHaveProperty(
      'disableAutoUpdate',
    );
    expect(snapshot.user.rawJson).toBe(source);
    expect(snapshot.user.originalSettings.model?.name).toBe(
      '${SETTINGS_SNAPSHOT_VALUE}',
    );
    expect(snapshot.migratedInMemoryScopes).toEqual(
      new Set([SettingScope.User]),
    );
    expect(fs.readFileSync(settingsPaths.user, 'utf8')).toBe(source);
    expect(fs.readdirSync(path.dirname(settingsPaths.user))).toEqual(
      beforeEntries,
    );
  });

  it('ignores even invalid workspace settings when explicit trust is false', () => {
    write(
      settingsPaths.user,
      JSON.stringify({ $version: 4, model: { name: 'trusted-user-model' } }),
    );
    write(settingsPaths.workspace, '{ invalid workspace JSON');

    const snapshot = readSnapshot(false);

    expect(snapshot.merged.model?.name).toBe('trusted-user-model');
    expect(snapshot.workspace.settings).toEqual({});
    expect(snapshot.workspaceSettingsActive).toBe(false);
    expect(snapshot.isTrusted).toBe(false);
    expect(fs.readFileSync(settingsPaths.workspace, 'utf8')).toBe(
      '{ invalid workspace JSON',
    );
    expect(fs.existsSync(`${settingsPaths.workspace}.corrupted`)).toBe(false);
  });

  it.each(['system', 'defaults', 'user', 'workspace'] as const)(
    'rejects corrupt %s JSON without recovery writes',
    (scope) => {
      const filePath = settingsPaths[scope];
      const source = '{ "model": { "name": "keep-me" }';
      write(filePath, source);
      const beforeEntries = fs.readdirSync(path.dirname(filePath));

      let failure: unknown;
      try {
        readSnapshot();
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(Error);
      expect(failure).toHaveProperty(
        'message',
        expect.stringContaining(filePath),
      );
      expect(failure).toHaveProperty(
        'message',
        expect.stringContaining('Settings file contains invalid JSON.'),
      );
      expect(failure).toHaveProperty(
        'message',
        expect.not.stringContaining('keep-me'),
      );

      expect(fs.readFileSync(filePath, 'utf8')).toBe(source);
      expect(fs.existsSync(`${filePath}.corrupted`)).toBe(false);
      expect(fs.readdirSync(path.dirname(filePath))).toEqual(beforeEntries);
    },
  );

  it('rejects an actual directory at the settings file path', () => {
    fs.mkdirSync(settingsPaths.user, { recursive: true });

    expect(() => readSnapshot()).toThrow(
      'Configuration path is not a regular file',
    );

    expect(fs.statSync(settingsPaths.user).isDirectory()).toBe(true);
    expect(fs.readdirSync(settingsPaths.user)).toEqual([]);
  });

  it.each(['null', '[]', '"text"', '42', 'true'])(
    'rejects a non-object JSON root: %s',
    (source) => {
      write(settingsPaths.user, source);

      expect(() => readSnapshot()).toThrow('not a valid JSON object');

      expect(fs.readFileSync(settingsPaths.user, 'utf8')).toBe(source);
      expect(fs.existsSync(`${settingsPaths.user}.corrupted`)).toBe(false);
    },
  );

  it.each([6, 999, 0, -1, 2.5, '4', null])(
    'rejects an unsupported explicit version: %s',
    (version) => {
      const source = JSON.stringify({
        $version: version,
        model: { name: 'keep' },
      });
      write(settingsPaths.user, source);

      expect(() => readSnapshot()).toThrow('unsupported version');

      expect(fs.readFileSync(settingsPaths.user, 'utf8')).toBe(source);
      expect(fs.existsSync(`${settingsPaths.user}.corrupted`)).toBe(false);
    },
  );

  it('accepts truly absent settings without creating any files or directories', () => {
    const beforeEntries = fs.readdirSync(root, { recursive: true });

    const snapshot = readSnapshot();

    expect(snapshot.merged).toEqual({});
    for (const scope of [
      snapshot.system,
      snapshot.systemDefaults,
      snapshot.user,
      snapshot.workspace,
    ]) {
      expect(scope.settings).toEqual({});
      expect(scope.rawJson).toBeUndefined();
      expect(fs.existsSync(scope.path)).toBe(false);
    }
    expect(snapshot.migratedInMemoryScopes.size).toBe(0);
    expect(fs.readdirSync(root, { recursive: true })).toEqual(beforeEntries);
  });

  it('rejects a dangling settings symlink instead of treating it as absent', () => {
    fs.mkdirSync(path.dirname(settingsPaths.user), { recursive: true });
    const missingTarget = path.join(root, 'missing-settings.json');
    fs.symlinkSync(missingTarget, settingsPaths.user);

    expect(() => readSnapshot()).toThrow(/ENOENT/);

    expect(fs.lstatSync(settingsPaths.user).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(settingsPaths.user)).toBe(missingTarget);
    expect(fs.existsSync(missingTarget)).toBe(false);
  });

  it.each(['user', 'workspace'] as const)(
    'rejects a dangling parent directory for %s settings',
    (scope) => {
      const parent = path.dirname(settingsPaths[scope]);
      const target = path.join(root, 'missing-settings-directory');
      fs.symlinkSync(target, parent, 'dir');

      expect(() => readSnapshot()).toThrow(/ENOENT/);

      expect(fs.lstatSync(parent).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(parent)).toBe(target);
      expect(fs.existsSync(target)).toBe(false);
    },
  );

  it.each(['before-read', 'after-read'] as const)(
    'rejects settings deleted %s after the existence check',
    (timing) => {
      write(settingsPaths.user, '{"$version":4,"model":{"name":"original"}}');
      const actualRead = fs.readFileSync;
      const read = vi
        .spyOn(fs, 'readFileSync')
        .mockImplementationOnce((...args) => {
          expect(args[0]).toBe(settingsPaths.user);
          if (timing === 'before-read') {
            fs.unlinkSync(settingsPaths.user);
            return actualRead(...args);
          }
          const contents = actualRead(...args);
          fs.unlinkSync(settingsPaths.user);
          return contents;
        });

      expect(() => readSnapshot()).toThrow(/ENOENT/);

      expect(read).toHaveBeenCalledOnce();
      expect(fs.existsSync(settingsPaths.user)).toBe(false);
      expect(fs.readdirSync(path.dirname(settingsPaths.user))).toEqual([]);
    },
  );

  it('rejects a file replaced while reading, even when the replacement has the same size', () => {
    const original = '{"$version":4,"model":{"name":"before"}}';
    const replacement = '{"$version":4,"model":{"name":"after!"}}';
    write(settingsPaths.user, original);
    const replacementPath = path.join(root, 'replacement.json');
    write(replacementPath, replacement);
    expect(Buffer.byteLength(original)).toBe(Buffer.byteLength(replacement));
    const actualRead = fs.readFileSync;
    const read = vi
      .spyOn(fs, 'readFileSync')
      .mockImplementationOnce((...args) => {
        expect(args[0]).toBe(settingsPaths.user);
        const contents = actualRead(...args);
        fs.renameSync(replacementPath, settingsPaths.user);
        return contents;
      });

    expect(() => readSnapshot()).toThrow(
      'Configuration file changed while it was read',
    );

    expect(read).toHaveBeenCalledOnce();
    expect(actualRead(settingsPaths.user, 'utf8')).toBe(replacement);
    expect(fs.existsSync(`${settingsPaths.user}.corrupted`)).toBe(false);
    expect(fs.readdirSync(path.dirname(settingsPaths.user))).toEqual([
      'settings.json',
    ]);
  });
});

import { describeTree as describeTreeUnder } from '../test-utils/describe-tree.js';
import { resetHomeEnvBootstrapForTesting } from './environment.js';

describe('readSettingsSnapshot', () => {
  let root: string;
  let workspace: string;
  let environment: NodeJS.ProcessEnv;
  let userFile: string;
  let workspaceFile: string;
  let systemFile: string;
  let processEnvironment: NodeJS.ProcessEnv;

  beforeEach(() => {
    root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-settings-snapshot-')),
    );
    workspace = path.join(root, 'workspace');
    fs.mkdirSync(path.join(workspace, '.qwen'), { recursive: true });
    environment = {
      QWEN_HOME: path.join(root, 'qwen-home'),
      QWEN_CODE_SYSTEM_SETTINGS_PATH: path.join(
        root,
        'system',
        'settings.json',
      ),
      QWEN_CODE_SYSTEM_DEFAULTS_PATH: path.join(
        root,
        'system',
        'system-defaults.json',
      ),
    };
    fs.mkdirSync(environment['QWEN_HOME']!, { recursive: true });
    fs.mkdirSync(path.join(root, 'system'), { recursive: true });
    userFile = path.join(environment['QWEN_HOME']!, 'settings.json');
    workspaceFile = path.join(workspace, '.qwen', 'settings.json');
    systemFile = environment['QWEN_CODE_SYSTEM_SETTINGS_PATH']!;
    // Point the process at the same tree, with a home .env that sets a
    // bootstrap key, so a step that writes through process-level paths or the
    // process environment is visible here.
    fs.writeFileSync(
      path.join(environment['QWEN_HOME']!, '.env'),
      `QWEN_RUNTIME_DIR=${path.join(root, 'runtime-from-env')}\n`,
    );
    for (const key of [
      'QWEN_HOME',
      'QWEN_CODE_SYSTEM_SETTINGS_PATH',
      'QWEN_CODE_SYSTEM_DEFAULTS_PATH',
    ]) {
      vi.stubEnv(key, environment[key]);
    }
    vi.stubEnv('QWEN_RUNTIME_DIR', undefined);
    // The home .env pre-resolution runs once per process; re-arm it so a
    // snapshot that ran it would write QWEN_RUNTIME_DIR here.
    resetHomeEnvBootstrapForTesting();
    processEnvironment = { ...process.env };
  });

  afterEach(() => {
    try {
      expect(process.env).toEqual(processEnvironment);
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  const read = (workspaceTrusted = true) =>
    readSettingsSnapshot(workspace, {
      runtimeEnvironment: environment,
      workspaceTrusted,
    });

  const describeTree = () => describeTreeUnder(root);

  it('locates and merges the layers through the given environment', () => {
    vi.stubEnv('QWEN_HOME', path.join(root, 'elsewhere'));
    vi.stubEnv(
      'QWEN_CODE_SYSTEM_SETTINGS_PATH',
      path.join(root, 'elsewhere.json'),
    );
    vi.stubEnv(
      'QWEN_CODE_SYSTEM_DEFAULTS_PATH',
      path.join(root, 'elsewhere-defaults.json'),
    );
    processEnvironment = { ...process.env };
    fs.writeFileSync(
      userFile,
      JSON.stringify({ $version: 4, ui: { theme: 'User Theme' } }),
    );
    fs.writeFileSync(
      workspaceFile,
      JSON.stringify({ $version: 4, ui: { hideTips: true } }),
    );
    fs.writeFileSync(
      systemFile,
      JSON.stringify({ $version: 4, general: { preferredEditor: 'vim' } }),
    );
    fs.writeFileSync(
      environment['QWEN_CODE_SYSTEM_DEFAULTS_PATH']!,
      JSON.stringify({ $version: 4, context: { fileName: 'DEFAULTS.md' } }),
    );

    const trusted = read();
    expect(trusted.merged.ui?.theme).toBe('User Theme');
    expect(trusted.merged.ui?.hideTips).toBe(true);
    expect(trusted.merged.general?.preferredEditor).toBe('vim');
    expect(trusted.merged.context?.fileName).toBe('DEFAULTS.md');
    expect(trusted.user.path).toBe(userFile);

    const untrusted = read(false);
    expect(untrusted.merged.ui?.hideTips).toBeUndefined();
    expect(untrusted.isTrusted).toBe(false);
  });

  it('resolves placeholders only from the given environment', () => {
    fs.writeFileSync(
      userFile,
      JSON.stringify({
        $version: 4,
        general: { preferredEditor: '${QWEN_SNAPSHOT_TEST_EDITOR}' },
        ui: { theme: '${QWEN_SNAPSHOT_TEST_THEME}' },
      }),
    );
    environment['QWEN_SNAPSHOT_TEST_EDITOR'] = 'nano';
    vi.stubEnv('QWEN_SNAPSHOT_TEST_EDITOR', 'vim');
    vi.stubEnv('QWEN_SNAPSHOT_TEST_THEME', 'Process Theme');
    processEnvironment = { ...process.env };

    const merged = read().merged;
    expect(merged.general?.preferredEditor).toBe('nano');
    expect(merged.ui?.theme).toBe('${QWEN_SNAPSHOT_TEST_THEME}');
  });

  it('resolves placeholders on Windows as a spawned session host sees them', () => {
    fs.writeFileSync(
      userFile,
      JSON.stringify({
        $version: 4,
        tools: { approvalMode: '${mode}' },
        general: { preferredEditor: '${Editor}' },
      }),
    );
    // A workspace .env can add a second spelling beside the daemon's own;
    // spawn passes on only the one that sorts first.
    environment['MODE'] = 'plan';
    environment['mode'] = 'default';
    environment['EDITOR'] = 'vim';
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      const merged = read().merged;
      expect(merged.tools?.approvalMode).toBe('plan');
      expect(merged.general?.preferredEditor).toBe('vim');
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });

  it('never looks for user settings the process home still holds', () => {
    // A process whose QWEN_HOME has moved away from a home that still holds
    // settings warns about the move after swapping QWEN_HOME to find them.
    const home = path.join(root, 'home');
    fs.mkdirSync(path.join(home, '.qwen'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.qwen', 'settings.json'),
      JSON.stringify({ $version: 4, ui: { theme: 'Old Home' } }),
    );
    vi.stubEnv('HOME', home);
    processEnvironment = { ...process.env };

    const settings = read();
    expect(settings.migrationWarnings).toEqual([]);
    expect(settings.merged.ui?.theme).toBeUndefined();
  });

  it('migrates and normalizes in memory without writing or changing the environment', () => {
    fs.writeFileSync(userFile, JSON.stringify({ $version: 3 }));
    fs.writeFileSync(workspaceFile, '{}');
    // A relaunched parent's corruption marker stays for the process itself.
    vi.stubEnv('QWEN_CODE_SETTINGS_CORRUPTED_PATH', `${userFile}.corrupted`);
    vi.stubEnv('QWEN_CODE_SETTINGS_WAS_RECOVERED', '1');
    processEnvironment = { ...process.env };
    const treeBefore = describeTree();

    const settings = read();

    const version = (layer: { settings: object }) =>
      (layer.settings as Record<string, unknown>)['$version'];
    expect(version(settings.user)).toBe(4);
    expect(version(settings.workspace)).toBe(4);
    expect(describeTree()).toEqual(treeBefore);
  });

  // The evaluation checks this first, through the same resolveHomeDirectory.
  it('throws when the home directory cannot be resolved', () => {
    // node:os is a file-level mock here, so the rebinding-and-sync mechanism
    // cannot reach the settings module; drive the mocked homedir itself.
    const mocked = vi.mocked(os.homedir);
    const original = mocked.getMockImplementation();
    mocked.mockReturnValue(path.join(root, 'missing-home'));
    try {
      expect(() => read()).toThrow(/ENOENT/);
    } finally {
      if (original) mocked.mockImplementation(original);
    }
  });

  it('reads and writes nothing without an environment', () => {
    // The process points at the same tree, so a read through process-level
    // paths would migrate the user file and reset the workspace file.
    fs.writeFileSync(userFile, JSON.stringify({ $version: 3 }));
    fs.writeFileSync(workspaceFile, '{ "ui": ');
    const treeBefore = describeTree();

    expect(() =>
      readSettingsSnapshot(workspace, {
        runtimeEnvironment: undefined as unknown as NodeJS.ProcessEnv,
        workspaceTrusted: true,
      }),
    ).toThrow('A settings snapshot needs an environment.');
    expect(describeTree()).toEqual(treeBefore);
  });

  it.each([
    [
      'invalid workspace JSON',
      () => fs.writeFileSync(workspaceFile, '{ "ui": '),
    ],
    ['invalid user JSON', () => fs.writeFileSync(userFile, '{ "ui": ')],
    [
      'a JSON value that is not an object',
      () => fs.writeFileSync(userFile, '[]'),
    ],
    [
      'a version this build cannot migrate',
      () => fs.writeFileSync(userFile, JSON.stringify({ $version: 99 })),
    ],
    [
      'a version that is not an integer',
      () => fs.writeFileSync(userFile, JSON.stringify({ $version: '4' })),
    ],
    [
      'a version below one',
      () => fs.writeFileSync(userFile, JSON.stringify({ $version: 0 })),
    ],
    ['a directory in place of the file', () => fs.mkdirSync(systemFile)],
    [
      'a dangling link in place of the file',
      () => fs.symlinkSync(path.join(root, 'gone.json'), userFile),
    ],
  ])('throws for %s without writing anything', (_name, arrange) => {
    arrange();
    const treeBefore = describeTree();

    expect(() => read()).toThrow();
    expect(describeTree()).toEqual(treeBefore);
  });
});
