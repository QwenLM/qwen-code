/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { ENV_CONFIG_DIR } from '@qwen-code/core';
import * as fs from 'node:fs';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyConfigDirFlagFromArgv,
  clearConfigDirFlagOverrideForTest,
  getConfigDirNameEnvError,
  parseConfigDirFlag,
} from './configDirFlag.js';

const CONFIG_HOME_DIR_OVERRIDE_KEY = Symbol.for('cli.configHomeDirOverride');

function getConfigDirOverride(): string | undefined {
  return (globalThis as Record<symbol, string | undefined>)[
    CONFIG_HOME_DIR_OVERRIDE_KEY
  ];
}

describe('configDirFlag', () => {
  let tempRoot: string;
  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'config-dir-中文 空格-'));
  });
  afterEach(() => {
    clearConfigDirFlagOverrideForTest();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('parses --config-dir followed by a path', () => {
    expect(
      parseConfigDirFlag(['node', 'script.js', '--config-dir', '/tmp/qwen']),
    ).toEqual({ value: '/tmp/qwen' });
  });

  it('parses --config-dir=<path>', () => {
    expect(
      parseConfigDirFlag(['node', 'script.js', '--config-dir=/tmp/qwen']),
    ).toEqual({ value: '/tmp/qwen' });
  });

  it('ignores --config-dir after --', () => {
    expect(
      parseConfigDirFlag([
        'node',
        'script.js',
        '--',
        '--config-dir',
        '/tmp/qwen',
      ]),
    ).toEqual({});
  });

  it('sets an absolute in-process override without setting ENV_CONFIG_DIR', () => {
    vi.stubEnv(ENV_CONFIG_DIR, undefined);

    const resolved = applyConfigDirFlagFromArgv([
      'node',
      'script.js',
      '--config-dir',
      path.relative(process.cwd(), path.join(tempRoot, 'e\u0301quipe')),
    ]);

    const expected = path.join(tempRoot, 'équipe');
    expect(resolved).toBe(expected);
    expect(fs.existsSync(expected)).toBe(false);
    expect(getConfigDirOverride()).toBe(expected);
    expect(process.env[ENV_CONFIG_DIR]).toBeUndefined();
  });

  it('does not modify an existing ENV_CONFIG_DIR environment variable', () => {
    vi.stubEnv(ENV_CONFIG_DIR, '/tmp/env-qwen-config');

    const target = path.join(tempRoot, 'flag-config');
    applyConfigDirFlagFromArgv(['node', 'script.js', `--config-dir=${target}`]);

    expect(getConfigDirOverride()).toBe(target);
    expect(process.env[ENV_CONFIG_DIR]).toBe('/tmp/env-qwen-config');
  });

  it('keeps an existing directory and its settings', () => {
    const target = path.join(tempRoot, 'existing');
    fs.mkdirSync(target);
    const settings = path.join(target, 'settings.json');
    fs.writeFileSync(settings, '{"mcpServers":{}}');
    expect(
      applyConfigDirFlagFromArgv(['node', 'cli', '--config-dir', target]),
    ).toBe(target);
    expect(fs.readFileSync(settings, 'utf8')).toBe('{"mcpServers":{}}');
  });

  it('exits before setting the override when the config path is a file', () => {
    const file = path.join(tempRoot, 'afile.txt');
    fs.writeFileSync(file, 'not-a-directory');
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(() =>
      applyConfigDirFlagFromArgv(['node', 'cli', '--config-dir', file]),
    ).toThrow('process.exit called');
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(String(stderr.mock.calls[0]?.[0])).toContain('not a directory');
    expect(String(stderr.mock.calls[0]?.[0])).toContain(file);
    expect(getConfigDirOverride()).toBeUndefined();
    expect(fs.readFileSync(file, 'utf8')).toBe('not-a-directory');
  });

  it('accepts a directory symlink (or a Windows junction)', () => {
    const target = path.join(tempRoot, 'directory');
    const link = path.join(tempRoot, 'directory-link');
    fs.mkdirSync(target);
    fs.symlinkSync(
      target,
      link,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    expect(
      applyConfigDirFlagFromArgv(['node', 'cli', '--config-dir', link]),
    ).toBe(link);
  });

  it.skipIf(process.platform === 'win32').each(['file', 'missing'])(
    'rejects a symlink to a %s target without replacing it',
    (kind) => {
      const target = path.join(tempRoot, 'target');
      const link = path.join(tempRoot, 'file-link');
      if (kind === 'file') fs.writeFileSync(target, 'not-a-directory');
      fs.symlinkSync(target, link, 'file');
      const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit called');
      });
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      expect(() =>
        applyConfigDirFlagFromArgv(['node', 'cli', '--config-dir', link]),
      ).toThrow('process.exit called');
      expect(exit).toHaveBeenCalledExactlyOnceWith(1);
      expect(String(stderr.mock.calls[0]?.[0])).toContain('not a directory');
      expect(String(stderr.mock.calls[0]?.[0])).toContain(link);
      expect(getConfigDirOverride()).toBeUndefined();
      expect(fs.readlinkSync(link)).toBe(target);
      if (kind === 'missing') expect(fs.existsSync(target)).toBe(false);
    },
  );

  it('exits with a clear error when --config-dir is missing a value', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    expect(() =>
      applyConfigDirFlagFromArgv(['node', 'script.js', '--config-dir']),
    ).toThrow('process.exit called');

    expect(exit).toHaveBeenCalledWith(1);
    expect(String(stderr.mock.calls[0]?.[0] ?? '')).toContain(
      '--config-dir requires a directory path',
    );
  });

  it.each([
    undefined,
    '',
    'abc',
    '.abc',
    'agents',
    '.agents',
    'abc.def',
    '目录',
    'e\u0301quipe',
    `e\u0301${'a'.repeat(63)}`,
    'name with spaces',
    '_',
    '-',
    '目'.repeat(64),
  ])('accepts the global config directory name %j', (value) => {
    expect(
      getConfigDirNameEnvError(
        { QWEN_CONFIG_DIR_NAME: value },
      ),
    ).toBeUndefined();
  });

  it.each([
    '.git',
    '.GIT',
    '.svn',
    '.hg',
    '.vscode',
    '.IDEA',
    '.husky',
    '.github',
    'node_modules',
    'Node_Modules',
    'bower_components',
  ])('reports the protected global config directory name %j', (value) => {
    expect(
      getConfigDirNameEnvError(
        { QWEN_CONFIG_DIR_NAME: value },
      ),
    ).toContain(
      'QWEN_CONFIG_DIR_NAME must not use protected directory name',
    );
  });

  it.each(['.agents', '.github-backup', 'my.git', 'config-service'])(
    'does not overmatch the valid global config directory name %j',
    (value) => {
      expect(
        getConfigDirNameEnvError(
          { QWEN_CONFIG_DIR_NAME: value },
        ),
      ).toBeUndefined();
    },
  );

  it.each([
    '.',
    '..',
    ' leading',
    'trailing ',
    ' ',
    'abc.',
    'a/b',
    'a\\b',
    'a:b',
    'a@b',
    'emoji-😀',
    `a\0b`,
    'line\nbreak',
    'CON',
    'con.txt',
    'PRN',
    'AUX.log',
    'NUL',
    'COM1',
    'com9.json',
    'LPT1',
    'lpt9.md',
    'a'.repeat(65),
  ])(
    'reports the invalid global config directory name %j',
    (value) => {
      expect(
        getConfigDirNameEnvError(
          { QWEN_CONFIG_DIR_NAME: value },
        ),
      ).toContain(
        'QWEN_CONFIG_DIR_NAME must be a valid directory name',
      );
    },
  );

  it('validates only the CN variable in CN builds', () => {
    expect(
      getConfigDirNameEnvError(
        {
          QWEN_CONFIG_DIR_NAME: 'a/b',
          EXAMPLE_CN_CONFIG_DIR_NAME: '.agents',
        },
        'EXAMPLE_CN_',
      ),
    ).toBeUndefined();
    expect(
      getConfigDirNameEnvError(
        {
          QWEN_CONFIG_DIR_NAME: 'abc',
          EXAMPLE_CN_CONFIG_DIR_NAME: 'a/b',
        },
        'EXAMPLE_CN_',
      ),
    ).toContain('EXAMPLE_CN_CONFIG_DIR_NAME');
  });

  it.each(['QWEN_', 'EXAMPLE_', 'EXAMPLE_CN_'])(
    'validates the selected %s namespace',
    (prefix) => {
      expect(getConfigDirNameEnvError({
        [`${prefix}CONFIG_DIR_NAME`]: '.git',
      }, prefix)).toContain(`${prefix}CONFIG_DIR_NAME must not use protected directory name`);
    },
  );

  it('ignores stale product variables with the default Qwen prefix', () => {
    expect(getConfigDirNameEnvError({
      QWEN_CONFIG_DIR_NAME: 'valid',
      EXAMPLE_CONFIG_DIR_NAME: '.git',
      EXAMPLE_CN_CONFIG_DIR_NAME: 'a/b',
    })).toBeUndefined();
  });

  it('exits before flag parsing when the directory name is invalid', () => {
    vi.stubEnv('BRAND_ENV_PREFIX', 'QWEN_');
    vi.stubEnv('QWEN_CONFIG_DIR_NAME', 'a/b');
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    expect(() => applyConfigDirFlagFromArgv(['node', 'script.js'])).toThrow(
      'process.exit called',
    );
    expect(exit).toHaveBeenCalledWith(1);
    expect(String(stderr.mock.calls[0]?.[0] ?? '')).toContain(
      'QWEN_CONFIG_DIR_NAME',
    );
  });

  it('exits before flag parsing when the directory name is protected', () => {
    vi.stubEnv('BRAND_ENV_PREFIX', 'QWEN_');
    vi.stubEnv('QWEN_CONFIG_DIR_NAME', '.GIT');
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    expect(() => applyConfigDirFlagFromArgv(['node', 'script.js'])).toThrow(
      'process.exit called',
    );
    expect(exit).toHaveBeenCalledWith(1);
    expect(String(stderr.mock.calls[0]?.[0] ?? '')).toContain(
      'QWEN_CONFIG_DIR_NAME must not use protected directory name',
    );
  });
});
