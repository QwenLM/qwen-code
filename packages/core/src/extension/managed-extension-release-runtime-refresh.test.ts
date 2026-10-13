/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Config } from '../config/config.js';
import { HookSystem } from '../hooks/hookSystem.js';
import { HookRegistry } from '../hooks/hookRegistry.js';
import { HookEventName } from '../hooks/types.js';
import { SkillManager } from '../skills/skill-manager.js';
import { KeychainTokenStorage } from '../mcp/token-storage/keychain-token-storage.js';
import { ExtensionUninstallEvent } from '../telemetry/types.js';
import { ExtensionManager } from './extensionManager.js';
import { ExtensionStore } from './extension-store.js';

const uninstallLog = vi.hoisted(() => vi.fn());
vi.mock('../telemetry/loggers.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../telemetry/loggers.js')>();
  return { ...actual, logExtensionUninstall: uninstallLog };
});

function writePackage(directory: string, name: string, marker: string) {
  fs.mkdirSync(path.join(directory, 'skills', marker), { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'qwen-extension.json'),
    JSON.stringify({
      name,
      version: '1.0.0',
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: 'command',
                name: marker,
                command: 'echo test-only-unexecuted',
              },
            ],
          },
        ],
      },
    }),
  );
  fs.writeFileSync(
    path.join(directory, 'skills', marker, 'SKILL.md'),
    `---\nname: ${marker}\ndescription: Isolated runtime witness\n---\n${marker}\n`,
  );
}

describe('managed release runtime settlement', () => {
  let root: string;
  let workspace: string;
  let managedRoot: string;
  let userRoot: string;

  beforeEach(() => {
    root = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-managed-runtime-')),
    );
    workspace = path.join(root, 'workspace');
    managedRoot = path.join(root, 'deployment');
    userRoot = path.join(root, 'home', 'extensions');
    for (const directory of [workspace, managedRoot, userRoot])
      fs.mkdirSync(directory, { recursive: true });
    vi.stubEnv('HOME', path.join(root, 'home'));
    vi.stubEnv('QWEN_HOME', path.join(root, 'home'));
    vi.stubEnv('QWEN_CODE_FORCE_FILE_STORAGE', 'true');
    vi.spyOn(os, 'homedir').mockReturnValue(path.join(root, 'home'));
    vi.spyOn(KeychainTokenStorage.prototype, 'isAvailable').mockResolvedValue(
      false,
    );
    vi.spyOn(KeychainTokenStorage.prototype, 'getKeytar').mockResolvedValue(
      null,
    );
    uninstallLog.mockClear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function setupRuntime(subject: ExtensionManager) {
    let currentSubject = subject;
    const config = {
      getProjectRoot: () => workspace,
      isTrustedFolder: () => true,
      isSafeMode: () => false,
      getBareMode: () => false,
      getDisabledSkillLevels: () => new Set(['bundled', 'project', 'user']),
      getSystemHooks: () => undefined,
      getUserHooks: () => undefined,
      getProjectHooks: () => undefined,
      getExtensions: () => currentSubject.getLoadedExtensions(),
      getActiveExtensions: () =>
        currentSubject
          .getLoadedExtensions()
          .filter((extension) => extension.isActive),
      getSettingsMcpServers: () => undefined,
      reinitializeMcpServers: async () => undefined,
      getSubagentManager: () => ({ refreshCache: async () => undefined }),
      refreshHierarchicalMemory: async () => undefined,
      getSkillManager: () => skills,
      getHookSystem: () => ({ reload: () => hooks.reloadConfiguredHooks() }),
    } as unknown as Config;
    const skills = new SkillManager(config);
    const hooks = new HookRegistry(config);
    subject.setConfig(config);
    return {
      skills,
      hooks,
      rebind: (next: ExtensionManager) => {
        currentSubject = next;
        next.setConfig(config);
      },
    };
  }

  async function prepareRelease(userBaselineEnabled?: boolean) {
    const deployed = path.join(managedRoot, 'provider');
    if (userBaselineEnabled === undefined)
      writePackage(deployed, 'demo', 'managed-witness');
    writePackage(path.join(userRoot, 'demo'), 'demo', 'returning-user-witness');
    const store = new ExtensionStore();
    const subject = new ExtensionManager({
      workspaceDir: workspace,
      managedExtensionsDir: managedRoot,
      isWorkspaceTrusted: true,
      extensionStore: store,
      usageStatisticsEnabled: false,
    });
    if (userBaselineEnabled !== undefined) {
      await subject.refreshCache();
      const user = subject.getLoadedExtensions()[0];
      expect(user.source).toBe('user');
      await store.setDefaultActivation(
        { id: user.id, name: user.name, source: 'user' },
        userBaselineEnabled ? 'enabled' : 'disabled',
        { clearLegacyPathRules: true },
      );
      writePackage(deployed, 'demo', 'managed-witness');
    }
    await subject.refreshCache();
    const managed = subject
      .getLoadedExtensions()
      .find((extension) => extension.source === 'managed')!;
    expect(managed).toBeDefined();
    if (userBaselineEnabled !== undefined) {
      await store.setDefaultActivation(
        { id: managed.id, name: managed.name, source: 'managed' },
        'enabled',
        { clearLegacyPathRules: true },
      );
      await subject.refreshCache();
    }
    const runtime = setupRuntime(subject);
    await runtime.hooks.initialize();
    expect(
      runtime.hooks
        .getHooksForEvent(HookEventName.UserPromptSubmit)
        .map((entry) => entry.config.name),
    ).toEqual(['managed-witness']);
    expect(
      (await runtime.skills.listSkills({ level: 'extension' })).map(
        (skill) => skill.authoredName,
      ),
    ).toEqual(['managed-witness']);
    fs.rmSync(deployed, { recursive: true });
    expect((await store.readSnapshot()).extensions[managed.id]).toBeDefined();
    const releasing = new ExtensionManager({
      workspaceDir: workspace,
      managedExtensionsDir: managedRoot,
      isWorkspaceTrusted: true,
      extensionStore: store,
      usageStatisticsEnabled: false,
    });
    runtime.rebind(releasing);
    expect(
      releasing
        .getLoadedExtensions()
        .some((extension) => extension.id === managed.id),
    ).toBe(false);
    return { subject: releasing, store, managed, ...runtime };
  }

  it('settles actual hook and skill caches after a withdrawn managed policy is released', async () => {
    const { subject, store, managed, hooks, skills } = await prepareRelease();
    const released = await subject.uninstallExtensionById(managed.id, false);
    expect(released.extensions[managed.id]).toBeUndefined();
    expect((await store.readSnapshot()).extensions[managed.id]).toBeUndefined();
    await subject.refreshCache();
    expect(subject.getLoadedExtensions()).toContainEqual(
      expect.objectContaining({ name: 'demo', source: 'user', isActive: true }),
    );
    expect
      .soft(
        hooks
          .getHooksForEvent(HookEventName.UserPromptSubmit)
          .map((entry) => entry.config.name),
      )
      .not.toContain('managed-witness');
    expect
      .soft(
        (await skills.listSkills({ level: 'extension' })).map(
          (skill) => skill.authoredName,
        ),
      )
      .not.toContain('managed-witness');
  });

  it.each([true, false])(
    'settles the returning user runtime before returning with activation %s',
    async (enabled) => {
      const { subject, store, managed, hooks, skills } =
        await prepareRelease(enabled);
      const released = await subject.uninstallExtensionById(managed.id, false);
      expect(released.extensions[managed.id]).toBeUndefined();
      expect(released.generation).toBe((await store.readSnapshot()).generation);
      expect(subject.getLoadedExtensions()).toEqual([
        expect.objectContaining({
          name: 'demo',
          source: 'user',
          isActive: enabled,
        }),
      ]);
      expect(
        hooks
          .getHooksForEvent(HookEventName.UserPromptSubmit)
          .map((entry) => entry.config.name),
      ).toEqual(enabled ? ['returning-user-witness'] : []);
      expect(
        (await skills.listSkills({ level: 'extension' })).map(
          (skill) => skill.authoredName,
        ),
      ).toEqual(enabled ? ['returning-user-witness'] : []);
    },
  );

  it('defers runtime refresh and uninstall telemetry on an update release', async () => {
    const { subject, store, managed, hooks, skills } = await prepareRelease();
    const cache = vi.spyOn(subject, 'refreshCache');
    const hookReload = vi.spyOn(hooks, 'reloadConfiguredHooks');
    const skillReload = vi.spyOn(skills, 'refreshCache');
    const released = await subject.uninstallExtensionById(managed.id, true);
    expect(released.extensions[managed.id]).toBeUndefined();
    expect((await store.readSnapshot()).extensions[managed.id]).toBeUndefined();
    expect(cache).not.toHaveBeenCalled();
    expect(hookReload).not.toHaveBeenCalled();
    expect(skillReload).not.toHaveBeenCalled();
    expect(uninstallLog).not.toHaveBeenCalled();
  });

  it('keeps a committed release successful when its telemetry logger throws', async () => {
    const { subject, store, managed, hooks, skills } = await prepareRelease();
    uninstallLog.mockImplementationOnce(() => {
      throw new Error('test-only telemetry failure');
    });
    const released = await subject.uninstallExtensionById(managed.id, false);
    expect(uninstallLog).toHaveBeenCalledTimes(1);
    expect(released.extensions[managed.id]).toBeUndefined();
    expect(released.generation).toBe((await store.readSnapshot()).generation);
    expect(
      hooks
        .getHooksForEvent(HookEventName.UserPromptSubmit)
        .map((entry) => entry.config.name),
    ).toEqual(['returning-user-witness']);
    expect(
      (await skills.listSkills({ level: 'extension' })).map(
        (skill) => skill.authoredName,
      ),
    ).toEqual(['returning-user-witness']);
  });

  it('settles a same-instance Config hook and skill runtime after a managed-only withdrawal', async () => {
    const deployed = path.join(managedRoot, 'provider');
    writePackage(deployed, 'live-config-demo', 'live-managed-witness');
    const config = new Config({
      interactive: false,
      targetDir: workspace,
      cwd: workspace,
      model: '',
      debugMode: false,
      chatRecording: false,
      trustedFolder: true,
      managedExtensionsDir: managedRoot,
      usageStatisticsEnabled: false,
      installProxyDispatcher: false,
    });
    const subject = config.getExtensionManager();
    subject.setConfig(config);
    const hooks = new HookSystem(config);
    const skills = new SkillManager(config);
    vi.spyOn(config, 'getHookSystem').mockReturnValue(hooks);
    vi.spyOn(config, 'getSkillManager').mockReturnValue(skills);
    vi.spyOn(config, 'getSubagentManager').mockReturnValue({
      refreshCache: async () => undefined,
    } as ReturnType<Config['getSubagentManager']>);
    vi.spyOn(config, 'refreshHierarchicalMemory').mockResolvedValue(undefined);
    await subject.refreshCache();
    const managed = subject.getLoadedExtensions()[0];
    await hooks.initialize();
    expect(hooks.getAllHooks().map((entry) => entry.config.name)).toEqual([
      'live-managed-witness',
    ]);
    expect(
      (await skills.listSkills({ level: 'extension' })).map(
        (skill) => skill.authoredName,
      ),
    ).toEqual(['live-managed-witness']);
    fs.rmSync(deployed, { recursive: true });
    await subject.refreshCache({ allowManagedHandBack: false });
    expect(subject.getLoadedExtensions()).toEqual([]);
    expect(
      (await new ExtensionStore().readSnapshot()).extensions[managed.id],
    ).toBeDefined();
    await subject.uninstallExtensionById(managed.id, false);
    expect(config.getExtensionManager()).toBe(subject);
    expect(hooks.getAllHooks()).toEqual([]);
    expect(await skills.listSkills({ level: 'extension' })).toEqual([]);
  });

  it('emits the normal success uninstall event for a released policy', async () => {
    const { subject, managed } = await prepareRelease();
    await subject.uninstallExtensionById(managed.id, false);
    expect(uninstallLog).toHaveBeenCalledTimes(1);
    expect(uninstallLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(ExtensionUninstallEvent),
    );
    expect(uninstallLog.mock.calls[0][1]).toMatchObject({
      extension_name: 'demo',
      status: 'success',
    });
  });

  it('returns a runtime failure warning after the policy release has committed', async () => {
    const { subject, store, managed, hooks } = await prepareRelease();
    vi.spyOn(hooks, 'reloadConfiguredHooks').mockRejectedValueOnce(
      new Error('test-only hook reload failure'),
    );
    const released = await subject.uninstallExtensionById(managed.id, false);
    expect((await store.readSnapshot()).extensions[managed.id]).toBeUndefined();
    expect(released.warnings ?? []).toContainEqual({
      code: 'extension_runtime_refresh_failed',
      error: 'test-only hook reload failure',
    });
    expect(released.generation).toBe((await store.readSnapshot()).generation);
    expect(uninstallLog).toHaveBeenCalledTimes(1);
    expect(uninstallLog.mock.calls[0][1]).toMatchObject({
      extension_name: 'demo',
      status: 'success',
    });
  });

  it('settles the same runtime consumers and telemetry for an ordinary user uninstall', async () => {
    writePackage(
      path.join(userRoot, 'plain-user'),
      'plain-user',
      'ordinary-user-witness',
    );
    const subject = new ExtensionManager({
      workspaceDir: workspace,
      managedExtensionsDir: managedRoot,
      isWorkspaceTrusted: true,
      usageStatisticsEnabled: false,
    });
    await subject.refreshCache();
    const user = subject.getLoadedExtensions()[0];
    const { hooks, skills } = setupRuntime(subject);
    await hooks.initialize();
    expect(await skills.listSkills({ level: 'extension' })).toHaveLength(1);
    await subject.uninstallExtensionById(user.id, false);
    expect(hooks.getHooksForEvent(HookEventName.UserPromptSubmit)).toEqual([]);
    expect(await skills.listSkills({ level: 'extension' })).toEqual([]);
    expect(uninstallLog).toHaveBeenCalledTimes(1);
  });
});
