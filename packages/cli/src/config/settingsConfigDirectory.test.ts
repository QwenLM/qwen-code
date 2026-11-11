/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('settings with a configured directory name', () => {
  let tempRoot: string;
  let workspace: string;
  let userConfigRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-config-name-'));
    workspace = path.join(tempRoot, 'workspace');
    userConfigRoot = path.join(tempRoot, 'user-config-root');
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(userConfigRoot, { recursive: true });

    vi.stubEnv('BRAND_ENV_PREFIX', 'EXAMPLE_');
    vi.stubEnv('EXAMPLE_CONFIG_DIR_NAME', 'abc');
    vi.stubEnv('EXAMPLE_CONFIG_DIR', userConfigRoot);
    vi.resetModules();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.resetModules();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('loads workspace settings only from the selected directory', async () => {
    await fs.writeFile(
      path.join(userConfigRoot, 'settings.json'),
      JSON.stringify({ security: { folderTrust: { enabled: false } } }),
    );
    await fs.mkdir(path.join(workspace, 'abc'), { recursive: true });
    await fs.mkdir(path.join(workspace, '.example'), { recursive: true });
    await fs.writeFile(
      path.join(workspace, 'abc', 'settings.json'),
      JSON.stringify({ context: { fileName: 'CUSTOM.md' } }),
    );
    await fs.writeFile(
      path.join(workspace, '.example', 'settings.json'),
      JSON.stringify({ context: { fileName: 'LEGACY.md' } }),
    );

    const { loadSettings } = await import('../test-utils/resolveSettings.js');
    const { Storage } = await import('@qwen-code/core');
    const settings = loadSettings(workspace);

    expect(new Storage(workspace).getWorkspaceSettingsPath()).toBe(
      path.join(workspace, 'abc', 'settings.json'),
    );
    expect(settings.project.path).toBe(
      path.join(workspace, 'abc', 'settings.json'),
    );
    expect(settings.project.settings.context?.fileName).toBe('CUSTOM.md');
  });

  it('loads the project environment only from the selected directory', async () => {
    await fs.mkdir(path.join(workspace, 'abc'), { recursive: true });
    await fs.mkdir(path.join(workspace, '.example'), { recursive: true });
    await fs.writeFile(
      path.join(userConfigRoot, '.env'),
      'CUSTOM_DIR_ENV=user\n',
    );
    await fs.writeFile(
      path.join(workspace, 'abc', '.env'),
      'CUSTOM_DIR_ENV=selected\n',
    );
    await fs.writeFile(
      path.join(workspace, '.example', '.env'),
      'CUSTOM_DIR_ENV=legacy\n',
    );
    vi.stubEnv('CUSTOM_DIR_ENV', undefined);

    const { loadEnvironment } = await import(
      '../test-utils/resolveSettings.js'
    );
    loadEnvironment({}, workspace, () => ({
      isTrusted: true,
      source: 'file',
    }));

    expect(process.env['CUSTOM_DIR_ENV']).toBe('selected');
  });

  it('falls back to the user config environment', async () => {
    await fs.writeFile(
      path.join(userConfigRoot, '.env'),
      'USER_CONFIG_ENV=user\n',
    );
    vi.stubEnv('USER_CONFIG_ENV', undefined);

    const { loadEnvironment } = await import(
      '../test-utils/resolveSettings.js'
    );
    loadEnvironment({}, workspace, () => ({
      isTrusted: true,
      source: 'file',
    }));

    expect(process.env['USER_CONFIG_ENV']).toBe('user');
  });

  it('ignores ordinary and parent config environment files', async () => {
    const parentConfigDir = path.join(tempRoot, 'abc');
    await fs.mkdir(parentConfigDir, { recursive: true });
    await fs.writeFile(
      path.join(workspace, '.env'),
      'WORKSPACE_ORDINARY_ENV=workspace\n',
    );
    await fs.writeFile(
      path.join(tempRoot, '.env'),
      'PARENT_ORDINARY_ENV=parent\n',
    );
    await fs.writeFile(
      path.join(parentConfigDir, '.env'),
      'PARENT_CONFIG_ENV=parent-config\n',
    );
    vi.stubEnv('WORKSPACE_ORDINARY_ENV', undefined);
    vi.stubEnv('PARENT_ORDINARY_ENV', undefined);
    vi.stubEnv('PARENT_CONFIG_ENV', undefined);

    const { loadEnvironment } = await import(
      '../test-utils/resolveSettings.js'
    );
    loadEnvironment({}, workspace, () => ({
      isTrusted: true,
      source: 'file',
    }));

    expect(process.env['WORKSPACE_ORDINARY_ENV']).toBeUndefined();
    expect(process.env['PARENT_ORDINARY_ENV']).toBeUndefined();
    expect(process.env['PARENT_CONFIG_ENV']).toBeUndefined();
  });
});
