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
import { FileTokenStorage } from '../mcp/token-storage/file-token-storage.js';
import { ExtensionManager } from './extensionManager.js';
import { ExtensionStore, ExtensionConflictError } from './extension-store.js';
import {
  ExtensionSettingScope,
  getEnvContents,
  hasStoredExtensionSecrets,
  updateSetting,
} from './extensionSettings.js';

const name = 'managed-workspace-secret';
const settings = [
  {
    name: 'Token',
    description: 'Test-only token',
    envVar: 'TOKEN',
    sensitive: true,
  },
];

function writePackage(directory: string, sensitive = true) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'qwen-extension.json'),
    JSON.stringify({
      name,
      version: '1.0.0',
      ...(sensitive ? { settings } : {}),
    }),
  );
}

describe('managed extension workspace secrets', () => {
  let root: string;
  let workspaceA: string;
  let workspaceB: string;
  let managedRoot: string;
  let userRoot: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    root = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), 'managed-workspace-secret-')),
    );
    workspaceA = path.join(root, 'workspace-a');
    workspaceB = path.join(root, 'workspace-b');
    managedRoot = path.join(root, 'deployment');
    userRoot = path.join(root, 'home', 'extensions');
    for (const dir of [workspaceA, workspaceB, managedRoot, userRoot]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    vi.stubEnv('QWEN_HOME', path.join(root, 'home'));
    vi.stubEnv('QWEN_CODE_FORCE_FILE_STORAGE', 'true');
    vi.spyOn(KeychainTokenStorage.prototype, 'isAvailable').mockResolvedValue(
      false,
    );
    vi.spyOn(KeychainTokenStorage.prototype, 'getKeytar').mockResolvedValue(
      null,
    );
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(workspaceA);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const manager = (workspaceDir = workspaceA) =>
    new ExtensionManager({
      workspaceDir,
      managedExtensionsDir: managedRoot,
      isWorkspaceTrusted: true,
      requestConsent: async () => undefined,
      requestSetting: async () => 'new-install-sentinel',
    });

  async function seedSecret() {
    writePackage(path.join(managedRoot, 'deployed'));
    cwdSpy.mockReturnValue(workspaceB);
    const initial = manager(workspaceB);
    await initial.refreshCache();
    const managed = initial
      .getLoadedExtensions()
      .find((item) => item.name === name)!;
    expect(managed.source).toBe('managed');
    await updateSetting(
      managed.config,
      managed.id,
      'TOKEN',
      async () => 'workspace-b-test-sentinel',
      ExtensionSettingScope.WORKSPACE,
    );
    const stored = new FileTokenStorage(
      `Qwen Code Extensions ${name} ${managed.id} ${workspaceB}`,
    );
    await expect(stored.getSecret('TOKEN')).resolves.toBe(
      'workspace-b-test-sentinel',
    );
    cwdSpy.mockReturnValue(workspaceA);
    fs.rmSync(path.join(managedRoot, 'deployed'), { recursive: true });
    return managed;
  }

  it.each(['refresh', 'release'] as const)(
    'clears workspace B secrets during %s from a fresh manager in workspace A',
    async (action) => {
      const managed = await seedSecret();
      if (action === 'refresh') writePackage(path.join(userRoot, 'user-copy'));
      const acting = manager();
      await acting.refreshCache({
        allowManagedHandBack: action === 'refresh',
      });
      if (action === 'release') {
        await acting.uninstallExtensionById(managed.id, false);
      }
      const snapshot = await new ExtensionStore().readSnapshot();
      expect(
        Object.values(snapshot.extensions).some(
          (policy) => policy.name === name && policy.managed,
        ),
      ).toBe(false);
      await expect(
        hasStoredExtensionSecrets(name, managed.id, [workspaceB]),
      ).resolves.toBe(false);

      writePackage(path.join(managedRoot, 'redeployed'));
      const redeployed = manager();
      await redeployed.refreshCache();
      const newManaged = redeployed
        .getLoadedExtensions()
        .find((item) => item.name === name)!;
      expect(newManaged.id).toBe(managed.id);
      cwdSpy.mockReturnValue(workspaceB);
      const resolved = await getEnvContents(newManaged.config, newManaged.id);
      expect(resolved['TOKEN']).toBeUndefined();
    },
  );

  it('rejects adoption in workspace A while workspace B retains a credential', async () => {
    const managed = await seedSecret();
    const fresh = manager();
    await fresh.refreshCache({ allowManagedHandBack: false });
    const source = path.join(root, 'user-source');
    writePackage(source, false);

    await expect(
      fresh.installExtension({ type: 'local', source }),
    ).rejects.toBeInstanceOf(ExtensionConflictError);
    const snapshot = await new ExtensionStore().readSnapshot();
    expect(
      Object.values(snapshot.extensions).some(
        (policy) => policy.name === name && policy.managed,
      ),
    ).toBe(true);
    await expect(hasStoredExtensionSecrets(name, managed.id)).resolves.toBe(
      true,
    );
    cwdSpy.mockReturnValue(workspaceB);
    await expect(getEnvContents(managed.config, managed.id)).resolves.toEqual({
      TOKEN: 'workspace-b-test-sentinel',
    });
  });
});
