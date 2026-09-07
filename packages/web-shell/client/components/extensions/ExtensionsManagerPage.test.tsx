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
});
