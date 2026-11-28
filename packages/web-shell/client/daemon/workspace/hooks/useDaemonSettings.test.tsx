// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const actions = vi.hoisted(() => ({
  loadSettingsStatus: vi.fn(),
  setWorkspaceSetting: vi.fn(),
}));
const scopedHandle = vi.hoisted(() => ({
  workspaceSettings: vi.fn(),
  setWorkspaceSetting: vi.fn(),
}));
const client = vi.hoisted(() => ({
  workspaceByCwd: vi.fn(() => scopedHandle),
}));

vi.mock('../DaemonWorkspaceProvider.js', () => ({
  useDaemonWorkspace: () => ({ actions, client }),
}));
vi.mock('../../session/DaemonSessionProvider.js', () => ({
  useDaemonWorkspaceEventSignals: () => undefined,
}));

const { useDaemonSettings } = await import('./useDaemonSettings.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useDaemonSettings', () => {
  it('loads and writes workspace-scoped settings via workspaceByCwd while routing user scope to primary actions', async () => {
    scopedHandle.workspaceSettings.mockResolvedValue({
      v: 1,
      settings: [],
    });
    scopedHandle.setWorkspaceSetting.mockResolvedValue({
      ok: true,
      key: 'general.vimMode',
      scope: 'workspace',
      value: true,
      requiresRestart: false,
    });
    actions.setWorkspaceSetting.mockResolvedValue({
      ok: true,
      key: 'general.vimMode',
      scope: 'user',
      value: false,
      requiresRestart: false,
    });

    let hook: ReturnType<typeof useDaemonSettings> | undefined;
    function Probe() {
      hook = useDaemonSettings({ workspaceCwd: '/secondary', autoLoad: true });
      return null;
    }

    const root = createRoot(document.createElement('div'));
    await act(async () => {
      root.render(<Probe />);
    });

    expect(client.workspaceByCwd).toHaveBeenCalledWith('/secondary');
    expect(scopedHandle.workspaceSettings).toHaveBeenCalledTimes(1);
    expect(actions.loadSettingsStatus).not.toHaveBeenCalled();

    await hook!.setValue('workspace', 'general.vimMode', true);
    expect(scopedHandle.setWorkspaceSetting).toHaveBeenCalledWith(
      'workspace',
      'general.vimMode',
      true,
    );
    expect(actions.setWorkspaceSetting).not.toHaveBeenCalled();

    await hook!.setValue('user', 'general.vimMode', false);
    expect(actions.setWorkspaceSetting).toHaveBeenCalledWith(
      'user',
      'general.vimMode',
      false,
    );

    await act(async () => {
      root.unmount();
    });
  });
});
