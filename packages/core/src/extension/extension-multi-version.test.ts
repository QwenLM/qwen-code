/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ExtensionManager, SettingScope } from './extensionManager.js';
import { ExtensionStore } from './extension-store.js';
import {
  ExtensionSettingScope,
  getScopedEnvContents,
  updateSetting,
} from './extensionSettings.js';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function createLocalExtensionSource(
  root: string,
  name: string,
  version: string,
  extra?: Record<string, unknown>,
): Promise<string> {
  const dir = path.join(root, `${name}-${version}`);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'qwen-extension.json'),
    JSON.stringify({ name, version, ...extra }, null, 2),
  );
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe('single-store multi-version extensions', () => {
  async function setupHarness() {
    const root = await makeTempDir('qwen-mv-ext-');
    const qwenHome = path.join(root, '.qwen');
    const extensionsDir = path.join(qwenHome, 'extensions');
    const versionsDir = path.join(qwenHome, 'extension-versions');
    const storeDir = path.join(qwenHome, 'extension-store');
    const sourcesDir = path.join(root, 'sources');
    const wsA = path.join(root, 'ws-a');
    const wsB = path.join(root, 'ws-b');
    const wsC = path.join(root, 'ws-c');
    await Promise.all([
      fs.mkdir(extensionsDir, { recursive: true }),
      fs.mkdir(sourcesDir, { recursive: true }),
      fs.mkdir(wsA, { recursive: true }),
      fs.mkdir(wsB, { recursive: true }),
      fs.mkdir(wsC, { recursive: true }),
    ]);

    const store = new ExtensionStore({
      extensionsDir,
      versionsDir,
      storeDir,
    });
    const makeManager = async (workspaceDir: string) => {
      const manager = new ExtensionManager({
        workspaceDir,
        isWorkspaceTrusted: true,
        extensionStore: store,
        requestConsent: async () => undefined,
        requestSetting: async () => 'test-value',
      });
      await manager.refreshCache();
      return manager;
    };

    return {
      root,
      extensionsDir,
      versionsDir,
      storeDir,
      sourcesDir,
      wsA,
      wsB,
      wsC,
      store,
      makeManager,
    };
  }

  it('coexists global v1 with workspace v2, enforces per-workspace exclusivity and no-fallback', async () => {
    const { extensionsDir, versionsDir, sourcesDir, wsA, wsB, makeManager } =
      await setupHarness();

    const srcV1 = await createLocalExtensionSource(sourcesDir, 'foo', '1.0.0');
    const srcV2 = await createLocalExtensionSource(sourcesDir, 'foo', '2.0.0');

    const mgrA = await makeManager(wsA);
    const v1 = await mgrA.installExtension(
      { type: 'local', source: srcV1 },
      async () => undefined,
      undefined,
      wsA,
      undefined,
      { scope: 'user' },
    );
    expect(v1.path).toBe(path.join(extensionsDir, 'foo'));
    expect(v1.versionSlot).toBeUndefined();

    const mgrB = await makeManager(wsB);
    const v2 = await mgrB.installExtension(
      { type: 'local', source: srcV2 },
      async () => undefined,
      undefined,
      wsB,
      undefined,
      { scope: 'workspace', workspacePath: wsB },
    );
    expect(v2.versionSlot).toBeDefined();
    expect(v2.path.startsWith(path.join(versionsDir, 'foo'))).toBe(true);
    expect(v2.id).not.toBe(v1.id);

    // Primary extensions root stays clean with only the global v1 folder.
    const topLevelDirs = (await fs.readdir(extensionsDir)).filter((entry) =>
      fsSync.statSync(path.join(extensionsDir, entry)).isDirectory(),
    );
    expect(topLevelDirs).toEqual(['foo']);

    // Workspace A runs v1; Workspace B runs strictly v2.
    await mgrA.refreshCache();
    expect(mgrA.getLoadedExtensions()).toHaveLength(1);
    expect(
      mgrA
        .getLoadedExtensions()
        .filter((e) => e.isActive)
        .map((e) => e.version),
    ).toEqual(['1.0.0']);

    await mgrB.refreshCache();
    expect(mgrB.getLoadedExtensions()).toHaveLength(1);
    expect(
      mgrB
        .getLoadedExtensions()
        .filter((e) => e.isActive)
        .map((e) => e.version),
    ).toEqual(['2.0.0']);
    expect(mgrB.getAllLoadedExtensions()).toHaveLength(2);

    // Disabling v2 in Workspace B must NOT fall back to global v1.
    await mgrB.disableExtension('foo', SettingScope.Workspace, wsB);
    await mgrB.refreshCache();
    expect(mgrB.getLoadedExtensions().filter((e) => e.isActive)).toHaveLength(
      0,
    );

    await mgrB.uninstallExtension('foo', false);
    expect(fsSync.existsSync(v2.path)).toBe(false);
    expect(fsSync.existsSync(v1.path)).toBe(true);
    const v3 = await createLocalExtensionSource(sourcesDir, 'foo', '3.0.0');
    await mgrB.installExtension(
      { type: 'local', source: v3 },
      async () => undefined,
      undefined,
      wsB,
      undefined,
      { scope: 'workspace', workspacePath: wsB },
    );
    await mgrB.disableExtension('foo', SettingScope.User, wsB);
    await Promise.all([mgrA.refreshCache(), mgrB.refreshCache()]);
    expect(mgrA.getLoadedExtensions().filter((e) => e.isActive)).toHaveLength(
      1,
    );
    expect(mgrB.getLoadedExtensions().filter((e) => e.isActive)).toHaveLength(
      0,
    );

    await mgrB.enableExtension('foo', SettingScope.Workspace, wsB);
    const reenabled = mgrB.getAllLoadedExtensions().filter((e) => e.isActive);
    expect(reenabled.map((e) => e.version)).toEqual(['3.0.0']);
    await mgrB.disableExtension('foo', SettingScope.Workspace, wsB);
    await mgrB.enableExtension('foo', SettingScope.Workspace, wsB);
    expect(
      mgrB
        .getAllLoadedExtensions()
        .filter((e) => e.isActive)
        .map((e) => e.version),
    ).toEqual(['3.0.0']);
    await mgrA.uninstallExtensionById(v1.id, false);
    await mgrB.disableExtension('foo', SettingScope.User, wsB);
    expect(
      mgrB.getAllLoadedExtensions().filter((e) => e.isActive),
    ).toHaveLength(0);
  });

  it('reuses identical versioned artifacts idempotently across workspaces without duplicating directories', async () => {
    const { versionsDir, sourcesDir, wsA, wsB, wsC, makeManager } =
      await setupHarness();

    const srcV2 = await createLocalExtensionSource(sourcesDir, 'foo', '2.0.0');

    const mgrA = await makeManager(wsA);
    const first = await mgrA.installExtension(
      { type: 'local', source: srcV2 },
      async () => undefined,
      undefined,
      wsA,
      undefined,
      { scope: 'workspace', workspacePath: wsA },
    );

    // Re-installing the exact same version in wsA is idempotent.
    const repeat = await mgrA.installExtension(
      { type: 'local', source: srcV2 },
      async () => undefined,
      undefined,
      wsA,
      undefined,
      { scope: 'workspace', workspacePath: wsA },
    );
    expect(repeat.id).toBe(first.id);

    // Installing the exact same version in wsB reuses the exact same disk directory.
    const mgrB = await makeManager(wsB);
    const second = await mgrB.installExtension(
      { type: 'local', source: srcV2 },
      async () => undefined,
      undefined,
      wsB,
      undefined,
      { scope: 'workspace', workspacePath: wsB },
    );
    expect(second.id).toBe(first.id);
    expect(second.path).toBe(first.path);

    const copiedSrc = path.join(sourcesDir, 'foo-2.0.0-copy');
    await fs.cp(srcV2, copiedSrc, { recursive: true });
    const fooSlots = await fs.readdir(path.join(versionsDir, 'foo'));
    expect(fooSlots).toHaveLength(1);

    const mgrC = await makeManager(wsC);
    const third = await mgrC.installExtension(
      { type: 'local', source: copiedSrc },
      async () => undefined,
      undefined,
      wsC,
      undefined,
      { scope: 'workspace', workspacePath: wsC },
    );
    expect(third.id).toBe(first.id);
    expect(third.path).toBe(first.path);
    expect(await fs.readdir(path.join(versionsDir, 'foo'))).toHaveLength(1);
    expect(mgrC.getLoadedExtensions().filter((e) => e.isActive)).toHaveLength(
      1,
    );
  });

  it('auto-prunes unreferenced versions on switch and reclaims stale workspace refs via prune', async () => {
    const { versionsDir, sourcesDir, wsA, wsB, makeManager } =
      await setupHarness();

    const srcV2 = await createLocalExtensionSource(sourcesDir, 'foo', '2.0.0');
    const srcV3 = await createLocalExtensionSource(sourcesDir, 'foo', '3.0.0');

    const mgrA = await makeManager(wsA);
    const v2 = await mgrA.installExtension(
      { type: 'local', source: srcV2 },
      async () => undefined,
      undefined,
      wsA,
      undefined,
      { scope: 'workspace', workspacePath: wsA },
    );
    expect(fsSync.existsSync(v2.path)).toBe(true);

    // Switching wsA to v3 automatically prunes unreferenced v2.
    const v3 = await mgrA.installExtension(
      { type: 'local', source: srcV3 },
      async () => undefined,
      undefined,
      wsA,
      undefined,
      { scope: 'workspace', workspacePath: wsA },
    );
    expect(fsSync.existsSync(v3.path)).toBe(true);
    expect(fsSync.existsSync(v2.path)).toBe(false);

    const preserved = await mgrA.pruneUnusedVersions({ dryRun: true });
    expect(preserved.pruned).toEqual([]);
    const reused = await fs.readdir(path.join(versionsDir, 'foo'));
    expect(reused).toHaveLength(1);

    // Bind v3 to wsB too, then delete wsA and wsB on disk and prune.
    const mgrB = await makeManager(wsB);
    await mgrB.installExtension(
      { type: 'local', source: srcV3 },
      async () => undefined,
      undefined,
      wsB,
      undefined,
      { scope: 'workspace', workspacePath: wsB },
    );
    await fs.rm(wsA, { recursive: true, force: true });
    await fs.rm(wsB, { recursive: true, force: true });

    const dryRun = await mgrB.pruneUnusedVersions({
      removeMissingWorkspaces: true,
      dryRun: true,
    });
    expect(dryRun.removedWorkspaceRefs).toBe(2);
    expect(dryRun.pruned.map((p) => p.id)).toEqual([v3.id]);
    expect(fsSync.existsSync(v3.path)).toBe(true);

    const pruned = await mgrB.pruneUnusedVersions({
      removeMissingWorkspaces: true,
    });
    expect(pruned.pruned.map((p) => p.id)).toEqual([v3.id]);
    expect(fsSync.existsSync(v3.path)).toBe(false);
    expect(fsSync.existsSync(path.join(versionsDir, 'foo'))).toBe(false);
  });

  it('supports concurrent workspace link branches and per-workspace .env isolation for shared versions', async () => {
    const { sourcesDir, wsA, wsB, makeManager } = await setupHarness();

    const branchA = await createLocalExtensionSource(
      sourcesDir,
      'linked-ext',
      '1.0.0',
      {
        settings: [
          { name: 'Endpoint', description: 'API endpoint', envVar: 'API_URL' },
        ],
      },
    );
    const branchB = await createLocalExtensionSource(
      sourcesDir,
      'linked-ext',
      '1.0.0-exp',
      {
        settings: [
          { name: 'Endpoint', description: 'API endpoint', envVar: 'API_URL' },
        ],
      },
    );

    const mgrA = await makeManager(wsA);
    const linkA = await mgrA.installExtension(
      { type: 'link', source: branchA },
      async () => undefined,
      undefined,
      wsA,
      undefined,
      { scope: 'workspace', workspacePath: wsA },
    );

    const mgrB = await makeManager(wsB);
    const linkB = await mgrB.installExtension(
      { type: 'link', source: branchB },
      async () => undefined,
      undefined,
      wsB,
      undefined,
      { scope: 'workspace', workspacePath: wsB },
    );

    expect(linkA.id).not.toBe(linkB.id);
    await mgrA.refreshCache();
    await mgrB.refreshCache();
    expect(mgrA.getLoadedExtensions().filter((e) => e.isActive)[0]?.path).toBe(
      branchA,
    );
    expect(mgrB.getLoadedExtensions().filter((e) => e.isActive)[0]?.path).toBe(
      branchB,
    );

    // Shared versioned artifact with isolated per-workspace .env files.
    const sharedSrc = await createLocalExtensionSource(
      sourcesDir,
      'shared-cfg',
      '1.0.0',
      {
        settings: [{ name: 'Mode', description: 'Mode', envVar: 'APP_MODE' }],
      },
    );
    const sharedA = await mgrA.installExtension(
      { type: 'local', source: sharedSrc },
      async () => undefined,
      undefined,
      wsA,
      undefined,
      { scope: 'workspace', workspacePath: wsA },
    );
    await mgrB.installExtension(
      { type: 'local', source: sharedSrc },
      async () => undefined,
      undefined,
      wsB,
      undefined,
      { scope: 'workspace', workspacePath: wsB },
    );

    await updateSetting(
      sharedA.config,
      sharedA.id,
      'APP_MODE',
      async () => 'alpha',
      ExtensionSettingScope.WORKSPACE,
      {
        workspaceDir: wsA,
        extensionDir: sharedA.path,
        workspaceEnvFilePath: mgrA.getWorkspaceEnvFilePath(sharedA.id, wsA),
      },
    );
    await updateSetting(
      sharedA.config,
      sharedA.id,
      'APP_MODE',
      async () => 'beta',
      ExtensionSettingScope.WORKSPACE,
      {
        workspaceDir: wsB,
        extensionDir: sharedA.path,
        workspaceEnvFilePath: mgrB.getWorkspaceEnvFilePath(sharedA.id, wsB),
      },
    );

    const envA = await getScopedEnvContents(
      sharedA.config,
      sharedA.id,
      ExtensionSettingScope.WORKSPACE,
      {
        workspaceDir: wsA,
        extensionDir: sharedA.path,
        workspaceEnvFilePath: mgrA.getWorkspaceEnvFilePath(sharedA.id, wsA),
      },
    );
    const envB = await getScopedEnvContents(
      sharedA.config,
      sharedA.id,
      ExtensionSettingScope.WORKSPACE,
      {
        workspaceDir: wsB,
        extensionDir: sharedA.path,
        workspaceEnvFilePath: mgrB.getWorkspaceEnvFilePath(sharedA.id, wsB),
      },
    );
    expect(envA['APP_MODE']).toBe('alpha');
    expect(envB['APP_MODE']).toBe('beta');
    await mgrA.uninstallExtensionById(sharedA.id, false);
    expect(
      fsSync.existsSync(
        path.dirname(mgrA.getWorkspaceEnvFilePath(sharedA.id, wsA)),
      ),
    ).toBe(false);
    expect(fsSync.existsSync(sharedA.path)).toBe(false);
  });
});
