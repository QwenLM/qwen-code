/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
// @vitest-environment jsdom

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { act } from 'react';
import { render } from 'ink-testing-library';
import { waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core';
import { ExtensionManager } from '@qwen-code/qwen-code-core/extension/extensionManager.js';
import { ExtensionStore } from '@qwen-code/qwen-code-core/extension/extension-store.js';
import {
  ExtensionSettingScope,
  getScopedEnvContents,
  updateSetting,
} from '@qwen-code/qwen-code-core/extension/extensionSettings.js';
import { KeychainTokenStorage } from '@qwen-code/qwen-code-core/mcp/token-storage/keychain-token-storage.js';
import { InstalledTab } from './InstalledTab.js';
import { SourcesTab } from './SourcesTab.js';

vi.mock('../../../hooks/useKeypress.js', () => ({ useKeypress: vi.fn() }));
vi.mock('../../../hooks/useTerminalSize.js', () => ({
  useTerminalSize: () => ({ rows: 24, columns: 80 }),
}));

const name = 'dialog-managed-read';
const token = 'test-only-dialog-sentinel';
const packageConfig = {
  name,
  version: '1.0.0',
  settings: [
    {
      name: 'Token',
      description: 'Test token',
      envVar: 'TOKEN',
      sensitive: true,
    },
  ],
};

function writePackage(directory: string) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'qwen-extension.json'),
    JSON.stringify(packageConfig),
  );
}

describe('dialog managed ownership read safety', () => {
  let root: string;
  let workspace: string;
  let managedRoot: string;
  let unmount: (() => void) | undefined;

  beforeEach(() => {
    root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-dialog-read-')),
    );
    workspace = path.join(root, 'workspace');
    managedRoot = path.join(root, 'deployment');
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(managedRoot, { recursive: true });
    vi.stubEnv('QWEN_HOME', path.join(root, 'home'));
    vi.stubEnv('QWEN_CODE_FORCE_FILE_STORAGE', 'true');
    vi.spyOn(KeychainTokenStorage.prototype, 'isAvailable').mockResolvedValue(
      false,
    );
    vi.spyOn(process, 'cwd').mockReturnValue(workspace);
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    unmount?.();
    unmount = undefined;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const manager = () =>
    new ExtensionManager({
      managedExtensionsDir: managedRoot,
      workspaceDir: workspace,
      isWorkspaceTrusted: true,
      requestConsent: async () => undefined,
    });

  async function withdrawnManaged() {
    const deployed = path.join(managedRoot, 'package');
    writePackage(deployed);
    writePackage(path.join(root, 'home', 'extensions', 'user-copy'));
    const initial = manager();
    await initial.refreshCache();
    const managed = initial
      .getLoadedExtensions()
      .find((extension) => extension.name === name)!;
    expect(managed.source).toBe('managed');
    await initial.setExtensionDefaultActivation(managed.id, 'disabled');
    await updateSetting(
      packageConfig,
      managed.id,
      'TOKEN',
      async () => token,
      ExtensionSettingScope.USER,
    );
    expect(
      (
        await getScopedEnvContents(
          packageConfig,
          managed.id,
          ExtensionSettingScope.USER,
        )
      )['TOKEN'],
    ).toBe(token);
    fs.rmSync(deployed, { recursive: true });
    return managed.id;
  }

  async function state(id: string) {
    const policies = Object.values(
      (await new ExtensionStore().readSnapshot()).extensions,
    );
    return {
      policy: policies.find((policy) => policy.name === name),
      token: (
        await getScopedEnvContents(
          packageConfig,
          id,
          ExtensionSettingScope.USER,
        )
      )['TOKEN'],
    };
  }

  it.each(['InstalledTab', 'SourcesTab'] as const)(
    'opening %s preserves retained managed policy and file-backed credential',
    async (tab) => {
      const id = await withdrawnManaged();
      const before = await state(id);
      const subject = manager();
      const refresh = vi.spyOn(subject, 'refreshCache');
      const config = {
        getExtensionManager: () => subject,
        getMcpServers: () => ({}),
        getToolRegistry: () => undefined,
      } as unknown as Config;
      const content = (reloadSignal: number) =>
        tab === 'InstalledTab' ? (
          <InstalledTab
            config={config}
            isActive
            onLockChange={vi.fn()}
            onStatus={vi.fn()}
            extensionsUpdateState={new Map()}
            reloadSignal={reloadSignal}
          />
        ) : (
          <SourcesTab
            config={config}
            isActive
            onLockChange={vi.fn()}
            onStatus={vi.fn()}
            onChanged={vi.fn()}
            onBrowse={vi.fn()}
            onFooter={vi.fn()}
            reloadSignal={reloadSignal}
          />
        );
      const view = render(content(0));
      unmount = () => {
        view.unmount();
        view.cleanup();
      };
      await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
      await act(async () => {
        await refresh.mock.results[0]?.value;
      });
      if (tab === 'InstalledTab')
        await waitFor(() => expect(view.lastFrame()).toContain(name));
      expect(subject.getLoadedExtensions()).toEqual([
        expect.objectContaining({ name, source: 'user', isActive: true }),
      ]);
      const after = await state(id);
      expect(after.policy).toMatchObject({
        managed: true,
        defaultActivation: 'disabled',
        preservedDefaultActivation: 'enabled',
      });
      expect(after.token).toBe(token);
      expect(after.policy).toEqual(before.policy);
      view.rerender(content(1));
      await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
      await act(async () => {
        await refresh.mock.results[1]?.value;
      });
      const reloaded = await state(id);
      expect(reloaded.policy).toEqual(after.policy);
      expect(reloaded.token).toBe(token);
      expect(subject.getLoadedExtensions()).toEqual([
        expect.objectContaining({ name, source: 'user', isActive: true }),
      ]);
    },
  );

  it('explicit read-only refresh preserves policy and credential (paired control)', async () => {
    const id = await withdrawnManaged();
    const subject = manager();
    await subject.refreshCache({ allowManagedHandBack: false });
    const after = await state(id);
    expect(after.policy?.managed).toBe(true);
    expect(after.token).toBe(token);
  });

  it('normal runtime refresh still commits hand-back and cleanup (paired control)', async () => {
    const id = await withdrawnManaged();
    const subject = manager();
    await subject.refreshCache();
    const after = await state(id);
    expect(after.policy?.managed).not.toBe(true);
    expect(after.token).toBeUndefined();
  });
});
