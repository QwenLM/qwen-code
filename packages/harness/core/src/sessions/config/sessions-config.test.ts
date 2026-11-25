/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  ENV_CONFIG_DIR,
  ENV_CLI_HOME,
  ENV_CONFIG_DIR_NAME,
} from '../../config/brand.js';
import * as nodePath from 'node:path';
import * as os from 'node:os';
import {
  getConfigHomeDir as getCoreConfigHomeDir,
  setConfigHomeDirOverride,
} from '../../utils/paths.js';
import {
  getConfigHomeDir,
  setConfigHomeDir,
  resetConfigHomeDirCache,
  getUserConfigDisplayPath,
} from './sessions-config.js';

describe('session config root', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    setConfigHomeDirOverride(undefined);
    setConfigHomeDir(undefined);
    delete process.env[ENV_CONFIG_DIR];
    delete process.env[ENV_CLI_HOME];
    delete process.env[ENV_CONFIG_DIR_NAME];
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    setConfigHomeDirOverride(undefined);
    setConfigHomeDir(undefined);
  });

  it('defaults to the entry config directory', () => {
    const dir = getConfigHomeDir();
    expect(dir).toBe(nodePath.join(os.homedir(), '.qwen').normalize('NFC'));
  });

  it('respects the configured root as a complete path', () => {
    const root = nodePath.resolve(os.tmpdir(), 'qwen-config');
    process.env[ENV_CONFIG_DIR] = root;
    resetConfigHomeDirCache();
    expect(getConfigHomeDir()).toBe(root);
    expect(getCoreConfigHomeDir()).toBe(root);
  });

  it('respects the configured home and appends the directory name', () => {
    const home = nodePath.resolve(os.tmpdir(), 'qwen-home');
    process.env[ENV_CLI_HOME] = home;
    resetConfigHomeDirCache();
    expect(getConfigHomeDir()).toBe(nodePath.join(home, '.qwen'));
    expect(getCoreConfigHomeDir()).toBe(nodePath.join(home, '.qwen'));
  });

  it('uses the directory name configured before loading the entry', async () => {
    process.env[ENV_CONFIG_DIR_NAME] = '.qwen-custom';
    vi.resetModules();
    const sessions = await import('./sessions-config.js');
    expect(sessions.getConfigHomeDir()).toBe(
      nodePath.join(os.homedir(), '.qwen-custom').normalize('NFC'),
    );
  });

  it('prefers the in-process override over environment variables', () => {
    const root = nodePath.resolve(os.tmpdir(), 'override');
    process.env[ENV_CONFIG_DIR] = nodePath.resolve(os.tmpdir(), 'env');
    setConfigHomeDir(root);
    expect(getConfigHomeDir()).toBe(root);
  });

  it('memoizes the resolved root', () => {
    const first = nodePath.resolve(os.tmpdir(), 'first');
    const second = nodePath.resolve(os.tmpdir(), 'second');
    process.env[ENV_CONFIG_DIR] = first;
    resetConfigHomeDirCache();
    expect(getConfigHomeDir()).toBe(first);

    process.env[ENV_CONFIG_DIR] = second;
    expect(getConfigHomeDir()).toBe(first);

    resetConfigHomeDirCache();
    expect(getConfigHomeDir()).toBe(second);
  });

  it('resolves relative override paths to absolute', () => {
    setConfigHomeDir('relative/dir');
    expect(getConfigHomeDir()).toBe(nodePath.resolve('relative/dir'));
  });

  it('reads an override published under the shared CLI key', () => {
    const global = globalThis as Record<symbol, string | undefined>;
    const root = nodePath.resolve(os.tmpdir(), 'new-config-root');
    global[Symbol.for('cli.configHomeDirOverride')] = root;

    expect(getConfigHomeDir()).toBe(root);
  });

  it.each(['QWEN_', 'EXAMPLE_', 'EXAMPLE_CN_'])(
    'matches Core roots with the injected %s namespace',
    async (prefix) => {
      const root = nodePath.resolve(os.tmpdir(), '配置 e\u0301', 'root');
      const home = nodePath.resolve(os.tmpdir(), '配置 e\u0301', 'home');
      vi.stubEnv('BRAND_ENV_PREFIX', prefix);
      vi.stubEnv(`${prefix}CONFIG_DIR`, root);
      vi.stubEnv(`${prefix}CLI_HOME`, home);
      vi.stubEnv(`${prefix}CONFIG_DIR_NAME`, 'team-config');
      const otherPrefix = prefix === 'EXAMPLE_' ? 'EXAMPLE_CN_' : 'EXAMPLE_';
      vi.stubEnv(`${otherPrefix}CONFIG_DIR`, nodePath.resolve(os.tmpdir(), 'unselected'));
      vi.resetModules();
      try {
        const [core, sessions] = await Promise.all([
          import('../../utils/paths.js'),
          import('./sessions-config.js'),
        ]);

        expect(core.getConfigHomeDir()).toBe(root.normalize('NFC'));
        expect(sessions.getConfigHomeDir()).toBe(root.normalize('NFC'));

        vi.stubEnv(`${prefix}CONFIG_DIR`, undefined);
        core._resetConfigHomeDirCache();
        sessions.resetConfigHomeDirCache();
        const expected = nodePath.join(home, 'team-config').normalize('NFC');
        expect(core.getConfigHomeDir()).toBe(expected);
        expect(sessions.getConfigHomeDir()).toBe(expected);
      } finally {
        vi.unstubAllEnvs();
        vi.resetModules();
      }
    },
  );

  it.each([
    {
      name: 'core then sessions',
      first: setConfigHomeDirOverride,
      second: setConfigHomeDir,
    },
    {
      name: 'sessions then core',
      first: setConfigHomeDir,
      second: setConfigHomeDirOverride,
    },
  ])('keeps roots and the shared key in sync across $name setters and clearing', ({ first, second }) => {
    const coreDefault = getCoreConfigHomeDir();
    const sessionDefault = getConfigHomeDir();
    const firstRoot = nodePath.resolve(os.tmpdir(), '配置 e\u0301', 'first');
    const secondRoot = nodePath.resolve(os.tmpdir(), '配置 e\u0301', 'second');
    const global = globalThis as Record<symbol, string | undefined>;
    const key = Symbol.for('cli.configHomeDirOverride');

    first(firstRoot);
    expect(getCoreConfigHomeDir()).toBe(firstRoot.normalize('NFC'));
    expect(getConfigHomeDir()).toBe(firstRoot.normalize('NFC'));
    expect(global[key]).toBe(firstRoot.normalize('NFC'));

    second(secondRoot);
    expect(getCoreConfigHomeDir()).toBe(secondRoot.normalize('NFC'));
    expect(getConfigHomeDir()).toBe(secondRoot.normalize('NFC'));
    expect(global[key]).toBe(secondRoot.normalize('NFC'));

    second(undefined);
    expect(getCoreConfigHomeDir()).toBe(coreDefault);
    expect(getConfigHomeDir()).toBe(sessionDefault);
    expect(global[key]).toBeUndefined();
  });

  it('renders display paths as ~/... for the default root', () => {
    expect(getUserConfigDisplayPath('projects', 'foo')).toBe(
      '~/.qwen/projects/foo',
    );
  });

  it('renders display paths as absolute for explicit roots', () => {
    const root = nodePath.resolve(os.tmpdir(), 'explicit');
    process.env[ENV_CONFIG_DIR] = root;
    resetConfigHomeDirCache();
    expect(getUserConfigDisplayPath('projects', 'foo')).toBe(
      nodePath.join(root, 'projects', 'foo'),
    );
  });

  it('renders display paths as absolute when the home is overridden', () => {
    const home = nodePath.resolve(os.tmpdir(), 'qwen-home');
    process.env[ENV_CLI_HOME] = home;
    resetConfigHomeDirCache();
    expect(getUserConfigDisplayPath('projects', 'foo')).toBe(
      nodePath.join(home, '.qwen', 'projects', 'foo'),
    );
  });

  it('renders display paths as ~/... for the configured directory name', async () => {
    process.env[ENV_CONFIG_DIR_NAME] = '.qwen-custom';
    vi.resetModules();
    const sessions = await import('./sessions-config.js');
    expect(sessions.getUserConfigDisplayPath('projects', 'foo')).toBe(
      '~/.qwen-custom/projects/foo',
    );
  });

  it.each(['.git', 'node_modules', 'a/b'])(
    'rejects the unsafe directory name %s through the sessions entry',
    async (name) => {
      vi.stubEnv(ENV_CONFIG_DIR_NAME, name);
      vi.resetModules();
      await expect(import('./sessions-config.js')).rejects.toThrow(
        ENV_CONFIG_DIR_NAME,
      );
    },
  );
});
