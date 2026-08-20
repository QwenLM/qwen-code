/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
import { render } from 'ink-testing-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import {
  ExtensionUpdateState,
  SettingScope,
  type Config,
  type Extension,
} from '@qwen-code/qwen-code-core';
import type { StatusMessage } from '../ExtensionsManagerDialog.js';
import type { PluginDetailAction } from './PluginDetailView.js';
import { ExtensionActionsView } from './ExtensionActionsView.js';

const mockPluginDetailView = vi.hoisted(() => vi.fn((_props: unknown) => null));
const mockRadioButtonSelect = vi.hoisted(() =>
  vi.fn((_props: unknown) => null),
);
const mockUninstallConfirmStep = vi.hoisted(() =>
  vi.fn((_props: unknown) => null),
);

vi.mock('../../../hooks/useKeypress.js', () => ({
  useKeypress: vi.fn(),
}));

vi.mock('./PluginDetailView.js', () => ({
  PluginDetailView: mockPluginDetailView,
}));

vi.mock('../../shared/RadioButtonSelect.js', () => ({
  RadioButtonSelect: mockRadioButtonSelect,
}));

vi.mock('../steps/UninstallConfirmStep.js', () => ({
  UninstallConfirmStep: mockUninstallConfirmStep,
}));

interface DetailProps {
  onAction: (action: PluginDetailAction) => void;
}

interface SelectProps {
  onSelect: (scope: 'user' | 'project') => void;
}

interface ConfirmProps {
  onConfirm: (extension: Extension) => void;
}

const extension = {
  id: 'demo-id',
  name: 'demo',
  version: '1.0.0',
  path: '/extensions/demo',
  isActive: true,
  installMetadata: { type: 'git', source: 'owner/demo' },
  mcpServers: {},
  commands: [],
  skills: [],
  agents: [],
  resolvedSettings: [],
  config: {},
  contextFiles: [],
} as unknown as Extension;

function createManager() {
  return {
    isFavorite: vi.fn(() => false),
    getExtensionScope: vi.fn(() => 'user' as const),
    setExtensionActivationScope: vi.fn().mockResolvedValue({ warnings: [] }),
    setExtensionScope: vi.fn(),
    disableExtension: vi.fn().mockResolvedValue({ warnings: [] }),
    enableExtension: vi.fn().mockResolvedValue({ warnings: [] }),
    checkForExtensionUpdate: vi
      .fn()
      .mockResolvedValue(ExtensionUpdateState.UPDATE_AVAILABLE),
    updateExtension: vi.fn().mockResolvedValue({ warnings: [] }),
    uninstallExtension: vi.fn().mockResolvedValue({ warnings: [] }),
  };
}

function renderView(
  manager: ReturnType<typeof createManager>,
  onStatus: (status: StatusMessage | null) => void,
  onReload = vi.fn(),
  onExit = vi.fn(),
) {
  const config = {
    getExtensionManager: () => manager,
  } as unknown as Config;
  render(
    <ExtensionActionsView
      config={config}
      extension={extension}
      isActive
      onStatus={onStatus}
      onReload={onReload}
      onExit={onExit}
    />,
  );
  return { onReload, onExit };
}

async function openScopeSelect(): Promise<SelectProps> {
  const detail = mockPluginDetailView.mock.calls.at(-1)?.[0] as
    | DetailProps
    | undefined;
  await act(async () => {
    detail?.onAction('change-scope');
  });
  return mockRadioButtonSelect.mock.calls.at(-1)?.[0] as unknown as SelectProps;
}

describe('ExtensionActionsView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('commits a scope change atomically and surfaces committed warnings', async () => {
    const manager = createManager();
    manager.setExtensionActivationScope.mockResolvedValueOnce({
      warnings: [
        { code: 'extension_runtime_refresh_failed', error: 'refresh failed' },
      ],
    });
    const statuses: Array<StatusMessage | null> = [];
    const { onReload } = renderView(manager, (status) => statuses.push(status));
    const select = await openScopeSelect();

    await act(async () => {
      select.onSelect('project');
    });

    await waitFor(() =>
      expect(manager.setExtensionActivationScope).toHaveBeenCalledWith(
        'demo-id',
        { scope: 'workspace', workspacePath: process.cwd() },
      ),
    );
    expect(manager.setExtensionScope).toHaveBeenCalledWith('demo', 'project');
    expect(onReload).toHaveBeenCalledOnce();
    expect(statuses).toContainEqual({
      type: 'warning',
      text: 'Set "demo" scope with warnings: refresh failed',
    });
  });

  it('does not update scope preferences when the atomic mutation fails', async () => {
    const manager = createManager();
    manager.setExtensionActivationScope.mockRejectedValueOnce(
      new Error('scope failed'),
    );
    const statuses: Array<StatusMessage | null> = [];
    const { onReload } = renderView(manager, (status) => statuses.push(status));
    const select = await openScopeSelect();

    await act(async () => {
      select.onSelect('project');
    });

    await waitFor(() =>
      expect(statuses).toContainEqual({
        type: 'error',
        text: 'scope failed',
      }),
    );
    expect(manager.setExtensionScope).not.toHaveBeenCalled();
    expect(onReload).not.toHaveBeenCalled();
  });

  it('reloads committed scope changes when saving the preference fails', async () => {
    const manager = createManager();
    manager.setExtensionActivationScope.mockResolvedValueOnce({});
    manager.setExtensionScope.mockImplementationOnce(() => {
      throw new Error('preference denied');
    });
    const statuses: Array<StatusMessage | null> = [];
    const { onReload } = renderView(manager, (status) => statuses.push(status));
    const select = await openScopeSelect();

    await act(async () => {
      select.onSelect('project');
    });

    await waitFor(() => expect(onReload).toHaveBeenCalledOnce());
    expect(statuses).toContainEqual({
      type: 'warning',
      text: 'Set "demo" scope with warnings: preference denied',
    });
  });

  it('surfaces committed activation warnings and reloads the view', async () => {
    const manager = createManager();
    manager.disableExtension.mockResolvedValueOnce({
      warnings: [
        { code: 'extension_runtime_refresh_failed', error: 'refresh failed' },
      ],
    });
    const statuses: Array<StatusMessage | null> = [];
    const { onReload } = renderView(manager, (status) => statuses.push(status));
    const detail = mockPluginDetailView.mock.calls.at(-1)?.[0] as
      | DetailProps
      | undefined;

    await act(async () => {
      await detail?.onAction('toggle');
    });

    expect(manager.disableExtension).toHaveBeenCalledWith(
      'demo',
      SettingScope.User,
    );
    expect(onReload).toHaveBeenCalledOnce();
    expect(statuses).toContainEqual({
      type: 'warning',
      text: '"demo" changed with warnings: refresh failed',
    });
  });

  it('surfaces update warnings distinctly and reloads the view', async () => {
    const manager = createManager();
    manager.updateExtension.mockResolvedValueOnce({
      warnings: [
        {
          code: 'extension_settings_legacy_sync_failed',
          error: 'keychain unavailable',
        },
      ],
    });
    const statuses: Array<StatusMessage | null> = [];
    const { onReload } = renderView(manager, (status) => statuses.push(status));
    const detail = mockPluginDetailView.mock.calls.at(-1)?.[0] as
      | DetailProps
      | undefined;

    await act(async () => {
      await detail?.onAction('update');
    });

    expect(onReload).toHaveBeenCalledOnce();
    expect(statuses).toContainEqual({
      type: 'warning',
      text: 'Updated "demo" with warnings: extension_settings_legacy_sync_failed: keychain unavailable.',
    });
  });

  it('surfaces committed uninstall warnings and reloads before exiting', async () => {
    const manager = createManager();
    manager.uninstallExtension.mockResolvedValueOnce({
      warnings: [
        { code: 'extension_runtime_refresh_failed', error: 'refresh failed' },
      ],
    });
    const statuses: Array<StatusMessage | null> = [];
    const { onReload, onExit } = renderView(manager, (status) =>
      statuses.push(status),
    );
    const detail = mockPluginDetailView.mock.calls.at(-1)?.[0] as
      | DetailProps
      | undefined;
    await act(async () => {
      detail?.onAction('uninstall');
    });
    const confirm = mockUninstallConfirmStep.mock.calls.at(-1)?.[0] as
      | ConfirmProps
      | undefined;

    await act(async () => {
      await confirm?.onConfirm(extension);
    });

    expect(manager.uninstallExtension).toHaveBeenCalledWith('demo', false);
    expect(onReload).toHaveBeenCalledOnce();
    expect(onExit).toHaveBeenCalledOnce();
    expect(statuses).toContainEqual({
      type: 'warning',
      text: 'Uninstalled "demo" with warnings: refresh failed',
    });
  });
});
