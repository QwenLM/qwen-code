/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

const loadSettings = vi.hoisted(() => vi.fn(() => { throw new Error('mcp list must not use legacy loadSettings'); }));
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ENV_CLI_HOME, Storage, runLogger } from '@qwen-code/core';
import { Command } from '@commander-js/extra-typings';
import { createMcpCommand } from './index.js';
import { SettingsService } from '@qwen-code/resource';
import { listMcpServers, getMcpServersFromConfig } from './list.js';
import {
  mergeSettings,
  setDefaultSettingSourcesForProcess,
  setFlagSettingsPath,
} from '../../config/settings.js';

import { createCliSettingsService } from '../../config/createCliSettingsService.js';
import {
  getFlagSettingsInput,
  type SettingSource,
} from '../../config/settings.js';

async function loadMcpListSettings(sources?: readonly SettingSource[]) {
  const service = await createCliSettingsService();
  const result = service.resolve({
    projectPath,
    sources,
    flagSettings: getFlagSettingsInput(),
  });
  for (const error of result.errors)
    runLogger.warn(`Error in ${error.path}: ${error.message}`);
  return result;
}

vi.mock('../../utils/exitCli.js', () => ({ exitCli: vi.fn() }));
vi.mock('../../utils/outputListeners.js', () => ({
  initializeOutputListenersAndFlush: vi.fn(),
}));

vi.mock('@qwen-code/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@qwen-code/core')>()),
  isHeadlessMode: () => false,
}));
vi.mock('../../config/settings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config/settings.js')>()),
  loadSettings,
  loadEnvironment: vi.fn(),
}));

let root: string;
let projectPath: string;
let userConfigDir: string;
function write(path: string, data: unknown) {
  writeFileSync(path, JSON.stringify(data));
}
function user(data: unknown) {
  write(join(userConfigDir, 'settings.json'), data);
}
function project(data: unknown) {
  write(join(projectPath, '.qwen', 'settings.json'), data);
}
function local(data: unknown) {
  write(join(projectPath, '.qwen', 'settings.local.json'), data);
}

beforeEach(() => {
  vi.clearAllMocks();
  root = mkdtempSync(join(tmpdir(), 'mcp-list-settings-中文 空格-'));
  projectPath = join(root, 'project');
  userConfigDir = join(root, 'custom-config');
  mkdirSync(userConfigDir);
  mkdirSync(join(projectPath, '.qwen'), { recursive: true });
  vi.spyOn(process, 'cwd').mockReturnValue(projectPath);
  vi.spyOn(Storage, 'getGlobalConfigDir').mockReturnValue(userConfigDir);
  vi.spyOn(runLogger, 'warn').mockImplementation(() => {});
  setDefaultSettingSourcesForProcess(undefined);
  setFlagSettingsPath(undefined);
});
afterEach(() => {
  setDefaultSettingSourcesForProcess(undefined);
  setFlagSettingsPath(undefined);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

it('uses SettingsService for the default list command without the legacy loader', async () => {
  const initialize = vi.spyOn(SettingsService.prototype, 'initialize');
  const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  await listMcpServers();
  expect(initialize).toHaveBeenCalledWith(
    expect.objectContaining({
      userConfigDir,
      projectConfigDirName: '.qwen',
    }),
  );
  expect(loadSettings).not.toHaveBeenCalled();
  expect(output).toHaveBeenCalledWith('No MCP servers configured.\n');
});

it('preserves trusted layer overrides, redaction defaults and .mcp.json precedence', async () => {
  user({
    permissions: { trustDirectories: [projectPath] },
    mcpServers: { one: { command: 'user', args: ['old'] } },
  });
  project({ mcpServers: { one: { command: 'project' } } });
  local({ mcpServers: { one: { command: 'local' } } });
  const loaded = await loadMcpListSettings();
  expect(loaded.isTrusted).toBe(true);
  expect(loaded.merged).toEqual(
    mergeSettings(
      loaded.user.settings,
      loaded.project.settings,
      loaded.isTrusted,
      loaded.local.settings,
      loaded.flag.settings,
    ),
  );
  expect(loaded.merged.mcpServers['one']).toEqual({ command: 'local' });
  expect(loaded.merged.advanced.excludedEnvVars).toEqual([
    'DEBUG',
    'DEBUG_MODE',
  ]);

  write(join(projectPath, '.mcp.json'), {
    mcpServers: { one: { command: 'mcp-json' } },
  });
  expect((await getMcpServersFromConfig(loaded.merged))['one'].command).toBe(
    'mcp-json',
  );
});

it('does not let project settings grant trust or apply project/local servers before trust', async () => {
  user({ mcpServers: { user: { command: 'user' } } });
  project({
    security: { folderTrust: { enabled: false } },
    mcpServers: { project: { command: 'project' } },
  });
  local({ mcpServers: { local: { command: 'local' } } });
  const loaded = await loadMcpListSettings();
  expect(loaded.isTrusted).toBe(false);
  expect(Object.keys(loaded.merged.mcpServers)).toEqual(['user']);
});

it('respects explicit source selection and applies explicit flags even without file sources', async () => {
  user({
    security: { folderTrust: { enabled: false } },
    mcpServers: { user: { command: 'user' } },
  });
  project({ mcpServers: { project: { command: 'project' } } });
  setDefaultSettingSourcesForProcess([]); // Must not override the explicit call.
  expect(
    Object.keys((await loadMcpListSettings(['user'])).merged.mcpServers),
  ).toEqual(['user']);
  const flagPath = join(root, 'flag.json');
  write(flagPath, {
    mcpServers: { flag: { url: 'https://example.com/mcp' } },
    mcp: { excluded: ['flag'] },
  });
  setFlagSettingsPath(flagPath);
  setDefaultSettingSourcesForProcess(['user']);
  const loaded = await loadMcpListSettings([]);
  expect(Object.keys(loaded.merged.mcpServers)).toEqual(['flag']);
  expect(loaded.merged.mcp.excluded).toEqual(['flag']);
  expect(loaded.isTrusted).toBe(false);
});

it('skips invalid server entries and resolves env placeholders before transport use', async () => {
  vi.stubEnv('MCP_LIST_TEST_COMMAND', 'node');
  user({
    mcpServers: {
      good: { command: '${MCP_LIST_TEST_COMMAND}' },
      bad: { command: 123 },
    },
  });
  const loaded = await loadMcpListSettings();
  expect(loaded.merged.mcpServers['good'].command).toBe('node');
  expect(loaded.merged.mcpServers).not.toHaveProperty('bad');
  expect(runLogger.warn).toHaveBeenCalled();
});

it('reports malformed file diagnostics and rejects an invalid explicit flag', async () => {
  writeFileSync(join(userConfigDir, 'settings.json'), '{broken');
  expect((await loadMcpListSettings()).merged.mcpServers).toEqual({});
  expect(runLogger.warn).toHaveBeenCalledWith(
    expect.stringContaining(join(userConfigDir, 'settings.json')),
  );
  const flagPath = join(root, 'flag.json');
  writeFileSync(flagPath, '{broken');
  setFlagSettingsPath(flagPath);
  await expect(loadMcpListSettings()).rejects.toThrow();
});

it('retains the home-directory project/local guard with a custom config directory', async () => {
  vi.stubEnv(ENV_CLI_HOME, projectPath);
  user({
    security: { folderTrust: { enabled: false } },
    mcpServers: { user: { command: 'user' } },
  });
  project({ mcpServers: { project: { command: 'project' } } });
  local({ mcpServers: { local: { command: 'local' } } });
  expect(Object.keys((await loadMcpListSettings()).merged.mcpServers)).toEqual([
    'user',
  ]);
});

it('keeps the existing trusted project .env loading behavior', async () => {
  vi.stubEnv('MCP_LIST_PROJECT_ENV_TEST', undefined);
  user({ security: { folderTrust: { enabled: false } } });
  writeFileSync(
    join(projectPath, '.qwen', '.env'),
    'MCP_LIST_PROJECT_ENV_TEST=from-project\n',
  );
  await loadMcpListSettings();
  expect(process.env['MCP_LIST_PROJECT_ENV_TEST']).toBe('from-project');
});

it('uses Storage project/local paths and ignores stale project files', async () => {
  user({ security: { folderTrust: { enabled: false } } });
  project({ mcpServers: { staleProject: { command: 'old-project' } } });
  local({ mcpServers: { staleLocal: { command: 'old-local' } } });
  const configDir = join(projectPath, '配置 custom');
  mkdirSync(configDir);
  vi.spyOn(Storage.prototype, 'getConfigDir').mockReturnValue(configDir);
  const storage = new Storage(projectPath);
  write(storage.getWorkspaceSettingsPath(), {
    mcpServers: { selected: { command: 'project' } },
  });
  write(storage.getWorkspaceLocalSettingsPath(), {
    mcpServers: { selected: { command: 'local' } },
  });
  const loaded = await loadMcpListSettings();
  expect(loaded.merged.mcpServers).toEqual({ selected: { command: 'local' } });
  expect(
    (await loadMcpListSettings(['user', 'project'])).merged.mcpServers,
  ).toEqual({
    selected: { command: 'project' },
  });
  rmSync(configDir, { recursive: true });
  setDefaultSettingSourcesForProcess(undefined);
  expect((await loadMcpListSettings()).merged.mcpServers).toEqual({});
});

it.each([
  { name: 'omitted', args: [], expected: undefined },
  {
    name: 'comma separated',
    args: ['--setting-sources', 'user, local'],
    expected: ['user', 'local'],
  },
  {
    name: 'repeated',
    args: ['--setting-sources', 'user', '--setting-sources', 'project'],
    expected: ['user', 'project'],
  },
  { name: 'empty', args: ['--setting-sources='], expected: [] },
  { name: 'unknown', args: ['--setting-sources', 'unknown'], expected: [] },
])(
  'passes $name command sources explicitly without reading process defaults',
  async ({ args, expected }) => {
    setDefaultSettingSourcesForProcess(['local']);
    const resolve = vi.spyOn(SettingsService.prototype, 'resolve');
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const program = new Command('cli').enablePositionalOptions();
    program.option(
      '--setting-sources <source>',
      '',
      (value: string, previous: string[] = []) => [...previous, value],
    );
    program.addCommand(createMcpCommand());
    await program.parseAsync([...args, 'mcp', 'list'], { from: 'user' });
    expect(resolve).toHaveBeenCalledWith(
      expect.objectContaining({ sources: expected }),
    );
    expect(loadSettings).not.toHaveBeenCalled();
  },
);

it('initializes the CLI service without resolving a project and retains the user snapshot', async () => {
  user({ mcpServers: { initial: { command: 'initial' } } });
  const resolve = vi.spyOn(SettingsService.prototype, 'resolve');
  const service = await createCliSettingsService();
  expect(resolve).not.toHaveBeenCalled();
  user({ mcpServers: { changed: { command: 'changed' } } });
  expect(
    Object.keys(
      service.resolve({ projectPath, sources: ['user'] }).merged.mcpServers,
    ),
  ).toEqual(['initial']);
});

it('concatenates dynamic hook events across user and project settings', async () => {
  const first = {
    matcher: '*',
    hooks: [{ type: 'command', command: 'echo user' }],
  };
  const second = {
    matcher: '*',
    hooks: [{ type: 'command', command: 'echo project' }],
  };
  user({
    security: { folderTrust: { enabled: false } },
    hooks: { CustomEvent: [first] },
  });
  project({ hooks: { CustomEvent: [second] } });
  const loaded = await loadMcpListSettings();
  expect(loaded.merged.hooks).toMatchObject({ CustomEvent: [first, second] });
});

it.each([['user'], []] as SettingSource[][])(
  'does not inject project env for sources %j',
  async (...sources) => {
    vi.stubEnv('MCP_LIST_PROJECT_ENV_TEST', undefined);
    vi.stubEnv('MCP_LIST_USER_ENV_TEST', undefined);
    user({ security: { folderTrust: { enabled: false } } });
    writeFileSync(
      join(projectPath, '.qwen', '.env'),
      'MCP_LIST_PROJECT_ENV_TEST=project\n',
    );
    writeFileSync(join(userConfigDir, '.env'), 'MCP_LIST_USER_ENV_TEST=user\n');
    await listMcpServers(sources);
    expect(process.env['MCP_LIST_PROJECT_ENV_TEST']).toBeUndefined();
    expect(process.env['MCP_LIST_USER_ENV_TEST']).toBe('user');
  },
);

it('removes legacy startup env before resolving the list command sources', async () => {
  vi.stubEnv('MCP_LIST_PROJECT_ENV_TEST', undefined);
  vi.stubEnv('MCP_LIST_USER_ENV_TEST', undefined);
  vi.stubEnv('MCP_LIST_HOST_ENV_TEST', 'host');
  writeFileSync(
    join(projectPath, '.qwen', '.env'),
    'MCP_LIST_PROJECT_ENV_TEST=project\nMCP_LIST_HOST_ENV_TEST=project\n',
  );
  writeFileSync(join(userConfigDir, '.env'), 'MCP_LIST_USER_ENV_TEST=user\n');
  const legacy = await vi.importActual<
    typeof import('../../test-utils/resolveSettings.js')
  >('../../config/settings.js');
  legacy.loadEnvironment({}, projectPath, () => ({ isTrusted: true, source: 'file' }));
  expect(process.env['MCP_LIST_PROJECT_ENV_TEST']).toBe('project');
  await listMcpServers(['user']);
  expect(process.env['MCP_LIST_PROJECT_ENV_TEST']).toBeUndefined();
  expect(process.env['MCP_LIST_USER_ENV_TEST']).toBe('user');
  expect(process.env['MCP_LIST_HOST_ENV_TEST']).toBe('host');
});
