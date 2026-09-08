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

const { actions, workspaceState } = vi.hoisted(() => ({
  actions: {
    loadExtensionsStatus: vi.fn(),
    activeExtensionOperations: vi.fn(),
  },
  workspaceState: {
    current: undefined as
      | undefined
      | {
          workspaceCwd: string;
          capabilities: {
            features: string[];
            workspaces?: Array<{
              id: string;
              cwd: string;
              primary: boolean;
              trusted: boolean;
            }>;
          };
          client: {
            extensionCatalog: ReturnType<typeof vi.fn>;
            workspaceByCwd: ReturnType<typeof vi.fn>;
            updateUserExtension?: ReturnType<typeof vi.fn>;
          };
        },
  },
}));

vi.mock('@qwen-code/web-shell/daemon-react-sdk', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@qwen-code/web-shell/daemon-react-sdk')
    >();
  return {
    ...actual,
    useConnection: () => ({ clientId: 'client-1' }),
    useWorkspace: () => workspaceState.current,
    useWorkspaceActions: () => actions,
    useWorkspaceEventSignals: () => null,
  };
});

const { ExtensionsManagerPage } = await import('./ExtensionsManagerPage');
const { I18nProvider } = await import('../../i18n');

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mountPage() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <I18nProvider language="en">
        <ExtensionsManagerPage onClose={vi.fn()} />
      </I18nProvider>,
    );
  });
  await flush();
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  workspaceState.current = undefined;
  vi.clearAllMocks();
  vi.useRealTimers();
});

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
  const workspaceByCwd = vi.fn(() => ({
    workspaceExtensions,
    ensureRuntime,
    workspaceRuntimeExtensions,
  }));
  const extensionCatalog = vi.fn(async () => ({
    v: 1,
    generation: 0,
    extensions: [],
  }));
  workspaceState.current = {
    workspaceCwd: '/repo/main',
    capabilities: {
      features: ['workspace_extensions_config_runtime'],
      workspaces: [
        { id: 'id-main', cwd: '/repo/main', primary: true, trusted },
      ],
    },
    client: { extensionCatalog, workspaceByCwd },
  };
  return {
    ensureRuntime,
    workspaceRuntimeExtensions,
    workspaceExtensions,
    workspaceByCwd,
    extensionCatalog,
  };
}

describe('ExtensionsManagerPage split-runtime trust gating', () => {
  beforeEach(() => {
    actions.loadExtensionsStatus.mockResolvedValue({ extensions: [] });
    actions.activeExtensionOperations.mockResolvedValue({ operations: [] });
  });

  it('keeps the legacy loader when the resolved primary workspace is untrusted', async () => {
    const mocks = makeSplitWorkspaceMocks(false);

    await mountPage();

    // The untrusted primary's runtime routes answer 403, so the page must
    // stay on the trust-free legacy catalog read.
    expect(actions.loadExtensionsStatus).toHaveBeenCalledOnce();
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
    expect(actions.loadExtensionsStatus).not.toHaveBeenCalled();
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

    expect(container!.textContent).toContain(
      'Workspace runtime is still starting',
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    await flush();

    expect(mocks.ensureRuntime).toHaveBeenCalledTimes(2);
    expect(container!.textContent).not.toContain(
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
    expect(container!.textContent).toContain(
      'Workspace runtime is not active.',
    );
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
      expect(container!.textContent).toContain('runtime prep exploded'),
    );

    // A load-driven runtime error owns no extension; it must stay visible
    // after navigating into the detail view, not render only in the list.
    const row = container!.querySelector('[role="button"][aria-label="demo"]');
    expect(row).not.toBeNull();
    await act(async () => {
      click(row!);
      await Promise.resolve();
    });
    expect(container!.textContent).toContain('runtime prep exploded');
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
    workspaceState.current!.client.updateUserExtension = updateUserExtension;

    await mountPage();

    // The initial unowned runtime error reaches the list view.
    await vi.waitFor(() =>
      expect(container!.textContent).toContain('runtime prep exploded'),
    );

    // Open the extension detail view.
    const row = container!.querySelector('[role="button"][aria-label="demo"]');
    expect(row).not.toBeNull();
    await act(async () => {
      click(row!);
      await Promise.resolve();
    });

    // Start the update action so the notice becomes owned by the selected
    // extension while the reload reports the same capability error.
    const trigger = container!.querySelector(
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
    expect(container!.textContent).toContain(
      'Extension action queued for "demo".',
    );
    expect(container!.textContent).not.toContain('runtime prep exploded');
  });
});
