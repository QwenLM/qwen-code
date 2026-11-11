/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveConfigDirectoryNames } from './configDirectory.js';

describe('resolveConfigDirectoryNames', () => {
  it.each([
    'abc',
    '.abc',
    'agents',
    '.agents',
    'abc.def',
    '目录',
    'name with spaces',
    '_',
    '-',
    '目'.repeat(64),
  ])('uses the valid configured value %j verbatim', (rawValue) => {
    expect(
      resolveConfigDirectoryNames({
        rawValue,
        envName: 'EXAMPLE_CONFIG_DIR_NAME',
        userDefault: '.qwen',
        projectDefault: '.qwen',
      }),
    ).toEqual({
      userConfigDirName: rawValue,
      projectConfigDirName: rawValue,
    });
  });

  it('normalizes the configured name to NFC for every directory scope', () => {
    expect(
      resolveConfigDirectoryNames({
        rawValue: 'e\u0301quipe',
        envName: 'EXAMPLE_CONFIG_DIR_NAME',
        userDefault: '.qwen',
        projectDefault: '.qwen',
      }),
    ).toEqual({
      userConfigDirName: 'équipe',
      projectConfigDirName: 'équipe',
    });
  });

  it('applies the length limit after NFC normalization', () => {
    const rawValue = `e\u0301${'a'.repeat(63)}`;

    expect(
      resolveConfigDirectoryNames({
        rawValue,
        envName: 'EXAMPLE_CONFIG_DIR_NAME',
        userDefault: '.qwen',
        projectDefault: '.qwen',
      }),
    ).toEqual({
      userConfigDirName: `é${'a'.repeat(63)}`,
      projectConfigDirName: `é${'a'.repeat(63)}`,
    });
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
  ])('rejects the protected directory name %j', (rawValue) => {
    expect(() =>
      resolveConfigDirectoryNames({
        rawValue,
        envName: 'EXAMPLE_CONFIG_DIR_NAME',
        userDefault: '.qwen',
        projectDefault: '.qwen',
      }),
    ).toThrow(/EXAMPLE_CONFIG_DIR_NAME must not use protected directory name/);
  });

  it.each(['.agents', '.github-backup', 'my.git', 'config-service'])(
    'does not overmatch the valid directory name %j',
    (rawValue) => {
      expect(
        resolveConfigDirectoryNames({
          rawValue,
          envName: 'EXAMPLE_CONFIG_DIR_NAME',
          userDefault: '.qwen',
          projectDefault: '.qwen',
        }),
      ).toEqual({
        userConfigDirName: rawValue,
        projectConfigDirName: rawValue,
      });
    },
  );

  it.each([undefined, ''])(
    'keeps the brand defaults when the configured value is %s',
    (rawValue) => {
      expect(
        resolveConfigDirectoryNames({
          rawValue,
          envName: 'EXAMPLE_CN_CONFIG_DIR_NAME',
          userDefault: '.qwen-cn',
          projectDefault: '.qwen',
        }),
      ).toEqual({
        userConfigDirName: '.qwen-cn',
        projectConfigDirName: '.qwen',
      });
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
    'rejects the invalid configured value %j',
    (rawValue) => {
      expect(() =>
        resolveConfigDirectoryNames({
          rawValue,
          envName: 'EXAMPLE_CONFIG_DIR_NAME',
          userDefault: '.qwen',
          projectDefault: '.qwen',
        }),
      ).toThrow(/EXAMPLE_CONFIG_DIR_NAME must be a valid directory name/);
    },
  );
});

describe('configured path contracts', () => {
  beforeEach(() => {
    vi.stubEnv('BRAND_ENV_PREFIX', 'EXAMPLE_');
    vi.stubEnv('QWEN_CONFIG_DIR_NAME', undefined);
    vi.stubEnv('QWEN_CONFIG_DIR', undefined);
    vi.stubEnv('QWEN_CLI_HOME', undefined);
  });

  afterEach(() => {
    const global = globalThis as Record<symbol, string | undefined>;
    delete global[Symbol.for('cli.configHomeDirOverride')];
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('uses the global configured name for user and project paths', async () => {

    vi.stubEnv('EXAMPLE_CONFIG_DIR_NAME', 'abc');
    vi.stubEnv('EXAMPLE_CN_CONFIG_DIR_NAME', 'ignored');
    vi.stubEnv('EXAMPLE_CONFIG_DIR', undefined);
    vi.stubEnv('EXAMPLE_CLI_HOME', undefined);
    vi.resetModules();

    const paths = await import('../utils/paths.js');

    expect(paths.CONFIG_DIR).toBe('abc');
    expect(paths.GLOBAL_CONFIG_DIR).toBe('abc');
    expect(paths.getConfigHomeDir()).toBe(path.join(os.homedir(), 'abc'));
    expect(paths.getUserConfigDisplayPath('settings.json')).toBe(
      '~/abc/settings.json',
    );
  });

  it('uses one NFC-normalized name for user and project paths', async () => {

    vi.stubEnv('EXAMPLE_CONFIG_DIR_NAME', 'e\u0301quipe');
    vi.stubEnv('EXAMPLE_CONFIG_DIR', undefined);
    vi.stubEnv('EXAMPLE_CLI_HOME', undefined);
    vi.resetModules();

    const paths = await import('../utils/paths.js');

    expect(paths.CONFIG_DIR).toBe('équipe');
    expect(paths.GLOBAL_CONFIG_DIR).toBe('équipe');
    expect(paths.getConfigHomeDir()).toBe(path.join(os.homedir(), 'équipe'));
    expect(paths.getUserConfigDisplayPath('settings.json')).toBe(
      '~/équipe/settings.json',
    );
  });

  it('preserves an explicitly dotted directory name', async () => {

    vi.stubEnv('EXAMPLE_CONFIG_DIR_NAME', '.abc');
    vi.stubEnv('EXAMPLE_CONFIG_DIR', undefined);
    vi.stubEnv('EXAMPLE_CLI_HOME', undefined);
    vi.resetModules();

    const paths = await import('../utils/paths.js');

    expect(paths.CONFIG_DIR).toBe('.abc');
    expect(paths.GLOBAL_CONFIG_DIR).toBe('.abc');
    expect(paths.getConfigHomeDir()).toBe(path.join(os.homedir(), '.abc'));
  });

  it('uses only the CN configured name in CN builds', async () => {

    vi.stubEnv('BRAND_ENV_PREFIX', 'EXAMPLE_CN_');
    vi.stubEnv('EXAMPLE_CONFIG_DIR_NAME', 'ignored');
    vi.stubEnv('EXAMPLE_CN_CONFIG_DIR_NAME', 'abc');
    vi.stubEnv('EXAMPLE_CN_CONFIG_DIR', '/tmp/full-root');
    vi.resetModules();

    const paths = await import('../utils/paths.js');

    expect(paths.CONFIG_DIR).toBe('abc');
    expect(paths.GLOBAL_CONFIG_DIR).toBe('abc');
    expect(paths.getConfigHomeDir()).toBe(path.resolve('/tmp/full-root'));
    expect(paths.getUserConfigDisplayPath('settings.json')).toBe(
      path.resolve('/tmp/full-root', 'settings.json'),
    );
  });

  it.each([undefined, ''])(
    'defaults to .qwen without a product prefix (%j)',
    async (prefix) => {

      vi.stubEnv('BRAND_ENV_PREFIX', prefix);
      vi.stubEnv('EXAMPLE_CONFIG_DIR_NAME', 'ignored-global');
      vi.stubEnv('EXAMPLE_CN_CONFIG_DIR_NAME', 'ignored-cn');
      vi.stubEnv('EXAMPLE_CN_CONFIG_DIR', undefined);
      vi.stubEnv('EXAMPLE_CN_CLI_HOME', undefined);
      vi.resetModules();

      const paths = await import('../utils/paths.js');

      expect(paths.CONFIG_DIR).toBe('.qwen');
      expect(paths.GLOBAL_CONFIG_DIR).toBe('.qwen');
      expect(paths.getConfigHomeDir()).toBe(
        path.join(os.homedir(), '.qwen'),
      );
    },
  );

  it('shows a CLI-home-derived user root as an absolute path', async () => {

    vi.stubEnv('EXAMPLE_CONFIG_DIR_NAME', 'abc');
    vi.stubEnv('EXAMPLE_CONFIG_DIR', undefined);
    vi.stubEnv('EXAMPLE_CLI_HOME', path.resolve('/tmp/test-cli-home'));
    vi.resetModules();

    const paths = await import('../utils/paths.js');

    expect(paths.getConfigHomeDir()).toBe(path.resolve('/tmp/test-cli-home', 'abc'));
    expect(paths.getUserConfigDisplayPath('settings.json')).toBe(
      path.resolve('/tmp/test-cli-home', 'abc', 'settings.json'),
    );
  });

  it('shows an explicit config root as absolute even when it equals the default root', async () => {
    const defaultRoot = path.join(os.homedir(), 'abc');

    vi.stubEnv('EXAMPLE_CONFIG_DIR_NAME', 'abc');
    vi.stubEnv('EXAMPLE_CONFIG_DIR', defaultRoot);
    vi.resetModules();

    const paths = await import('../utils/paths.js');

    expect(paths.getUserConfigDisplayPath('settings.json')).toBe(
      path.join(defaultRoot, 'settings.json'),
    );
  });

  it('shows an explicit CLI home as absolute even when it equals OS home', async () => {

    vi.stubEnv('EXAMPLE_CONFIG_DIR_NAME', 'abc');
    vi.stubEnv('EXAMPLE_CONFIG_DIR', undefined);
    vi.stubEnv('EXAMPLE_CLI_HOME', os.homedir());
    vi.resetModules();

    const paths = await import('../utils/paths.js');

    expect(paths.getUserConfigDisplayPath('settings.json')).toBe(
      path.join(os.homedir(), 'abc', 'settings.json'),
    );
  });

  it('shows an in-process root as absolute even when it equals the default root', async () => {

    vi.stubEnv('EXAMPLE_CONFIG_DIR_NAME', 'abc');
    vi.stubEnv('EXAMPLE_CONFIG_DIR', undefined);
    vi.stubEnv('EXAMPLE_CLI_HOME', undefined);
    vi.resetModules();

    const paths = await import('../utils/paths.js');
    const defaultRoot = path.join(os.homedir(), 'abc');
    paths.setConfigHomeDirOverride(defaultRoot);

    expect(paths.getUserConfigDisplayPath('settings.json')).toBe(
      path.join(defaultRoot, 'settings.json'),
    );
  });

  it('keeps a complete user-root override separate from project paths', async () => {

    vi.stubEnv('EXAMPLE_CONFIG_DIR_NAME', 'abc');
    vi.stubEnv('EXAMPLE_CONFIG_DIR', '/tmp/full-root');
    vi.resetModules();

    const { Storage } = await import('./storage.js');
    const workspace = '/tmp/example-workspace';
    const storage = new Storage(workspace);

    const userPaths = [
      Storage.getMcpOAuthTokensPath(),
      Storage.getGlobalSettingsPath(),
      Storage.getInstallationIdPath(),
      Storage.getUserCommandsDir(),
      Storage.getUserSkillsDir(),
      Storage.getGlobalMemoryFilePath(),
      Storage.getUserPoliciesDir(),
      Storage.getUserKeybindingsPath(),
      Storage.getUserAgentsDir(),
      Storage.getGlobalTempDir(),
      Storage.getGlobalBinDir(),
      Storage.getOAuthCredsPath(),
    ];
    expect(userPaths.every((value) => value.startsWith(path.resolve('/tmp/full-root')))).toBe(
      true,
    );

    const projectRoot = path.join(workspace, 'abc');
    const projectPaths = [
      storage.getConfigDir(),
      storage.getWorkspaceSettingsPath(),
      storage.getWorkspaceLocalSettingsPath(),
      storage.getProjectCommandsDir(),
      storage.getProjectSkillsDir(),
      storage.getProjectAgentsDir(),
      storage.getExtensionsDir(),
      storage.getExtensionsConfigPath(),
    ];
    expect(projectPaths.every((value) => value.startsWith(projectRoot))).toBe(
      true,
    );
  });
});
