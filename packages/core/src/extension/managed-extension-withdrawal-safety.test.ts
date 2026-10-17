/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const manifestReads = vi.hoisted(() => ({
  paths: new Set<string>(),
  calls: [] as string[],
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync(...args: Parameters<typeof actual.readFileSync>) {
      if (typeof args[0] === 'string' && manifestReads.paths.has(args[0])) {
        manifestReads.calls.push(args[0]);
      }
      return actual.readFileSync(...args);
    },
  };
});
import { FileTokenStorage } from '../mcp/token-storage/file-token-storage.js';
import { KeychainTokenStorage } from '../mcp/token-storage/keychain-token-storage.js';
import {
  ExtensionManager,
  ManagedExtensionReadOnlyError,
  hashValue,
} from './extensionManager.js';
import {
  ExtensionConflictError,
  ExtensionStore,
  type ExtensionStoreSnapshot,
} from './extension-store.js';
import {
  ExtensionSettingScope,
  hasStoredExtensionSecrets,
  updateSetting,
} from './extensionSettings.js';
import { AGENT_PLUGIN_SCHEMA } from './agent-plugins-v1/index.js';

const settings = [{ name: 'Token', envVar: 'TOKEN', sensitive: true }];

function writePackage(directory: string, name: string) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'qwen-extension.json'),
    JSON.stringify({ name, version: '1.0.0', settings }),
  );
}

describe('managed extension withdrawal safety', () => {
  let root: string;
  let workspace: string;
  let managedRoot: string;
  let userRoot: string;

  beforeEach(() => {
    manifestReads.paths.clear();
    manifestReads.calls.length = 0;
    root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-managed-withdrawal-')),
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

  function manager() {
    return new ExtensionManager({
      workspaceDir: workspace,
      isWorkspaceTrusted: true,
      managedExtensionsDir: managedRoot,
      requestConsent: async () => undefined,
    });
  }

  it('retains managed ownership during a named refresh until a full discovery proves withdrawal', async () => {
    const artifact = path.join(userRoot, 'returning');
    const deployed = path.join(managedRoot, 'provider');
    const stableId = 'e1'.repeat(32);
    writePackage(artifact, 'original');
    fs.writeFileSync(
      path.join(artifact, '.qwen-extension-install.json'),
      JSON.stringify({
        type: 'snapshot',
        source: artifact,
        installId: stableId,
      }),
    );
    const store = new ExtensionStore();
    const subject = manager();
    await subject.refreshCache();
    expect(subject.getLoadedExtensions()[0].id).toBe(stableId);
    await store.setWorkspaceActivation(
      { id: stableId, name: 'original', source: 'user' },
      workspace,
      'disabled',
    );
    writePackage(deployed, 'original');
    await subject.refreshCache();
    const managed = subject.getLoadedExtensions()[0];
    await store.setWorkspaceActivation(
      { id: managed.id, name: 'original', source: 'managed' },
      workspace,
      'enabled',
    );
    await updateSetting(
      managed.config,
      managed.id,
      'TOKEN',
      async () => 'test-only-sentinel',
      ExtensionSettingScope.USER,
    );
    fs.rmSync(deployed, { recursive: true });
    await new ExtensionManager({
      workspaceDir: workspace,
      isWorkspaceTrusted: true,
    }).refreshCache();
    const retained = await store.readSnapshot();
    expect(retained.extensions[stableId]).toMatchObject({
      name: 'original',
      managed: true,
      workspaceOverrides: { [workspace]: 'enabled' },
      preservedWorkspaceOverrides: { [workspace]: 'disabled' },
    });
    writePackage(artifact, 'renamed');
    writePackage(deployed, 'original');
    const bytes = fs.readFileSync(
      path.join(store.storeDir, 'state.json'),
      'utf8',
    );
    const clearing = vi.spyOn(FileTokenStorage.prototype, 'deleteSecret');
    const refreshing = manager();
    await expect(refreshing.refreshCache()).rejects.toBeInstanceOf(
      ExtensionConflictError,
    );
    await expect(
      refreshing.refreshCache({ names: ['renamed'] }),
    ).rejects.toBeInstanceOf(ExtensionConflictError);
    expect(
      fs.readFileSync(path.join(store.storeDir, 'state.json'), 'utf8'),
    ).toBe(bytes);
    expect(await store.readSnapshot()).toEqual(retained);
    expect(clearing).not.toHaveBeenCalled();
    expect(
      await hasStoredExtensionSecrets('original', managed.id, [workspace]),
    ).toBe(true);
    fs.rmSync(deployed, { recursive: true });
    await expect(
      refreshing.refreshCache({ names: ['renamed'] }),
    ).rejects.toBeInstanceOf(ExtensionConflictError);
    expect(
      fs.readFileSync(path.join(store.storeDir, 'state.json'), 'utf8'),
    ).toBe(bytes);
    await refreshing.refreshCache();
    const restored = await store.readSnapshot();
    expect(restored.extensions[stableId].managed).toBeUndefined();
    expect(restored.extensions[stableId].workspaceOverrides).toEqual({
      [workspace]: 'disabled',
    });
    expect(restored.pendingManagedSecretNames).toBeUndefined();
    expect(refreshing.getLoadedExtensions()[0]).toMatchObject({
      name: 'renamed',
      id: stableId,
      source: 'user',
      isActive: false,
    });
    expect(
      await hasStoredExtensionSecrets('original', managed.id, [workspace]),
    ).toBe(false);
  });

  it('hands back a proven withdrawn episode before a stable user id changes name', async () => {
    const store = new ExtensionStore();
    const user = {
      id: 'e1'.repeat(32),
      name: 'original',
      source: 'user' as const,
    };
    const managed = {
      id: 'e2'.repeat(32),
      name: 'original',
      source: 'managed' as const,
    };
    await store.ensureInitialized([user]);
    await store.setWorkspaceActivation(user, workspace, 'disabled');
    await store.ensureInitialized([managed]);
    await store.ensureInitialized([{ ...managed, name: 'Original' }]);
    await store.ensureInitialized([{ ...managed, name: 'ORIGINAL' }]);
    await store.ensureInitialized([user]);
    const bytes = fs.readFileSync(
      path.join(store.storeDir, 'state.json'),
      'utf8',
    );
    const renamed = { ...user, name: 'renamed' };
    await expect(store.ensureInitialized([renamed])).rejects.toBeInstanceOf(
      ExtensionConflictError,
    );
    await expect(
      store.ensureInitialized([renamed, managed], {
        managedAbsenceProven: true,
      }),
    ).rejects.toBeInstanceOf(ExtensionConflictError);
    await expect(
      store.ensureInitialized([renamed], {
        managedAbsenceProven: true,
        unprovenManagedNames: new Set(['staging']),
      }),
    ).rejects.toBeInstanceOf(ExtensionConflictError);
    expect(
      fs.readFileSync(path.join(store.storeDir, 'state.json'), 'utf8'),
    ).toBe(bytes);
    const handedBack = vi.fn();
    const restored = await store.ensureInitialized([renamed], {
      managedAbsenceProven: true,
      onManagedHandBack: handedBack,
    });
    expect(restored.extensions[user.id]).toMatchObject({
      name: 'renamed',
      workspaceOverrides: { [workspace]: 'disabled' },
    });
    expect(restored.extensions[user.id].managed).toBeUndefined();
    expect(restored.extensions[user.id].managedSecretNames).toBeUndefined();
    expect(handedBack.mock.calls).toEqual([
      ['original'],
      ['Original'],
      ['ORIGINAL'],
    ]);
    expect(restored.pendingManagedSecretNames).toEqual([
      'original',
      'Original',
      'ORIGINAL',
    ]);
    expect(await store.readSnapshot()).toEqual(restored);
    expect(restored.extensions[user.id].preserveActivationOnNextInstall).toBe(
      true,
    );
    const staging = await store.createStagingDirectory();
    writePackage(staging, renamed.name);
    const installed = await store.commitArtifact({
      operation: 'install',
      identity: renamed,
      stagingDirectory: staging,
      destinationDirectory: path.join(userRoot, renamed.name),
      initialActivation: { scope: 'user' },
    });
    expect(installed.extensions[user.id].workspaceOverrides).toEqual({
      [workspace]: 'disabled',
    });
    expect(installed.pendingManagedSecretNames).toEqual(
      restored.pendingManagedSecretNames,
    );
  });

  it.each(['refresh', 'release'] as const)(
    'retries every managed secret spelling after a failed %s cleanup across process restart',
    async (operation) => {
      const names = ['acme', 'Acme', 'ACME'];
      const deployed = path.join(managedRoot, 'provider');
      writePackage(path.join(userRoot, 'returning'), names[0]);
      const subject = manager();
      let managedId = '';
      for (const name of names) {
        writePackage(deployed, name);
        await subject.refreshCache();
        const extension = subject
          .getLoadedExtensions()
          .find((item) => item.source === 'managed')!;
        managedId = extension.id;
        await updateSetting(
          extension.config,
          extension.id,
          'TOKEN',
          async () => 'test-only-sentinel',
          ExtensionSettingScope.USER,
        );
        expect(
          await hasStoredExtensionSecrets(name, managedId, [workspace]),
        ).toBe(true);
      }
      fs.rmSync(deployed, { recursive: true });
      const original = FileTokenStorage.prototype.deleteSecret;
      const failure = vi
        .spyOn(FileTokenStorage.prototype, 'deleteSecret')
        .mockRejectedValue(
          Object.assign(new Error('test-only EACCES'), { code: 'EACCES' }),
        );
      const releasing = manager();
      if (operation === 'release')
        await releasing.uninstallExtensionById(managedId, false);
      else await releasing.refreshCache();
      expect(failure).toHaveBeenCalledTimes(names.length);
      for (const name of names)
        expect(
          await hasStoredExtensionSecrets(name, managedId, [workspace]),
        ).toBe(true);
      expect(
        (await new ExtensionStore().readSnapshot()).pendingManagedSecretNames,
      ).toEqual(names);
      const attempts = vi
        .spyOn(FileTokenStorage.prototype, 'deleteSecret')
        .mockImplementation(original);
      await manager().refreshCache({ allowManagedHandBack: false });
      await manager().refreshCatalogSnapshot();
      expect(attempts).not.toHaveBeenCalled();
      expect(
        (await new ExtensionStore().readSnapshot()).pendingManagedSecretNames,
      ).toEqual(names);
      await manager().refreshCache();
      expect(attempts).toHaveBeenCalledTimes(names.length);
      expect(
        (await new ExtensionStore().readSnapshot()).pendingManagedSecretNames,
      ).toBeUndefined();
      for (const name of names)
        expect(
          await hasStoredExtensionSecrets(name, managedId, [workspace]),
        ).toBe(false);
      attempts.mockClear();
      await manager().refreshCache();
      expect(attempts).not.toHaveBeenCalled();
    },
  );

  it.each(['canonical', 'noncanonical'] as const)(
    'restores a temporarily unreadable %s user copy after explicit managed release',
    async (location) => {
      const name = 'portable';
      const artifact = path.join(
        userRoot,
        location === 'canonical' ? name : 'returning',
      );
      const deployed = path.join(managedRoot, 'provider');
      writePackage(artifact, name);
      const initial = manager();
      await initial.refreshCache();
      const user = initial.getLoadedExtensions()[0];
      await initial.setExtensionWorkspaceActivation(
        user.id,
        workspace,
        'disabled',
      );
      writePackage(deployed, name);
      await initial.refreshCache();
      const managed = initial.getLoadedExtensions()[0];
      expect(
        (await initial.getExtensionStoreSnapshot()).extensions[managed.id]
          .preservedWorkspaceOverrides,
      ).toEqual({ [workspace]: 'disabled' });
      fs.rmSync(deployed, { recursive: true });
      fs.writeFileSync(path.join(artifact, 'qwen-extension.json'), '{');
      const released = await manager().uninstallExtensionById(
        managed.id,
        false,
      );
      expect(released.extensions[managed.id]).toBeUndefined();
      expect(Object.values(released.extensions)).toEqual([
        expect.objectContaining({
          name,
          declarationOnly: true,
          workspaceOverrides: { [workspace]: 'disabled' },
        }),
      ]);
      expect(Object.values(released.extensions)[0].managed).toBeUndefined();
      writePackage(artifact, name);
      const returning = manager();
      await returning.refreshCache();
      const repaired = returning.getLoadedExtensions()[0];
      expect(repaired).toMatchObject({ name, source: 'user', isActive: false });
      expect(
        (await returning.getExtensionStoreSnapshot()).extensions[repaired.id]
          .workspaceOverrides,
      ).toEqual({ [workspace]: 'disabled' });
    },
  );

  it.each(['artifact', 'activation'] as const)(
    'keeps the captured discovery snapshot when another writer commits %s before debt cleanup',
    async (change) => {
      const name = 'capture-race';
      const artifact = path.join(userRoot, 'returning');
      const deployed = path.join(managedRoot, 'provider');
      writePackage(artifact, name);
      const initial = manager();
      await initial.refreshCache();
      const user = initial.getLoadedExtensions()[0];
      writePackage(deployed, name);
      await initial.refreshCache();
      fs.rmSync(deployed, { recursive: true });
      const store = new ExtensionStore();
      const refreshing = new ExtensionManager({
        workspaceDir: workspace,
        isWorkspaceTrusted: true,
        managedExtensionsDir: managedRoot,
        extensionStore: store,
      });
      const drain = store.clearPendingManagedSecrets.bind(store);
      let captured: ExtensionStoreSnapshot | undefined;
      const raced = vi
        .spyOn(store, 'clearPendingManagedSecrets')
        .mockImplementationOnce(async (...args) => {
          captured = await new ExtensionStore().readSnapshot();
          expect(captured.pendingManagedSecretNames).toEqual([name]);
          expect(captured.extensions[user.id].defaultActivation).toBe(
            'enabled',
          );
          const writer = new ExtensionStore();
          if (change === 'artifact') {
            const staging = await writer.createStagingDirectory();
            writePackage(staging, name);
            fs.writeFileSync(
              path.join(staging, 'qwen-extension.json'),
              JSON.stringify({ name, version: '2.0.0', settings }),
            );
            await writer.commitArtifact({
              operation: 'update',
              identity: { id: user.id, name, source: 'user' },
              stagingDirectory: staging,
              destinationDirectory: artifact,
            });
          } else {
            await writer.setDefaultActivation(
              { id: user.id, name, source: 'user' },
              'disabled',
            );
          }
          return await drain(...args);
        });
      const result = await refreshing.refreshCacheWithSnapshot();
      expect(raced).toHaveBeenCalledOnce();
      expect(result.generation).toBe(captured!.generation);
      expect(result.extensions[user.id].defaultActivation).toBe('enabled');
      expect(refreshing.getLoadedExtensions()[0]).toMatchObject({
        version: '1.0.0',
        isActive: true,
      });
      const persisted = await new ExtensionStore().readSnapshot();
      expect(persisted.generation).toBe(captured!.generation + 1);
      expect(persisted.pendingManagedSecretNames).toEqual([name]);
      if (change === 'artifact')
        expect(persisted.extensions[user.id].artifactGeneration).toBe(
          persisted.generation,
        );
      else
        expect(persisted.extensions[user.id].defaultActivation).toBe(
          'disabled',
        );
      expect(result.extensions[user.id].artifactGeneration).toBe(
        captured!.extensions[user.id].artifactGeneration,
      );
      expect(await refreshing.refreshCacheIfSourcesChanged()).toBe(true);
      expect(refreshing.getLoadedExtensions()[0]).toMatchObject({
        version: change === 'artifact' ? '2.0.0' : '1.0.0',
        isActive: change === 'artifact',
      });
      expect(
        (await new ExtensionStore().readSnapshot()).pendingManagedSecretNames,
      ).toEqual([name]);
      await refreshing.refreshCache();
      expect(refreshing.getLoadedExtensions()[0]).toMatchObject({
        version: change === 'artifact' ? '2.0.0' : '1.0.0',
        isActive: change === 'artifact',
      });
      expect(
        (await new ExtensionStore().readSnapshot()).pendingManagedSecretNames,
      ).toBeUndefined();
    },
  );

  it('refuses a redeployment that appears during the surviving-user-artifact scan', async () => {
    const name = 'scan-race';
    const deployed = path.join(managedRoot, 'provider');
    writePackage(deployed, name);
    const initial = manager();
    await initial.refreshCache();
    const extension = initial.getLoadedExtensions()[0];
    await updateSetting(
      extension.config,
      extension.id,
      'TOKEN',
      async () => 'test-only-sentinel',
      ExtensionSettingScope.USER,
    );
    initial.toggleFavorite(name);
    fs.mkdirSync(path.join(userRoot, name), { recursive: true });
    const envPath = path.join(userRoot, name, '.env');
    fs.writeFileSync(envPath, 'PREFERENCE=keep\n');
    fs.rmSync(deployed, { recursive: true });
    const releasing = manager();
    const scanner = releasing as unknown as {
      hasSurvivingUserExtension: (
        name: string,
        snapshot: ExtensionStoreSnapshot,
      ) => Promise<boolean>;
    };
    const scan = scanner.hasSurvivingUserExtension.bind(releasing);
    const raced = vi
      .spyOn(scanner, 'hasSurvivingUserExtension')
      .mockImplementationOnce(async (scannedName, snapshot) => {
        const survives = await scan(scannedName, snapshot);
        expect(survives).toBe(false);
        writePackage(deployed, name);
        return survives;
      });
    const before = fs.readFileSync(
      path.join(new ExtensionStore().storeDir, 'state.json'),
      'utf8',
    );
    await expect(
      releasing.uninstallExtensionById(extension.id, false),
    ).rejects.toBeInstanceOf(ManagedExtensionReadOnlyError);
    expect(raced).toHaveBeenCalledOnce();
    expect(
      fs.readFileSync(
        path.join(new ExtensionStore().storeDir, 'state.json'),
        'utf8',
      ),
    ).toBe(before);
    expect(
      await hasStoredExtensionSecrets(name, extension.id, [workspace]),
    ).toBe(true);
    expect(fs.readFileSync(envPath, 'utf8')).toBe('PREFERENCE=keep\n');
    expect(manager().isFavorite(name)).toBe(true);
  });

  it('retains failed spellings, skips a newly claimed owner, and preserves debt through unrelated state writes', async () => {
    const store = new ExtensionStore();
    const managed = {
      id: 'c1'.repeat(32),
      name: 'demo',
      source: 'managed' as const,
    };
    for (const name of ['demo', 'Demo', 'DEMO'])
      await store.ensureInitialized([{ ...managed, name }]);
    const user = { id: 'c2'.repeat(32), name: 'demo', source: 'user' as const };
    await store.ensureInitialized([user], { managedAbsenceProven: true });
    const clear = vi.fn(async (name: string) => {
      if (name === 'Demo') throw new Error('test-only unavailable');
    });
    const partial = await store.clearPendingManagedSecrets(clear);
    expect(clear.mock.calls.map(([name]) => name)).toEqual([
      'demo',
      'Demo',
      'DEMO',
    ]);
    expect(partial.snapshot.pendingManagedSecretNames).toEqual(['Demo']);
    expect(partial.failures).toEqual([
      { name: 'Demo', error: expect.any(Error) },
    ]);
    await store.setDefaultActivation(user, 'disabled');
    const staging = await store.createStagingDirectory();
    writePackage(staging, 'other');
    await store.commitArtifact({
      operation: 'install',
      identity: { id: 'c3'.repeat(32), name: 'other', source: 'user' },
      stagingDirectory: staging,
      destinationDirectory: path.join(userRoot, 'other'),
      initialActivation: { scope: 'user' },
    });
    expect(
      (await new ExtensionStore().readSnapshot()).pendingManagedSecretNames,
    ).toEqual(['Demo']);
    await store.ensureInitialized([managed]);
    clear.mockClear();
    const reclaimed = await store.clearPendingManagedSecrets(clear);
    expect(clear).not.toHaveBeenCalled();
    expect(reclaimed.snapshot.pendingManagedSecretNames).toEqual(['Demo']);
    await store.ensureInitialized([user], { managedAbsenceProven: true });
    const retry = vi.fn(async () => undefined);
    const healthy = await store.clearPendingManagedSecrets(retry);
    expect(retry.mock.calls).toEqual([['Demo'], ['demo']]);
    expect(healthy.snapshot.pendingManagedSecretNames).toBeUndefined();
    expect(await store.readSnapshot()).toEqual(healthy.snapshot);
  });

  it('keeps cleanup debt when a committed release is followed by a failed cleanup acknowledgement write', async () => {
    const store = new ExtensionStore();
    const managed = {
      id: 'd1'.repeat(32),
      name: 'debt',
      source: 'managed' as const,
    };
    await store.ensureInitialized([managed]);
    const released = await store.removePolicy(managed);
    expect(released.pendingManagedSecretNames).toEqual(['debt']);
    expect((await store.inspectEmptiness()).status).toBe('unknown');
    const writer = store as unknown as {
      writeSnapshotUnlocked: (snapshot: unknown) => Promise<void>;
    };
    const fault = vi
      .spyOn(writer, 'writeSnapshotUnlocked')
      .mockRejectedValueOnce(new Error('test-only state write failed'));
    const clear = vi.fn(async () => undefined);
    await expect(store.clearPendingManagedSecrets(clear)).rejects.toThrow(
      'test-only state write failed',
    );
    expect(clear).toHaveBeenCalledExactlyOnceWith('debt');
    expect(
      (await new ExtensionStore().readSnapshot()).pendingManagedSecretNames,
    ).toEqual(['debt']);
    fault.mockRestore();
    const retried = await store.clearPendingManagedSecrets(clear);
    expect(clear).toHaveBeenCalledTimes(2);
    expect(retried.snapshot.pendingManagedSecretNames).toBeUndefined();
    expect((await store.inspectEmptiness()).status).toBe('empty');
  });

  it('rejects preservation identity collisions before releasing or cleaning any secret', async () => {
    const store = new ExtensionStore();
    const managed = {
      id: 'd2'.repeat(32),
      name: 'portable',
      source: 'managed' as const,
    };
    const occupied = {
      id: hashValue(managed.name),
      name: 'different',
      source: 'user' as const,
    };
    await store.ensureInitialized([managed, occupied]);
    const before = fs.readFileSync(
      path.join(store.storeDir, 'state.json'),
      'utf8',
    );
    await expect(
      store.removePolicy(managed, {
        preserveActivation: () => ({ ...occupied, name: managed.name }),
      }),
    ).rejects.toBeInstanceOf(ExtensionConflictError);
    expect(
      fs.readFileSync(path.join(store.storeDir, 'state.json'), 'utf8'),
    ).toBe(before);
    expect(
      (await store.readSnapshot()).pendingManagedSecretNames,
    ).toBeUndefined();
  });

  it('does not commit ownership release or cleanup debt when the synchronous hand-back callback throws', async () => {
    const store = new ExtensionStore();
    const identity = { id: 'd3'.repeat(32), name: 'callback' };
    await store.ensureInitialized([{ ...identity, source: 'managed' }]);
    const before = fs.readFileSync(
      path.join(store.storeDir, 'state.json'),
      'utf8',
    );
    await expect(
      store.ensureInitialized([{ ...identity, source: 'user' }], {
        managedAbsenceProven: true,
        onManagedHandBack: () => {
          throw new Error('test-only callback failed');
        },
      }),
    ).rejects.toThrow('test-only callback failed');
    expect(
      fs.readFileSync(path.join(store.storeDir, 'state.json'), 'utf8'),
    ).toBe(before);
    expect(
      (await store.readSnapshot()).pendingManagedSecretNames,
    ).toBeUndefined();
  });

  it('reads the validated canonical manifest target when recovering a contained symlink declared name', async () => {
    const directory = path.join(managedRoot, 'provider');
    fs.mkdirSync(directory);
    for (const name of ['provider', 'elsewhere', 'neutral']) {
      writePackage(path.join(userRoot, name), name);
    }
    const alias = path.join(directory, 'plugin.json');
    const canonical = path.join(directory, 'invalid.json');
    fs.writeFileSync(
      canonical,
      JSON.stringify({
        $schema: AGENT_PLUGIN_SCHEMA,
        name: 'elsewhere',
        version: 42,
      }),
    );
    fs.symlinkSync('invalid.json', alias);
    manifestReads.paths.add(alias);
    manifestReads.paths.add(canonical);
    const subject = manager();
    await subject.refreshCache();
    expect(subject.getLoadedExtensions()).toEqual([
      expect.objectContaining({ name: 'neutral', source: 'user' }),
    ]);
    expect(manifestReads.calls).toContain(canonical);
    expect(manifestReads.calls).not.toContain(alias);
  });

  it.each([
    'escaping',
    'contained-invalid',
    'contained-valid',
    'contained-symlink',
  ] as const)(
    'confines failed Agent Plugin name recovery: %s',
    async (shape) => {
      const directory = path.join(managedRoot, 'provider');
      fs.mkdirSync(directory);
      for (const name of ['provider', 'elsewhere', 'neutral'])
        writePackage(path.join(userRoot, name), name);
      const raw = JSON.stringify({
        $schema: AGENT_PLUGIN_SCHEMA,
        name: 'elsewhere',
        version: shape === 'contained-invalid' ? 42 : '1.0.0',
      });
      const manifest = path.join(directory, 'plugin.json');
      if (shape === 'escaping') {
        const outside = path.join(root, 'outside.json');
        fs.writeFileSync(outside, raw);
        fs.symlinkSync(outside, manifest);
      } else if (shape === 'contained-symlink') {
        fs.writeFileSync(path.join(directory, 'contained.json'), raw);
        fs.symlinkSync('contained.json', manifest);
      } else fs.writeFileSync(manifest, raw);
      const subject = manager();
      await subject.refreshCache();
      const loaded = subject.getLoadedExtensions();
      expect(loaded.some((extension) => extension.name === 'neutral')).toBe(
        true,
      );
      expect(loaded.some((extension) => extension.source === 'managed')).toBe(
        shape === 'contained-valid' || shape === 'contained-symlink',
      );
      expect(
        loaded.some(
          (extension) =>
            extension.name === 'elsewhere' && extension.source === 'user',
        ),
      ).toBe(shape === 'escaping');
      expect(loaded.some((extension) => extension.name === 'provider')).toBe(
        shape === 'contained-valid' || shape === 'contained-symlink',
      );
    },
  );
});
