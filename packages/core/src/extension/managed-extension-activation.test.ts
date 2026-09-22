/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Config } from '../config/config.js';
import { SettingScope } from './extensionManager.js';
import { ExtensionStore } from './extension-store.js';

let temporary: string;
let managedExtensionsDir: string;
let firstWorkspace: string;
let secondWorkspace: string;

function writeExtension(root: string, name: string, version: string): void {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'qwen-extension.json'),
    JSON.stringify({ name, version }),
  );
  fs.writeFileSync(path.join(root, 'QWEN.md'), `${name} context ${version}`);
}

async function createConfig(
  cwd: string,
  includeManaged = true,
): Promise<Config> {
  const config = new Config({
    sessionId: 'managed-activation-test',
    targetDir: cwd,
    cwd,
    debugMode: false,
    chatRecording: false,
    ...(includeManaged ? { managedExtensionsDir } : {}),
  });
  await config.getExtensionManager().refreshCache();
  return config;
}

describe('managed user activation outside the home directory', () => {
  beforeEach(() => {
    temporary = fs.mkdtempSync(
      path.join(os.tmpdir(), 'qwen-managed-activation-'),
    );
    const home = path.join(temporary, 'home');
    managedExtensionsDir = path.join(temporary, 'prepared');
    firstWorkspace = path.join(temporary, 'workspace-a');
    secondWorkspace = path.join(temporary, 'workspace-b');
    fs.mkdirSync(home);
    fs.mkdirSync(firstWorkspace);
    fs.mkdirSync(secondWorkspace);
    fs.mkdirSync(managedExtensionsDir);
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.stubEnv('QWEN_HOME', path.join(home, '.qwen'));
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(temporary, { recursive: true, force: true });
  });

  it('disables managed context across restart, version changes and sibling workspaces without activating a shadowed package', async () => {
    const managedPackage = path.join(managedExtensionsDir, 'deployed');
    writeExtension(managedPackage, 'portable', '1.0.0');
    writeExtension(
      path.join(process.env['QWEN_HOME']!, 'extensions', 'user-copy'),
      'portable',
      'user',
    );
    const first = await createConfig(firstWorkspace);
    const manager = first.getExtensionManager();
    const original = first.getExtensions()[0]!;
    expect(first.getExtensionContextFilePaths()).toContain(
      path.join(managedPackage, 'QWEN.md'),
    );

    await manager.disableExtension('portable', SettingScope.User);
    expect(first.getActiveExtensions()).toEqual([]);
    expect(first.getExtensionContextFilePaths()).toEqual([]);
    writeExtension(managedPackage, 'portable', '2.0.0');

    const restarted = await createConfig(secondWorkspace);
    expect(restarted.getExtensions()).toEqual([
      expect.objectContaining({
        id: original.id,
        source: 'managed',
        version: '2.0.0',
        isActive: false,
      }),
    ]);
    expect(restarted.getExtensionContextFilePaths()).toEqual([]);
    await restarted
      .getExtensionManager()
      .enableExtension('portable', SettingScope.User);
    const reenabled = await createConfig(firstWorkspace);
    expect(reenabled.getActiveExtensions()).toEqual([
      expect.objectContaining({
        id: original.id,
        source: 'managed',
        version: '2.0.0',
      }),
    ]);
    expect(reenabled.getExtensionContextFilePaths()).toEqual([
      path.join(managedPackage, 'QWEN.md'),
    ]);
  });

  it.each(['CLI', 'API'] as const)(
    '%s explicitly re-enables a managed after an inherited home-path disable while retaining exact workspace overrides',
    async (entrypoint) => {
      const homeWorkspace = path.join(os.homedir(), 'workspace');
      fs.mkdirSync(homeWorkspace);
      writeExtension(
        path.join(process.env['QWEN_HOME']!, 'extensions', 'user-copy'),
        'portable',
        'user',
      );
      const legacy = await createConfig(homeWorkspace, false);
      await legacy
        .getExtensionManager()
        .disableExtension('portable', SettingScope.User);
      expect(legacy.getActiveExtensions()).toEqual([]);

      writeExtension(
        path.join(managedExtensionsDir, 'deployed'),
        'portable',
        '1.0.0',
      );
      const inherited = await createConfig(homeWorkspace);
      expect(inherited.getExtensions()).toEqual([
        expect.objectContaining({ source: 'managed', isActive: false }),
      ]);
      const workspaceOverride = await createConfig(secondWorkspace);
      await workspaceOverride
        .getExtensionManager()
        .disableExtension('portable', SettingScope.Workspace);

      if (entrypoint === 'CLI') {
        await inherited
          .getExtensionManager()
          .enableExtension('portable', SettingScope.User);
      } else {
        await inherited
          .getExtensionManager()
          .setExtensionDefaultActivation(
            inherited.getExtensions()[0]!.id,
            'enabled',
          );
      }
      expect((await createConfig(homeWorkspace)).getActiveExtensions()).toEqual(
        [expect.objectContaining({ source: 'managed', isActive: true })],
      );
      expect(
        (await createConfig(secondWorkspace)).getActiveExtensions(),
      ).toEqual([]);
    },
  );

  it('clears legacy rules only for managed identities in a mixed API batch and retains exact workspace overrides', async () => {
    const homeWorkspace = path.join(os.homedir(), 'workspace');
    fs.mkdirSync(homeWorkspace);
    const userRoot = path.join(process.env['QWEN_HOME']!, 'extensions');
    writeExtension(path.join(userRoot, 'portable'), 'portable', 'user');
    writeExtension(path.join(userRoot, 'user-only'), 'user-only', '1.0.0');
    const legacy = await createConfig(homeWorkspace, false);
    for (const name of ['portable', 'user-only']) {
      await legacy
        .getExtensionManager()
        .disableExtension(name, SettingScope.User);
    }
    writeExtension(
      path.join(managedExtensionsDir, 'deployed'),
      'portable',
      '1.0.0',
    );
    const selected = await createConfig(homeWorkspace);
    const overridden = await createConfig(secondWorkspace);
    await overridden
      .getExtensionManager()
      .disableExtension('portable', SettingScope.Workspace);
    await selected
      .getExtensionManager()
      .setExtensionDefaultActivations(['portable', 'user-only'], 'enabled');

    const reloaded = await createConfig(homeWorkspace);
    expect(reloaded.getExtensions()).toEqual([
      expect.objectContaining({
        name: 'portable',
        source: 'managed',
        isActive: true,
      }),
      expect.objectContaining({
        name: 'user-only',
        source: 'user',
        isActive: false,
      }),
    ]);
    const other = await createConfig(secondWorkspace);
    expect(
      other.getExtensions().find((extension) => extension.name === 'portable')
        ?.isActive,
    ).toBe(false);
  });

  it('hands a shadowed user package home-path disable back after the managed episode', async () => {
    const homeWorkspace = path.join(os.homedir(), 'workspace');
    fs.mkdirSync(homeWorkspace);
    writeExtension(
      path.join(process.env['QWEN_HOME']!, 'extensions', 'user-copy'),
      'portable',
      'user',
    );
    const legacy = await createConfig(homeWorkspace, false);
    await legacy
      .getExtensionManager()
      .disableExtension('portable', SettingScope.User);
    expect(legacy.getActiveExtensions()).toEqual([]);

    // The managed package claims the user policy by name; enabling it must
    // clear the inherited rule for the managed package without destroying
    // the user's own preference.
    writeExtension(
      path.join(managedExtensionsDir, 'deployed'),
      'portable',
      '1.0.0',
    );
    const adopted = await createConfig(homeWorkspace);
    expect(adopted.getExtensions()).toEqual([
      expect.objectContaining({ source: 'managed', isActive: false }),
    ]);
    await adopted
      .getExtensionManager()
      .enableExtension('portable', SettingScope.User);
    expect((await createConfig(homeWorkspace)).getActiveExtensions()).toEqual([
      expect.objectContaining({ source: 'managed' }),
    ]);

    // Withdrawing the managed package hands the policy back: the user copy
    // returns still disabled by its surviving home-path rule.
    fs.rmSync(path.join(managedExtensionsDir, 'deployed'), {
      recursive: true,
      force: true,
    });
    const restored = await createConfig(homeWorkspace);
    expect(restored.getExtensions()).toEqual([
      expect.objectContaining({ source: 'user', isActive: false }),
    ]);
    expect(restored.getActiveExtensions()).toEqual([]);
    const activation = await restored
      .getExtensionManager()
      .getExtensionActivation(restored.getExtensions()[0]!.id, homeWorkspace);
    expect(activation).toMatchObject({
      effective: 'disabled',
      source: 'legacy_path_rule',
    });
    const snapshot = await new ExtensionStore().readSnapshot();
    const policy = Object.values(snapshot.extensions).find(
      (entry) => entry.name === 'portable',
    );
    expect(policy?.legacyPathRules?.length).toBeGreaterThan(0);
    expect(policy?.preservedLegacyPathRules).toBeUndefined();
  });

  it('retains the existing home-path activation semantics for user extensions', async () => {
    writeExtension(
      path.join(process.env['QWEN_HOME']!, 'extensions', 'user-only'),
      'user-only',
      '1.0.0',
    );
    const config = await createConfig(firstWorkspace, false);
    await config
      .getExtensionManager()
      .disableExtension('user-only', SettingScope.User);
    expect(
      (await createConfig(secondWorkspace, false)).getActiveExtensions(),
    ).toEqual([expect.objectContaining({ name: 'user-only', source: 'user' })]);
  });
});
