/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExtensionStore } from './extension-store.js';
import { ExtensionManager } from './extensionManager.js';
import {
  assertManagedExtensionStateSeparation,
  getVerifiedManagedExtensionsDir,
  resolveManagedExtensionsDir,
} from './managed-extension-dir.js';
import { KeychainTokenStorage } from '../mcp/token-storage/keychain-token-storage.js';

function writePackage(directory: string, name: string) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'qwen-extension.json'),
    JSON.stringify({ name, version: '1.0.0' }),
  );
}

describe('managed extension boundary safety', () => {
  let root: string;
  let workspace: string;
  let managedRoot: string;
  let store: ExtensionStore;
  let enablementPath: string;

  beforeEach(() => {
    root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-managed-boundary-')),
    );
    workspace = path.join(root, 'workspace');
    managedRoot = path.join(root, 'deployment', 'extensions');
    for (const directory of [workspace, managedRoot]) {
      fs.mkdirSync(directory, { recursive: true });
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
    store = new ExtensionStore();
    enablementPath = path.join(
      store.extensionsDir,
      'extension-enablement.json',
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const legacyRule = (directory: string) =>
    `!/${directory.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')}/*`;

  function writeNewerProjection(name: string, rules: string[]) {
    fs.mkdirSync(path.dirname(enablementPath), { recursive: true });
    fs.writeFileSync(
      enablementPath,
      JSON.stringify({ [name]: { overrides: rules } }),
    );
    const future = new Date(Date.now() + 10_000);
    fs.utimesSync(enablementPath, future, future);
  }

  it.each(['scope', 'default', 'batch'] as const)(
    'retains a late legacy projection without a pre-claim stash during a %s change',
    async (change) => {
      const identity = { id: 'f1'.repeat(32), name: 'late-rules' };
      const born = await store.ensureInitialized([
        { ...identity, source: 'managed' },
      ]);
      expect(
        born.extensions[identity.id].preservedLegacyPathRules,
      ).toBeUndefined();
      const rule = legacyRule(workspace);
      writeNewerProjection(identity.name, [rule]);
      const projected = await store.ensureInitialized([
        { ...identity, source: 'managed' },
      ]);
      expect(projected.extensions[identity.id].legacyPathRules).toEqual([rule]);
      if (change === 'scope') {
        await store.setActivationScope(identity, { scope: 'user' });
      } else if (change === 'default') {
        await store.setDefaultActivation(identity, 'enabled', {
          clearLegacyPathRules: true,
        });
      } else {
        await store.setDefaultActivations([identity], 'enabled', {
          clearLegacyPathRulesForManaged: true,
        });
      }
      fs.rmSync(enablementPath);
      const handedBack = await store.ensureInitialized([identity], {
        managedAbsenceProven: true,
      });
      expect(handedBack.extensions[identity.id].managed).toBeUndefined();
      expect(
        store.getActivation(
          handedBack,
          identity.id,
          identity.name,
          path.join(workspace, 'a'),
        ),
      ).toMatchObject({ effective: 'disabled', source: 'legacy_path_rule' });
    },
  );

  it.each([false, true])(
    'keeps the pre-claim stash authoritative with a late projection: %s',
    async (hasLateProjection) => {
      const identity = { id: 'f2'.repeat(32), name: 'claimed-rules' };
      const earlierWorkspace = path.join(root, 'earlier-workspace');
      const earlierRule = legacyRule(earlierWorkspace);
      writeNewerProjection(identity.name, [earlierRule]);
      await store.ensureInitialized([identity]);
      const claimed = await store.ensureInitialized([
        { ...identity, source: 'managed' },
      ]);
      expect(claimed.extensions[identity.id].preservedLegacyPathRules).toEqual([
        earlierRule,
      ]);
      if (hasLateProjection) {
        writeNewerProjection(identity.name, [legacyRule(workspace)]);
        await store.ensureInitialized([{ ...identity, source: 'managed' }]);
      }
      await store.setActivationScope(identity, { scope: 'user' });
      fs.rmSync(enablementPath);
      const handedBack = await store.ensureInitialized([identity], {
        managedAbsenceProven: true,
      });
      expect
        .soft(
          store.getActivation(
            handedBack,
            identity.id,
            identity.name,
            path.join(earlierWorkspace, 'a'),
          ),
        )
        .toMatchObject({ effective: 'disabled', source: 'legacy_path_rule' });
      if (hasLateProjection) {
        expect
          .soft(
            store.getActivation(
              handedBack,
              identity.id,
              identity.name,
              path.join(workspace, 'a'),
            ),
          )
          .toMatchObject({ effective: 'enabled', source: 'default' });
      }
    },
  );

  function manager() {
    return new ExtensionManager({
      workspaceDir: workspace,
      isWorkspaceTrusted: true,
      managedExtensionsDir: managedRoot,
      extensionStore: store,
      requestConsent: async () => undefined,
    });
  }

  it('loads a package from an unchanged pinned root', async () => {
    writePackage(path.join(managedRoot, 'trusted'), 'trusted');
    expect(resolveManagedExtensionsDir(managedRoot)).toBe(managedRoot);
    expect(await manager().loadManagedExtensions(workspace)).toEqual([
      expect.objectContaining({ name: 'trusted', source: 'managed' }),
    ]);
  });

  it('keeps an unavailable pinned root for state-separation checks', () => {
    const pinned = resolveManagedExtensionsDir(managedRoot)!;
    fs.rmSync(managedRoot, { recursive: true });
    expect(
      resolveManagedExtensionsDir(pinned, undefined, { alreadyResolved: true }),
    ).toBe(pinned);
    expect(getVerifiedManagedExtensionsDir(pinned)).toBeUndefined();
    expect(() =>
      assertManagedExtensionStateSeparation(pinned, [
        path.join(pinned, 'state'),
      ]),
    ).toThrow('must not overlap');
    expect(process.stderr.write).toHaveBeenCalledTimes(1);
    resolveManagedExtensionsDir(pinned, undefined, { alreadyResolved: true });
    expect(process.stderr.write).toHaveBeenCalledTimes(1);
  });

  it.each(['missing', 'file'] as const)(
    'retains configuration and reports a %s root as unavailable to loading',
    async (state) => {
      const pinned = resolveManagedExtensionsDir(managedRoot)!;
      const existing = manager();
      fs.rmSync(managedRoot, { recursive: true });
      if (state === 'file') fs.writeFileSync(managedRoot, 'not a directory');
      expect(
        resolveManagedExtensionsDir(pinned, undefined, {
          alreadyResolved: true,
        }),
      ).toBe(pinned);
      expect(getVerifiedManagedExtensionsDir(pinned)).toBeUndefined();
      const onListFailure = vi.fn();
      expect(
        await existing.loadManagedExtensions(workspace, { onListFailure }),
      ).toEqual([]);
      expect(onListFailure).toHaveBeenCalled();
    },
  );

  it.skipIf(process.platform === 'win32').each(['root', 'parent'] as const)(
    'retains configuration but revokes root trust after its %s is relinked, warning once',
    (linkPosition) => {
      const pinned = resolveManagedExtensionsDir(managedRoot)!;
      const target =
        linkPosition === 'root' ? managedRoot : path.dirname(managedRoot);
      const replacement = path.join(root, 'replacement');
      fs.mkdirSync(path.join(replacement, 'extensions'), { recursive: true });
      fs.renameSync(target, `${target}-original`);
      fs.symlinkSync(replacement, target, 'dir');
      expect(getVerifiedManagedExtensionsDir(pinned)).toBeUndefined();
      expect
        .soft(
          resolveManagedExtensionsDir(pinned, undefined, {
            alreadyResolved: true,
          }),
        )
        .toBe(pinned);
      expect.soft(process.stderr.write).toHaveBeenCalledTimes(1);
      resolveManagedExtensionsDir(pinned, undefined, { alreadyResolved: true });
      expect.soft(process.stderr.write).toHaveBeenCalledTimes(1);
    },
  );

  it.skipIf(process.platform === 'win32').each(['root', 'parent'] as const)(
    'does not load packages after an existing manager has its %s relinked',
    async (linkPosition) => {
      resolveManagedExtensionsDir(managedRoot);
      const existing = manager();
      const target =
        linkPosition === 'root' ? managedRoot : path.dirname(managedRoot);
      const replacement = path.join(root, 'replacement');
      const packageRoot =
        linkPosition === 'root'
          ? replacement
          : path.join(replacement, 'extensions');
      writePackage(
        path.join(packageRoot, 'replacement-package'),
        'replacement-package',
      );
      fs.renameSync(target, `${target}-original`);
      fs.symlinkSync(replacement, target, 'dir');
      const onListFailure = vi.fn();
      expect
        .soft(
          await existing.loadManagedExtensions(workspace, { onListFailure }),
        )
        .toEqual([]);
      // A failed root check must not be mistaken for proven deployment withdrawal.
      expect.soft(onListFailure).toHaveBeenCalled();
    },
  );
});
