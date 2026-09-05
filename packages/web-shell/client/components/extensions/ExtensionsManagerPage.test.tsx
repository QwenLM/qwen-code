/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const state = vi.hoisted(() => {
  const activationHandle = { accepted: true as const, operationId: 'activate' };
  const refreshHandle = { accepted: true as const, operationId: 'refresh' };
  const workspaceHandle = {
    workspaceExtensions: vi.fn(),
    setExtensionActivation: vi.fn(),
    clearExtensionActivation: vi.fn(),
    refreshExtensionRuntime: vi.fn(),
  };
  const client = {
    workspaceByCwd: vi.fn(() => workspaceHandle),
    setExtensionDefaultActivation: vi.fn(),
    waitForExtensionOperation: vi.fn(),
  };
  return {
    activationHandle,
    refreshHandle,
    workspaceHandle,
    client,
    actions: {
      loadExtensionsStatus: vi.fn(),
      activeExtensionOperations: vi.fn(),
      extensionOperationStatus: vi.fn(),
    },
    workspace: {
      workspaceCwd: '/work/primary',
      client,
      capabilities: {
        features: ['extension_activation_explicit_refresh'],
      },
    },
  };
});

vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  useConnection: () => ({ clientId: 'client-1' }),
  useWorkspace: () => state.workspace,
  useWorkspaceActions: () => state.actions,
  useWorkspaceEventSignals: () => undefined,
}));

const { ExtensionsManagerPage } = await import('./ExtensionsManagerPage');
const { I18nProvider } = await import('../../i18n');

let container: HTMLDivElement;
let root: Root;

async function renderPage(): Promise<void> {
  await act(async () => {
    root.render(
      <I18nProvider language="en">
        <ExtensionsManagerPage onClose={vi.fn()} />
      </I18nProvider>,
    );
  });
  await vi.waitFor(() => {
    expect(container.querySelector('[aria-label="Demo"]')).not.toBeNull();
  });
}

function findButton(label: string): HTMLButtonElement {
  const matches = Array.from(
    container.querySelectorAll<HTMLButtonElement>('button'),
  ).filter((button) => button.textContent?.trim() === label);
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

async function chooseActivation(
  scope: 'user' | 'workspace',
  label: string,
): Promise<void> {
  // The detail panel replaces the card list once an extension is selected.
  const card = container.querySelector<HTMLElement>('[aria-label="Demo"]');
  if (card) {
    await act(async () => {
      card.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  }
  const triggers = container.querySelectorAll<HTMLElement>('[role="combobox"]');
  expect(triggers).toHaveLength(2);
  await act(async () => triggers[scope === 'user' ? 0 : 1]!.click());
  const option = Array.from(
    document.body.querySelectorAll<HTMLElement>('[role="option"]'),
  ).find((candidate) => candidate.textContent?.trim() === label);
  expect(option).toBeDefined();
  await act(async () => {
    option!.click();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  state.workspace.capabilities.features = [
    'extension_activation_explicit_refresh',
  ];
  state.workspaceHandle.workspaceExtensions.mockReset().mockResolvedValue({
    v: 1,
    workspaceId: 'primary',
    workspaceCwd: '/work/primary',
    trusted: true,
    desiredGeneration: 1,
    appliedGeneration: 1,
    extensions: [
      {
        extensionId: 'a'.repeat(64),
        name: 'demo',
        version: '1.0.0',
        defaultActivation: 'enabled',
        workspaceActivation: null,
        effectiveActivation: 'enabled',
        activationSource: 'default',
      },
    ],
  });
  state.workspaceHandle.setExtensionActivation
    .mockReset()
    .mockResolvedValue(state.activationHandle);
  state.workspaceHandle.clearExtensionActivation.mockReset();
  state.workspaceHandle.refreshExtensionRuntime
    .mockReset()
    .mockResolvedValue(state.refreshHandle);
  state.client.workspaceByCwd.mockClear();
  state.client.setExtensionDefaultActivation
    .mockReset()
    .mockResolvedValue(state.activationHandle);
  state.client.waitForExtensionOperation.mockReset().mockResolvedValue({
    v: 1,
    operationId: 'activate',
    operation: 'activation',
    status: 'succeeded',
    createdAt: 1,
    updatedAt: 2,
    result: { status: 'disabled', name: 'demo' },
  });
  state.actions.loadExtensionsStatus.mockReset().mockResolvedValue({
    v: 1,
    workspaceCwd: '/work/primary',
    initialized: true,
    extensions: [
      {
        kind: 'extension',
        id: 'a'.repeat(64),
        name: 'demo',
        displayName: 'Demo',
        version: '1.0.0',
        isActive: true,
        path: '/extensions/demo',
        capabilities: {
          mcpServerCount: 0,
          skillCount: 0,
          agentCount: 0,
          hookCount: 0,
          commandCount: 0,
          contextFileCount: 0,
          channelCount: 0,
          hasSettings: false,
        },
      },
    ],
  });
  state.actions.activeExtensionOperations.mockReset().mockResolvedValue({
    v: 1,
    operations: [],
  });
  state.actions.extensionOperationStatus.mockReset();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('ExtensionsManagerPage activation refresh', () => {
  it('submits a workspace refresh without polling or blocking the page', async () => {
    // A refresh that never settles keeps the page busy if it is awaited.
    state.workspaceHandle.refreshExtensionRuntime.mockReturnValue(
      new Promise(() => {}),
    );
    await renderPage();
    await chooseActivation('workspace', 'Disabled');

    // No client id: the workspace-qualified route validates a supplied id
    // against only the targeted runtime, then discards it.
    await vi.waitFor(() => {
      expect(
        state.workspaceHandle.refreshExtensionRuntime,
      ).toHaveBeenCalledWith();
    });
    expect(state.client.waitForExtensionOperation).toHaveBeenCalledOnce();
    expect(state.client.waitForExtensionOperation).toHaveBeenCalledWith(
      state.activationHandle,
    );
    expect(
      container.querySelectorAll<HTMLButtonElement>('[role="combobox"]')[1]!
        .disabled,
    ).toBe(false);
  });

  it('refreshes only the current workspace after a global activation', async () => {
    await renderPage();
    await chooseActivation('user', 'Disabled');

    expect(state.client.setExtensionDefaultActivation).toHaveBeenCalledWith(
      'a'.repeat(64),
      'disabled',
    );
    expect(state.client.workspaceByCwd).toHaveBeenLastCalledWith(
      '/work/primary',
    );
    expect(
      state.workspaceHandle.refreshExtensionRuntime,
    ).toHaveBeenCalledWith();
  });

  it('does not submit an extra refresh to an older daemon', async () => {
    state.workspace.capabilities.features = [];
    await renderPage();
    await chooseActivation('workspace', 'Disabled');

    expect(
      state.workspaceHandle.refreshExtensionRuntime,
    ).not.toHaveBeenCalled();
  });

  it('keeps the newer mutation message when an earlier refresh rejects late', async () => {
    let rejectRefresh: ((error: Error) => void) | undefined;
    state.workspaceHandle.refreshExtensionRuntime.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectRefresh = reject;
      }),
    );
    await renderPage();
    await chooseActivation('workspace', 'Disabled');
    await vi.waitFor(() => {
      expect(state.workspaceHandle.refreshExtensionRuntime).toHaveBeenCalled();
    });

    state.client.waitForExtensionOperation.mockResolvedValue({
      v: 1,
      operationId: 'activate',
      operation: 'activation',
      status: 'failed',
      createdAt: 1,
      updatedAt: 2,
      error: 'boom-later-mutation',
    });
    await chooseActivation('workspace', 'Enabled');
    await vi.waitFor(() => {
      expect(container.textContent).toContain('boom-later-mutation');
    });

    await act(async () => {
      rejectRefresh!(new Error('boom-stale-refresh'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('boom-later-mutation');
    expect(container.textContent).toContain('session refresh failed');
  });

  it('does not adopt an in-flight refresh as a pending mutation', async () => {
    const running = {
      v: 1 as const,
      operationId: 'refresh-1',
      operation: 'refresh',
      status: 'running' as const,
      phase: 'reconciling' as const,
      createdAt: 1,
      updatedAt: 2,
    };
    state.actions.activeExtensionOperations.mockResolvedValue({
      v: 1,
      operations: [running],
    });
    state.actions.extensionOperationStatus.mockResolvedValue(running);
    await renderPage();

    expect(container.textContent).not.toContain('Extension action queued');
    expect(findButton('Add').disabled).toBe(false);

    await chooseActivation('workspace', 'Disabled');
    expect(state.workspaceHandle.setExtensionActivation).toHaveBeenCalledOnce();
  });

  it('keeps the catalog load error when a stale refresh rejects', async () => {
    let rejectRefresh: ((error: Error) => void) | undefined;
    state.workspaceHandle.refreshExtensionRuntime.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectRefresh = reject;
      }),
    );
    await renderPage();
    await chooseActivation('workspace', 'Disabled');
    await vi.waitFor(() => {
      expect(state.workspaceHandle.refreshExtensionRuntime).toHaveBeenCalled();
    });

    // The catalog error banner only renders in the list view.
    await act(async () => {
      findButton('Manage Extensions').click();
    });
    state.actions.loadExtensionsStatus.mockRejectedValue(
      new Error('catalog-reload-failed'),
    );
    await act(async () => {
      findButton('Refresh').click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(container.textContent).toContain('catalog-reload-failed');
    });

    await act(async () => {
      rejectRefresh!(new Error('boom-stale-refresh'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('catalog-reload-failed');
    expect(container.textContent).toContain('session refresh failed');
  });

  it('clears a stale refresh failure when a new activation starts', async () => {
    state.workspaceHandle.refreshExtensionRuntime.mockRejectedValueOnce(
      new Error('refresh unavailable'),
    );
    await renderPage();
    await chooseActivation('workspace', 'Disabled');
    await vi.waitFor(() => {
      expect(container.textContent).toContain('session refresh failed');
    });

    state.workspaceHandle.refreshExtensionRuntime.mockReturnValue(
      new Promise(() => {}),
    );
    await chooseActivation('workspace', 'Enabled');
    expect(container.textContent).not.toContain('session refresh failed');
  });

  it('keeps activation successful when refresh submission fails', async () => {
    state.workspaceHandle.refreshExtensionRuntime.mockRejectedValue(
      new Error('refresh unavailable'),
    );
    await renderPage();
    await chooseActivation('workspace', 'Disabled');

    await vi.waitFor(() => {
      expect(container.textContent).toContain(
        'Extension action succeeded, but session refresh failed: refresh unavailable',
      );
    });
    expect(state.workspaceHandle.setExtensionActivation).toHaveBeenCalledOnce();
    expect(state.client.waitForExtensionOperation).toHaveBeenCalledOnce();
  });
});
