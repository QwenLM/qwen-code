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

const settings = [{ name: 'Token', envVar: 'TOKEN', sensitive: true }];

function writePackage(directory: string, name: string) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'qwen-extension.json'),
    JSON.stringify({ name, version: '1.0.0', settings }),
  );
  fs.writeFileSync(path.join(directory, 'QWEN.md'), 'Test-only context.');
}

describe('managed extension release safety', () => {
  let root: string;
  let workspace: string;
  let managedRoot: string;
  let userRoot: string;

  beforeEach(() => {
    root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-managed-release-')),
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
    vi.spyOn(KeychainTokenStorage.prototype, 'getKeytar').mockResolvedValue(
      null,
    );
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const manager = (extensionStore?: ExtensionStore) =>
    new ExtensionManager({
      workspaceDir: workspace,
      isWorkspaceTrusted: true,
      managedExtensionsDir: managedRoot,
      requestConsent: async () => undefined,
      ...(extensionStore ? { extensionStore } : {}),
    });

  function seedPreferences(subject: ExtensionManager, name: string) {
    subject.toggleFavorite(name);
    subject.setExtensionScope(name, 'project');
    subject.setMcpServerDisabled(name, 'helper', true);
  }

  function expectPreferences(
    subject: ExtensionManager,
    name: string,
    retained: boolean,
  ) {
    expect.soft(subject.isFavorite(name)).toBe(retained);
    expect
      .soft(subject.getExtensionScope(name))
      .toBe(retained ? 'project' : undefined);
    expect
      .soft(subject.getDisabledMcpServers(name))
      .toEqual(retained ? ['helper'] : []);
  }

  async function seedSecret(subject: ExtensionManager, name: string) {
    const managed = subject
      .getLoadedExtensions()
      .find((item) => item.name === name)!;
    expect(managed.source).toBe('managed');
    await updateSetting(
      managed.config,
      managed.id,
      'TOKEN',
      async () => 'test-only-sentinel',
      ExtensionSettingScope.USER,
    );
    expect(await hasStoredExtensionSecrets(name, managed.id, [workspace])).toBe(
      true,
    );
    return managed;
  }

  it.each([
    ['valid', 'canonical'],
    ['valid', 'noncanonical'],
    ['temporarily-unreadable', 'canonical'],
    ['temporarily-unreadable', 'noncanonical'],
  ] as const)(
    'preserves preferences and settings when a %s %s same-name user artifact survives release',
    async (state, location) => {
      const name = 'portable';
      const deployed = path.join(managedRoot, 'provider-a');
      const artifact = path.join(
        userRoot,
        location === 'canonical' ? name : 'returning-user',
      );
      writePackage(deployed, name);
      writePackage(artifact, name);
      const initial = manager();
      seedPreferences(initial, name);
      await initial.refreshCache();
      const managed = await seedSecret(initial, name);
      const settingsDirectory = path.join(userRoot, name);
      fs.mkdirSync(settingsDirectory, { recursive: true });
      const envPath = path.join(settingsDirectory, '.env');
      fs.writeFileSync(envPath, 'PREFERENCE=keep\n');
      fs.rmSync(deployed, { recursive: true });
      if (state === 'temporarily-unreadable')
        fs.writeFileSync(path.join(artifact, 'qwen-extension.json'), '{');
      const before = fs.readFileSync(
        path.join(artifact, 'qwen-extension.json'),
        'utf8',
      );
      const releasing = manager();
      const released = await releasing.uninstallExtensionById(
        managed.id,
        false,
      );
      expect(released.extensions[managed.id]).toBeUndefined();
      expect(
        fs.readFileSync(path.join(artifact, 'qwen-extension.json'), 'utf8'),
      ).toBe(before);
      expect(
        await hasStoredExtensionSecrets(name, managed.id, [workspace]),
      ).toBe(false);
      expectPreferences(manager(), name, true);
      expect(fs.readFileSync(envPath, 'utf8')).toBe('PREFERENCE=keep\n');
      if (state === 'valid') {
        const returning = manager();
        await returning.refreshCache();
        expect(returning.getLoadedExtensions()).toEqual([
          expect.objectContaining({ name, source: 'user' }),
        ]);
        expect(returning.getDisabledMcpServers(name)).toEqual(['helper']);
      }
    },
  );

  it('clears preferences and settings when no same-name user artifact survives', async () => {
    const name = 'portable';
    const deployed = path.join(managedRoot, 'provider-a');
    writePackage(deployed, name);
    const initial = manager();
    await initial.refreshCache();
    const managed = await seedSecret(initial, name);
    seedPreferences(initial, name);
    const settingsDirectory = path.join(userRoot, name);
    fs.mkdirSync(settingsDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(settingsDirectory, '.env'),
      'PREFERENCE=discard\n',
    );
    fs.rmSync(deployed, { recursive: true });
    const released = await manager().uninstallExtensionById(managed.id, false);
    expect(released.extensions[managed.id]).toBeUndefined();
    expectPreferences(manager(), name, false);
    expect(fs.existsSync(settingsDirectory)).toBe(false);
    expect(await hasStoredExtensionSecrets(name, managed.id, [workspace])).toBe(
      false,
    );
  });

  it('does not retain abandoned preferences merely because an unrelated user artifact exists', async () => {
    const name = 'portable';
    const deployed = path.join(managedRoot, 'provider-a');
    writePackage(deployed, name);
    writePackage(path.join(userRoot, 'other-bundle'), 'other-extension');
    const initial = manager();
    await initial.refreshCache();
    const managed = await seedSecret(initial, name);
    seedPreferences(initial, name);
    const settingsDirectory = path.join(userRoot, name);
    fs.mkdirSync(settingsDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(settingsDirectory, '.env'),
      'PREFERENCE=discard\n',
    );
    fs.rmSync(deployed, { recursive: true });
    await manager().uninstallExtensionById(managed.id, false);
    expectPreferences(manager(), name, false);
    expect(fs.existsSync(settingsDirectory)).toBe(false);
    expect(
      fs.existsSync(path.join(userRoot, 'other-bundle', 'qwen-extension.json')),
    ).toBe(true);
  });

  it('still clears name preferences during an ordinary user uninstall', async () => {
    const name = 'user-package';
    const artifact = path.join(userRoot, name);
    writePackage(artifact, name);
    const initial = manager();
    await initial.refreshCache();
    const user = initial.getLoadedExtensions()[0];
    expect(user.source).toBe('user');
    seedPreferences(initial, name);
    await initial.uninstallExtensionById(user.id, false);
    expectPreferences(manager(), name, false);
    expect(fs.existsSync(artifact)).toBe(false);
  });

  it('continues later spelling cleanup and preference cleanup when settings-only removal fails', async () => {
    const names = ['demo', 'Demo', 'DEMO'];
    const deployed = path.join(managedRoot, 'versioned-bundle');
    const initial = manager();
    let managedId: string | undefined;
    for (const name of names) {
      writePackage(deployed, name);
      await initial.refreshCache();
      managedId = (await seedSecret(initial, name)).id;
      seedPreferences(initial, name);
      const directory = path.join(userRoot, name);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, '.env'), 'PREFERENCE=discard\n');
    }
    fs.rmSync(deployed, { recursive: true });
    const remove = fs.promises.rm;
    const attempts: string[] = [];
    vi.spyOn(fs.promises, 'rm').mockImplementation(async (target, options) => {
      attempts.push(String(target));
      if (String(target) === path.join(userRoot, names[0]))
        throw new Error('test-only settings cleanup failure');
      await remove(target, options);
    });
    const released = await manager().uninstallExtensionById(managedId!, false);
    expect(released.extensions[managedId!]).toBeUndefined();
    expect(released.warnings).toContainEqual({
      code: 'extension_settings_cleanup_failed',
      error: 'test-only settings cleanup failure',
    });
    expect(attempts).toContain(path.join(userRoot, names[1]));
    for (const name of names) expectPreferences(manager(), name, false);
  });

  it('clears name preferences and settings for all recorded spellings', async () => {
    const names = ['demo', 'Demo', 'DEMO'];
    const deployed = path.join(managedRoot, 'versioned-bundle');
    const subject = manager();
    let managedId: string | undefined;
    for (const name of names) {
      writePackage(deployed, name);
      await subject.refreshCache();
      managedId = (await seedSecret(subject, name)).id;
      seedPreferences(subject, name);
      const directory = path.join(userRoot, name);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, '.env'), 'PREFERENCE=discard\n');
    }
    expect(
      (await new ExtensionStore().readSnapshot()).extensions[managedId!]
        ?.managedSecretNames,
    ).toEqual(names);
    fs.rmSync(deployed, { recursive: true });
    const released = await manager().uninstallExtensionById(managedId!, false);
    expect(released.extensions[managedId!]).toBeUndefined();
    for (const name of names) {
      expectPreferences(manager(), name, false);
      expect.soft(fs.existsSync(path.join(userRoot, name))).toBe(false);
      expect
        .soft(await hasStoredExtensionSecrets(name, managedId!, [workspace]))
        .toBe(false);
    }
  });

  it.each([
    'complete',
    'manifestless',
    'unavailable',
    'different-directory',
  ] as const)(
    'refuses release when the deployment becomes %s before commit',
    async (state) => {
      const name = 'release-race';
      const deployed = path.join(managedRoot, 'provider-a');
      writePackage(deployed, name);
      const initial = manager();
      await initial.refreshCache();
      const managed = await seedSecret(initial, name);
      seedPreferences(initial, name);
      const settingsDirectory = path.join(userRoot, name);
      fs.mkdirSync(settingsDirectory, { recursive: true });
      const envPath = path.join(settingsDirectory, '.env');
      fs.writeFileSync(envPath, 'PREFERENCE=keep\n');
      fs.rmSync(deployed, { recursive: true });
      const releaseStore = new ExtensionStore();
      const removePolicy = releaseStore.removePolicy.bind(releaseStore);
      let redeployed = false;
      vi.spyOn(releaseStore, 'removePolicy').mockImplementationOnce(
        async (identity, options) => {
          expect(fs.existsSync(deployed)).toBe(false);
          if (state === 'unavailable') {
            fs.rmSync(managedRoot, { recursive: true });
          } else {
            const destination =
              state === 'different-directory'
                ? path.join(managedRoot, 'provider-b')
                : deployed;
            writePackage(destination, name);
            if (state === 'manifestless')
              fs.unlinkSync(path.join(destination, 'qwen-extension.json'));
          }
          redeployed = true;
          return await removePolicy(identity, options);
        },
      );
      const releasing = manager(releaseStore);
      const outcome = await releasing
        .uninstallExtensionById(managed.id, false)
        .then(
          () => 'released',
          (error: unknown) => error,
        );
      expect(redeployed).toBe(true);
      expect.soft(outcome).toBeInstanceOf(ManagedExtensionReadOnlyError);
      expect
        .soft(
          (await new ExtensionStore().readSnapshot()).extensions[managed.id],
        )
        .toMatchObject({
          managed: true,
          managedDirectory: 'provider-a',
        });
      expect
        .soft(await hasStoredExtensionSecrets(name, managed.id, [workspace]))
        .toBe(true);
      expect.soft(fs.readFileSync(envPath, 'utf8')).toBe('PREFERENCE=keep\n');
      expectPreferences(manager(), name, true);
    },
  );

  it.each(['deployed', 'manifestless'] as const)(
    'refuses release and preserves all state when the source is %s',
    async (state) => {
      const name = 'release-control';
      const deployed = path.join(managedRoot, 'provider-a');
      writePackage(deployed, name);
      const initial = manager();
      await initial.refreshCache();
      const managed = await seedSecret(initial, name);
      seedPreferences(initial, name);
      if (state === 'manifestless')
        fs.unlinkSync(path.join(deployed, 'qwen-extension.json'));
      await expect(
        manager().uninstallExtensionById(managed.id, false),
      ).rejects.toBeInstanceOf(ManagedExtensionReadOnlyError);
      expect(
        (await new ExtensionStore().readSnapshot()).extensions[managed.id],
      ).toMatchObject({ managed: true });
      expect(
        await hasStoredExtensionSecrets(name, managed.id, [workspace]),
      ).toBe(true);
      expectPreferences(manager(), name, true);
    },
  );
});
