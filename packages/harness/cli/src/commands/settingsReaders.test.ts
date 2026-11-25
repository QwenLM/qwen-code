/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Command, type CommandUnknownOpts } from '@commander-js/extra-typings';
import { CONFIG_DIR, Storage } from '@qwen-code/core';
import {
  listKnownMarketplaces,
  loadKnownMarketplacesConfig,
} from '../../../core/src/plugins/management/marketplaceManager.js';
import { createListCommand as createPluginListCommand } from './plugins/list.js';
import { createGetCommand, resolveMcpServerForCommand } from './mcp/get.js';
import { createMarketplaceListCommand } from './plugins/marketplace/list.js';
import { setFlagSettingsPath } from '../config/settings.js';
import { loadSettingsFromFlag } from '../config/flagSettings.js';

vi.mock('../utils/exitCli.js', () => ({ exitCli: vi.fn() }));
vi.mock('../config/settings.js', async (original) => ({
  ...(await original<typeof import('../config/settings.js')>()),
  loadSettings: () => {
    throw new Error('Reader must not use legacy loadSettings');
  },
}));
vi.mock('@qwen-code/core', async (original) => ({
  ...(await original<typeof import('@qwen-code/core')>()),
  isHeadlessMode: () => false,
}));
vi.mock('../../../core/src/plugins/management/marketplaceManager.js', async (original) => ({
  ...(await original<typeof import('../../../core/src/plugins/management/marketplaceManager.js')>()),
  listKnownMarketplaces: vi.fn(() => [
    'user-market',
    'project-market',
    'visible',
  ]),
  loadKnownMarketplacesConfig: vi.fn(() => ({})),
}));
let root: string;
let project: string;
let user: string;
let output: string;
const write = (file: string, value: unknown) =>
  writeFileSync(file, JSON.stringify(value));
const server = (command: string) => ({ command, disabled: true });
function run(command: CommandUnknownOpts, args: string[]) {
  const program = new Command()
    .enablePositionalOptions()
    .option(
      '--setting-sources <source>',
      '',
      (value, previous: string[] = []) => [...previous, value],
    );
  program.addCommand(command);
  return program.parseAsync(args, { from: 'user' });
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'settings-readers-'));
  project = join(root, 'project');
  user = join(root, 'user');
  mkdirSync(join(project, CONFIG_DIR), { recursive: true });
  mkdirSync(user);
  vi.spyOn(process, 'cwd').mockReturnValue(project);
  vi.spyOn(Storage, 'getGlobalConfigDir').mockReturnValue(user);
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
  output = '';
  write(join(user, 'settings.json'), {
    permissions: { trustDirectories: [project] },
    mcpServers: { target: server('user') },
    blockedMarketplaces: ['user-market'],
  });
  write(join(project, CONFIG_DIR, 'settings.json'), {
    mcpServers: { target: server('project') },
    blockedMarketplaces: ['project-market'],
  });
  write(join(project, CONFIG_DIR, 'settings.local.json'), {
    mcpServers: { target: server('local') },
  });
  write(join(project, '.mcp.json'), {
    mcpServers: { target: server('mcp-json') },
  });
});
afterEach(() => {
  setFlagSettingsPath(undefined);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

it.each([
  [[], 'local'],
  [['--scope', 'project'], 'mcp-json'],
  [['--scope', 'user'], 'user'],
] as const)(
  'preserves scope lookup and JSON output: %j',
  async (options, expected) => {
    await run(createGetCommand(), ['get', 'target', '--json', ...options]);
    expect(output).toContain(`"command": "${expected}"`);
    expect(output).not.toContain('Status:');
  },
);
it('passes global sources explicitly and keeps project MCP JSON independent', async () => {
  await run(createGetCommand(), [
    '--setting-sources',
    'user',
    'get',
    'target',
    '--json',
  ]);
  expect(output).toContain('"command": "mcp-json"');
  output = '';
  await run(createGetCommand(), [
    '--setting-sources',
    'user',
    'get',
    'target',
    '--scope',
    'local',
  ]);
  expect(output).toContain('not found in local settings');
});
it('does not replace the scoped JSON server with flag overrides', async () => {
  const flag = join(root, 'flags.json');
  write(flag, { mcpServers: { target: server('flag') } });
  setFlagSettingsPath(flag);
  await run(createGetCommand(), ['get', 'target', '--scope', 'user', '--json']);
  expect(output).toContain('"command": "user"');
});

it('keeps inline flags in merged settings for a scoped MCP lookup', async () => {
  loadSettingsFromFlag(
    JSON.stringify({ mcpServers: { target: server('inline') } }),
  );
  const resolved = await resolveMcpServerForCommand('target', {
    scope: 'user',
  });
  expect(resolved?.server.command).toBe('user');
  expect(resolved?.settings.mcpServers?.['target']?.command).toBe('inline');
});
it.each([
  [[], ['visible']],
  [
    ['--setting-sources', 'user'],
    ['project-market', 'visible'],
  ],
  [['--setting-sources='], ['project-market', 'user-market', 'visible']],
] as const)(
  'filters marketplace list with selected settings: %j',
  async (flags, names) => {
    await run(createMarketplaceListCommand(), [...flags, 'list', '--json']);
    expect(
      JSON.parse(output).map((entry: { name: string }) => entry.name),
    ).toEqual(names);
    expect(listKnownMarketplaces).toHaveBeenCalled();
    expect(loadKnownMarketplacesConfig).toHaveBeenCalled();
  },
);

it('loads plugins list through SettingsService with explicit source selection', async () => {
  const adapter = vi
    .spyOn(
      await import('@qwen-code/core/plugin-management'),
      'listPluginsForCommand',
    )
    .mockResolvedValue('plugins');
  write(join(user, 'settings.json'), {
    permissions: { trustDirectories: [project] },
    enabledPlugins: { 'demo@mp': true },
  });
  write(join(project, CONFIG_DIR, 'settings.json'), {
    enabledPlugins: { 'demo@mp': false },
  });
  await run(createPluginListCommand(), ['--setting-sources', 'user', 'list']);
  expect(adapter).toHaveBeenLastCalledWith(
    expect.objectContaining({
      settings: expect.objectContaining({
        merged: expect.objectContaining({
          enabledPlugins: { 'demo@mp': true },
        }),
      }),
    }),
  );
  adapter.mockClear();
  await run(createPluginListCommand(), ['list']);
  expect(adapter).toHaveBeenLastCalledWith(
    expect.objectContaining({
      settings: expect.objectContaining({
        project: expect.objectContaining({
          settings: expect.objectContaining({
            enabledPlugins: { 'demo@mp': false },
          }),
        }),
        merged: expect.objectContaining({
          enabledPlugins: { 'demo@mp': false },
        }),
      }),
    }),
  );
});
