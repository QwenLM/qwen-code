/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KeychainTokenStorage } from '../mcp/token-storage/keychain-token-storage.js';
import { ExtensionStore } from './extension-store.js';
import {
  ExtensionManager,
  ExtensionNotUpdatableError,
  ManagedExtensionReadOnlyError,
  type Extension,
} from './extensionManager.js';

describe('managed extension admission probes', () => {
  let root: string;
  let workspace: string;
  let pluginRoot: string;
  let dataRoot: string;
  let subject: ExtensionManager;
  let store: ExtensionStore;

  beforeEach(async () => {
    root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-managed-name-probe-')),
    );
    workspace = path.join(root, 'workspace');
    const managedRoot = path.join(root, 'deployment');
    pluginRoot = path.join(managedRoot, 'package');
    fs.mkdirSync(workspace);
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, 'plugin.json'),
      JSON.stringify({
        $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
        name: 'managed-probe',
        version: '1.0.0',
      }),
    );
    fs.writeFileSync(
      path.join(pluginRoot, 'mcp.json'),
      JSON.stringify({
        $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
        mcpServers: {
          fixture: {
            type: 'stdio',
            command: 'node',
            cwd: '${PLUGIN_DATA}/work',
          },
        },
      }),
    );
    vi.stubEnv('QWEN_HOME', path.join(root, 'home'));
    vi.stubEnv('QWEN_CODE_FORCE_FILE_STORAGE', 'true');
    vi.spyOn(KeychainTokenStorage.prototype, 'isAvailable').mockResolvedValue(
      false,
    );
    vi.spyOn(KeychainTokenStorage.prototype, 'getKeytar').mockResolvedValue(
      null,
    );
    store = new ExtensionStore();
    subject = new ExtensionManager({
      workspaceDir: workspace,
      managedExtensionsDir: managedRoot,
      extensionStore: store,
      isWorkspaceTrusted: true,
      usageStatisticsEnabled: false,
    });
    const manifests = await subject.loadManagedExtensions(workspace, {
      manifestOnly: true,
      createDataDir: false,
    });
    expect(manifests).toHaveLength(1);
    expect(manifests[0]?.mcpServers?.['fixture']?.command).toBe('node');
    dataRoot = store.agentPluginDataRoot(manifests[0]!.id);
    expect(fs.existsSync(dataRoot)).toBe(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function userExtension(name: string): Extension {
    return {
      id: 'a1'.repeat(32),
      name,
      version: '1.0.0',
      isActive: true,
      source: 'user',
      path: path.join(root, 'user-fixture'),
      config: { name, version: '1.0.0' },
      contextFiles: [],
    };
  }

  function expectNoManagedRuntimeDirectories(): void {
    expect.soft(fs.existsSync(dataRoot)).toBe(false);
    expect.soft(fs.existsSync(path.join(dataRoot, 'work'))).toBe(false);
  }

  it('refuses a same-name user update without creating managed stdio data', async () => {
    await expect(
      subject.prepareExtensionUpdate({
        extension: userExtension('MANAGED-PROBE'),
      }),
    ).rejects.toBeInstanceOf(ManagedExtensionReadOnlyError);
    expectNoManagedRuntimeDirectories();
  });

  it('checks an unrelated user update without creating managed stdio data', async () => {
    await expect(
      subject.prepareExtensionUpdate({
        extension: userExtension('unrelated-user'),
      }),
    ).rejects.toBeInstanceOf(ExtensionNotUpdatableError);
    expectNoManagedRuntimeDirectories();
  });

  it('leaves managed stdio data absent during an unknown by-id uninstall', async () => {
    const before = await store.readSnapshot();
    expect(
      await subject.uninstallExtensionById('b2'.repeat(32), false),
    ).toEqual(before);
    expectNoManagedRuntimeDirectories();
  });

  it('creates managed stdio data and its working directory for runtime loading', async () => {
    const manifests = await subject.loadManagedExtensions(workspace);
    expect(manifests).toHaveLength(1);
    expect(manifests[0]?.source).toBe('managed');
    expect(manifests[0]?.mcpServers?.['fixture']?.cwd).toBe(
      path.join(dataRoot, 'work'),
    );
    expect(fs.statSync(dataRoot).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(dataRoot, 'work')).isDirectory()).toBe(true);
  });
});
