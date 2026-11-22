// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '../i18n';
import { WebShellPortalRootContext } from '../portalRoot';
import { TOUCH_COMPOSER_QUERY } from './useIsTouchComposer';
import { publishSidechannelRemotePrompt } from '../daemon/remotePromptSidechannel';
import type {
  DaemonInputHistoryResult,
  DaemonWorkspaceContextValue,
} from '../daemon/workspace/types';
import { ComposerWorkspaceProvider } from './useComposerWorkspace';
import {
  useComposerCore,
  type UseComposerCoreOptions,
  type UseComposerCoreReturn,
} from './useComposerCore';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let currentWorkspace:
  | {
      workspaceCwd?: string;
      capabilities?: {
        features?: string[];
        workspaces?: Array<{
          id: string;
          cwd: string;
          primary?: boolean;
          trusted?: boolean;
        }>;
      };
      actions?: {
        loadInputHistory?: ReturnType<typeof vi.fn>;
        recordInputHistory?: ReturnType<typeof vi.fn>;
      };
      client: {
        workspaceByCwd: ReturnType<typeof vi.fn>;
      };
    }
  | undefined;

function makeFakeClient() {
  return {
    workspaceByCwd: vi.fn(() => ({
      globWorkspace: vi.fn(),
      readWorkspaceFileBytes: vi.fn(),
      statWorkspaceFile: vi.fn(),
      listWorkspaceDirectory: vi.fn(),
    })),
  };
}

const originalMatchMedia = window.matchMedia;
const originalMaxTouchPoints = Object.getOwnPropertyDescriptor(
  Navigator.prototype,
  'maxTouchPoints',
);

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let latest: UseComposerCoreReturn | null = null;

function mockTouchDevice() {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query === TOUCH_COMPOSER_QUERY,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => true,
  })) as unknown as typeof window.matchMedia;
  Object.defineProperty(navigator, 'maxTouchPoints', {
    value: 5,
    configurable: true,
  });
}

function Harness({
  options,
}: {
  options: UseComposerCoreOptions;
}): React.JSX.Element {
  latest = useComposerCore(options);
  return <div ref={latest.containerRef} />;
}

async function mount(overrides: Partial<UseComposerCoreOptions> = {}) {
  if (!container) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  }
  const options: UseComposerCoreOptions = {
    onSubmit: vi.fn(),
    commands: [],
    sessionId: 'session-shared',
    ...overrides,
  };
  await act(async () => {
    root!.render(
      <I18nProvider>
        <WebShellPortalRootContext.Provider value={container}>
          <ComposerWorkspaceProvider
            value={
              currentWorkspace as unknown as
                | DaemonWorkspaceContextValue
                | undefined
            }
          >
            <Harness options={options} />
          </ComposerWorkspaceProvider>
        </WebShellPortalRootContext.Provider>
      </I18nProvider>,
    );
    await Promise.resolve();
  });
}

describe('useComposerCore cross-device input history sync', () => {
  beforeEach(() => {
    mockTouchDevice();
    currentWorkspace = undefined;
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    latest = null;
    currentWorkspace = undefined;
    window.matchMedia = originalMatchMedia;
    if (originalMaxTouchPoints) {
      Object.defineProperty(
        Navigator.prototype,
        'maxTouchPoints',
        originalMaxTouchPoints,
      );
    }
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('shows desktop history in mobile Input history panel and live-updates while open', async () => {
    let resolveOpenRefresh!: (value: DaemonInputHistoryResult) => void;
    const loadInputHistory = vi
      .fn()
      .mockResolvedValueOnce({
        notModified: false,
        kind: 'prompt',
        entries: ['from desktop 1'],
        revision: 'rev1',
      } satisfies DaemonInputHistoryResult)
      .mockImplementationOnce(
        () =>
          new Promise<DaemonInputHistoryResult>((resolve) => {
            resolveOpenRefresh = resolve;
          }),
      );

    currentWorkspace = {
      workspaceCwd: '/repo/a',
      capabilities: {
        features: ['workspace_input_history', 'workspace_qualified_rest_core'],
        workspaces: [
          { id: 'ws-a', cwd: '/repo/a', primary: true, trusted: true },
        ],
      },
      actions: { loadInputHistory, recordInputHistory: vi.fn() },
      client: makeFakeClient(),
    };

    await mount({ atWorkspaceCwd: '/repo/a' });
    expect(loadInputHistory).toHaveBeenCalledTimes(1);
    expect(loadInputHistory).toHaveBeenLastCalledWith({
      kind: 'prompt',
      workspaceId: undefined,
    });

    // Open mobile Input history: initially shows prefetched desktop entry.
    act(() => latest!.searchState.openHistorySearch());
    expect(latest!.searchState.searchMatches).toEqual(['from desktop 1']);
    expect(loadInputHistory).toHaveBeenCalledTimes(2);
    expect(loadInputHistory).toHaveBeenLastCalledWith({
      kind: 'prompt',
      workspaceId: undefined,
      ifNoneMatch: '"v1:rev1"',
    });

    // Desktop submits another prompt while mobile panel is open -> panel updates live.
    await act(async () => {
      resolveOpenRefresh({
        notModified: false,
        kind: 'prompt',
        entries: ['from desktop 1', 'from desktop 2'],
        revision: 'rev2',
      });
      await Promise.resolve();
    });
    expect(latest!.searchState.searchMatches).toEqual([
      'from desktop 2',
      'from desktop 1',
    ]);
  });

  it('refreshes prompt history when another client submits on the same session via SSE sidechannel', async () => {
    const loadInputHistory = vi
      .fn()
      .mockResolvedValueOnce({
        notModified: false,
        kind: 'prompt',
        entries: ['initial'],
        revision: 'rev1',
      } satisfies DaemonInputHistoryResult)
      .mockResolvedValueOnce({
        notModified: false,
        kind: 'prompt',
        entries: ['initial', 'live from desktop'],
        revision: 'rev2',
      } satisfies DaemonInputHistoryResult);

    currentWorkspace = {
      workspaceCwd: '/repo/a',
      capabilities: {
        features: ['workspace_input_history'],
        workspaces: [
          { id: 'ws-a', cwd: '/repo/a', primary: true, trusted: true },
        ],
      },
      actions: { loadInputHistory, recordInputHistory: vi.fn() },
      client: makeFakeClient(),
    };

    await mount({ sessionId: 'session-live', atWorkspaceCwd: '/repo/a' });
    expect(loadInputHistory).toHaveBeenCalledTimes(1);

    // Other session's signal is ignored.
    await act(async () => {
      publishSidechannelRemotePrompt({
        sessionId: 'session-other',
        kind: 'prompt',
      });
      await Promise.resolve();
    });
    expect(loadInputHistory).toHaveBeenCalledTimes(1);

    // Same session's remote prompt signal triggers refresh immediately.
    await act(async () => {
      publishSidechannelRemotePrompt({
        sessionId: 'session-live',
        kind: 'prompt',
      });
      await Promise.resolve();
    });
    expect(loadInputHistory).toHaveBeenCalledTimes(2);

    act(() => latest!.searchState.openHistorySearch());
    expect(latest!.searchState.searchMatches).toEqual([
      'live from desktop',
      'initial',
    ]);
  });

  it('routes trusted non-primary workspaces by workspaceId and never falls back to primary for untrusted ones', async () => {
    const loadInputHistory = vi.fn().mockResolvedValue({
      notModified: false,
      kind: 'prompt',
      entries: ['secondary entry'],
      revision: 'rev-sec',
    } satisfies DaemonInputHistoryResult);

    currentWorkspace = {
      workspaceCwd: '/repo/primary',
      capabilities: {
        features: ['workspace_input_history', 'workspace_qualified_rest_core'],
        workspaces: [
          {
            id: 'ws-primary',
            cwd: '/repo/primary',
            primary: true,
            trusted: true,
          },
          {
            id: 'ws-secondary',
            cwd: '/repo/secondary',
            primary: false,
            trusted: true,
          },
          {
            id: 'ws-untrusted',
            cwd: '/repo/untrusted',
            primary: false,
            trusted: false,
          },
        ],
      },
      actions: { loadInputHistory, recordInputHistory: vi.fn() },
      client: makeFakeClient(),
    };

    await mount({ atWorkspaceCwd: '/repo/secondary' });
    expect(loadInputHistory).toHaveBeenCalledWith({
      kind: 'prompt',
      workspaceId: 'ws-secondary',
    });

    loadInputHistory.mockClear();
    await mount({ atWorkspaceCwd: '/repo/untrusted' });
    expect(loadInputHistory).not.toHaveBeenCalled();

    await mount({ atWorkspaceCwd: '/repo/unknown' });
    expect(loadInputHistory).not.toHaveBeenCalled();
  });

  it('syncs shell history on entering shellMode and stays local-only without capability', async () => {
    const loadInputHistory = vi.fn().mockImplementation(async ({ kind }) => ({
      notModified: false,
      kind,
      entries: kind === 'shell' ? ['git status', 'npm test'] : ['hello'],
      revision: `rev-${kind}`,
    }));

    currentWorkspace = {
      workspaceCwd: '/repo/a',
      capabilities: {
        features: ['workspace_input_history'],
        workspaces: [
          { id: 'ws-a', cwd: '/repo/a', primary: true, trusted: true },
        ],
      },
      actions: { loadInputHistory, recordInputHistory: vi.fn() },
      client: makeFakeClient(),
    };

    await mount({ atWorkspaceCwd: '/repo/a', shellModeEnabled: true });
    expect(loadInputHistory).toHaveBeenCalledTimes(1);
    expect(loadInputHistory).toHaveBeenCalledWith({
      kind: 'prompt',
      workspaceId: undefined,
    });

    await act(async () => {
      latest!.setShellMode(true);
      await Promise.resolve();
    });
    expect(loadInputHistory).toHaveBeenCalledWith({
      kind: 'shell',
      workspaceId: undefined,
    });

    act(() => latest!.searchState.openHistorySearch());
    expect(latest!.searchState.searchMatches).toEqual([
      'npm test',
      'git status',
    ]);

    // Without workspace_input_history capability, no daemon calls happen.
    loadInputHistory.mockClear();
    currentWorkspace = {
      workspaceCwd: '/repo/a',
      capabilities: { features: [] },
      actions: { loadInputHistory, recordInputHistory: vi.fn() },
      client: makeFakeClient(),
    };
    await mount({ atWorkspaceCwd: '/repo/a', shellModeEnabled: true });
    expect(loadInputHistory).not.toHaveBeenCalled();
  });

  it('does not refetch on workspace context re-render and queues a follow-up when SSE arrives mid-flight', async () => {
    let resolveFirst!: (value: DaemonInputHistoryResult) => void;
    const loadInputHistory = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<DaemonInputHistoryResult>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({
        notModified: false,
        kind: 'prompt',
        entries: ['first', 'arrived mid-flight'],
        revision: 'rev2',
      } satisfies DaemonInputHistoryResult);

    currentWorkspace = {
      workspaceCwd: '/repo/a',
      capabilities: {
        features: ['workspace_input_history'],
        workspaces: [
          { id: 'ws-a', cwd: '/repo/a', primary: true, trusted: true },
        ],
      },
      actions: { loadInputHistory, recordInputHistory: vi.fn() },
      client: makeFakeClient(),
    };

    await mount({ sessionId: 'session-flight', atWorkspaceCwd: '/repo/a' });
    expect(loadInputHistory).toHaveBeenCalledTimes(1);

    // Re-rendering with a fresh workspace object for the same targetKey must not trigger a refetch.
    currentWorkspace = { ...currentWorkspace };
    await mount({ sessionId: 'session-flight', atWorkspaceCwd: '/repo/a' });
    expect(loadInputHistory).toHaveBeenCalledTimes(1);

    // An SSE remote prompt signal arriving while the first GET is in-flight queues one follow-up.
    publishSidechannelRemotePrompt({
      sessionId: 'session-flight',
      kind: 'prompt',
    });
    expect(loadInputHistory).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirst({
        notModified: false,
        kind: 'prompt',
        entries: ['first'],
        revision: 'rev1',
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(loadInputHistory).toHaveBeenCalledTimes(2);
    expect(loadInputHistory).toHaveBeenLastCalledWith({
      kind: 'prompt',
      workspaceId: undefined,
      ifNoneMatch: '"v1:rev1"',
    });
  });
});
