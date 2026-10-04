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
import {
  ExtensionManager,
  ManagedExtensionReadOnlyError,
} from './extensionManager.js';
import { ExtensionStore } from './extension-store.js';
import {
  ExtensionSettingScope,
  hasStoredExtensionSecrets,
  updateSetting,
} from './extensionSettings.js';

const settings = [
  {
    name: 'Token',
    description: 'Test token',
    envVar: 'TOKEN',
    sensitive: true,
  },
];

function writePackage(directory: string) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'qwen-extension.json'),
    JSON.stringify({ name: 'release-race', version: '1.0.0', settings }),
  );
}

describe('managed relocation safety', () => {
  let root: string;
  let workspace: string;
  let managedRoot: string;
  let userRoot: string;

  beforeEach(() => {
    root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-managed-relocation-')),
    );
    workspace = path.join(root, 'workspace');
    managedRoot = path.join(root, 'deployment');
    userRoot = path.join(root, 'home', 'extensions');
    for (const directory of [workspace, managedRoot, userRoot])
      fs.mkdirSync(directory, { recursive: true });
    vi.stubEnv('QWEN_HOME', path.join(root, 'home'));
    vi.stubEnv('QWEN_CODE_FORCE_FILE_STORAGE', 'true');
    vi.spyOn(KeychainTokenStorage.prototype, 'isAvailable').mockResolvedValue(
      false,
    );
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const manager = () =>
    new ExtensionManager({
      workspaceDir: workspace,
      isWorkspaceTrusted: true,
      managedExtensionsDir: managedRoot,
    });

  it.each(['same-directory', 'relocated-directory', 'withdrawn'] as const)(
    'preserves credentials until proven withdrawal: %s',
    async (scenario) => {
      const deployed = path.join(managedRoot, 'provider-a');
      writePackage(path.join(userRoot, 'user-copy'));
      writePackage(deployed);
      const initial = manager();
      await initial.refreshCache();
      const managed = initial
        .getLoadedExtensions()
        .find((item) => item.name === 'release-race')!;
      expect(managed.source).toBe('managed');
      await initial.setExtensionDefaultActivation(managed.id, 'disabled');
      await updateSetting(
        managed.config,
        managed.id,
        'TOKEN',
        async () => 'test-only-relocation-token',
        ExtensionSettingScope.USER,
      );
      const secretPresent = () =>
        hasStoredExtensionSecrets(managed.name, managed.id, [workspace]);
      expect(await secretPresent()).toBe(true);
      const originalPolicy = (await new ExtensionStore().readSnapshot())
        .extensions[managed.id];
      expect(originalPolicy?.managedDirectory).toBe('provider-a');

      if (scenario === 'same-directory') {
        fs.unlinkSync(path.join(deployed, 'qwen-extension.json'));
      } else {
        fs.rmSync(deployed, { recursive: true });
        if (scenario === 'relocated-directory')
          fs.mkdirSync(path.join(managedRoot, 'provider-b'));
      }
      const fresh = manager();
      await fresh.refreshCache();
      const policy = Object.values(
        (await new ExtensionStore().readSnapshot()).extensions,
      ).find((item) => item.name === managed.name);
      const retained = await secretPresent();
      expect
        .soft(policy?.managed)
        .toBe(scenario === 'withdrawn' ? undefined : true);
      expect.soft(retained).toBe(scenario !== 'withdrawn');
      expect(
        fresh.getLoadedExtensions().find((item) => item.name === managed.name)
          ?.isActive,
      ).toBe(scenario === 'withdrawn');

      if (scenario !== 'withdrawn') {
        const finalDirectory =
          scenario === 'same-directory'
            ? deployed
            : path.join(managedRoot, 'provider-b');
        writePackage(finalDirectory);
        const redeployed = manager();
        await redeployed.refreshCache();
        const returned = redeployed
          .getLoadedExtensions()
          .find((item) => item.name === managed.name)!;
        expect(returned.source).toBe('managed');
        expect(returned.id).toBe(managed.id);
        expect(returned.isActive).toBe(false);
        const finalSecret = await secretPresent();
        expect.soft(finalSecret).toBe(true);
      }
    },
  );

  it('refuses adoption while relocation is ambiguous and allows it after the directory is removed', async () => {
    const deployed = path.join(managedRoot, 'provider-a');
    writePackage(deployed);
    const initial = manager();
    await initial.refreshCache();
    const managed = initial.getLoadedExtensions()[0]!;
    expect(
      await hasStoredExtensionSecrets(managed.name, managed.id, [workspace]),
    ).toBe(false);
    const before = await initial.getExtensionStoreSnapshot();
    fs.rmSync(deployed, { recursive: true });
    const staging = path.join(managedRoot, 'provider-b');
    fs.mkdirSync(staging);
    const source = path.join(root, 'user-source');
    fs.mkdirSync(source);
    fs.writeFileSync(
      path.join(source, 'qwen-extension.json'),
      JSON.stringify({ name: managed.name, version: '2.0.0' }),
    );

    const subject = manager();
    await subject.refreshCache();
    await expect(
      subject.installExtension({ type: 'local', source }),
    ).rejects.toBeInstanceOf(ManagedExtensionReadOnlyError);
    expect(await subject.getExtensionStoreSnapshot()).toEqual(before);
    expect(fs.existsSync(path.join(userRoot, managed.name))).toBe(false);

    fs.rmSync(staging, { recursive: true });
    await subject.installExtension({ type: 'local', source });
    const installed = subject
      .getLoadedExtensions()
      .find((item) => item.name === managed.name)!;
    expect(installed.source).toBe('user');
    expect(installed.config.version).toBe('2.0.0');
    expect(
      (await subject.getExtensionStoreSnapshot()).extensions[installed.id]
        ?.managed,
    ).toBeUndefined();
  });
});
