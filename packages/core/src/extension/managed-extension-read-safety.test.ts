/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { Storage } from '../config/storage.js';
import { KeychainTokenStorage } from '../mcp/token-storage/keychain-token-storage.js';
import { WorkspaceContext } from '../utils/workspaceContext.js';
import { getFileReadDefaultPermission } from '../tools/file-read-permission.js';
import { ExtensionConflictError, ExtensionStore } from './extension-store.js';
import type { ExtensionConfig } from './extensionManager.js';
import {
  clearStoredExtensionSecrets,
  ExtensionSettingScope,
  hasStoredExtensionSecrets,
  updateSetting,
} from './extensionSettings.js';
import { resolveManagedExtensionsDir } from './managed-extension-dir.js';

describe('managed extension read safety', () => {
  let root: string;
  let real: string;
  let alias: string;
  const name = 'managed-read-safety';
  const id = 'e5'.repeat(32);
  const config: ExtensionConfig = {
    name,
    version: '1.0.0',
    settings: [
      {
        name: 'Token',
        description: 'test token',
        envVar: 'TOKEN',
        sensitive: true,
      },
    ],
  };

  beforeEach(() => {
    root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-managed-read-safety-')),
    );
    real = path.join(root, 'real');
    alias = path.join(root, 'link');
    fs.mkdirSync(real);
    fs.symlinkSync(
      real,
      alias,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    vi.stubEnv('QWEN_HOME', path.join(root, 'home'));
    vi.stubEnv('QWEN_CODE_FORCE_FILE_STORAGE', 'true');
    vi.spyOn(KeychainTokenStorage.prototype, 'isAvailable').mockResolvedValue(
      false,
    );
    vi.spyOn(KeychainTokenStorage.prototype, 'getKeytar').mockResolvedValue(
      null,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function writeWorkspaceSecret() {
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(real);
    try {
      await updateSetting(
        config,
        id,
        'TOKEN',
        async () => 'test-only-sentinel',
        ExtensionSettingScope.WORKSPACE,
      );
    } finally {
      cwd.mockRestore();
    }
    expect(await hasStoredExtensionSecrets(name, id, [real])).toBe(true);
  }

  it('detects a workspace secret through its symlink spelling', async () => {
    await writeWorkspaceSecret();
    expect(await hasStoredExtensionSecrets(name, id, [alias])).toBe(true);
  });

  it('clears the workspace secret through its symlink spelling', async () => {
    await writeWorkspaceSecret();
    await clearStoredExtensionSecrets(name, id, [alias]);
    expect(await hasStoredExtensionSecrets(name, id, [real])).toBe(false);
  });

  it('refuses adoption through a symlink workspace while a secret exists', async () => {
    const store = new ExtensionStore();
    const before = await store.ensureInitialized([
      { id, name, source: 'managed' },
    ]);
    const destination = path.join(Storage.getUserExtensionsDir(), name);
    fs.mkdirSync(destination, { recursive: true });
    fs.writeFileSync(path.join(destination, '.env'), 'SAVED=old\n');
    await writeWorkspaceSecret();
    const staging = await store.createStagingDirectory();
    fs.writeFileSync(path.join(staging, 'qwen-extension.json'), '{}');
    await expect(
      store.commitArtifact({
        operation: 'install',
        identity: { id: 'e6'.repeat(32), name },
        destinationDirectory: destination,
        stagingDirectory: staging,
        initialActivation: { scope: 'user' },
        allowManagedPolicyAdoption: true,
        adoptionProbeWorkspaceCwds: [alias],
      }),
    ).rejects.toBeInstanceOf(ExtensionConflictError);
    expect(await store.readSnapshot()).toEqual(before);
  });

  it('asks for a path below an unavailable deployment root', () => {
    const managed = path.join(root, 'deployment');
    fs.mkdirSync(managed);
    const pinned = resolveManagedExtensionsDir(managed);
    fs.rmdirSync(managed);
    const degraded = resolveManagedExtensionsDir(pinned, undefined, {
      alreadyResolved: true,
    });
    const runtime = path.join(root, 'runtime');
    fs.mkdirSync(runtime);
    const makeConfig = (managedExtensionsDir?: string) =>
      ({
        getWorkspaceContext: () => new WorkspaceContext(real),
        getTargetDir: () => real,
        getManagedExtensionsDir: () => managedExtensionsDir,
        getPlansDir: () => path.join(runtime, 'plans'),
        storage: {
          getProjectTempDir: () => path.join(runtime, 'tmp'),
          getProjectDir: () => path.join(runtime, 'project'),
          getWorkflowRunsDir: () => path.join(runtime, 'workflows'),
          getUserSkillsDirs: () => [],
        },
      }) as unknown as Config;
    const requested = path.join(managed, 'secret.txt');
    expect(getFileReadDefaultPermission(makeConfig(), requested)).toBe('ask');
    expect(getFileReadDefaultPermission(makeConfig(degraded), requested)).toBe(
      'ask',
    );
  });
});
