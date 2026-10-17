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
import {
  clearStoredExtensionSecrets,
  ExtensionSettingScope,
  hasStoredExtensionSecrets,
  updateSetting,
} from './extensionSettings.js';
import { ExtensionManager } from './extensionManager.js';
import { ExtensionConflictError, ExtensionStore } from './extension-store.js';

const NAME = 'backend-safety';
const ID = 'bd'.repeat(32);
const USER_SERVICE = `Qwen Code Extensions ${NAME} ${ID}`;
const settings = [
  {
    name: 'Token',
    description: 'Test token',
    envVar: 'TOKEN',
    sensitive: true,
  },
];
const config = { name: NAME, version: '1.0.0', settings };

describe('managed secret backend safety', () => {
  let root: string;
  let workspace: string;
  let data: Map<string, Map<string, string>>;
  let modulePresent: boolean;
  let backendAvailable: boolean;
  let enumerationAvailable: boolean;

  beforeEach(() => {
    root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-keychain-safety-')),
    );
    workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace);
    vi.stubEnv('QWEN_HOME', path.join(root, 'home'));
    vi.stubEnv('QWEN_CODE_FORCE_FILE_STORAGE', 'false');
    vi.spyOn(process, 'cwd').mockReturnValue(workspace);
    data = new Map();
    modulePresent = true;
    backendAvailable = true;
    enumerationAvailable = true;
    const entries = (service: string) => {
      let values = data.get(service);
      if (!values) data.set(service, (values = new Map()));
      return values;
    };
    const keytar = {
      getPassword: async (service: string, account: string) => {
        if (!backendAvailable) throw new Error('Test keyring is locked');
        return entries(service).get(account) ?? null;
      },
      setPassword: async (service: string, account: string, value: string) => {
        if (!backendAvailable) throw new Error('Test keyring is locked');
        entries(service).set(account, value);
      },
      deletePassword: async (service: string, account: string) => {
        if (!backendAvailable) throw new Error('Test keyring is locked');
        return entries(service).delete(account);
      },
      findCredentials: async (service: string) => {
        if (!backendAvailable || !enumerationAvailable)
          throw new Error('Test keyring cannot enumerate');
        return [...entries(service)].map(([account, password]) => ({
          account,
          password,
        }));
      },
    };
    // Keep real availability checks and secret operations; only substitute
    // the optional native module to avoid modifying the user's OS keyring.
    vi.spyOn(KeychainTokenStorage.prototype, 'getKeytar').mockImplementation(
      async () => (modulePresent ? keytar : null),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const seed = async (scope = ExtensionSettingScope.USER, id = ID) => {
    await updateSetting(
      config,
      id,
      'TOKEN',
      async () => 'test-only-sentinel',
      scope,
    );
  };
  const writePackage = (directory: string) => {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, 'qwen-extension.json'),
      JSON.stringify(config),
    );
  };

  it('does not prove absence when a present backend becomes unavailable after a workspace write', async () => {
    await seed(ExtensionSettingScope.WORKSPACE);
    expect(
      data.get(`${USER_SERVICE} ${workspace}`)?.get('__secret__TOKEN'),
    ).toBe('test-only-sentinel');
    backendAvailable = false;
    expect(await new KeychainTokenStorage(USER_SERVICE).isAvailable()).toBe(
      false,
    );
    expect(
      await new KeychainTokenStorage(USER_SERVICE).getKeytar(),
    ).not.toBeNull();
    await expect(
      hasStoredExtensionSecrets(NAME, ID, [workspace]),
    ).resolves.toBe(true);
  });

  it('surfaces incomplete cleanup when a present backend becomes unavailable', async () => {
    await seed();
    backendAvailable = false;
    await expect(
      clearStoredExtensionSecrets(NAME, ID, [workspace]),
    ).rejects.toThrow();
    expect(data.get(USER_SERVICE)?.get('__secret__TOKEN')).toBe(
      'test-only-sentinel',
    );
  });

  it('refuses adoption without changing policy when the populated backend is unavailable', async () => {
    const store = new ExtensionStore();
    const managed = { id: ID, name: NAME, source: 'managed' as const };
    const before = await store.ensureInitialized([managed]);
    await seed(ExtensionSettingScope.WORKSPACE);
    backendAvailable = false;
    const staging = await store.createStagingDirectory();
    fs.writeFileSync(
      path.join(staging, 'qwen-extension.json'),
      JSON.stringify(config),
    );
    await expect(
      store.commitArtifact({
        operation: 'install',
        identity: { id: 'be'.repeat(32), name: NAME },
        destinationDirectory: path.join(root, 'home', 'extensions', NAME),
        stagingDirectory: staging,
        initialActivation: { scope: 'user' },
        allowManagedPolicyAdoption: true,
      }),
    ).rejects.toBeInstanceOf(ExtensionConflictError);
    expect(await store.readSnapshot()).toEqual(before);
  });

  it('reports incomplete cleanup on explicit release of a withdrawn managed package', async () => {
    const managedRoot = path.join(root, 'deployment');
    const packageDir = path.join(managedRoot, NAME);
    writePackage(packageDir);
    const createManager = () =>
      new ExtensionManager({
        workspaceDir: workspace,
        isWorkspaceTrusted: true,
        managedExtensionsDir: managedRoot,
        requestConsent: async () => undefined,
      });
    const initial = createManager();
    await initial.refreshCache();
    const managed = initial
      .getLoadedExtensions()
      .find((item) => item.name === NAME)!;
    await seed(ExtensionSettingScope.USER, managed.id);
    fs.rmSync(packageDir, { recursive: true });
    backendAvailable = false;
    const fresh = createManager();
    await fresh.refreshCache({ allowManagedHandBack: false });
    const result = await fresh.uninstallExtensionById(managed.id, false);
    expect
      .soft(
        data
          .get(`Qwen Code Extensions ${NAME} ${managed.id}`)
          ?.get('__secret__TOKEN'),
      )
      .toBe('test-only-sentinel');
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'extension_secrets_cleanup_failed' }),
      ]),
    );
  });

  it('clears independent file-backed scopes while reporting a locked native backend', async () => {
    await seed();
    vi.stubEnv('QWEN_CODE_FORCE_FILE_STORAGE', 'true');
    await seed();
    await seed(ExtensionSettingScope.WORKSPACE);
    vi.stubEnv('QWEN_CODE_FORCE_FILE_STORAGE', 'false');
    const userFile = new FileTokenStorage(USER_SERVICE);
    const workspaceFile = new FileTokenStorage(`${USER_SERVICE} ${workspace}`);
    await expect(userFile.getSecret('TOKEN')).resolves.toBe(
      'test-only-sentinel',
    );
    await expect(workspaceFile.getSecret('TOKEN')).resolves.toBe(
      'test-only-sentinel',
    );
    backendAvailable = false;
    await expect(
      clearStoredExtensionSecrets(NAME, ID, [workspace]),
    ).rejects.toThrow();
    await expect(userFile.getSecret('TOKEN')).resolves.toBeNull();
    await expect(workspaceFile.getSecret('TOKEN')).resolves.toBeNull();
    expect(data.get(USER_SERVICE)?.get('__secret__TOKEN')).toBe(
      'test-only-sentinel',
    );
  });

  it('allows an absent optional module and genuinely empty file storage', async () => {
    modulePresent = false;
    await expect(
      hasStoredExtensionSecrets(NAME, ID, [workspace]),
    ).resolves.toBe(false);
    await expect(
      clearStoredExtensionSecrets(NAME, ID, [workspace]),
    ).resolves.toBeUndefined();
  });

  it('probes and clears file-backed secrets with the optional module absent', async () => {
    modulePresent = false;
    await seed();
    await expect(
      new FileTokenStorage(USER_SERVICE).getSecret('TOKEN'),
    ).resolves.toBe('test-only-sentinel');
    await expect(
      hasStoredExtensionSecrets(NAME, ID, [workspace]),
    ).resolves.toBe(true);
    await clearStoredExtensionSecrets(NAME, ID, [workspace]);
    await expect(
      hasStoredExtensionSecrets(NAME, ID, [workspace]),
    ).resolves.toBe(false);
  });

  it('probes and clears an available keychain backend', async () => {
    await seed();
    await expect(
      hasStoredExtensionSecrets(NAME, ID, [workspace]),
    ).resolves.toBe(true);
    await clearStoredExtensionSecrets(NAME, ID, [workspace]);
    expect(data.get(USER_SERVICE)?.has('__secret__TOKEN')).toBe(false);
    await expect(
      hasStoredExtensionSecrets(NAME, ID, [workspace]),
    ).resolves.toBe(false);
  });

  it('does not prove absence when an available backend cannot enumerate', async () => {
    await seed();
    enumerationAvailable = false;
    await expect(
      hasStoredExtensionSecrets(NAME, ID, [workspace]),
    ).resolves.toBe(true);
    await expect(
      clearStoredExtensionSecrets(NAME, ID, [workspace]),
    ).rejects.toThrow('cannot enumerate');
  });
});
