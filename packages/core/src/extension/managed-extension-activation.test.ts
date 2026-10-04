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
import { KeychainTokenStorage } from '../mcp/token-storage/keychain-token-storage.js';
import { SettingScope, type ExtensionManager } from './extensionManager.js';
import {
  ExtensionConflictError,
  ExtensionStore,
  type ExtensionPolicy,
} from './extension-store.js';

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

interface ActivationCase {
  name: string;
  initialDisabled?: boolean;
  initialWorkspaceDisabled?: boolean;
  active: boolean;
  skill?: boolean;
  apply: (
    manager: ExtensionManager,
    id: string,
    cwd: string,
  ) => Promise<unknown>;
}

const activationCases: ActivationCase[] = [
  {
    name: 'CLI user enable',
    initialDisabled: true,
    active: true,
    apply: (manager) => manager.enableExtension('portable', SettingScope.User),
  },
  {
    name: 'CLI user disable',
    active: false,
    apply: (manager) => manager.disableExtension('portable', SettingScope.User),
  },
  {
    name: 'CLI workspace enable',
    initialDisabled: true,
    active: true,
    apply: (manager) =>
      manager.enableExtension('portable', SettingScope.Workspace),
  },
  {
    name: 'CLI workspace disable',
    active: false,
    apply: (manager) =>
      manager.disableExtension('portable', SettingScope.Workspace),
  },
  {
    name: 'default disable',
    active: false,
    apply: (manager, id) =>
      manager.setExtensionDefaultActivation(id, 'disabled'),
  },
  {
    name: 'bulk default disable',
    active: false,
    apply: (manager) =>
      manager.setExtensionDefaultActivations(['portable'], 'disabled'),
  },
  {
    name: 'user scope',
    initialDisabled: true,
    active: true,
    apply: (manager, id) =>
      manager.setExtensionActivationScope(id, { scope: 'user' }),
  },
  {
    name: 'workspace scope',
    active: true,
    apply: (manager, id, cwd) =>
      manager.setExtensionActivationScope(id, {
        scope: 'workspace',
        workspacePath: cwd,
      }),
  },
  {
    name: 'workspace disable',
    active: false,
    apply: (manager, id, cwd) =>
      manager.setExtensionWorkspaceActivation(id, cwd, 'disabled'),
  },
  {
    name: 'bulk workspace disable',
    active: false,
    apply: (manager, _id, cwd) =>
      manager.setExtensionWorkspaceActivations(['portable'], cwd, 'disabled'),
  },
  {
    name: 'workspace inherit',
    initialWorkspaceDisabled: true,
    active: true,
    apply: (manager, id, cwd) =>
      manager.clearExtensionWorkspaceActivation(id, cwd),
  },
  {
    name: 'bulk workspace inherit',
    initialWorkspaceDisabled: true,
    active: true,
    apply: (manager, _id, cwd) =>
      manager.setExtensionWorkspaceActivations(['portable'], cwd, 'inherit'),
  },
  {
    name: 'skill disable',
    active: true,
    skill: true,
    apply: (manager, id, cwd) =>
      manager.setExtensionSkillStates(id, cwd, [
        { name: 'review', state: 'disabled' },
      ]),
  },
];

function activationFields(policy: ExtensionPolicy) {
  return {
    defaultActivation: policy.defaultActivation,
    workspaceOverrides: policy.workspaceOverrides,
    legacyPathRules: policy.legacyPathRules,
    skillWorkspaceOverrides: policy.skillWorkspaceOverrides,
  };
}

describe('managed user activation outside the home directory', () => {
  beforeEach(() => {
    temporary = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-managed-activation-')),
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
    vi.stubEnv('QWEN_CODE_FORCE_FILE_STORAGE', 'true');
    // These fixtures use temporary file storage, never the host keychain.
    vi.spyOn(KeychainTokenStorage.prototype, 'isAvailable').mockResolvedValue(
      false,
    );
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

  it('hands a fresh-store inherited home-path disable back after the managed episode', async () => {
    const homeWorkspace = path.join(os.homedir(), 'workspace');
    fs.mkdirSync(homeWorkspace);
    // A home upgrading from a pre-state.json release: only the V1 enablement
    // file carries the disable, and no extension store exists yet.
    const enablementDir = path.join(process.env['QWEN_HOME']!, 'extensions');
    fs.mkdirSync(enablementDir, { recursive: true });
    const rule = `!${os.homedir().replace(/\\/g, '/')}/*`;
    fs.writeFileSync(
      path.join(enablementDir, 'extension-enablement.json'),
      JSON.stringify({ portable: { overrides: [rule] } }),
    );
    writeExtension(path.join(enablementDir, 'user-copy'), 'portable', 'user');

    writeExtension(
      path.join(managedExtensionsDir, 'deployed'),
      'portable',
      '1.0.0',
    );
    expect(
      fs.existsSync(
        path.join(process.env['QWEN_HOME']!, 'extension-store', 'state.json'),
      ),
    ).toBe(false);
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

    fs.rmSync(path.join(managedExtensionsDir, 'deployed'), {
      recursive: true,
      force: true,
    });
    const restored = await createConfig(homeWorkspace);
    expect(restored.getExtensions()).toEqual([
      expect.objectContaining({ source: 'user', isActive: false }),
    ]);
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

  async function claimActivationFixture(test: ActivationCase) {
    const cwd = path.join(os.homedir(), 'workspace');
    fs.mkdirSync(cwd);
    const userPackage = path.join(
      process.env['QWEN_HOME']!,
      'extensions',
      'user-copy',
    );
    const managedPackage = path.join(managedExtensionsDir, 'deployed');
    for (const directory of [userPackage, managedPackage]) {
      writeExtension(directory, 'portable', '1.0.0');
      fs.mkdirSync(path.join(directory, 'skills', 'review'), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(directory, 'skills', 'review', 'SKILL.md'),
        '---\nname: review\ndescription: Review code\n---\nReview code.',
      );
    }
    const user = await createConfig(cwd, false);
    const userManager = user.getExtensionManager();
    const userId = user.getExtensions()[0]!.id;
    if (test.initialDisabled) {
      await userManager.setExtensionDefaultActivation(userId, 'disabled');
    }
    if (test.initialWorkspaceDisabled) {
      await userManager.setExtensionWorkspaceActivation(
        userId,
        cwd,
        'disabled',
      );
    }
    const baseline = activationFields(
      (await new ExtensionStore().readSnapshot()).extensions[userId]!,
    );
    const claimed = await createConfig(cwd);
    expect(claimed.getExtensions()[0]!.source).toBe('managed');
    return { cwd, userId, managedPackage, claimed, baseline };
  }

  it.each(activationCases)(
    'refuses $name on a returning user copy when the managed root is unknown',
    async (test) => {
      const { cwd, userId, managedPackage, baseline } =
        await claimActivationFixture(test);
      fs.rmSync(managedPackage, { recursive: true });
      const writer = await createConfig(cwd, false);
      expect(writer.getExtensions()[0]!.source).toBe('user');
      const store = new ExtensionStore();
      const before = await store.readSnapshot();
      await expect(
        test.apply(writer.getExtensionManager(), userId, cwd),
      ).rejects.toThrow(ExtensionConflictError);
      expect(await store.readSnapshot()).toEqual(before);
      const handback = await createConfig(cwd);
      expect(
        activationFields((await store.readSnapshot()).extensions[userId]!),
      ).toEqual(baseline);
      expect(handback.getExtensions()[0]!.source).toBe('user');
    },
  );

  it.each(activationCases)(
    'retains $name after a proven withdrawal and subsequent read-only and committing refreshes',
    async (test) => {
      const { cwd, userId, managedPackage } =
        await claimActivationFixture(test);
      fs.rmSync(managedPackage, { recursive: true });
      const writer = new Config({
        sessionId: 'activation-handback',
        targetDir: cwd,
        cwd,
        debugMode: false,
        chatRecording: false,
        managedExtensionsDir,
      });
      const manager = writer.getExtensionManager();
      await manager.refreshCache({ allowManagedHandBack: false });
      const store = new ExtensionStore();
      expect((await store.readSnapshot()).extensions[userId]!.managed).toBe(
        true,
      );
      await test.apply(manager, userId, cwd);
      const after = await store.readSnapshot();
      expect(after.extensions[userId]!.managed).toBeUndefined();
      if (test.name === 'workspace scope') {
        expect(after.extensions[userId]).toMatchObject({
          defaultActivation: 'disabled',
          workspaceOverrides: { [cwd]: 'enabled' },
        });
      }
      expect(writer.getExtensions()[0]!.isActive).toBe(test.active);
      if (test.skill) {
        expect(
          manager.getExtensionSkillState(userId, 'review', cwd)
            .workspaceEnabled,
        ).toBe(false);
      }
      const reader = new Config({
        sessionId: 'activation-reader',
        targetDir: cwd,
        cwd,
        debugMode: false,
        chatRecording: false,
        managedExtensionsDir,
      });
      await reader
        .getExtensionManager()
        .refreshCache({ allowManagedHandBack: false });
      expect(reader.getExtensions()[0]!.isActive).toBe(test.active);
      await reader.getExtensionManager().refreshCache();
      expect(reader.getExtensions()[0]!.isActive).toBe(test.active);
      expect(
        activationFields((await store.readSnapshot()).extensions[userId]!),
      ).toEqual(activationFields(after.extensions[userId]!));
      if (test.skill) {
        expect(
          reader
            .getExtensionManager()
            .getExtensionSkillState(userId, 'review', cwd).workspaceEnabled,
        ).toBe(false);
      }
    },
  );

  it.each(activationCases)(
    'keeps the pre-claim baseline when $name targets the still-deployed managed package',
    async (test) => {
      const { cwd, userId, managedPackage, claimed, baseline } =
        await claimActivationFixture(test);
      const manager = claimed.getExtensionManager();
      const managedId = claimed.getExtensions()[0]!.id;
      await test.apply(manager, managedId, cwd);
      expect(claimed.getExtensions()[0]!.isActive).toBe(test.active);
      const restarted = await createConfig(cwd);
      expect(restarted.getExtensions()[0]!.isActive).toBe(test.active);
      if (test.skill) {
        expect(
          restarted
            .getExtensionManager()
            .getExtensionSkillState(managedId, 'review', cwd).workspaceEnabled,
        ).toBe(false);
      }
      fs.rmSync(managedPackage, { recursive: true });
      await createConfig(cwd);
      expect(
        activationFields(
          (await new ExtensionStore().readSnapshot()).extensions[userId]!,
        ),
      ).toEqual(baseline);
    },
  );

  it.each(['unavailable root', 'unnamed relocated entry'] as const)(
    'refuses activation without changing the retained policy during an %s',
    async (failure) => {
      const { claimed, managedPackage, baseline, userId, cwd } =
        await claimActivationFixture(activationCases[1]!);
      if (failure === 'unavailable root') {
        fs.renameSync(managedExtensionsDir, `${managedExtensionsDir}-offline`);
      } else {
        fs.rmSync(managedPackage, { recursive: true });
        fs.mkdirSync(path.join(managedExtensionsDir, 'new-deployment'));
      }
      const manager = claimed.getExtensionManager();
      await manager.refreshCache({ allowManagedHandBack: false });
      const store = new ExtensionStore();
      const before = await store.readSnapshot();
      await expect(
        manager.disableExtension('portable', SettingScope.User),
      ).rejects.toThrow(ExtensionConflictError);
      expect(await store.readSnapshot()).toEqual(before);
      if (failure === 'unavailable root') {
        fs.mkdirSync(managedExtensionsDir);
      } else {
        fs.rmSync(path.join(managedExtensionsDir, 'new-deployment'), {
          recursive: true,
        });
      }
      await createConfig(cwd);
      expect(
        activationFields((await store.readSnapshot()).extensions[userId]!),
      ).toEqual(baseline);
    },
  );
});
