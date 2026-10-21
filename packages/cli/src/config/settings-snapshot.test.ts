/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import * as os from 'node:os';
import nodeOs from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { describeTree as describeTreeUnder } from '../test-utils/describe-tree.js';
import { resetHomeEnvBootstrapForTesting } from './environment.js';
import { readSettingsSnapshot } from './settings.js';

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
    readSettingsSnapshot(workspace, { environment, workspaceTrusted });

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
    // Builtin named exports follow the module object only after a sync.
    const homedir = nodeOs.homedir;
    nodeOs.homedir = () => path.join(root, 'missing-home');
    syncBuiltinESMExports();
    try {
      expect(() => read()).toThrow(/ENOENT/);
    } finally {
      nodeOs.homedir = homedir;
      syncBuiltinESMExports();
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
        environment: undefined as unknown as NodeJS.ProcessEnv,
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
