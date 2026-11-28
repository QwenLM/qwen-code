// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type React from 'react';
import { act } from 'react';
import { waitFor } from '@testing-library/react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '../i18n';
import { WebShellPortalRootContext } from '../portalRoot';
import { TOUCH_COMPOSER_QUERY } from './useIsTouchComposer';
import { createFakeIndexedDB } from '../test/fake-indexeddb';
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
import { getPromptHistoryStorageKey } from './useInputHistory';

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
  return latest.mobileComposer ? (
    <textarea
      ref={latest.mobileComposer.textareaRef}
      value={latest.mobileComposer.value}
      onChange={latest.mobileComposer.onChange}
      placeholder={latest.mobileComposer.placeholder}
    />
  ) : (
    <div ref={latest.containerRef} />
  );
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
    vi.unstubAllGlobals();
    window.history.replaceState({}, '', '/');
  });

  it('restores a saved welcome draft in the selected workspace without submitting', async () => {
    const draft = "Summarize yesterday's failed jobs";
    const recommendation = 'Show my upcoming jobs';
    const onSubmit = vi.fn();
    const recordInputHistory = vi.fn().mockRejectedValue(new Error('offline'));
    let revision = 0;
    const loadInputHistory = vi.fn(
      async (): Promise<DaemonInputHistoryResult> => ({
        notModified: false,
        kind: 'prompt',
        entries: [],
        revision: `rev${++revision}`,
      }),
    );
    currentWorkspace = {
      workspaceCwd: '/repo/primary',
      capabilities: {
        features: ['workspace_input_history', 'workspace_qualified_rest_core'],
        workspaces: [
          { id: 'primary', cwd: '/repo/primary', primary: true },
          { id: 'secondary', cwd: '/repo/secondary', trusted: true },
        ],
      },
      actions: { loadInputHistory, recordInputHistory },
      client: makeFakeClient(),
    };
    const options = { sessionId: undefined, onSubmit };
    await mount({ ...options, atWorkspaceCwd: '/repo/secondary' });
    await act(async () => {
      const { handle } = latest!;
      handle.setText(' \n ');
      handle.saveCurrentDraftToHistory();
      handle.setText(` ${draft} `);
      handle.saveCurrentDraftToHistory();
      handle.setText(recommendation);
    });
    expect(latest!.handle.getText()).toBe(recommendation);
    expect(recordInputHistory).toHaveBeenCalledExactlyOnceWith({
      kind: 'prompt',
      workspaceId: 'secondary',
      entry: draft,
    });

    // The draft survives successive remote revisions even if the write fails.
    for (let attempt = 0; attempt < 3; attempt++) {
      await act(async () => latest!.searchState.openHistorySearch());
      expect(latest!.searchState.searchMatches).toEqual([draft]);
      act(() => latest!.searchState.closeSearch(true));
    }
    expect(loadInputHistory).toHaveBeenCalledTimes(4);
    act(() => latest!.searchState.restoreSearchMatch!(draft));
    expect(latest!.handle.getText()).toBe(draft);
    expect(onSubmit).not.toHaveBeenCalled();

    await mount({ ...options, atWorkspaceCwd: '/repo/primary' });
    await act(async () => latest!.searchState.openHistorySearch());
    expect(latest!.searchState.searchMatches).toEqual([]);
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

  it('does not create pending history without a resolved workspace target', async () => {
    vi.stubGlobal('indexedDB', createFakeIndexedDB().factory);
    currentWorkspace = {
      workspaceCwd: '/repo/unresolved',
      capabilities: {
        features: ['workspace_input_history', 'workspace_qualified_rest_core'],
        workspaces: [
          { id: 'known', cwd: '/repo/known', primary: true, trusted: true },
        ],
      },
      actions: {
        loadInputHistory: vi.fn().mockResolvedValue({
          notModified: false,
          kind: 'prompt',
          entries: [],
          revision: 'rev',
        } satisfies DaemonInputHistoryResult),
      },
      client: makeFakeClient(),
    };

    const onSubmit: UseComposerCoreOptions['onSubmit'] = vi.fn();
    const storageKey = getPromptHistoryStorageKey('/repo/unresolved');
    await mount({ atWorkspaceCwd: '/repo/unresolved', onSubmit });
    act(() => latest!.setText('/init'));
    await waitFor(() => expect(latest!.canSubmit).toBe(true));
    await act(async () => latest!.submitText());
    expect(onSubmit).toHaveBeenCalled();

    expect(localStorage.getItem(`${storageKey}:pending-remote`)).toBeNull();
    expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual(['/init']);

    currentWorkspace = {
      ...currentWorkspace,
      capabilities: {
        ...currentWorkspace.capabilities,
        workspaces: [
          ...currentWorkspace.capabilities.workspaces!,
          { id: 'resolved', cwd: '/repo/unresolved', trusted: true },
        ],
      },
    };
    await mount({ atWorkspaceCwd: '/repo/unresolved', onSubmit });
    act(() => latest!.setText('/init'));
    await waitFor(() => expect(latest!.canSubmit).toBe(true));
    await act(async () => latest!.submitText());
    expect(localStorage.getItem(`${storageKey}:pending-remote`)).not.toBeNull();
  });

  it('supports implicit primary history and keeps local input from an unsupported daemon', async () => {
    vi.stubGlobal('indexedDB', createFakeIndexedDB().factory);
    const loadInputHistory = vi.fn().mockResolvedValue({
      notModified: false,
      kind: 'prompt',
      entries: [],
      revision: 'r0',
    } satisfies DaemonInputHistoryResult);
    const onSubmit: UseComposerCoreOptions['onSubmit'] = vi.fn();
    currentWorkspace = {
      workspaceCwd: '/repo/primary',
      capabilities: { features: [] },
      actions: { loadInputHistory },
      client: makeFakeClient(),
    };

    await mount({ onSubmit });
    act(() => latest!.setText('local input'));
    await waitFor(() => expect(latest!.canSubmit).toBe(true));
    await act(async () => latest!.submitText());
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(
      localStorage.getItem('qwen-web-shell-history:pending-remote'),
    ).toBeNull();
    expect(loadInputHistory).not.toHaveBeenCalled();

    loadInputHistory
      .mockResolvedValueOnce({
        notModified: false,
        kind: 'prompt',
        entries: ['from desktop'],
        revision: 'r1',
      } satisfies DaemonInputHistoryResult)
      .mockResolvedValueOnce({
        notModified: false,
        kind: 'prompt',
        entries: ['from another desktop'],
        revision: 'r2',
      } satisfies DaemonInputHistoryResult);
    currentWorkspace = {
      ...currentWorkspace,
      capabilities: {
        ...currentWorkspace.capabilities,
        features: ['workspace_input_history'],
      },
    };
    await mount({ onSubmit });
    await waitFor(() => expect(loadInputHistory).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(
        JSON.parse(localStorage.getItem('qwen-web-shell-history')!),
      ).toEqual(['local input', 'from desktop']),
    );
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });
    await waitFor(() => expect(loadInputHistory).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        JSON.parse(localStorage.getItem('qwen-web-shell-history')!),
      ).toEqual(['local input', 'from another desktop']),
    );
  });

  it('creates pending history for an implicit primary target', async () => {
    vi.stubGlobal('indexedDB', createFakeIndexedDB().factory);
    const loadInputHistory = vi.fn().mockResolvedValue({
      notModified: false,
      kind: 'prompt',
      entries: [],
      revision: 'rev',
    } satisfies DaemonInputHistoryResult);
    const onSubmit: UseComposerCoreOptions['onSubmit'] = vi.fn();
    currentWorkspace = {
      workspaceCwd: '/repo/primary',
      capabilities: { features: ['workspace_input_history'] },
      actions: { loadInputHistory },
      client: makeFakeClient(),
    };

    await mount({ onSubmit });
    act(() => latest!.setText('implicit primary input'));
    await waitFor(() => expect(latest!.canSubmit).toBe(true));
    await act(async () => latest!.submitText());
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(
      JSON.parse(
        localStorage.getItem('qwen-web-shell-history:pending-remote')!,
      ),
    ).toEqual([expect.objectContaining({ text: 'implicit primary input' })]);
    expect(loadInputHistory).toHaveBeenCalled();
  });

  it('keeps deferred primary history when the capability list becomes specific', async () => {
    vi.stubGlobal('indexedDB', createFakeIndexedDB().factory);
    const recordInputHistory = vi.fn().mockResolvedValue(undefined);
    let commitAccepted: (() => void) | undefined;
    const onSubmit: UseComposerCoreOptions['onSubmit'] = vi.fn(
      (_text, _images, _files, accepted) => {
        commitAccepted = accepted;
        return false;
      },
    );
    currentWorkspace = {
      workspaceCwd: '/repo/primary',
      capabilities: { features: ['workspace_input_history'] },
      actions: {
        loadInputHistory: vi.fn().mockResolvedValue({
          notModified: false,
          kind: 'prompt',
          entries: [],
          revision: 'rev',
        } satisfies DaemonInputHistoryResult),
        recordInputHistory,
      },
      client: makeFakeClient(),
    };
    const options: Partial<UseComposerCoreOptions> = {
      composerScopeKey: 'same-primary',
      atWorkspaceCwd: '/repo/primary',
      onSubmit,
    };

    await mount(options);
    act(() => latest!.setText('/init'));
    await waitFor(() => expect(latest!.canSubmit).toBe(true));
    await act(async () => latest!.submitText());
    expect(onSubmit).toHaveBeenCalled();

    currentWorkspace = {
      ...currentWorkspace,
      capabilities: {
        features: ['workspace_input_history'],
        workspaces: [
          {
            id: 'primary-id',
            cwd: '/repo/primary',
            primary: true,
            trusted: true,
          },
        ],
      },
    };
    await mount(options);
    await act(async () => {
      commitAccepted?.();
      await Promise.resolve();
    });

    expect(recordInputHistory).toHaveBeenCalledWith({
      kind: 'prompt',
      entry: '/init',
    });
  });

  it('records a deferred slash acceptance after a new session is allocated', async () => {
    vi.stubGlobal('indexedDB', createFakeIndexedDB().factory);
    const recordInputHistory = vi.fn().mockResolvedValue(undefined);
    let commitAccepted: (() => void) | undefined;
    const onSubmit: UseComposerCoreOptions['onSubmit'] = vi.fn(
      (_text, _images, _files, accepted) => {
        commitAccepted = accepted;
        return false;
      },
    );
    currentWorkspace = {
      workspaceCwd: '/repo/primary',
      capabilities: {
        features: ['workspace_input_history', 'workspace_qualified_rest_core'],
        workspaces: [
          {
            id: 'primary-id',
            cwd: '/repo/primary',
            primary: true,
            trusted: true,
          },
        ],
      },
      actions: {
        loadInputHistory: vi.fn().mockResolvedValue({
          notModified: false,
          kind: 'prompt',
          entries: [],
          revision: 'rev',
        } satisfies DaemonInputHistoryResult),
        recordInputHistory,
      },
      client: makeFakeClient(),
    };

    await mount({
      sessionId: undefined,
      atWorkspaceCwd: '/repo/primary',
      onSubmit,
    });
    act(() => latest!.setText('/goal improve shared history'));
    await waitFor(() => expect(latest!.canSubmit).toBe(true));
    await act(async () => latest!.submitText());
    expect(onSubmit).toHaveBeenCalled();

    await mount({
      sessionId: 'allocated-session',
      atWorkspaceCwd: '/repo/primary',
    });
    await act(async () => {
      commitAccepted?.();
      await Promise.resolve();
    });

    expect(recordInputHistory).toHaveBeenCalledTimes(1);
    expect(recordInputHistory).toHaveBeenCalledWith({
      kind: 'prompt',
      entry: '/goal improve shared history',
    });
  });

  it('does not commit deferred slash history to a newly selected workspace', async () => {
    vi.stubGlobal('indexedDB', createFakeIndexedDB().factory);
    const recordInputHistory = vi.fn().mockResolvedValue(undefined);
    const loadInputHistory = vi.fn().mockResolvedValue({
      notModified: false,
      kind: 'prompt',
      entries: [],
      revision: 'rev-a',
    } satisfies DaemonInputHistoryResult);
    let commitAccepted: (() => void) | undefined;
    const onSubmit: UseComposerCoreOptions['onSubmit'] = vi.fn(
      (_text, _images, _files, accepted) => {
        commitAccepted = accepted;
        return false;
      },
    );
    const options: Partial<UseComposerCoreOptions> = {
      composerScopeKey: 'shared-live-key',
      onSubmit,
    };
    currentWorkspace = {
      workspaceCwd: '/repo/a',
      capabilities: {
        features: ['workspace_input_history', 'workspace_qualified_rest_core'],
        workspaces: [
          { id: 'ws-a', cwd: '/repo/a', trusted: true },
          { id: 'ws-b', cwd: '/repo/b', trusted: true },
        ],
      },
      actions: { loadInputHistory, recordInputHistory },
      client: makeFakeClient(),
    };

    await mount({ ...options, atWorkspaceCwd: '/repo/a' });
    act(() => latest!.setText('/init'));
    await waitFor(() => expect(latest!.canSubmit).toBe(true));
    expect(latest!.getText()).toBe('/init');
    await act(async () => latest!.submitText());
    expect(onSubmit).toHaveBeenCalled();
    expect(commitAccepted).toEqual(expect.any(Function));

    currentWorkspace = { ...currentWorkspace, workspaceCwd: '/repo/b' };
    await mount({ ...options, atWorkspaceCwd: '/repo/b' });
    await act(async () => {
      commitAccepted?.();
      await Promise.resolve();
    });
    expect(recordInputHistory).not.toHaveBeenCalled();
    expect(
      JSON.parse(
        localStorage.getItem('qwen-web-shell-history:shared-live-key')!,
      ),
    ).toEqual(['/init']);

    // A control acceptance in the original workspace does record its target.
    currentWorkspace = { ...currentWorkspace, workspaceCwd: '/repo/a' };
    await mount({ ...options, atWorkspaceCwd: '/repo/a' });
    act(() => latest!.setText('/init again'));
    await act(async () => {
      latest!.submitText();
      commitAccepted?.();
    });
    expect(recordInputHistory).toHaveBeenCalledWith({
      kind: 'prompt',
      entry: '/init again',
      workspaceId: 'ws-a',
    });
  });

  it('does not fetch remote data for an explicitly shared non-workspace key', async () => {
    localStorage.setItem(
      'qwen-web-shell-history:shared-sync-scope',
      JSON.stringify(['local-a']),
    );
    localStorage.setItem(
      'qwen-web-shell-history:shared-sync-scope:pending-remote',
      JSON.stringify([
        {
          text: 'local-a',
          seenRemoteRevision: 'rev-a',
          missedRemoteSnapshots: 0,
        },
      ]),
    );
    const loadInputHistory = vi.fn();
    currentWorkspace = {
      workspaceCwd: '/repo/a',
      capabilities: {
        features: ['workspace_input_history', 'workspace_qualified_rest_core'],
        workspaces: [
          { id: 'ws-a', cwd: '/repo/a', trusted: true },
          { id: 'ws-b', cwd: '/repo/b', trusted: true },
        ],
      },
      actions: { loadInputHistory },
      client: makeFakeClient(),
    };
    await mount({
      composerScopeKey: 'shared-sync-scope',
      atWorkspaceCwd: '/repo/a',
    });
    currentWorkspace = { ...currentWorkspace, workspaceCwd: '/repo/b' };
    await mount({
      composerScopeKey: 'shared-sync-scope',
      atWorkspaceCwd: '/repo/b',
    });
    await act(async () => {
      publishSidechannelRemotePrompt({
        sessionId: 'session-shared',
        kind: 'prompt',
        baseSeq: 1,
      });
      latest!.searchState.openHistorySearch();
      await Promise.resolve();
    });

    expect(loadInputHistory).not.toHaveBeenCalled();
    expect(
      JSON.parse(
        localStorage.getItem('qwen-web-shell-history:shared-sync-scope')!,
      ),
    ).toEqual(['local-a']);
    expect(
      localStorage.getItem(
        'qwen-web-shell-history:shared-sync-scope:pending-remote',
      ),
    ).toBe(
      JSON.stringify([
        {
          text: 'local-a',
          seenRemoteRevision: 'rev-a',
          missedRemoteSnapshots: 0,
        },
      ]),
    );
  });

  it('namespaces a reserved secondary id when switching away from primary', async () => {
    vi.stubGlobal('indexedDB', createFakeIndexedDB().factory);
    const resolvers: Array<(result: DaemonInputHistoryResult) => void> = [];
    const loadInputHistory = vi.fn(
      () =>
        new Promise<DaemonInputHistoryResult>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const recordInputHistory = vi.fn().mockResolvedValue(undefined);
    let accept: (() => void) | undefined;
    const onSubmit: UseComposerCoreOptions['onSubmit'] = vi.fn(
      (_text, _images, _files, accepted) => {
        accept = accepted;
        return false;
      },
    );
    currentWorkspace = {
      workspaceCwd: '/repo/primary',
      capabilities: {
        features: ['workspace_input_history', 'workspace_qualified_rest_core'],
        workspaces: [
          {
            id: 'root-primary',
            cwd: '/repo/primary',
            primary: true,
            trusted: true,
          },
          { id: '<primary>', cwd: '/repo/other', trusted: true },
        ],
      },
      actions: { loadInputHistory, recordInputHistory },
      client: makeFakeClient(),
    };
    await mount({ onSubmit, atWorkspaceCwd: '/repo/primary' });
    act(() => latest!.setText('/init'));
    await vi.waitFor(() => expect(latest!.canSubmit).toBe(true));
    await act(async () => latest!.submitText());
    expect(accept).toEqual(expect.any(Function));

    currentWorkspace = { ...currentWorkspace, workspaceCwd: '/repo/other' };
    await mount({ atWorkspaceCwd: '/repo/other' });
    expect(loadInputHistory).toHaveBeenCalledTimes(2);
    expect(loadInputHistory.mock.calls[1][0]).toMatchObject({
      kind: 'prompt',
      workspaceId: '<primary>',
    });
    await act(async () => {
      accept?.();
      await Promise.resolve();
    });
    expect(recordInputHistory).not.toHaveBeenCalled();

    act(() => latest!.searchState.openHistorySearch());
    await act(async () => {
      resolvers[0]({
        notModified: false,
        kind: 'prompt',
        entries: ['old-main'],
        revision: 'old',
      });
      await Promise.resolve();
    });
    expect(latest!.searchState.searchMatches).not.toContain('old-main');
    await act(async () => {
      resolvers[1]({
        notModified: false,
        kind: 'prompt',
        entries: ['other-workspace'],
        revision: 'other',
      });
      await Promise.resolve();
    });
    expect(latest!.searchState.searchMatches).toContain('other-workspace');
  });

  it('keeps the latest A request authoritative across A → B → A switches', async () => {
    const responses: Array<(value: DaemonInputHistoryResult) => void> = [];
    const loadInputHistory = vi.fn(
      () =>
        new Promise<DaemonInputHistoryResult>((resolve) => {
          responses.push(resolve);
        }),
    );
    const snapshot = (
      entries: string[],
      revision: string,
    ): DaemonInputHistoryResult => ({
      notModified: false,
      kind: 'prompt',
      entries,
      revision,
    });
    currentWorkspace = {
      workspaceCwd: '/repo/a',
      capabilities: {
        features: ['workspace_input_history', 'workspace_qualified_rest_core'],
        workspaces: [
          { id: 'ws-a', cwd: '/repo/a', trusted: true },
          { id: 'ws-b', cwd: '/repo/b', trusted: true },
        ],
      },
      actions: { loadInputHistory },
      client: makeFakeClient(),
    };
    const select = async (workspaceCwd: string) => {
      currentWorkspace = { ...currentWorkspace, workspaceCwd };
      await mount({
        composerScopeKey: workspaceCwd,
        atWorkspaceCwd: workspaceCwd,
      });
    };
    const settle = async (
      index: number,
      entries: string[],
      revision: string,
    ) => {
      await act(async () => {
        responses[index](snapshot(entries, revision));
        await Promise.resolve();
      });
    };

    await select('/repo/a');
    await select('/repo/b');
    await select('/repo/a');
    expect(loadInputHistory).toHaveBeenCalledTimes(3);

    // The new A wins, even though the older A carries the same target key.
    await settle(2, ['old', 'new'], 'new-a');
    act(() => latest!.searchState.openHistorySearch());
    expect(loadInputHistory).toHaveBeenCalledTimes(4);
    expect(latest!.searchState.searchMatches).toEqual(['new', 'old']);

    // An older A must neither apply its snapshot nor clear the newest GET.
    await settle(0, ['stale'], 'stale-a');
    await act(async () => {
      publishSidechannelRemotePrompt({
        sessionId: 'session-shared',
        kind: 'prompt',
        baseSeq: 1,
      });
      await Promise.resolve();
    });
    expect(loadInputHistory).toHaveBeenCalledTimes(4);
    expect(latest!.searchState.searchMatches).toEqual(['new', 'old']);

    // The unrelated B response is ignored; the queued current A is refreshed once.
    await settle(1, ['other-workspace'], 'b');
    await settle(3, ['old', 'new', 'latest'], 'latest-a');
    expect(latest!.searchState.searchMatches).toEqual(['latest', 'new', 'old']);
    await vi.waitFor(() => expect(loadInputHistory).toHaveBeenCalledTimes(5));
    await act(async () => {
      responses[4]({ notModified: true, kind: 'prompt' });
      await Promise.resolve();
    });
  });
});
