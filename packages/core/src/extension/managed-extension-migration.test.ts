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
import {
  ExtensionManager,
  ManagedExtensionReadOnlyError,
} from './extensionManager.js';
import { ExtensionStore } from './extension-store.js';
import {
  updateSetting,
  getScopedEnvContents,
  ExtensionSettingScope,
} from './extensionSettings.js';

function inventory(root: string): Record<string, string> {
  return Object.fromEntries(
    fs
      .readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const file = path.join(entry.parentPath, entry.name);
        return [path.relative(root, file), fs.readFileSync(file, 'base64')];
      }),
  );
}

describe('managed extension activation migration', () => {
  let temporary: string;
  let workspace: string;
  let otherWorkspace: string;
  let managedExtensionsDir: string;
  let source: string;
  let configurations: Config[];
  const name = 'migration-fixture';

  function writePackage(directory: string, version: string): void {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, 'qwen-extension.json'),
      JSON.stringify({ name, version }),
    );
    fs.writeFileSync(path.join(directory, 'QWEN.md'), `Context ${version}`);
  }

  function manager(includeManaged = true): ExtensionManager {
    return new ExtensionManager({
      workspaceDir: workspace,
      isWorkspaceTrusted: true,
      ...(includeManaged ? { managedExtensionsDir } : {}),
    });
  }

  async function installUserPackage() {
    const installer = manager(false);
    await installer.refreshCache();
    const installed = await installer.installExtension({
      type: 'local',
      source,
    });
    await installer.setExtensionDefaultActivation(installed.id, 'disabled');
    await installer.setExtensionWorkspaceActivation(
      installed.id,
      otherWorkspace,
      'disabled',
    );
    const snapshot = await installer.getExtensionStoreSnapshot();
    expect(installed.source).toBe('user');
    expect(snapshot.extensions[installed.id].artifactGeneration).toBeTypeOf(
      'number',
    );
    return { installer, installed, snapshot };
  }

  beforeEach(() => {
    temporary = fs.mkdtempSync(
      path.join(os.tmpdir(), 'qwen-managed-migration-'),
    );
    const home = path.join(temporary, 'home');
    workspace = path.join(temporary, 'workspace');
    otherWorkspace = path.join(temporary, 'other-workspace');
    managedExtensionsDir = path.join(temporary, 'managed');
    source = path.join(temporary, 'source');
    for (const directory of [
      home,
      workspace,
      otherWorkspace,
      managedExtensionsDir,
    ])
      fs.mkdirSync(directory);
    writePackage(source, '1.0.0');
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.stubEnv('QWEN_HOME', path.join(home, '.qwen'));
    vi.stubEnv('QWEN_CODE_FORCE_FILE_STORAGE', 'true');
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    configurations = [];
  });

  afterEach(async () => {
    for (const config of configurations) await config.shutdown();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(temporary, { recursive: true, force: true });
  });

  it.each(['manager', 'initialized Config'] as const)(
    'keeps real inherited installation state usable after batch then single activation through %s',
    async (owner) => {
      const { installed, snapshot: installedState } =
        await installUserPackage();
      fs.rmSync(installed.path, { recursive: true });
      expect(await new ExtensionStore().readSnapshot()).toEqual(installedState);
      const managedPackage = path.join(managedExtensionsDir, 'deployed');
      writePackage(managedPackage, '2.0.0');
      const before = inventory(managedExtensionsDir);
      let subject = manager();
      if (owner === 'initialized Config') {
        const config = new Config({
          sessionId: 'managed-migration',
          model: '',
          targetDir: workspace,
          cwd: workspace,
          debugMode: false,
          chatRecording: false,
          interactive: false,
          trustedFolder: true,
          managedExtensionsDir,
          telemetry: { enabled: false },
          disableAllHooks: true,
          enableManagedAutoMemory: false,
          enableManagedAutoDream: false,
        });
        configurations.push(config);
        await config.initialize();
        subject = config.getExtensionManager();
      }
      await subject.refreshCache();
      const extension = subject.getLoadedExtensions()[0];
      expect(extension).toMatchObject({
        source: 'managed',
        version: '2.0.0',
        isActive: false,
      });
      const inherited = (await subject.getExtensionStoreSnapshot()).extensions[
        extension.id
      ];
      expect(inherited.artifactGeneration).toBe(
        installedState.extensions[installed.id].artifactGeneration,
      );
      expect(inherited.workspaceOverrides).toEqual(
        installedState.extensions[installed.id].workspaceOverrides,
      );

      for (let round = 0; round < 2; round++) {
        await subject.setExtensionDefaultActivations([name], 'disabled');
        await expect(
          subject.setExtensionDefaultActivation(extension.id, 'enabled'),
        ).resolves.toMatchObject({
          extensions: { [extension.id]: { defaultActivation: 'enabled' } },
        });
        const after = await subject.getExtensionStoreSnapshot();
        expect(after.extensions[extension.id]).toMatchObject({
          managed: true,
          artifactGeneration:
            installedState.extensions[installed.id].artifactGeneration,
          workspaceOverrides:
            installedState.extensions[installed.id].workspaceOverrides,
        });
        expect(after.extensions[extension.id].declarationOnly).toBeUndefined();
        await subject.refreshCache();
        expect(await subject.getExtensionStoreSnapshot()).toEqual(after);
      }
      await expect(
        subject.uninstallExtensionById(extension.id, false),
      ).rejects.toBeInstanceOf(ManagedExtensionReadOnlyError);
      expect(inventory(managedExtensionsDir)).toEqual(before);
    },
  );

  it('preserves real user artifact paths and transactions across managed name-case changes', async () => {
    const { installer, installed } = await installUserPackage();
    const userName = name.toUpperCase();
    fs.writeFileSync(
      path.join(installed.path, 'qwen-extension.json'),
      JSON.stringify({ name: userName, version: '1.0.0' }),
    );
    await installer.refreshCache();
    const userState = await installer.getExtensionStoreSnapshot();
    expect(userState.extensions[installed.id].artifactDirectory).toBe(name);

    const managedPackage = path.join(managedExtensionsDir, 'deployed');
    writePackage(managedPackage, '2.0.0');
    const external = manager();
    await external.refreshCache();
    const managedId = external.getLoadedExtensions()[0].id;
    fs.writeFileSync(
      path.join(managedPackage, 'qwen-extension.json'),
      JSON.stringify({ name: 'MiGrAtIoN-FiXtUrE', version: '2.1.0' }),
    );
    await external.refreshCache();
    const managedState = await external.getExtensionStoreSnapshot();
    expect(managedState.extensions[managedId]).toMatchObject({
      managed: true,
      artifactDirectory: name,
      artifactGeneration: userState.extensions[installed.id].artifactGeneration,
    });
    const managedBefore = inventory(managedExtensionsDir);

    const user = manager(false);
    await user.refreshCache();
    const restored = await user.getExtensionStoreSnapshot();
    expect(restored.extensions[installed.id]).toEqual(
      userState.extensions[installed.id],
    );
    const store = new ExtensionStore();
    const staging = await store.createStagingDirectory();
    fs.cpSync(installed.path, staging, { recursive: true });
    fs.writeFileSync(
      path.join(staging, 'qwen-extension.json'),
      JSON.stringify({ name: userName, version: '3.0.0' }),
    );
    const updated = await store.commitArtifact({
      operation: 'update',
      identity: { id: installed.id, name: userName },
      stagingDirectory: staging,
      destinationDirectory: path.join(path.dirname(installed.path), userName),
      expectedArtifactGeneration:
        restored.extensions[installed.id].artifactGeneration,
    });
    expect(updated.extensions[installed.id]).toMatchObject({
      artifactDirectory: name,
      artifactGeneration: updated.generation,
      defaultActivation: 'disabled',
      workspaceOverrides: userState.extensions[installed.id].workspaceOverrides,
    });
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(installed.path, 'qwen-extension.json'),
          'utf8',
        ),
      ).version,
    ).toBe('3.0.0');
    expect(fs.readdirSync(path.dirname(installed.path))).toContain(name);
    expect(fs.readdirSync(path.dirname(installed.path))).not.toContain(
      userName,
    );
    await user.uninstallExtension(userName, false);
    expect(fs.existsSync(installed.path)).toBe(false);
    expect(inventory(managedExtensionsDir)).toEqual(managedBefore);
  });

  it.each(['package removed', 'launcher option removed'] as const)(
    'allows an explicit user install to adopt retained managed preferences after %s',
    async (withdrawal) => {
      const managedPackage = path.join(managedExtensionsDir, 'deployed');
      writePackage(managedPackage, '2.0.0');
      const deployed = manager();
      await deployed.refreshCache();
      const managedId = deployed.getLoadedExtensions()[0].id;
      await deployed.setExtensionDefaultActivation(managedId, 'disabled');
      await deployed.setExtensionWorkspaceActivation(
        managedId,
        otherWorkspace,
        'disabled',
      );
      deployed.toggleFavorite(name);
      deployed.setMcpServerDisabled(name, 'helper', true);
      const before = await deployed.getExtensionStoreSnapshot();
      if (withdrawal === 'package removed')
        fs.rmSync(managedPackage, { recursive: true });
      const user = manager(withdrawal === 'package removed');
      await user.refreshCache();
      expect(user.getLoadedExtensions()).toEqual([]);
      expect(await user.getExtensionStoreSnapshot()).toEqual(before);
      const installed = await user.installExtension({ type: 'local', source });
      const after = await user.getExtensionStoreSnapshot();
      expect(installed).toMatchObject({
        name,
        source: 'user',
        isActive: false,
      });
      expect(installed.id).not.toBe(managedId);
      expect(after.extensions[managedId]).toBeUndefined();
      expect(after.extensions[installed.id]).toMatchObject({
        defaultActivation: 'disabled',
        workspaceOverrides: before.extensions[managedId].workspaceOverrides,
        artifactGeneration: after.generation,
      });
      expect(after.extensions[installed.id].managed).toBeUndefined();
      expect(user.isFavorite(name)).toBe(true);
      expect(user.getDisabledMcpServers(name)).toEqual(['helper']);
      const installedFiles = inventory(installed.path);
      await expect(
        user.uninstallExtensionById(managedId, false),
      ).resolves.toEqual(after);
      expect(inventory(installed.path)).toEqual(installedFiles);
      expect(await user.getExtensionStoreSnapshot()).toEqual(after);
    },
  );

  it('preserves saved managed settings when an explicit user install takes over its settings directory', async () => {
    const settings = [
      {
        name: 'Endpoint',
        description: 'Public endpoint',
        envVar: 'PUBLIC_ENDPOINT',
      },
      {
        name: 'Retained',
        description: 'Saved extra setting',
        envVar: 'RETAINED_VALUE',
      },
    ];
    const managedPackage = path.join(managedExtensionsDir, 'deployed');
    writePackage(managedPackage, '2.0.0');
    fs.writeFileSync(
      path.join(managedPackage, 'qwen-extension.json'),
      JSON.stringify({ name, version: '2.0.0', settings }),
    );
    const deployed = manager();
    await deployed.refreshCache();
    const [managed] = deployed.getLoadedExtensions();
    await deployed.setExtensionDefaultActivation(managed.id, 'disabled');
    await updateSetting(
      managed.config,
      managed.id,
      'Endpoint',
      async () => 'https://example.invalid/saved',
      ExtensionSettingScope.USER,
    );
    await updateSetting(
      managed.config,
      managed.id,
      'Retained',
      async () => 'saved value',
      ExtensionSettingScope.USER,
    );
    const userDirectory = path.join(
      process.env['QWEN_HOME']!,
      'extensions',
      name,
    );
    expect(fs.readdirSync(userDirectory)).toEqual(['.env']);
    const saved = fs.readFileSync(path.join(userDirectory, '.env'), 'utf8');
    fs.rmSync(managedPackage, { recursive: true });
    await deployed.refreshCache();
    fs.writeFileSync(
      path.join(source, 'qwen-extension.json'),
      JSON.stringify({ name, version: '3.0.0', settings: [settings[0]] }),
    );
    const installed = await deployed.installExtension(
      { type: 'local', source },
      undefined,
      async () => 'https://example.invalid/new',
    );
    expect(installed).toMatchObject({ source: 'user', isActive: false });
    expect(
      await getScopedEnvContents(
        installed.config,
        installed.id,
        ExtensionSettingScope.USER,
      ),
    ).toEqual({
      PUBLIC_ENDPOINT: 'https://example.invalid/new',
      RETAINED_VALUE: 'saved value',
    });
    expect(fs.readFileSync(path.join(userDirectory, '.env'), 'utf8')).toContain(
      saved,
    );
    const snapshot = await deployed.getExtensionStoreSnapshot();
    expect(snapshot.extensions[managed.id]).toBeUndefined();
    expect(snapshot.extensions[installed.id]).not.toHaveProperty('managed');
    const installedFiles = inventory(userDirectory);
    await deployed.uninstallExtensionById(managed.id, false);
    expect(inventory(userDirectory)).toEqual(installedFiles);
  });

  it('rejects installing over a managed source hidden by a name-filtered cache', async () => {
    writePackage(path.join(managedExtensionsDir, 'deployed'), '2.0.0');
    const deployed = manager();
    await deployed.refreshCache();
    const before = await deployed.getExtensionStoreSnapshot();
    await deployed.refreshCache({ names: ['unrelated'] });
    expect(deployed.getLoadedExtensions()).toEqual([]);
    await expect(
      deployed.installExtension({ type: 'local', source }),
    ).rejects.toBeInstanceOf(ManagedExtensionReadOnlyError);
    expect(await deployed.getExtensionStoreSnapshot()).toEqual(before);
    expect(
      fs.existsSync(path.join(process.env['QWEN_HOME']!, 'extensions', name)),
    ).toBe(false);
  });

  it('rechecks managed ownership when committing a prepared user install', async () => {
    const managedPackage = path.join(managedExtensionsDir, 'deployed');
    writePackage(managedPackage, '2.0.0');
    const deployed = manager();
    await deployed.refreshCache();
    fs.rmSync(managedPackage, { recursive: true });
    await deployed.refreshCache();
    const prepared = await deployed.prepareExtensionInstall({
      installMetadata: { type: 'local', source },
      initialActivation: { scope: 'user' },
    });
    try {
      writePackage(managedPackage, '3.0.0');
      const before = await deployed.getExtensionStoreSnapshot();
      await expect(
        deployed.commitPreparedExtension(prepared),
      ).rejects.toBeInstanceOf(ManagedExtensionReadOnlyError);
      expect(await deployed.getExtensionStoreSnapshot()).toEqual(before);
      expect(fs.existsSync(prepared.destinationDirectory)).toBe(false);
    } finally {
      await deployed.disposePreparedExtension(prepared);
    }
  });

  it('still demotes a real user installation when its artifact is missing', async () => {
    const { installer, installed } = await installUserPackage();
    fs.rmSync(installed.path, { recursive: true });
    await installer.setExtensionDefaultActivations([name], 'disabled');
    expect(
      (await installer.getExtensionStoreSnapshot()).extensions[installed.id],
    ).toMatchObject({ declarationOnly: true });
    await expect(
      installer.setExtensionDefaultActivation(installed.id, 'enabled'),
    ).rejects.toMatchObject({ code: 'extension_conflict' });
  });

  it('restores user artifact liveness checks after discovering the shadowed user package again', async () => {
    const { installed, snapshot: installedState } = await installUserPackage();
    writePackage(path.join(managedExtensionsDir, 'deployed'), '2.0.0');
    const external = manager();
    await external.refreshCache();
    const managedId = external.getLoadedExtensions()[0].id;
    expect(
      (await external.getExtensionStoreSnapshot()).extensions[managedId],
    ).toMatchObject({ managed: true });
    const user = manager(false);
    await user.refreshCache();
    const returned = await user.getExtensionStoreSnapshot();
    expect(returned.extensions[installed.id].artifactGeneration).toBe(
      installedState.extensions[installed.id].artifactGeneration,
    );
    expect(returned.extensions[installed.id]).not.toHaveProperty('managed');
    fs.rmSync(installed.path, { recursive: true });
    await user.setExtensionDefaultActivations([name], 'disabled');
    await expect(
      user.setExtensionDefaultActivation(installed.id, 'enabled'),
    ).rejects.toMatchObject({ code: 'extension_conflict' });
  });
});
