/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileTokenStorage } from '../mcp/token-storage/file-token-storage.js';
import { KeychainTokenStorage } from '../mcp/token-storage/keychain-token-storage.js';
import {
  ExtensionManager,
  ExtensionUpdateState,
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

function writePackage(
  directory: string,
  name: string,
  version = '1.0.0',
  sensitive = true,
) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'qwen-extension.json'),
    JSON.stringify({ name, version, ...(sensitive ? { settings } : {}) }),
  );
  fs.writeFileSync(path.join(directory, 'QWEN.md'), 'Test-only context.');
}

describe('managed extension lifecycle safety', () => {
  let root: string;
  let workspace: string;
  let managedRoot: string;
  let userRoot: string;

  beforeEach(() => {
    root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-managed-lifecycle-')),
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

  const manager = (configured = true) =>
    new ExtensionManager({
      workspaceDir: workspace,
      isWorkspaceTrusted: true,
      ...(configured ? { managedExtensionsDir: managedRoot } : {}),
      requestConsent: async () => undefined,
    });
  const secretPresent = (name: string, id: string) =>
    hasStoredExtensionSecrets(name, id, [workspace]);
  async function seedSecret(subject: ExtensionManager, name: string) {
    const extension = subject
      .getLoadedExtensions()
      .find((item) => item.name === name)!;
    expect(extension.source).toBe('managed');
    await updateSetting(
      extension.config,
      extension.id,
      'TOKEN',
      async () => 'test-only-sentinel',
      ExtensionSettingScope.USER,
    );
    expect(await secretPresent(name, extension.id)).toBe(true);
    return extension;
  }

  it.each([
    { directory: 'acme-toolkit', action: 'refresh' },
    { directory: 'acme-toolkit-1.4.0', action: 'refresh' },
    { directory: 'acme-toolkit', action: 'release' },
    { directory: 'acme-toolkit-1.4.0', action: 'release' },
  ] as const)(
    'retains the manifestless $directory package during $action',
    async ({ directory, action }) => {
      const name = 'acme-toolkit';
      const deployed = path.join(managedRoot, directory);
      if (action === 'refresh')
        writePackage(path.join(userRoot, 'user-copy'), name);
      writePackage(deployed, name);
      const initial = manager();
      await initial.refreshCache();
      const managed = await seedSecret(initial, name);
      fs.unlinkSync(path.join(deployed, 'qwen-extension.json'));
      vi.mocked(process.stderr.write).mockClear();
      const fresh = manager();
      if (action === 'refresh') {
        await fresh.refreshCache();
        expect(fresh.getLoadedExtensions()).toEqual([
          expect.objectContaining({ name, source: 'user' }),
        ]);
        expect(
          vi.mocked(process.stderr.write).mock.calls.flat().join(''),
        ).not.toContain('shadowed');
      } else {
        await fresh.refreshCache({ allowManagedHandBack: false });
        expect(fresh.getLoadedExtensions()).toEqual([]);
        await expect(
          fresh.uninstallExtensionById(managed.id, false),
        ).rejects.toBeInstanceOf(ManagedExtensionReadOnlyError);
      }
      expect
        .soft(
          Object.values(
            (await new ExtensionStore().readSnapshot()).extensions,
          ).find((policy) => policy.name === name)?.managed,
        )
        .toBe(true);
      expect.soft(await secretPresent(name, managed.id)).toBe(true);
    },
  );

  it.each(['refresh', 'release'] as const)(
    'defers %s until an unattributed asset-only directory is removed',
    async (action) => {
      const name = 'acme-toolkit';
      const deployed = path.join(managedRoot, 'acme-toolkit-1.4.0');
      if (action === 'refresh')
        writePackage(path.join(userRoot, 'user-copy'), name);
      writePackage(deployed, name);
      const initial = manager();
      await initial.refreshCache();
      const managed = await seedSecret(initial, name);
      fs.rmSync(deployed, { recursive: true });
      fs.mkdirSync(path.join(managedRoot, 'unrelated-assets'));
      fs.writeFileSync(
        path.join(managedRoot, 'unrelated-assets', 'logo.txt'),
        'asset',
      );
      const fresh = manager();
      await fresh.refreshCache({ allowManagedHandBack: action === 'refresh' });
      if (action === 'release') {
        await expect(
          fresh.uninstallExtensionById(managed.id, false),
        ).rejects.toBeInstanceOf(ManagedExtensionReadOnlyError);
      }
      expect(await secretPresent(name, managed.id)).toBe(true);
      expect(
        Object.values(
          (await new ExtensionStore().readSnapshot()).extensions,
        ).find((policy) => policy.name === name)?.managed,
      ).toBe(true);
      fs.rmSync(path.join(managedRoot, 'unrelated-assets'), {
        recursive: true,
      });
      const confirmed = manager();
      await confirmed.refreshCache({
        allowManagedHandBack: action === 'refresh',
      });
      if (action === 'release')
        await confirmed.uninstallExtensionById(managed.id, false);
      expect(await secretPresent(name, managed.id)).toBe(false);
      expect(
        Object.values(
          (await new ExtensionStore().readSnapshot()).extensions,
        ).some((policy) => policy.name === name && policy.managed),
      ).toBe(false);
    },
  );

  it.each([
    { names: ['demo'], action: 'refresh' },
    { names: ['demo', 'Demo'], action: 'refresh' },
    { names: ['demo', 'Demo', 'DEMO'], action: 'refresh' },
    { names: ['demo'], action: 'release' },
    { names: ['demo', 'Demo'], action: 'release' },
    { names: ['demo', 'Demo', 'DEMO'], action: 'release' },
  ] as const)(
    'cleans every managed spelling $names during $action',
    async ({ names, action }) => {
      const deployed = path.join(managedRoot, 'versioned-bundle');
      const subject = manager();
      let managedId: string | undefined;
      for (const name of names) {
        writePackage(deployed, name);
        await subject.refreshCache();
        const extension = await seedSecret(subject, name);
        if (managedId !== undefined) expect(extension.id).toBe(managedId);
        managedId = extension.id;
      }
      for (const name of names)
        expect(await secretPresent(name, managedId!)).toBe(true);
      fs.rmSync(deployed, { recursive: true });
      if (action === 'refresh')
        writePackage(
          path.join(userRoot, 'returning-user'),
          names[names.length - 1]!,
        );
      const fresh = manager();
      await fresh.refreshCache({ allowManagedHandBack: action === 'refresh' });
      if (action === 'release')
        await fresh.uninstallExtensionById(managedId!, false);
      for (const name of names)
        expect.soft(await secretPresent(name, managedId!), name).toBe(false);
      expect(
        Object.values(
          (await new ExtensionStore().readSnapshot()).extensions,
        ).some((policy) => policy.managed),
      ).toBe(false);
    },
  );

  async function createUpdateCandidates(withManagedPolicy = true) {
    const blockedSource = path.join(root, 'blocked-source');
    const siblingSource = path.join(root, 'sibling-source');
    writePackage(blockedSource, 'retained', '1.0.0', false);
    writePackage(siblingSource, 'sibling', '1.0.0', false);
    const installer = manager(false);
    await installer.refreshCache();
    await installer.installExtension({ type: 'local', source: blockedSource });
    await installer.installExtension({ type: 'local', source: siblingSource });
    if (withManagedPolicy) {
      writePackage(
        path.join(managedRoot, 'retained'),
        'retained',
        '2.0.0',
        false,
      );
      await manager().refreshCache();
    }
    writePackage(blockedSource, 'retained', '2.0.0', false);
    writePackage(siblingSource, 'sibling', '2.0.0', false);
    const subject = manager(false);
    await subject.refreshCache();
    const retained = subject
      .getLoadedExtensions()
      .find((item) => item.name === 'retained')!;
    const sibling = subject
      .getLoadedExtensions()
      .find((item) => item.name === 'sibling')!;
    expect(retained.source).toBe('user');
    expect(
      (await subject.getExtensionStoreSnapshot()).extensions[retained.id]
        ?.managed,
    ).toBe(withManagedPolicy ? true : undefined);
    return { subject, retained, sibling };
  }

  it('does not advertise retained managed policies as available user updates', async () => {
    const { subject } = await createUpdateCandidates();
    const callback = vi.fn();
    await subject.checkForAllExtensionUpdates(callback);
    expect(callback).toHaveBeenCalledWith(
      'sibling',
      ExtensionUpdateState.UPDATE_AVAILABLE,
    );
    expect(callback).toHaveBeenCalledWith(
      'retained',
      ExtensionUpdateState.NOT_UPDATABLE,
    );
    expect(callback).not.toHaveBeenCalledWith(
      'retained',
      ExtensionUpdateState.UPDATE_AVAILABLE,
    );
  });

  it('reports a terminal callback for a retained managed update refusal', async () => {
    const { subject, retained } = await createUpdateCandidates();
    const callback = vi.fn();
    await subject
      .updateExtension(
        retained,
        ExtensionUpdateState.UPDATE_AVAILABLE,
        callback,
      )
      .catch((error: unknown) =>
        expect(error).toBeInstanceOf(ManagedExtensionReadOnlyError),
      );
    expect(callback).toHaveBeenCalledWith(
      'retained',
      expect.stringMatching(/error|not.updatable/i),
    );
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(retained.path, 'qwen-extension.json'),
          'utf8',
        ),
      ).version,
    ).toBe('1.0.0');
  });

  it('retains a successful sibling update result when a retained managed candidate refuses', async () => {
    const { subject, sibling } = await createUpdateCandidates();
    const callback = vi.fn();
    const states = new Map(
      subject
        .getLoadedExtensions()
        .map((extension) => [
          extension.name,
          { status: ExtensionUpdateState.UPDATE_AVAILABLE, processed: true },
        ]),
    );
    const outcome = await subject
      .updateAllUpdatableExtensions(states, callback, false)
      .then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
    await vi.waitFor(() =>
      expect(callback).toHaveBeenCalledWith(
        'sibling',
        ExtensionUpdateState.UPDATED_NEEDS_RESTART,
      ),
    );
    expect(
      JSON.parse(
        fs.readFileSync(path.join(sibling.path, 'qwen-extension.json'), 'utf8'),
      ).version,
    ).toBe('2.0.0');
    expect.soft(outcome).toEqual({
      value: [
        {
          name: 'sibling',
          originalVersion: '1.0.0',
          updatedVersion: '2.0.0',
        },
      ],
    });
    expect(callback).toHaveBeenCalledWith(
      'retained',
      expect.stringMatching(/error|not.updatable/i),
    );
  });
  it('retains successful siblings when an ordinary local update source fails', async () => {
    const { subject, sibling, retained } = await createUpdateCandidates(false);
    fs.unlinkSync(path.join(root, 'blocked-source', 'qwen-extension.json'));
    const callback = vi.fn();
    const states = new Map(
      subject
        .getLoadedExtensions()
        .map((extension) => [
          extension.name,
          { status: ExtensionUpdateState.UPDATE_AVAILABLE, processed: true },
        ]),
    );
    const outcome = await subject
      .updateAllUpdatableExtensions(states, callback, false)
      .then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
    await vi.waitFor(() =>
      expect(callback).toHaveBeenCalledWith(
        'sibling',
        ExtensionUpdateState.UPDATED_NEEDS_RESTART,
      ),
    );
    expect(callback).toHaveBeenCalledWith(
      'retained',
      ExtensionUpdateState.ERROR,
    );
    expect(
      JSON.parse(
        fs.readFileSync(path.join(sibling.path, 'qwen-extension.json'), 'utf8'),
      ).version,
    ).toBe('2.0.0');
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(retained.path, 'qwen-extension.json'),
          'utf8',
        ),
      ).version,
    ).toBe('1.0.0');
    expect(outcome).toEqual({
      value: [
        { name: 'sibling', originalVersion: '1.0.0', updatedVersion: '2.0.0' },
      ],
    });
  });
  it('continues cleaning later spellings and reports a failed credential cleanup', async () => {
    const names = ['demo', 'Demo', 'DEMO'];
    const deployed = path.join(managedRoot, 'versioned-bundle');
    const subject = manager();
    let managedId: string | undefined;
    for (const name of names) {
      writePackage(deployed, name);
      await subject.refreshCache();
      managedId = (await seedSecret(subject, name)).id;
    }
    fs.rmSync(deployed, { recursive: true });
    const fresh = manager();
    await fresh.refreshCache({ allowManagedHandBack: false });
    const failingService = `Qwen Code Extensions demo ${managedId}`;
    const listSecrets = FileTokenStorage.prototype.listSecrets;
    const attempts: string[] = [];
    const failure = vi
      .spyOn(FileTokenStorage.prototype, 'listSecrets')
      .mockImplementation(async function (this: FileTokenStorage) {
        const serviceName = (this as unknown as { serviceName: string })
          .serviceName;
        attempts.push(serviceName);
        if (serviceName === failingService)
          throw new Error('simulated credential read failure');
        return listSecrets.call(this);
      });
    const released = await fresh.uninstallExtensionById(managedId!, false);
    failure.mockRestore();
    expect(attempts[0]).toBe(failingService);
    expect(released.warnings).toContainEqual({
      code: 'extension_secrets_cleanup_failed',
      error: 'simulated credential read failure',
    });
    expect(await secretPresent('demo', managedId!)).toBe(true);
    expect(await secretPresent('Demo', managedId!)).toBe(false);
    expect(await secretPresent('DEMO', managedId!)).toBe(false);
  });
  it('refuses release when another manager changes the managed directory after its snapshot', async () => {
    const name = 'release-race';
    const originalDirectory = path.join(managedRoot, 'provider-a');
    const replacementDirectory = path.join(managedRoot, 'provider-b');
    writePackage(originalDirectory, name);
    const initial = manager();
    await initial.refreshCache();
    const managed = await seedSecret(initial, name);
    const settingsDirectory = path.join(userRoot, name);
    fs.mkdirSync(settingsDirectory);
    const envPath = path.join(settingsDirectory, '.env');
    fs.writeFileSync(envPath, 'PREFERENCE=keep\n');
    const releaseStore = new ExtensionStore();
    const readSnapshot = releaseStore.readSnapshot.bind(releaseStore);
    let replacementWasRecorded = false;
    vi.spyOn(releaseStore, 'readSnapshot').mockImplementationOnce(async () => {
      const original = await readSnapshot();
      expect(original.extensions[managed.id]?.managedDirectory).toBe(
        'provider-a',
      );
      fs.rmSync(originalDirectory, { recursive: true });
      writePackage(replacementDirectory, name);
      await manager().refreshCache();
      const latest = await new ExtensionStore().readSnapshot();
      expect(latest.extensions[managed.id]?.managedDirectory).toBe(
        'provider-b',
      );
      replacementWasRecorded = true;
      fs.unlinkSync(path.join(replacementDirectory, 'qwen-extension.json'));
      return original;
    });
    const releasing = new ExtensionManager({
      workspaceDir: workspace,
      isWorkspaceTrusted: true,
      managedExtensionsDir: managedRoot,
      extensionStore: releaseStore,
    });
    const outcome = await releasing
      .uninstallExtensionById(managed.id, false)
      .then(
        () => 'released',
        () => 'rejected',
      );
    expect(replacementWasRecorded).toBe(true);
    expect.soft(outcome).toBe('rejected');
    expect
      .soft((await new ExtensionStore().readSnapshot()).extensions[managed.id])
      .toMatchObject({ managed: true, managedDirectory: 'provider-b' });
    expect.soft(await secretPresent(name, managed.id)).toBe(true);
    expect.soft(fs.existsSync(envPath)).toBe(true);
    if (fs.existsSync(envPath))
      expect(fs.readFileSync(envPath, 'utf8')).toBe('PREFERENCE=keep\n');
  });
});
