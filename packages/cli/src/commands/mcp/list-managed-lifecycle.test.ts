/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExtensionManager } from '@qwen-code/qwen-code-core/extension/extensionManager.js';
import { ExtensionStore } from '@qwen-code/qwen-code-core/extension/extension-store.js';
import {
  ExtensionSettingScope,
  getScopedEnvContents,
  updateSetting,
} from '@qwen-code/qwen-code-core/extension/extensionSettings.js';
import { KeychainTokenStorage } from '@qwen-code/qwen-code-core/mcp/token-storage/keychain-token-storage.js';
import yargs from 'yargs';
import { listMcpServers } from './list.js';
import { reconnectCommand } from './reconnect.js';
import { handleList } from '../extensions/list.js';
import { settingsCommand } from '../extensions/settings.js';
import { handleSourcesList } from '../extensions/sources.js';
import {
  extensionToOutputString,
  getExtensionManager,
} from '../extensions/utils.js';
import { writeStdoutLine } from '../../utils/stdioHelpers.js';
import { loadChannelsFromExtensions } from '../channel/runtime.js';

vi.mock('../../config/settings.js', () => ({
  loadSettings: vi.fn(() => ({ merged: { mcpServers: {} } })),
  SettingScope: { User: 'User', Workspace: 'Workspace' },
}));
vi.mock('../../config/trustedFolders.js', () => ({
  isWorkspaceTrusted: vi.fn(() => ({ isTrusted: true })),
}));
vi.mock('../extensions/consent.js', () => ({
  requestConsentOrFail: vi.fn(),
  requestConsentNonInteractive: vi.fn(),
  requestChoicePluginNonInteractive: vi.fn(),
}));
vi.mock('../../config/mcpServers.js', () => ({
  assembleMcpServers: vi.fn(() => ({})),
}));
vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: vi.fn(),
  writeStderrLine: vi.fn(),
  clearScreen: vi.fn(),
}));

const name = 'r29-managed-read';
const token = 'test-only-r29-sentinel';
const config = {
  name,
  version: '1.0.0',
  settings: [
    {
      name: 'Token',
      description: 'Test token',
      envVar: 'TOKEN',
      sensitive: true,
    },
  ],
};

function writePackage(directory: string) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'qwen-extension.json'),
    JSON.stringify(config),
  );
}

describe('MCP list managed lifecycle safety', () => {
  let root: string;
  let workspace: string;
  let managedRoot: string;

  beforeEach(() => {
    root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-r29-list-')),
    );
    workspace = path.join(root, 'workspace');
    managedRoot = path.join(root, 'deployment');
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(managedRoot, { recursive: true });
    vi.stubEnv('QWEN_HOME', path.join(root, 'home'));
    vi.stubEnv('QWEN_CODE_FORCE_FILE_STORAGE', 'true');
    vi.spyOn(KeychainTokenStorage.prototype, 'isAvailable').mockResolvedValue(
      false,
    );
    vi.spyOn(process, 'cwd').mockReturnValue(workspace);
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const manager = (enabledExtensionOverrides?: string[]) =>
    new ExtensionManager({
      managedExtensionsDir: managedRoot,
      enabledExtensionOverrides,
      workspaceDir: workspace,
      isWorkspaceTrusted: true,
    });

  async function withdrawnManaged(disabled = false) {
    const deployed = path.join(managedRoot, 'package');
    writePackage(deployed);
    writePackage(path.join(root, 'home', 'extensions', 'user-copy'));
    const initial = manager();
    await initial.refreshCache();
    const managed = initial
      .getLoadedExtensions()
      .find((extension) => extension.name === name)!;
    expect(managed.source).toBe('managed');
    if (disabled) {
      await initial.setExtensionDefaultActivation(managed.id, 'disabled');
    }
    await updateSetting(
      config,
      managed.id,
      'TOKEN',
      async () => token,
      ExtensionSettingScope.USER,
    );
    expect(
      (
        await getScopedEnvContents(
          config,
          managed.id,
          ExtensionSettingScope.USER,
        )
      )['TOKEN'],
    ).toBe(token);
    expect(
      (await new ExtensionStore().readSnapshot()).extensions[managed.id]
        ?.managed,
    ).toBe(true);
    fs.rmSync(deployed, { recursive: true });
    return managed.id;
  }

  it.each([
    ['MCP list', () => listMcpServers(managedRoot)],
    [
      'MCP reconnect all metadata',
      () =>
        reconnectCommand.handler({
          all: true,
          'managed-extensions': managedRoot,
        } as never),
    ],
    [
      'MCP reconnect single metadata',
      async () => {
        const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
          throw new Error('expected missing server exit');
        });
        await expect(
          reconnectCommand.handler({
            'server-name': 'missing',
            all: false,
            'managed-extensions': managedRoot,
          } as never),
        ).rejects.toThrow('expected missing server exit');
        expect(exit).toHaveBeenCalledWith(1);
      },
    ],
    ['extension list', () => handleList(managedRoot)],
    [
      'extension settings list',
      () =>
        yargs([])
          .option('managed-extensions', { type: 'string' })
          .command(settingsCommand)
          .exitProcess(false)
          .parseAsync([
            'settings',
            'list',
            name,
            '--managed-extensions',
            managedRoot,
          ]),
    ],
    ['source registry list', () => handleSourcesList(managedRoot)],
    ['channel metadata loading', () => loadChannelsFromExtensions(managedRoot)],
  ] as const)(
    'preserves ownership and secrets during %s',
    async (_label, read) => {
      const id = await withdrawnManaged();
      await read();
      const policies = Object.values(
        (await new ExtensionStore().readSnapshot()).extensions,
      );
      expect
        .soft(policies.find((policy) => policy.name === name)?.managed)
        .toBe(true);
      expect
        .soft(
          (await getScopedEnvContents(config, id, ExtensionSettingScope.USER))[
            'TOKEN'
          ],
        )
        .toBe(token);
    },
  );

  it('lists the returning user activation without consuming managed policy or secrets', async () => {
    const id = await withdrawnManaged(true);
    vi.mocked(writeStdoutLine).mockClear();
    await handleList(managedRoot);
    const output = vi.mocked(writeStdoutLine).mock.calls.flat().join('\n');
    expect.soft(output).toContain('Enabled (User): true');
    expect.soft(output).toContain('Enabled (Workspace): true');
    expect.soft(output).toContain('✓');
    const policy = Object.values(
      (await new ExtensionStore().readSnapshot()).extensions,
    ).find((candidate) => candidate.name === name);
    expect(policy).toMatchObject({
      managed: true,
      defaultActivation: 'disabled',
      preservedDefaultActivation: 'enabled',
    });
    expect(
      (await getScopedEnvContents(config, id, ExtensionSettingScope.USER))[
        'TOKEN'
      ],
    ).toBe(token);
  });

  it.each([
    { overrides: ['none'], enabled: false },
    { overrides: ['another-extension'], enabled: false },
    { overrides: [name.toUpperCase()], enabled: true },
  ])(
    'keeps CLI overrides $overrides in loaded activation output',
    async ({ overrides, enabled }) => {
      await withdrawnManaged(true);
      const reader = manager(overrides);
      await reader.refreshCache({ allowManagedHandBack: false });
      const extension = reader.getLoadedExtensions()[0]!;
      expect(extension.isActive).toBe(enabled);
      const output = extensionToOutputString(extension, reader, workspace);
      expect(output).toContain(`Enabled (User): ${enabled}`);
      expect(output).toContain(`Enabled (Workspace): ${enabled}`);
      expect(reader.getLoadedExtensionActivation(extension.id)).toMatchObject({
        effective: enabled ? 'enabled' : 'disabled',
        source: 'cli_override',
      });
    },
  );

  it('preserves ownership and secrets through an explicitly readonly refresh', async () => {
    const id = await withdrawnManaged();
    await manager().refreshCache({ allowManagedHandBack: false });
    expect(
      Object.values(
        (await new ExtensionStore().readSnapshot()).extensions,
      ).find((policy) => policy.name === name)?.managed,
    ).toBe(true);
    expect(
      (await getScopedEnvContents(config, id, ExtensionSettingScope.USER))[
        'TOKEN'
      ],
    ).toBe(token);
  });

  it('still releases ownership and secrets through an ordinary lifecycle refresh', async () => {
    const id = await withdrawnManaged();
    await getExtensionManager(managedRoot);
    const policies = Object.values(
      (await new ExtensionStore().readSnapshot()).extensions,
    );
    expect(
      policies.some((policy) => policy.name === name && policy.managed),
    ).toBe(false);
    expect(
      (await getScopedEnvContents(config, id, ExtensionSettingScope.USER))[
        'TOKEN'
      ],
    ).toBeUndefined();
  });
});
