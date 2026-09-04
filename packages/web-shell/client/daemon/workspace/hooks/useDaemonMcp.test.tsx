/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { actions, client, resource, workspaceClient } = vi.hoisted(() => {
  const workspace = {
    runtimeMcp: vi.fn(),
    ensureRuntime: vi.fn(),
    runtimeStatus: vi.fn(),
    mcpConfig: vi.fn(),
    reloadRuntimeMcp: vi.fn(),
    runtimeMcpTools: vi.fn(),
    runtimeMcpResources: vi.fn(),
    restartRuntimeMcpServer: vi.fn(),
    manageRuntimeMcpServer: vi.fn(),
    setMcpServer: vi.fn(),
    removeMcpServer: vi.fn(),
    setMcpServerEnabled: vi.fn(),
  };
  return {
    actions: {
      loadMcpStatus: vi.fn(),
      ensureRuntime: vi.fn(),
      loadMcpConfig: vi.fn(),
      initializeMcp: vi.fn(),
      reloadMcp: vi.fn(),
      loadMcpTools: vi.fn(),
      loadMcpResources: vi.fn(),
      restartMcpServer: vi.fn(),
      manageMcpServer: vi.fn(),
      addRuntimeMcpServer: vi.fn(),
      removeRuntimeMcpServer: vi.fn(),
      setMcpServer: vi.fn(),
      removeMcpServer: vi.fn(),
      setMcpServerEnabled: vi.fn(),
    },
    client: {
      workspaceByCwd: vi.fn(() => workspace),
      setUserMcpServerEnabled: vi.fn(),
    },
    resource: {
      data: undefined,
      loading: false,
      error: undefined,
      reload: vi.fn(),
    },
    workspaceClient: workspace,
  };
});

vi.mock('../DaemonWorkspaceProvider.js', () => ({
  useDaemonWorkspace: () => ({
    actions,
    client,
    workspaceCwd: '/workspace',
  }),
}));
vi.mock('../../session/DaemonSessionProvider.js', () => ({
  useDaemonWorkspaceEventSignals: () => undefined,
}));
vi.mock('./useDaemonResource.js', () => ({
  useDaemonResource: () => resource,
}));
vi.mock('./useWorkspaceEventReload.js', () => ({
  useWorkspaceEventReload: () => undefined,
}));

const { useDaemonMcp } = await import('./useDaemonMcp.js');

describe('useDaemonMcp', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('keeps action identities stable across renders', async () => {
    let current: ReturnType<typeof useDaemonMcp> | undefined;
    function TestComponent() {
      current = useDaemonMcp({ autoLoad: false });
      return null;
    }
    await act(async () => root.render((<TestComponent />) as ReactNode));
    const first = current;
    await act(async () => root.render((<TestComponent />) as ReactNode));

    expect(current?.initialize).toBe(first?.initialize);
    expect(current?.reloadConfig).toBe(first?.reloadConfig);
    expect(current?.reload).toBe(first?.reload);
    expect(current?.loadTools).toBe(first?.loadTools);
  });

  it('uses own properties when selecting a config scope', async () => {
    workspaceClient.mcpConfig.mockResolvedValue({
      user: { constructor: { command: 'user-server' } },
      workspace: {},
    });
    client.setUserMcpServerEnabled.mockResolvedValue({ changed: true });
    let current: ReturnType<typeof useDaemonMcp> | undefined;
    function TestComponent() {
      current = useDaemonMcp({
        autoLoad: false,
        workspaceCwd: '/workspace',
      });
      return null;
    }
    await act(async () => root.render((<TestComponent />) as ReactNode));
    await current?.manageServer('constructor', 'disable');

    expect(client.setUserMcpServerEnabled).toHaveBeenCalledWith(
      'constructor',
      false,
    );
    expect(workspaceClient.setMcpServerEnabled).not.toHaveBeenCalled();
  });
});
