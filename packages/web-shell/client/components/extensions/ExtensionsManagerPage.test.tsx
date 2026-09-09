// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DaemonHttpError } from '@qwen-code/sdk/daemon';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
if (!globalThis.PointerEvent) {
  globalThis.PointerEvent = MouseEvent as typeof PointerEvent;
}
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = () => {};
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {};
}

function click(element: Element): void {
  element.dispatchEvent(
    new PointerEvent('pointerdown', { bubbles: true, button: 0 }),
  );
  element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

const state = vi.hoisted(() => {
  const activationHandle = {
    accepted: true as const,
    operationId: 'activate',
  };
  const refreshHandle = { accepted: true as const, operationId: 'refresh' };
  const workspaceHandle = {
    workspaceExtensions: vi.fn(),
    setExtensionActivation: vi.fn(),
    clearExtensionActivation: vi.fn(),
    refreshExtensionRuntime: vi.fn(),
  };
  const client = {
    workspaceByCwd: vi.fn(),
    setExtensionDefaultActivation: vi.fn(),
    waitForExtensionOperation: vi.fn(),
    extensionCatalog: vi.fn(),
    updateUserExtension: vi.fn(),
    uninstallUserExtension: vi.fn(),
    checkUserExtensionUpdates: vi.fn(),
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
        features: [] as string[],
        workspaces: undefined as
          | Array<{
              id: string;
              cwd: string;
              primary: boolean;
              trusted: boolean;
            }>
          | undefined,
      },
    },
    signals: null as { extensionsVersion: number } | null,
  };
});

vi.mock('@qwen-code/web-shell/daemon-react-sdk', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@qwen-code/web-shell/daemon-react-sdk')
    >();
  return {
    ...actual,
    useConnection: () => ({ clientId: 'client-1' }),
    useWorkspace: () => state.workspace,
    useWorkspaceActions: () => state.actions,
    useWorkspaceEventSignals: () => state.signals,
  };
});

const { ExtensionsManagerPage } = await import('./ExtensionsManagerPage');
const { I18nProvider } = await import('../../i18n');

let container: HTMLDivElement;
let root: Root;

function render(): void {
  root.render(
    <I18nProvider language="en">
      <ExtensionsManagerPage onClose={vi.fn()} />
    </I18nProvider>,
  );
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mountPage() {
  await act(async () => {
    render();
  });
  await flush();
}

async function renderPage(): Promise<void> {
  await act(async () => {
    render();
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
  cardLabel = 'Demo',
): Promise<void> {
  // The detail panel replaces the card list once an extension is selected.
  const card = container.querySelector<HTMLElement>(
    `[aria-label="${cardLabel}"]`,
  );
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

function makeSplitWorkspaceMocks(trusted: boolean) {
  const ensureRuntime = vi.fn(async () => ({}));
  const workspaceRuntimeExtensions = vi.fn(async () => ({
    v: 1,
    workspaceCwd: '/repo/main',
    initialized: true,
    runtimeEpoch: 1,
    extensions: [],
  }));
  const workspaceExtensions = vi.fn(async () => null);
  state.client.workspaceByCwd.mockImplementation(() => ({
    workspaceExtensions,
    ensureRuntime,
    workspaceRuntimeExtensions,
  }));
  state.client.extensionCatalog.mockResolvedValue({
    v: 1,
    generation: 0,
    extensions: [],
  });
  state.workspace.workspaceCwd = '/repo/main';
  state.workspace.capabilities = {
    features: ['workspace_extensions_config_runtime'],
    workspaces: [{ id: 'id-main', cwd: '/repo/main', primary: true, trusted }],
  };
  return {
    ensureRuntime,
    workspaceRuntimeExtensions,
    workspaceExtensions,
    workspaceByCwd: state.client.workspaceByCwd,
    extensionCatalog: state.client.extensionCatalog,
  };
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  state.workspace.workspaceCwd = '/work/primary';
  state.workspace.capabilities = { features: [], workspaces: undefined };
  state.signals = null;
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('ExtensionsManagerPage split-runtime trust gating', () => {
  beforeEach(() => {
    state.actions.loadExtensionsStatus.mockResolvedValue({ extensions: [] });
    state.actions.activeExtensionOperations.mockResolvedValue({
      operations: [],
    });
  });

  it('keeps the legacy loader when the resolved primary workspace is untrusted', async () => {
    const mocks = makeSplitWorkspaceMocks(false);

    await mountPage();

    // The untrusted primary's runtime routes answer 403, so the page must
    // stay on the trust-free legacy catalog read.
    expect(state.actions.loadExtensionsStatus).toHaveBeenCalledOnce();
    expect(mocks.extensionCatalog).not.toHaveBeenCalled();
    expect(mocks.ensureRuntime).not.toHaveBeenCalled();
    expect(mocks.workspaceRuntimeExtensions).not.toHaveBeenCalled();
  });

  it('uses the split runtime loader for a trusted primary workspace', async () => {
    const mocks = makeSplitWorkspaceMocks(true);

    await mountPage();

    await vi.waitFor(() => expect(mocks.ensureRuntime).toHaveBeenCalledOnce());
    expect(mocks.extensionCatalog).toHaveBeenCalled();
    expect(mocks.workspaceRuntimeExtensions).toHaveBeenCalled();
    expect(state.actions.loadExtensionsStatus).not.toHaveBeenCalled();
  });

  it('re-arms the runtime retry when the initial ensure answers a retryable 503', async () => {
    vi.useFakeTimers();
    const mocks = makeSplitWorkspaceMocks(true);
    mocks.ensureRuntime
      .mockRejectedValueOnce(
        new DaemonHttpError(
          503,
          { code: 'runtime_still_starting' },
          'Workspace runtime is still starting',
        ),
      )
      .mockResolvedValue({});

    await mountPage();

    expect(mocks.ensureRuntime).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    await flush();

    expect(mocks.ensureRuntime).toHaveBeenCalledTimes(2);
  });

  it('clears the load-failure notice once the retried load succeeds', async () => {
    vi.useFakeTimers();
    const mocks = makeSplitWorkspaceMocks(true);
    mocks.ensureRuntime
      .mockRejectedValueOnce(
        new DaemonHttpError(
          503,
          { code: 'runtime_still_starting' },
          'Workspace runtime is still starting',
        ),
      )
      .mockResolvedValue({});

    await mountPage();

    expect(container.textContent).toContain(
      'Workspace runtime is still starting',
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    await flush();

    expect(mocks.ensureRuntime).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain(
      'Workspace runtime is still starting',
    );
  });

  it('does not re-arm the runtime retry when the runtime is unavailable', async () => {
    vi.useFakeTimers();
    const mocks = makeSplitWorkspaceMocks(true);
    mocks.ensureRuntime.mockRejectedValue(
      new DaemonHttpError(
        503,
        { code: 'workspace_runtime_unavailable' },
        'Workspace runtime is not active.',
      ),
    );

    await mountPage();

    expect(mocks.ensureRuntime).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    await flush();

    expect(mocks.ensureRuntime).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Workspace runtime is not active.');
  });

  it('does not re-arm the runtime retry when the catalog answers 403', async () => {
    vi.useFakeTimers();
    const mocks = makeSplitWorkspaceMocks(true);
    mocks.ensureRuntime.mockRejectedValueOnce(
      new DaemonHttpError(
        403,
        { code: 'untrusted_workspace' },
        'Workspace is not trusted.',
      ),
    );

    await mountPage();

    expect(mocks.ensureRuntime).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    await flush();

    expect(mocks.ensureRuntime).toHaveBeenCalledTimes(1);
  });

  it('renders an unowned runtime Extension error in the detail view', async () => {
    const mocks = makeSplitWorkspaceMocks(true);
    mocks.ensureRuntime.mockResolvedValue({
      runtimeEpoch: 1,
      capabilities: {
        extensions: {
          state: 'error',
          runtimeEpoch: 1,
          desiredGeneration: 0,
          appliedGeneration: 0,
          error: { message: 'runtime prep exploded' },
        },
      },
    });
    mocks.extensionCatalog.mockResolvedValue({
      v: 1,
      generation: 0,
      extensions: [
        {
          id: 'ext-demo',
          name: 'demo',
          version: '1.0.0',
          defaultActivation: 'enabled',
          workspaceOverrideCount: 0,
          isActive: true,
        },
      ],
    });

    await mountPage();
    await vi.waitFor(() =>
      expect(container.textContent).toContain('runtime prep exploded'),
    );

    // A load-driven runtime error owns no extension; it must stay visible
    // after navigating into the detail view, not render only in the list.
    const row = container.querySelector('[role="button"][aria-label="demo"]');
    expect(row).not.toBeNull();
    await act(async () => {
      click(row!);
      await Promise.resolve();
    });
    expect(container.textContent).toContain('runtime prep exploded');
  });

  it('keeps an owned notice visible when a reload reports a runtime Extension error', async () => {
    const mocks = makeSplitWorkspaceMocks(true);
    mocks.ensureRuntime.mockResolvedValue({
      runtimeEpoch: 1,
      capabilities: {
        extensions: {
          state: 'error',
          runtimeEpoch: 1,
          desiredGeneration: 0,
          appliedGeneration: 0,
          error: { message: 'runtime prep exploded' },
        },
      },
    });
    mocks.extensionCatalog.mockResolvedValue({
      v: 1,
      generation: 0,
      extensions: [
        {
          id: 'ext-demo',
          name: 'demo',
          version: '1.0.0',
          defaultActivation: 'enabled',
          workspaceOverrideCount: 0,
          updateState: 'update available',
          isActive: true,
        },
      ],
    });
    const updateUserExtension = vi.fn(async () => ({}));
    state.client.updateUserExtension = updateUserExtension;

    await mountPage();

    // The initial unowned runtime error reaches the list view.
    await vi.waitFor(() =>
      expect(container.textContent).toContain('runtime prep exploded'),
    );

    // Open the extension detail view.
    const row = container.querySelector('[role="button"][aria-label="demo"]');
    expect(row).not.toBeNull();
    await act(async () => {
      click(row!);
      await Promise.resolve();
    });

    // Start the update action so the notice becomes owned by the selected
    // extension while the reload reports the same capability error.
    const trigger = container.querySelector(
      'button[aria-label="Extension actions"]',
    );
    expect(trigger).not.toBeNull();
    await act(async () => {
      click(trigger!);
      await Promise.resolve();
    });
    const updateItem = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ).find((item) => item.textContent === 'Update Extension');
    expect(updateItem).toBeDefined();
    const catalogReads = mocks.extensionCatalog.mock.calls.length;
    await act(async () => {
      click(updateItem!);
      await Promise.resolve();
    });

    // The reload that follows the mutation re-reads the catalog; once it
    // settles, the runtime error must not have replaced the owned result —
    // the detail view renders only notices it owns.
    await vi.waitFor(() =>
      expect(mocks.extensionCatalog.mock.calls.length).toBeGreaterThan(
        catalogReads,
      ),
    );
    await flush();
    expect(updateUserExtension).toHaveBeenCalledOnce();
    expect(container.textContent).toContain(
      'Extension action queued for "demo".',
    );
    expect(container.textContent).not.toContain('runtime prep exploded');
  });

  it('surfaces a runtime Extension error that arrives after an owned update settles', async () => {
    const mocks = makeSplitWorkspaceMocks(true);
    mocks.ensureRuntime.mockResolvedValue({});
    mocks.extensionCatalog.mockResolvedValue({
      v: 1,
      generation: 0,
      extensions: [
        {
          id: 'ext-demo',
          name: 'demo',
          version: '1.0.0',
          defaultActivation: 'enabled',
          workspaceOverrideCount: 0,
          updateState: 'update available',
          isActive: true,
        },
        {
          id: 'ext-other',
          name: 'other',
          version: '1.0.0',
          defaultActivation: 'enabled',
          workspaceOverrideCount: 0,
        },
      ],
    });
    // No operationId: runMutation settles without polling, through its
    // .finally branch.
    const updateUserExtension = vi.fn(async () => ({}));
    state.client.updateUserExtension = updateUserExtension;

    await mountPage();

    const row = container.querySelector('[role="button"][aria-label="demo"]');
    expect(row).not.toBeNull();
    await act(async () => {
      click(row!);
      await Promise.resolve();
    });
    const trigger = container.querySelector(
      'button[aria-label="Extension actions"]',
    );
    expect(trigger).not.toBeNull();
    await act(async () => {
      click(trigger!);
      await Promise.resolve();
    });
    const updateItem = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ).find((item) => item.textContent === 'Update Extension');
    expect(updateItem).toBeDefined();
    await act(async () => {
      click(updateItem!);
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(container.textContent).toContain(
        'Extension action queued for "demo".',
      ),
    );
    await flush();

    await act(async () => {
      click(findButton('Manage Extensions'));
    });
    await act(async () => {
      click(container.querySelector('[role="button"][aria-label="other"]')!);
    });
    expect(container.textContent).not.toContain(
      'Extension action queued for "demo".',
    );

    // The runtime capability latches to error after the mutation settled;
    // the next signal-driven load must record it in both views.
    mocks.ensureRuntime.mockResolvedValue({
      runtimeEpoch: 1,
      capabilities: {
        extensions: {
          state: 'error',
          runtimeEpoch: 1,
          desiredGeneration: 0,
          appliedGeneration: 0,
          error: { message: 'runtime prep exploded' },
        },
      },
    });
    await act(async () => {
      state.signals = { extensionsVersion: 1 };
      render();
      await Promise.resolve();
    });

    await vi.waitFor(() =>
      expect(container.textContent).toContain('runtime prep exploded'),
    );
    expect(container.textContent).not.toContain(
      'Extension action queued for "demo".',
    );

    // The list view renders the same unowned notice after navigating back.
    await act(async () => {
      click(findButton('Manage Extensions'));
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(container.textContent).toContain('runtime prep exploded'),
    );
  });

  it('surfaces a runtime Extension error that arrives after a polled update settles', async () => {
    const mocks = makeSplitWorkspaceMocks(true);
    mocks.ensureRuntime.mockResolvedValue({});
    mocks.extensionCatalog.mockResolvedValue({
      v: 1,
      generation: 0,
      extensions: [
        {
          id: 'ext-demo',
          name: 'demo',
          version: '1.0.0',
          defaultActivation: 'enabled',
          workspaceOverrideCount: 0,
          updateState: 'update available',
          isActive: true,
        },
      ],
    });
    const updateUserExtension = vi.fn(async () => ({ operationId: 'op-1' }));
    state.client.updateUserExtension = updateUserExtension;
    state.actions.extensionOperationStatus.mockResolvedValue({
      v: 1,
      operationId: 'op-1',
      operation: 'update',
      status: 'succeeded',
      createdAt: 1,
      updatedAt: 2,
    });

    await mountPage();

    const row = container.querySelector('[role="button"][aria-label="demo"]');
    expect(row).not.toBeNull();
    await act(async () => {
      click(row!);
      await Promise.resolve();
    });
    const trigger = container.querySelector(
      'button[aria-label="Extension actions"]',
    );
    expect(trigger).not.toBeNull();
    await act(async () => {
      click(trigger!);
      await Promise.resolve();
    });
    const updateItem = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ).find((item) => item.textContent === 'Update Extension');
    expect(updateItem).toBeDefined();
    await act(async () => {
      click(updateItem!);
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(container.textContent).toContain('Extension "demo" updated.'),
    );
    await flush();

    mocks.ensureRuntime.mockResolvedValue({
      runtimeEpoch: 1,
      capabilities: {
        extensions: {
          state: 'error',
          runtimeEpoch: 1,
          desiredGeneration: 0,
          appliedGeneration: 0,
          error: { message: 'runtime prep exploded' },
        },
      },
    });
    await act(async () => {
      state.signals = { extensionsVersion: 1 };
      render();
      await Promise.resolve();
    });

    await vi.waitFor(() =>
      expect(container.textContent).toContain('runtime prep exploded'),
    );
    expect(container.textContent).not.toContain('Extension "demo" updated.');
  });
});

describe('ExtensionsManagerPage activation refresh', () => {
  beforeEach(() => {
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
    state.client.workspaceByCwd
      .mockReset()
      .mockImplementation(() => state.workspaceHandle);
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

  it.each(['refresh', 'check-updates'])(
    'does not adopt an in-flight %s as a pending mutation',
    async (operation) => {
      const running = {
        v: 1 as const,
        operationId: 'refresh-1',
        operation,
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
      expect(state.actions.extensionOperationStatus).not.toHaveBeenCalled();

      await chooseActivation('workspace', 'Disabled');
      expect(
        state.workspaceHandle.setExtensionActivation,
      ).toHaveBeenCalledOnce();
    },
  );

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

    // A non-activation action retires the banner as well.
    await act(async () => {
      findButton('Manage Extensions').click();
    });
    await act(async () => {
      findButton('Refresh').click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).not.toContain('session refresh failed');

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

  it('skips the session refresh when the workspace is not trusted', async () => {
    state.workspaceHandle.workspaceExtensions.mockResolvedValue({
      v: 1,
      workspaceId: 'primary',
      workspaceCwd: '/work/primary',
      trusted: false,
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
    await renderPage();
    await chooseActivation('user', 'Disabled');

    // The success message renders only after the refresh call site, so a
    // refresh that would happen could not arrive after this assertion.
    await vi.waitFor(() => {
      expect(container.textContent).toContain('Extension "demo" disabled.');
    });
    expect(state.client.setExtensionDefaultActivation).toHaveBeenCalledWith(
      'a'.repeat(64),
      'disabled',
    );
    expect(
      state.workspaceHandle.refreshExtensionRuntime,
    ).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('session refresh failed');
  });

  it('confines the refresh failure banner to the extension that triggered it', async () => {
    state.actions.loadExtensionsStatus.mockResolvedValue({
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
        {
          kind: 'extension',
          id: 'b'.repeat(64),
          name: 'other',
          displayName: 'Other',
          version: '2.0.0',
          isActive: true,
          path: '/extensions/other',
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
    state.workspaceHandle.workspaceExtensions.mockResolvedValue({
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
        {
          extensionId: 'b'.repeat(64),
          name: 'other',
          version: '2.0.0',
          defaultActivation: 'enabled',
          workspaceActivation: null,
          effectiveActivation: 'enabled',
          activationSource: 'default',
        },
      ],
    });
    state.workspaceHandle.refreshExtensionRuntime.mockRejectedValueOnce(
      new Error('refresh unavailable'),
    );
    await renderPage();
    await chooseActivation('workspace', 'Disabled');
    await vi.waitFor(() => {
      expect(container.textContent).toContain('session refresh failed');
    });

    await act(async () => {
      findButton('Manage Extensions').click();
    });
    const otherCard = container.querySelector<HTMLElement>(
      '[aria-label="Other"]',
    );
    expect(otherCard).not.toBeNull();
    await act(async () => {
      otherCard!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await vi.waitFor(() => {
      expect(container.querySelectorAll('[role="combobox"]')).toHaveLength(2);
    });
    expect(container.textContent).not.toContain('session refresh failed');
  });

  it('decides the refresh on the trust the reload observes', async () => {
    await renderPage();

    // Trust is revoked out of band after the page mounted; the reload the
    // activation performs observes it before the refresh decision.
    state.workspaceHandle.workspaceExtensions.mockResolvedValue({
      v: 1,
      workspaceId: 'primary',
      workspaceCwd: '/work/primary',
      trusted: false,
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
    await chooseActivation('user', 'Disabled');

    // The success message renders only after the refresh call site, so a
    // refresh that would happen could not arrive after this assertion.
    await vi.waitFor(() => {
      expect(container.textContent).toContain('Extension "demo" disabled.');
    });
    expect(state.client.setExtensionDefaultActivation).toHaveBeenCalledWith(
      'a'.repeat(64),
      'disabled',
    );
    expect(
      state.workspaceHandle.refreshExtensionRuntime,
    ).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('session refresh failed');
  });

  it('keeps the last known trust when the reload loses the activation projection', async () => {
    state.workspaceHandle.workspaceExtensions.mockResolvedValue({
      v: 1,
      workspaceId: 'primary',
      workspaceCwd: '/work/primary',
      trusted: false,
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
    await renderPage();

    // The post-activation reload loses the projection entirely; the refresh
    // decision must fall back to the remembered trust, not default to
    // trusted.
    state.workspaceHandle.workspaceExtensions.mockRejectedValue(
      new Error('projection-unavailable'),
    );
    await chooseActivation('user', 'Disabled');

    // The success message renders only after the refresh call site, so a
    // refresh that would happen could not arrive after this assertion.
    await vi.waitFor(() => {
      expect(container.textContent).toContain('Extension "demo" disabled.');
    });
    expect(state.client.setExtensionDefaultActivation).toHaveBeenCalledWith(
      'a'.repeat(64),
      'disabled',
    );
    expect(
      state.workspaceHandle.refreshExtensionRuntime,
    ).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('session refresh failed');
  });

  it('keeps the newer refresh failure when a superseded refresh rejects late', async () => {
    state.actions.loadExtensionsStatus.mockResolvedValue({
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
        {
          kind: 'extension',
          id: 'b'.repeat(64),
          name: 'other',
          displayName: 'Other',
          version: '2.0.0',
          isActive: true,
          path: '/extensions/other',
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
    state.workspaceHandle.workspaceExtensions.mockResolvedValue({
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
        {
          extensionId: 'b'.repeat(64),
          name: 'other',
          version: '2.0.0',
          defaultActivation: 'enabled',
          workspaceActivation: null,
          effectiveActivation: 'enabled',
          activationSource: 'default',
        },
      ],
    });
    // Each submission gets its own promise so the two refreshes can fail
    // independently and out of order.
    const rejections: Array<(error: Error) => void> = [];
    state.workspaceHandle.refreshExtensionRuntime.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejections.push(reject);
        }),
    );
    await renderPage();
    await chooseActivation('workspace', 'Disabled');
    await vi.waitFor(() => {
      expect(
        state.workspaceHandle.refreshExtensionRuntime,
      ).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      findButton('Manage Extensions').click();
    });
    const otherCard = container.querySelector<HTMLElement>(
      '[aria-label="Other"]',
    );
    expect(otherCard).not.toBeNull();
    await act(async () => {
      otherCard!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await vi.waitFor(() => {
      expect(container.querySelectorAll('[role="combobox"]')).toHaveLength(2);
    });
    await chooseActivation('workspace', 'Disabled');
    await vi.waitFor(() => {
      expect(
        state.workspaceHandle.refreshExtensionRuntime,
      ).toHaveBeenCalledTimes(2);
    });

    // The newer refresh fails first and owns the banner.
    await act(async () => {
      rejections[1]!(new Error('boom-newer-refresh'));
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(container.textContent).toContain(
        'session refresh failed: boom-newer-refresh',
      );
    });

    // A rejection from the superseded refresh must not evict it.
    await act(async () => {
      rejections[0]!(new Error('boom-superseded-refresh'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain(
      'session refresh failed: boom-newer-refresh',
    );
    expect(container.textContent).not.toContain('boom-superseded-refresh');
  });
});

describe('ExtensionsManagerPage runtime-error gate and degraded reads', () => {
  const catalogWithDemo = {
    v: 1 as const,
    generation: 1,
    extensions: [
      {
        id: 'ext-demo',
        name: 'demo',
        version: '1.0.0',
        defaultActivation: 'enabled' as const,
        workspaceOverrideCount: 0,
        updateState: 'update available' as const,
        isActive: true,
      },
    ],
  };
  const projectionWithDemo = {
    v: 1 as const,
    workspaceId: 'id-main',
    workspaceCwd: '/repo/main',
    trusted: true,
    desiredGeneration: 1,
    appliedGeneration: 1,
    extensions: [
      {
        extensionId: 'ext-demo',
        name: 'demo',
        version: '1.0.0',
        defaultActivation: 'enabled' as const,
        workspaceActivation: null,
        effectiveActivation: 'enabled' as const,
        activationSource: 'default' as const,
      },
    ],
  };
  const runtimeError = {
    runtimeEpoch: 1,
    capabilities: {
      extensions: {
        state: 'error' as const,
        runtimeEpoch: 1,
        desiredGeneration: 0,
        appliedGeneration: 0,
        error: { message: 'runtime prep exploded' },
      },
    },
  };

  beforeEach(() => {
    state.actions.loadExtensionsStatus.mockResolvedValue({ extensions: [] });
    state.actions.activeExtensionOperations.mockResolvedValue({
      operations: [],
    });
    state.actions.extensionOperationStatus.mockReset();
    state.client.setExtensionDefaultActivation.mockReset();
    state.client.waitForExtensionOperation.mockReset();
    state.client.updateUserExtension.mockReset();
    state.client.uninstallUserExtension.mockReset();
    state.client.checkUserExtensionUpdates.mockReset();
  });

  async function mountSplitDemo() {
    const mocks = makeSplitWorkspaceMocks(true);
    mocks.ensureRuntime.mockResolvedValue({});
    mocks.extensionCatalog.mockResolvedValue(catalogWithDemo);
    mocks.workspaceExtensions.mockResolvedValue(projectionWithDemo);
    await mountPage();
    await vi.waitFor(() =>
      expect(
        container.querySelector('[role="button"][aria-label="demo"]'),
      ).not.toBeNull(),
    );
    return mocks;
  }

  async function openDemoDetail() {
    const row = container.querySelector<HTMLElement>(
      '[role="button"][aria-label="demo"]',
    );
    expect(row).not.toBeNull();
    await act(async () => {
      click(row!);
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(container.querySelectorAll('[role="combobox"]')).toHaveLength(2),
    );
  }

  async function openActionsMenu() {
    const trigger = container.querySelector(
      'button[aria-label="Extension actions"]',
    );
    expect(trigger).not.toBeNull();
    await act(async () => {
      click(trigger!);
      await Promise.resolve();
    });
  }

  async function clickMenuItem(text: string) {
    const item = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ).find((candidate) => candidate.textContent === text);
    expect(item).toBeDefined();
    await act(async () => {
      click(item!);
      await Promise.resolve();
    });
  }

  async function flipRuntimeToError(
    mocks: ReturnType<typeof makeSplitWorkspaceMocks>,
  ) {
    mocks.ensureRuntime.mockResolvedValue(runtimeError);
    await act(async () => {
      state.signals = { extensionsVersion: 1 };
      render();
      await Promise.resolve();
    });
  }

  async function expectRuntimeErrorVisible() {
    await vi.waitFor(() =>
      expect(container.textContent).toContain('runtime prep exploded'),
    );
  }

  it('surfaces a runtime error that arrives after an activation settles', async () => {
    const mocks = await mountSplitDemo();
    state.client.setExtensionDefaultActivation.mockResolvedValue(
      state.activationHandle,
    );
    state.client.waitForExtensionOperation.mockResolvedValue({
      v: 1,
      operationId: 'activate',
      operation: 'activation',
      status: 'succeeded',
      createdAt: 1,
      updatedAt: 2,
      result: { status: 'disabled', name: 'demo' },
    });

    await chooseActivation('user', 'Disabled', 'demo');
    await vi.waitFor(() =>
      expect(container.textContent).toContain('Extension "demo" disabled.'),
    );

    // The activation released its notice owner on settle, so a runtime
    // error surfacing now must reach the gate.
    await flipRuntimeToError(mocks);
    await expectRuntimeErrorVisible();
    expect(container.textContent).not.toContain('Extension "demo" disabled.');

    // The unowned notice renders in the list view as well.
    await act(async () => {
      click(findButton('Manage Extensions'));
      await Promise.resolve();
    });
    await expectRuntimeErrorVisible();
  });

  it('surfaces a runtime error that arrives after a check for updates settles', async () => {
    const mocks = await mountSplitDemo();
    state.client.checkUserExtensionUpdates.mockResolvedValue({
      accepted: true,
      operationId: 'check',
    });
    state.client.waitForExtensionOperation.mockResolvedValue({
      v: 1,
      operationId: 'check',
      operation: 'update-check',
      status: 'succeeded',
      createdAt: 1,
      updatedAt: 2,
      result: { states: { demo: 'up to date' } },
    });
    await openDemoDetail();

    await openActionsMenu();
    await clickMenuItem('Check for updates');
    await vi.waitFor(() =>
      expect(container.textContent).toContain('up to date'),
    );

    await flipRuntimeToError(mocks);
    await expectRuntimeErrorVisible();
    expect(container.textContent).not.toContain('up to date');
  });

  it.each([
    {
      outcome: 'waiting_for_input without an interaction',
      operation: {
        v: 1 as const,
        operationId: 'op-1',
        operation: 'update',
        status: 'waiting_for_input' as const,
        createdAt: 1,
        updatedAt: 2,
      },
      failureText: 'Extension operation failed.',
    },
    {
      outcome: 'failed',
      operation: {
        v: 1 as const,
        operationId: 'op-1',
        operation: 'update',
        status: 'failed' as const,
        error: 'update exploded',
        createdAt: 1,
        updatedAt: 2,
      },
      failureText: 'update exploded',
    },
    {
      outcome: 'a 404 poll',
      operation: null,
      failureText: 'operation gone',
    },
  ])(
    'surfaces a runtime error that arrives after a polled mutation ends with $outcome',
    async ({ operation, failureText }) => {
      const mocks = await mountSplitDemo();
      state.client.updateUserExtension.mockResolvedValue({
        operationId: 'op-1',
      });
      if (operation) {
        state.actions.extensionOperationStatus.mockResolvedValue(operation);
      } else {
        state.actions.extensionOperationStatus.mockRejectedValue(
          new DaemonHttpError(404, {}, 'operation gone'),
        );
      }
      await openDemoDetail();

      await openActionsMenu();
      await clickMenuItem('Update Extension');
      await vi.waitFor(() =>
        expect(container.textContent).toContain(failureText),
      );

      await flipRuntimeToError(mocks);
      await expectRuntimeErrorVisible();
    },
  );

  it('surfaces a runtime error that arrives after a polled uninstall fails', async () => {
    const mocks = await mountSplitDemo();
    state.client.uninstallUserExtension.mockResolvedValue({
      operationId: 'op-u',
    });
    state.actions.extensionOperationStatus.mockResolvedValue({
      v: 1,
      operationId: 'op-u',
      operation: 'uninstall',
      status: 'failed',
      error: 'uninstall exploded',
      createdAt: 1,
      updatedAt: 2,
    });
    await openDemoDetail();

    await openActionsMenu();
    await clickMenuItem('Uninstall Extension');
    const confirm = await vi.waitFor(() => {
      const dialog = document.body.querySelector('[role="alertdialog"]');
      expect(dialog).not.toBeNull();
      const button = Array.from(
        dialog!.querySelectorAll<HTMLButtonElement>('button'),
      ).find(
        (candidate) => candidate.textContent?.trim() === 'Uninstall Extension',
      );
      expect(button).toBeDefined();
      return button!;
    });
    await act(async () => {
      click(confirm);
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(container.textContent).toContain('uninstall exploded'),
    );

    await flipRuntimeToError(mocks);
    await expectRuntimeErrorVisible();
  });

  it('keeps the live runtime rows when the projection read fails', async () => {
    const mocks = makeSplitWorkspaceMocks(true);
    mocks.workspaceExtensions.mockResolvedValue(null);
    mocks.extensionCatalog.mockResolvedValue({
      v: 1,
      generation: 1,
      extensions: [
        {
          id: 'ext-demo',
          name: 'demo',
          version: '1.0.0',
          defaultActivation: 'enabled',
          workspaceOverrideCount: 0,
        },
      ],
    });
    mocks.ensureRuntime.mockResolvedValue({
      v: 1,
      workspaceCwd: '/repo/main',
      state: 'idle',
      runtimeLive: true,
      runtimeEpoch: 7,
      capabilities: {
        extensions: {
          state: 'ready',
          revision: 1,
          runtimeEpoch: 7,
          desiredGeneration: 1,
          appliedGeneration: 1,
        },
      },
    });
    mocks.workspaceRuntimeExtensions.mockResolvedValue({
      v: 1,
      workspaceCwd: '/repo/main',
      initialized: true,
      runtimeEpoch: 7,
      extensions: [
        {
          kind: 'extension',
          id: 'ext-demo',
          name: 'demo',
          displayName: 'Demo Display Name',
          description: 'live runtime description',
          version: '1.0.0',
          isActive: false,
          path: '/ext/demo',
          updateState: 'update available',
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
          details: {
            mcpServers: [],
            commands: [],
            skills: ['runtime-skill'],
            agents: [],
            contextFiles: [],
            settings: [],
          },
        },
      ],
    });

    await mountPage();

    // The projection never answered, but the runtime agrees with the
    // coordinator on the epoch: the card must show the live row, not the
    // bare catalog entry with its user-scope default.
    await vi.waitFor(() =>
      expect(
        container.querySelector(
          '[role="button"][aria-label="Demo Display Name"]',
        ),
      ).not.toBeNull(),
    );
    const card = container.querySelector<HTMLElement>(
      '[role="button"][aria-label="Demo Display Name"]',
    );
    expect(card?.textContent).toContain('live runtime description');
    expect(card?.textContent).toContain('disabled');
    expect(card?.textContent).toContain('update available');
    expect(card?.textContent).not.toContain('No description');
  });

  it('does not refresh the runtime after a user-scope toggle on an untrusted secondary', async () => {
    const workspaceExtensions = vi.fn(async () => ({
      v: 1 as const,
      workspaceId: 'id-other',
      workspaceCwd: '/repo/other',
      trusted: false,
      desiredGeneration: 1,
      appliedGeneration: 1,
      extensions: [
        {
          extensionId: 'ext-demo',
          name: 'demo',
          version: '1.0.0',
          defaultActivation: 'enabled' as const,
          workspaceActivation: null,
          effectiveActivation: 'enabled' as const,
          activationSource: 'default' as const,
        },
      ],
    }));
    const ensureRuntime = vi.fn(async () => ({}));
    const workspaceRuntimeExtensions = vi.fn(async () => {
      throw new DaemonHttpError(
        403,
        { code: 'untrusted_workspace' },
        'Workspace is not trusted.',
      );
    });
    const refreshExtensionRuntime = vi.fn(async () => state.refreshHandle);
    state.client.workspaceByCwd.mockImplementation(() => ({
      workspaceExtensions,
      ensureRuntime,
      workspaceRuntimeExtensions,
      refreshExtensionRuntime,
    }));
    state.client.extensionCatalog.mockResolvedValue(catalogWithDemo);
    state.client.setExtensionDefaultActivation.mockResolvedValue(
      state.activationHandle,
    );
    state.client.waitForExtensionOperation.mockResolvedValue({
      v: 1,
      operationId: 'activate',
      operation: 'activation',
      status: 'succeeded',
      createdAt: 1,
      updatedAt: 2,
      result: { status: 'disabled', name: 'demo' },
    });
    state.workspace.capabilities = {
      features: [
        'workspace_extensions_config_runtime',
        'extension_activation_explicit_refresh',
      ],
      workspaces: [
        { id: 'id-main', cwd: '/work/primary', primary: true, trusted: true },
        { id: 'id-other', cwd: '/repo/other', primary: false, trusted: false },
      ],
    };

    await act(async () => {
      root.render(
        <I18nProvider language="en">
          <ExtensionsManagerPage onClose={vi.fn()} workspaceCwd="/repo/other" />
        </I18nProvider>,
      );
    });
    await vi.waitFor(() =>
      expect(
        container.querySelector('[role="button"][aria-label="demo"]'),
      ).not.toBeNull(),
    );

    await chooseActivation('user', 'Disabled', 'demo');

    await vi.waitFor(() =>
      expect(container.textContent).toContain('Extension "demo" disabled.'),
    );
    expect(state.client.setExtensionDefaultActivation).toHaveBeenCalledWith(
      'ext-demo',
      'disabled',
    );
    // The trust-gated runtime catalog answered 403, but the projection had
    // already reported trusted:false — the refresh must stay suppressed.
    expect(refreshExtensionRuntime).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('session refresh failed');
  });

  it('decides the refresh on the trust the activation reload observes, even when the runtime leg fails', async () => {
    let trusted = true;
    let rejectCatalog = false;
    const workspaceExtensions = vi.fn(async () => ({
      v: 1 as const,
      workspaceId: 'id-main',
      workspaceCwd: '/repo/main',
      trusted,
      desiredGeneration: 1,
      appliedGeneration: 1,
      extensions: [
        {
          extensionId: 'ext-demo',
          name: 'demo',
          version: '1.0.0',
          defaultActivation: 'enabled' as const,
          workspaceActivation: null,
          effectiveActivation: 'enabled' as const,
          activationSource: 'default' as const,
        },
      ],
    }));
    const ensureRuntime = vi.fn(async () => ({}));
    const workspaceRuntimeExtensions = vi.fn(async () => {
      if (rejectCatalog) {
        throw new DaemonHttpError(
          403,
          { code: 'untrusted_workspace' },
          'Workspace is not trusted.',
        );
      }
      return {
        v: 1 as const,
        workspaceCwd: '/repo/main',
        initialized: true,
        runtimeEpoch: 1,
        extensions: [],
      };
    });
    const refreshExtensionRuntime = vi.fn(async () => state.refreshHandle);
    state.client.workspaceByCwd.mockImplementation(() => ({
      workspaceExtensions,
      ensureRuntime,
      workspaceRuntimeExtensions,
      refreshExtensionRuntime,
    }));
    state.client.extensionCatalog.mockResolvedValue(catalogWithDemo);
    state.client.setExtensionDefaultActivation.mockResolvedValue(
      state.activationHandle,
    );
    state.client.waitForExtensionOperation.mockResolvedValue({
      v: 1,
      operationId: 'activate',
      operation: 'activation',
      status: 'succeeded',
      createdAt: 1,
      updatedAt: 2,
      result: { status: 'disabled', name: 'demo' },
    });
    state.workspace.capabilities = {
      features: [
        'workspace_extensions_config_runtime',
        'extension_activation_explicit_refresh',
      ],
      workspaces: [
        { id: 'id-main', cwd: '/repo/main', primary: true, trusted: true },
      ],
    };

    await mountPage();
    await vi.waitFor(() =>
      expect(
        container.querySelector('[role="button"][aria-label="demo"]'),
      ).not.toBeNull(),
    );

    // Trust is revoked out of band after the mount; the activation's own
    // reload observes trusted:false from the projection, then the
    // trust-gated runtime leg 403s. The refresh decision must use the
    // freshly observed distrust, not the render-time trusted state.
    trusted = false;
    rejectCatalog = true;
    await chooseActivation('user', 'Disabled', 'demo');

    await vi.waitFor(() =>
      expect(container.textContent).toContain('Extension "demo" disabled.'),
    );
    expect(refreshExtensionRuntime).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('session refresh failed');
  });
});
