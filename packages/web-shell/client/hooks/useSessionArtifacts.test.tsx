// @vitest-environment jsdom
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestToast } from '../components/ToastHost';
import { ReportedArtifactRegistration } from '../components/ReportedArtifactRegistration';
import { WebShellPortalRootContext } from '../portalRoot';
import { DaemonHttpError } from '@qwen-code/sdk/daemon';
import type { DaemonSessionArtifact } from '@qwen-code/sdk/daemon';
import {
  useSessionArtifacts,
  type SessionArtifactsState,
} from './useSessionArtifacts';

vi.mock('../components/ToastHost', () => ({ requestToast: vi.fn() }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

const sdkMock = vi.hoisted(() => ({
  ownerVersion: 0,
  blocks: [] as unknown[],
  ownerGuard: { capture: vi.fn() },
  actions: {
    loadArtifacts: vi.fn(),
    addArtifact: vi.fn(),
  },
  connection: {
    status: 'connected',
    sessionId: 'session-a',
    capabilities: { features: ['session_artifacts'] },
    catchingUp: false,
  },
  artifactsVersion: 0,
}));

vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  useActions: () => sdkMock.actions,
  useConnection: () => sdkMock.connection,
  useDaemonSessionOwnerGuard: () => sdkMock.ownerGuard,
  useWorkspaceEventSignals: () => ({
    artifactsVersion: sdkMock.artifactsVersion,
  }),
}));

vi.mock('./useAnimationFrameTranscriptBlocks', () => ({
  useAnimationFrameTranscriptSnapshot: () => ({ blocks: sdkMock.blocks }),
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let latestState: SessionArtifactsState | undefined;

function deferred<T>(): Deferred<T> {
  let resolve: ((value: T) => void) | undefined;
  let reject: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  if (!resolve || !reject) {
    throw new Error('deferred promise did not initialize');
  }
  return { promise, resolve, reject };
}

function artifact(id: string): DaemonSessionArtifact {
  return {
    id,
    kind: 'html',
    storage: 'workspace',
    source: 'tool',
    status: 'available',
    title: id,
    workspacePath: `${id}.html`,
    clientRetained: false,
    createdAt: '2026-07-09T00:00:00.000Z',
    updatedAt: '2026-07-09T00:00:00.000Z',
  };
}

function TestHost() {
  latestState = useSessionArtifacts();
  // Mirrors App's composition: the registration runs in a child rendered
  // inside the portal-root provider, not in the hook above it.
  return React.createElement(ReportedArtifactRegistration, {
    registered: latestState.artifacts,
    hydrated: latestState.hydrated,
    refresh: latestState.refresh,
  });
}

async function renderHookHost() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(React.createElement(TestHost));
  });
}

async function rerenderHookHost() {
  await act(async () => {
    root?.render(React.createElement(TestHost));
  });
}

beforeEach(() => {
  latestState = undefined;
  vi.mocked(requestToast).mockClear();
  sdkMock.blocks = [];
  sdkMock.actions.addArtifact.mockReset();
  sdkMock.connection = {
    status: 'connected',
    sessionId: 'session-a',
    capabilities: { features: ['session_artifacts'] },
    catchingUp: false,
  };
  sdkMock.artifactsVersion = 0;
  sdkMock.ownerVersion = 0;
  sdkMock.ownerGuard.capture.mockImplementation(() => {
    const version = sdkMock.ownerVersion;
    return { isCurrent: () => sdkMock.ownerVersion === version };
  });
  sdkMock.actions.loadArtifacts.mockReset();
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root?.unmount();
    });
    root = null;
  }
  container?.remove();
  container = null;
});

describe('useSessionArtifacts', () => {
  it('refreshes concurrent registration conflicts without discarding successful checks', async () => {
    const exported = ['first', 'second'].map((id) => ({
      ...artifact(id),
      source: 'client' as const,
      clientId: 'another-client',
    }));
    sdkMock.actions.loadArtifacts
      .mockResolvedValueOnce({ artifacts: [] })
      .mockResolvedValue({ artifacts: exported });
    sdkMock.actions.addArtifact.mockRejectedValue(
      new DaemonHttpError(
        403,
        { code: 'session_artifact_forbidden' },
        'already owned',
      ),
    );
    await renderHookHost();
    expect(latestState?.artifacts).toEqual([]);
    sdkMock.blocks = [
      {
        id: 'export-result',
        kind: 'assistant',
        text: 'Exported',
        meta: {
          source: 'slash_command',
          sessionArtifacts: exported.map(({ title, workspacePath }) => ({
            kind: 'html',
            storage: 'workspace',
            title,
            workspacePath,
          })),
        },
      },
    ];
    await rerenderHookHost();
    expect(sdkMock.actions.addArtifact).toHaveBeenCalledTimes(2);
    expect(sdkMock.actions.loadArtifacts).toHaveBeenCalledTimes(3);
    expect(latestState?.artifacts).toEqual(exported);
    expect(requestToast).not.toHaveBeenCalled();
  });

  it('treats a cross-client registration conflict as benign even when the resync fails', async () => {
    const exported = artifact('first');
    sdkMock.actions.loadArtifacts
      .mockResolvedValueOnce({ artifacts: [] })
      .mockRejectedValueOnce(new Error('Failed to fetch'));
    sdkMock.actions.addArtifact.mockRejectedValue(
      new DaemonHttpError(
        403,
        { code: 'session_artifact_forbidden' },
        'already owned',
      ),
    );
    await renderHookHost();
    expect(latestState?.artifacts).toEqual([]);
    sdkMock.blocks = [
      {
        id: 'export-result',
        kind: 'assistant',
        text: 'Exported',
        meta: {
          source: 'slash_command',
          sessionArtifacts: [
            {
              kind: 'html',
              storage: 'workspace',
              title: exported.title,
              workspacePath: exported.workspacePath,
            },
          ],
        },
      },
    ];
    await rerenderHookHost();
    expect(sdkMock.actions.addArtifact).toHaveBeenCalledTimes(1);
    expect(sdkMock.actions.loadArtifacts).toHaveBeenCalledTimes(2);
    expect(requestToast).not.toHaveBeenCalled();
  });

  it('scopes the registration failure toast to the shell root in the App composition (F1)', async () => {
    // App calls useSessionArtifacts in its body, ABOVE the portal-root
    // provider it returns; the registration must run in a child inside the
    // provider or its failure toast reads an unpopulated context. Moving the
    // registration back into the hook nulls the third argument here.
    const shellRoot = document.createElement('div');
    shellRoot.setAttribute('data-web-shell-root', '');
    document.body.appendChild(shellRoot);
    try {
      sdkMock.actions.loadArtifacts.mockResolvedValue({ artifacts: [] });
      sdkMock.actions.addArtifact.mockRejectedValue(new Error('offline'));
      sdkMock.blocks = [
        {
          id: 'export-result',
          kind: 'assistant',
          text: 'Exported',
          meta: {
            source: 'slash_command',
            sessionArtifacts: [
              {
                kind: 'html',
                storage: 'workspace',
                title: 'first',
                workspacePath: 'first.html',
              },
            ],
          },
        },
      ];
      function AppShapeHost() {
        const state = useSessionArtifacts();
        return React.createElement(
          WebShellPortalRootContext.Provider,
          { value: shellRoot },
          React.createElement(ReportedArtifactRegistration, {
            registered: state.artifacts,
            hydrated: state.hydrated,
            refresh: state.refresh,
          }),
        );
      }
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
      await act(async () => {
        root?.render(React.createElement(AppShapeHost));
      });
      // Exactly one registration instance: re-adding the registration inside
      // useSessionArtifacts (above the provider) would fire a second, unscoped
      // toast alongside this one.
      expect(requestToast).toHaveBeenCalledTimes(1);
      expect(requestToast).toHaveBeenCalledWith(
        'error',
        'artifact.registrationFailed',
        shellRoot,
      );
    } finally {
      shellRoot.remove();
    }
  });

  it('loads new sessions and reuses a previous session result', async () => {
    const sessionA = deferred<{ artifacts: DaemonSessionArtifact[] }>();
    const sessionB = deferred<{ artifacts: DaemonSessionArtifact[] }>();
    const sessionARefresh = deferred<{ artifacts: DaemonSessionArtifact[] }>();
    sdkMock.actions.loadArtifacts
      .mockReturnValueOnce(sessionA.promise)
      .mockReturnValueOnce(sessionB.promise)
      .mockReturnValueOnce(sessionARefresh.promise);

    await renderHookHost();
    await act(async () => {
      sessionA.resolve({ artifacts: [artifact('from-session-a')] });
      await sessionA.promise;
    });
    expect(latestState?.artifacts.map((item) => item.id)).toEqual([
      'from-session-a',
    ]);

    sdkMock.connection = {
      status: 'connected',
      sessionId: 'session-b',
      capabilities: { features: ['session_artifacts'] },
      catchingUp: false,
    };
    sdkMock.ownerVersion += 1;
    await rerenderHookHost();

    expect(latestState?.loading).toBe(true);
    expect(latestState?.artifacts).toEqual([]);

    await act(async () => {
      sessionB.resolve({ artifacts: [artifact('from-session-b')] });
      await sessionB.promise;
    });
    expect(latestState?.artifacts.map((item) => item.id)).toEqual([
      'from-session-b',
    ]);

    sdkMock.connection = {
      status: 'connected',
      sessionId: 'session-a',
      capabilities: { features: ['session_artifacts'] },
    };
    sdkMock.ownerVersion += 1;
    await rerenderHookHost();

    expect(latestState?.loading).toBe(false);
    expect(latestState?.artifacts.map((item) => item.id)).toEqual([
      'from-session-a',
    ]);

    await act(async () => {
      sessionARefresh.resolve({ artifacts: [artifact('updated-session-a')] });
      await sessionARefresh.promise;
    });
    expect(latestState?.artifacts.map((item) => item.id)).toEqual([
      'updated-session-a',
    ]);
  });

  it('retains at most twenty session results', async () => {
    sdkMock.actions.loadArtifacts.mockResolvedValue({ artifacts: [] });
    await renderHookHost();

    for (let index = 0; index < 21; index += 1) {
      sdkMock.connection = {
        status: 'connected',
        sessionId: `session-${index}`,
        capabilities: { features: ['session_artifacts'] },
      };
      sdkMock.ownerVersion += 1;
      await rerenderHookHost();
    }

    const reloaded = deferred<{ artifacts: DaemonSessionArtifact[] }>();
    sdkMock.actions.loadArtifacts.mockReturnValueOnce(reloaded.promise);
    sdkMock.connection = {
      status: 'connected',
      sessionId: 'session-a',
      capabilities: { features: ['session_artifacts'] },
    };
    sdkMock.ownerVersion += 1;
    await rerenderHookHost();

    expect(latestState?.loading).toBe(true);
    await act(async () => {
      reloaded.resolve({ artifacts: [] });
      await reloaded.promise;
    });

    const retainedRefresh = deferred<{ artifacts: DaemonSessionArtifact[] }>();
    sdkMock.actions.loadArtifacts.mockReturnValueOnce(retainedRefresh.promise);
    sdkMock.connection = {
      status: 'connected',
      sessionId: 'session-20',
      capabilities: { features: ['session_artifacts'] },
    };
    sdkMock.ownerVersion += 1;
    await rerenderHookHost();

    expect(latestState?.loading).toBe(false);
    await act(async () => {
      retainedRefresh.resolve({ artifacts: [] });
      await retainedRefresh.promise;
    });
  });

  it('keeps current artifacts visible while refreshing the same session', async () => {
    const initialLoad = deferred<{ artifacts: DaemonSessionArtifact[] }>();
    const refreshLoad = deferred<{ artifacts: DaemonSessionArtifact[] }>();
    sdkMock.actions.loadArtifacts
      .mockReturnValueOnce(initialLoad.promise)
      .mockReturnValueOnce(refreshLoad.promise);

    await renderHookHost();
    await act(async () => {
      initialLoad.resolve({ artifacts: [artifact('current-artifact')] });
      await initialLoad.promise;
    });

    sdkMock.artifactsVersion = 1;
    await rerenderHookHost();

    expect(latestState?.loading).toBe(false);
    expect(latestState?.artifacts.map((item) => item.id)).toEqual([
      'current-artifact',
    ]);

    await act(async () => {
      refreshLoad.resolve({ artifacts: [artifact('refreshed-artifact')] });
      await refreshLoad.promise;
    });
    expect(latestState?.artifacts.map((item) => item.id)).toEqual([
      'refreshed-artifact',
    ]);
  });

  it('keeps cached artifacts visible and reconciles after reconnect with the same owner', async () => {
    const reconcileLoad = deferred<{ artifacts: DaemonSessionArtifact[] }>();
    sdkMock.actions.loadArtifacts
      .mockResolvedValueOnce({ artifacts: [artifact('cached-artifact')] })
      .mockReturnValueOnce(reconcileLoad.promise);
    await renderHookHost();
    const cachedArtifacts = latestState?.artifacts;

    for (const status of ['disconnected', 'connecting']) {
      sdkMock.connection.status = status;
      await rerenderHookHost();
      expect(latestState?.artifacts).toBe(cachedArtifacts);
      expect(latestState?.artifactById.has('cached-artifact')).toBe(true);
      expect(latestState?.loading).toBe(false);
      expect(sdkMock.actions.loadArtifacts).toHaveBeenCalledOnce();
    }

    sdkMock.connection.status = 'connected';
    await rerenderHookHost();
    expect(latestState?.artifacts).toBe(cachedArtifacts);
    expect(latestState?.hydrated).toBe(true);
    expect(sdkMock.actions.loadArtifacts).toHaveBeenCalledTimes(2);

    await act(async () => {
      reconcileLoad.resolve({ artifacts: [artifact('reconciled-artifact')] });
      await reconcileLoad.promise;
    });
    expect(latestState?.artifacts.map((item) => item.id)).toEqual([
      'reconciled-artifact',
    ]);
    expect(latestState?.hydrated).toBe(true);
  });

  it.each(['session', 'workspace'])(
    'does not show another %s artifact cache while disconnected',
    async (scope) => {
      Object.assign(sdkMock.connection, { workspaceCwd: '/workspace/a' });
      sdkMock.actions.loadArtifacts.mockResolvedValueOnce({
        artifacts: [artifact('cached-artifact')],
      });
      await renderHookHost();
      expect(latestState?.artifactById.has('cached-artifact')).toBe(true);

      sdkMock.connection.status = 'disconnected';
      Object.assign(
        sdkMock.connection,
        scope === 'session'
          ? { sessionId: 'session-b' }
          : { workspaceCwd: '/workspace/b' },
      );
      sdkMock.ownerVersion += 1;
      await rerenderHookHost();

      expect(latestState?.artifacts).toEqual([]);
      expect(latestState?.artifactById.size).toBe(0);
      expect(latestState?.hydrated).toBe(false);
      expect(sdkMock.actions.loadArtifacts).toHaveBeenCalledOnce();
    },
  );

  it('keeps an empty result visible while refreshing the same session', async () => {
    const initialLoad = deferred<{ artifacts: DaemonSessionArtifact[] }>();
    const refreshLoad = deferred<{ artifacts: DaemonSessionArtifact[] }>();
    sdkMock.actions.loadArtifacts
      .mockReturnValueOnce(initialLoad.promise)
      .mockReturnValueOnce(refreshLoad.promise);

    await renderHookHost();
    await act(async () => {
      initialLoad.resolve({ artifacts: [] });
      await initialLoad.promise;
    });

    sdkMock.artifactsVersion = 1;
    await rerenderHookHost();

    expect(latestState?.loading).toBe(false);
    expect(latestState?.artifacts).toEqual([]);

    await act(async () => {
      refreshLoad.resolve({ artifacts: [] });
      await refreshLoad.promise;
    });
  });

  it('hides cached artifacts when the daemon no longer supports them', async () => {
    sdkMock.actions.loadArtifacts.mockResolvedValue({
      artifacts: [artifact('cached-artifact')],
    });
    await renderHookHost();
    expect(latestState?.artifacts.map((item) => item.id)).toEqual([
      'cached-artifact',
    ]);

    sdkMock.connection = {
      ...sdkMock.connection,
      capabilities: { features: [] },
    };
    await rerenderHookHost();

    expect(latestState?.artifacts).toEqual([]);
    expect(sdkMock.actions.loadArtifacts).toHaveBeenCalledOnce();
  });

  it('loads a same-id replacement without waiting for the old owner', async () => {
    const oldLoad = deferred<{ artifacts: DaemonSessionArtifact[] }>();
    sdkMock.actions.loadArtifacts
      .mockReturnValueOnce(oldLoad.promise)
      .mockResolvedValueOnce({ artifacts: [artifact('replacement')] });

    await renderHookHost();
    expect(sdkMock.actions.loadArtifacts).toHaveBeenCalledOnce();

    sdkMock.ownerVersion += 1;
    await rerenderHookHost();

    expect(sdkMock.actions.loadArtifacts).toHaveBeenCalledTimes(2);
    expect(latestState?.artifacts.map((item) => item.id)).toEqual([
      'replacement',
    ]);

    await act(async () => {
      oldLoad.resolve({ artifacts: [artifact('stale')] });
      await oldLoad.promise;
    });
    expect(latestState?.artifacts.map((item) => item.id)).toEqual([
      'replacement',
    ]);
  });

  it('keeps automatic refresh failures silent and recovers on the next refresh (#7427)', async () => {
    // A transient `Failed to fetch` on an automatic refresh is noise the user
    // cannot act on. The panel keeps last-good artifacts when it has them,
    // clears `loading`, and exposes no error state.
    //
    // Every mocked load is a deferred settled explicitly inside `act` (and
    // awaited there), the same shape the pre-existing tests in this file
    // use: flushing with a bare microtask left the hook's refresh
    // continuation off the commit under full-suite parallel load, making
    // the last-good assertions intermittently see `artifacts === []`
    // (#7427 review).
    const load1 = deferred<{ artifacts: DaemonSessionArtifact[] }>();
    const load2 = deferred<{ artifacts: DaemonSessionArtifact[] }>();
    const load3 = deferred<{ artifacts: DaemonSessionArtifact[] }>();
    const load4 = deferred<{ artifacts: DaemonSessionArtifact[] }>();
    sdkMock.actions.loadArtifacts
      .mockReturnValueOnce(load1.promise)
      .mockReturnValueOnce(load2.promise)
      .mockReturnValueOnce(load3.promise)
      .mockReturnValueOnce(load4.promise);

    await renderHookHost();
    expect(sdkMock.actions.loadArtifacts).toHaveBeenCalledTimes(1);

    // Automatic refresh #1: initial mount fails before any last-good data exists.
    await act(async () => {
      load1.reject(new Error('Failed to fetch'));
      await load1.promise.catch(() => undefined);
    });
    expect(latestState?.loading).toBe(false);
    expect(latestState?.error).toBeNull();
    expect(latestState?.artifacts).toEqual([]);

    // Automatic refresh #2: artifactsVersion recovers and establishes last-good.
    sdkMock.artifactsVersion = 1;
    await rerenderHookHost();
    expect(sdkMock.actions.loadArtifacts).toHaveBeenCalledTimes(2);
    await act(async () => {
      load2.resolve({ artifacts: [artifact('current-artifact')] });
      await load2.promise;
    });
    expect(latestState?.artifacts.map((item) => item.id)).toEqual([
      'current-artifact',
    ]);
    expect(latestState?.loading).toBe(false);

    // Automatic refresh #3: artifactsVersion fails and keeps last-good.
    sdkMock.artifactsVersion = 2;
    await rerenderHookHost();
    expect(sdkMock.actions.loadArtifacts).toHaveBeenCalledTimes(3);
    await act(async () => {
      load3.reject(new Error('Failed to fetch'));
      await load3.promise.catch(() => undefined);
    });
    expect(latestState?.loading).toBe(false);
    expect(latestState?.error).toBeNull();
    expect(latestState?.artifacts.map((item) => item.id)).toEqual([
      'current-artifact',
    ]);

    // Re-rendering the same version is not a new automatic refresh.
    await rerenderHookHost();
    expect(sdkMock.actions.loadArtifacts).toHaveBeenCalledTimes(3);

    // The panel is not wedged: the next automatic refresh recovers.
    sdkMock.artifactsVersion = 3;
    await rerenderHookHost();
    expect(sdkMock.actions.loadArtifacts).toHaveBeenCalledTimes(4);
    await act(async () => {
      load4.resolve({ artifacts: [artifact('recovered-artifact')] });
      await load4.promise;
    });
    expect(latestState?.artifacts.map((item) => item.id)).toEqual([
      'recovered-artifact',
    ]);
  });

  it('keeps the empty artifacts reference stable while a load has not established an owner', async () => {
    // A session whose artifact load fails (e.g. a subagent session without an
    // artifacts endpoint) caches one empty array, so the hook must hand back
    // that stable reference. A fresh literal per render changes
    // `artifacts` identity on every render, which re-runs consumer effects
    // that depend on it and cascades into an infinite update loop.
    const load = deferred<{ artifacts: DaemonSessionArtifact[] }>();
    sdkMock.actions.loadArtifacts.mockReturnValueOnce(load.promise);

    await renderHookHost();
    await act(async () => {
      load.reject(new Error('Failed to fetch'));
      await load.promise.catch(() => undefined);
    });
    expect(latestState?.artifacts).toEqual([]);

    const firstReference = latestState?.artifacts;
    await rerenderHookHost();
    await rerenderHookHost();
    expect(latestState?.artifacts).toBe(firstReference);
  });

  it('keeps background refreshes hidden through superseded failures', async () => {
    const initialLoad = deferred<{ artifacts: DaemonSessionArtifact[] }>();
    const staleLoad = deferred<{ artifacts: DaemonSessionArtifact[] }>();
    const finalLoad = deferred<{ artifacts: DaemonSessionArtifact[] }>();
    sdkMock.actions.loadArtifacts
      .mockReturnValueOnce(initialLoad.promise)
      .mockReturnValueOnce(staleLoad.promise)
      .mockReturnValueOnce(finalLoad.promise);

    await renderHookHost();
    await act(async () => {
      initialLoad.resolve({ artifacts: [artifact('current-artifact')] });
      await initialLoad.promise;
    });

    sdkMock.artifactsVersion = 1;
    await rerenderHookHost();
    expect(latestState?.loading).toBe(false);

    sdkMock.artifactsVersion = 2;
    await rerenderHookHost();
    // The stale failure lands while the superseding load is still in flight.
    // It must neither replace the last-good data nor expose a loading state.
    await act(async () => {
      staleLoad.reject(new Error('Failed to fetch'));
      await staleLoad.promise.catch(() => undefined);
    });
    expect(latestState?.loading).toBe(false);
    expect(latestState?.artifacts.map((item) => item.id)).toEqual([
      'current-artifact',
    ]);

    await act(async () => {
      finalLoad.resolve({ artifacts: [artifact('replacement')] });
      await finalLoad.promise;
    });
    expect(latestState?.loading).toBe(false);
    expect(latestState?.artifacts.map((item) => item.id)).toEqual([
      'replacement',
    ]);
  });

  it('ignores stale success from superseded artifact refreshes', async () => {
    const initialLoad = deferred<{ artifacts: DaemonSessionArtifact[] }>();
    const staleLoad = deferred<{ artifacts: DaemonSessionArtifact[] }>();
    const finalLoad = deferred<{ artifacts: DaemonSessionArtifact[] }>();
    sdkMock.actions.loadArtifacts
      .mockReturnValueOnce(initialLoad.promise)
      .mockReturnValueOnce(staleLoad.promise)
      .mockReturnValueOnce(finalLoad.promise);

    await renderHookHost();
    await act(async () => {
      initialLoad.resolve({ artifacts: [artifact('current-artifact')] });
      await initialLoad.promise;
    });

    sdkMock.artifactsVersion = 1;
    await rerenderHookHost();
    sdkMock.artifactsVersion = 2;
    await rerenderHookHost();

    await act(async () => {
      staleLoad.resolve({ artifacts: [artifact('stale-artifact')] });
      await staleLoad.promise;
    });
    expect(latestState?.loading).toBe(false);
    expect(latestState?.artifacts.map((item) => item.id)).toEqual([
      'current-artifact',
    ]);

    await act(async () => {
      finalLoad.resolve({ artifacts: [artifact('replacement')] });
      await finalLoad.promise;
    });
    expect(latestState?.loading).toBe(false);
    expect(latestState?.artifacts.map((item) => item.id)).toEqual([
      'replacement',
    ]);
  });

  it('refreshes when the version returns to a previously-seen value (#7427)', async () => {
    // The version effect's previous-value bookkeeping must survive a
    // NON-MONOTONIC sequence: starting at a non-zero version, a return to a
    // previously-seen value is still a transition. A mutant that forgets to
    // record the seen version keeps comparing against the mount value and
    // silently skips the returning refresh (stale panel, suite green).
    const load1 = deferred<{ artifacts: DaemonSessionArtifact[] }>();
    const load2 = deferred<{ artifacts: DaemonSessionArtifact[] }>();
    const load3 = deferred<{ artifacts: DaemonSessionArtifact[] }>();
    sdkMock.actions.loadArtifacts
      .mockReturnValueOnce(load1.promise)
      .mockReturnValueOnce(load2.promise)
      .mockReturnValueOnce(load3.promise);
    sdkMock.artifactsVersion = 1;

    await renderHookHost();
    expect(sdkMock.actions.loadArtifacts).toHaveBeenCalledTimes(1);
    await act(async () => {
      load1.resolve({ artifacts: [artifact('v1')] });
      await load1.promise;
    });

    sdkMock.artifactsVersion = 2;
    await rerenderHookHost();
    expect(sdkMock.actions.loadArtifacts).toHaveBeenCalledTimes(2);
    await act(async () => {
      load2.resolve({ artifacts: [artifact('v2')] });
      await load2.promise;
    });

    // Back to a previously-seen version — must fire again.
    sdkMock.artifactsVersion = 1;
    await rerenderHookHost();
    expect(sdkMock.actions.loadArtifacts).toHaveBeenCalledTimes(3);
    await act(async () => {
      load3.resolve({ artifacts: [artifact('v1-again')] });
      await load3.promise;
    });
    expect(latestState?.artifacts.map((item) => item.id)).toEqual(['v1-again']);
  });

  it('drops an in-flight load whose session owner flipped mid-flight (#7427)', async () => {
    // The success guard is `requestId stale OR owner stale`. The requestId
    // half is exercised by the supersede tests; the OWNER half needs its own
    // pin: the provider flips `isCurrent` the instant the session switches —
    // BEFORE any re-render — so an in-flight load resolving in that window
    // passes the requestId check and only the owner check stops it from
    // painting the previous session's artifacts.
    const initialLoad = deferred<{ artifacts: DaemonSessionArtifact[] }>();
    const inFlightLoad = deferred<{ artifacts: DaemonSessionArtifact[] }>();
    sdkMock.actions.loadArtifacts
      .mockReturnValueOnce(initialLoad.promise)
      .mockReturnValueOnce(inFlightLoad.promise);

    await renderHookHost();
    await act(async () => {
      initialLoad.resolve({ artifacts: [artifact('current-artifact')] });
      await initialLoad.promise;
    });

    // Start refresh #2 via a version bump (owner captured at version 0)...
    sdkMock.artifactsVersion = 1;
    await rerenderHookHost();
    expect(sdkMock.actions.loadArtifacts).toHaveBeenCalledTimes(2);

    // ...then the session flips mid-flight, without a re-render landing yet.
    sdkMock.ownerVersion += 1;
    await act(async () => {
      inFlightLoad.resolve({ artifacts: [artifact('stale')] });
      await inFlightLoad.promise;
      // Restore before the act finishes so later assertions see a clean
      // owner; the guard already evaluated against the flipped value.
      sdkMock.ownerVersion = 0;
    });
    expect(latestState?.artifacts.map((item) => item.id)).toEqual([
      'current-artifact',
    ]);
  });

  it('reconciles after same-session catch-up without clearing last-good artifacts', async () => {
    const initialLoad = deferred<{ artifacts: DaemonSessionArtifact[] }>();
    const reconcileLoad = deferred<{ artifacts: DaemonSessionArtifact[] }>();
    sdkMock.actions.loadArtifacts
      .mockReturnValueOnce(initialLoad.promise)
      .mockReturnValueOnce(reconcileLoad.promise);

    await renderHookHost();
    await act(async () => {
      initialLoad.resolve({ artifacts: [artifact('current-artifact')] });
      await initialLoad.promise;
    });
    expect(sdkMock.actions.loadArtifacts).toHaveBeenCalledTimes(1);

    sdkMock.connection.catchingUp = true;
    sdkMock.artifactsVersion += 1;
    await rerenderHookHost();
    expect(latestState?.artifacts.map((item) => item.id)).toEqual([
      'current-artifact',
    ]);
    expect(sdkMock.actions.loadArtifacts).toHaveBeenCalledTimes(1);

    sdkMock.connection.catchingUp = false;
    await rerenderHookHost();
    expect(sdkMock.actions.loadArtifacts).toHaveBeenCalledTimes(2);
    await act(async () => {
      reconcileLoad.resolve({ artifacts: [artifact('reconciled-artifact')] });
      await reconcileLoad.promise;
    });
    expect(latestState?.artifacts.map((item) => item.id)).toEqual([
      'reconciled-artifact',
    ]);
  });

  it('shows the load-embedded snapshot while catching up, then the live fetch wins', async () => {
    sdkMock.connection = {
      status: 'connected',
      sessionId: 'session-a',
      capabilities: { features: ['session_artifacts'] },
      catchingUp: true,
      restoredArtifacts: [artifact('early-artifact')],
      restoredArtifactsSessionId: 'session-a',
    };
    const liveLoad = deferred<{ artifacts: DaemonSessionArtifact[] }>();
    sdkMock.actions.loadArtifacts.mockReturnValueOnce(liveLoad.promise);

    await renderHookHost();
    // The gated fetch is blocked by catchingUp, but the embedded snapshot is
    // already visible so a session-level entry can render before the replay.
    expect(sdkMock.actions.loadArtifacts).not.toHaveBeenCalled();
    expect(latestState?.artifacts.map((item) => item.id)).toEqual([
      'early-artifact',
    ]);

    sdkMock.connection.catchingUp = false;
    await rerenderHookHost();
    expect(sdkMock.actions.loadArtifacts).toHaveBeenCalledTimes(1);
    // The snapshot still supplies the list while the gated fetch is in flight,
    // so the panel must not flip to a skeleton (early-list -> spinner flicker).
    expect(latestState?.loading).toBe(false);
    expect(latestState?.artifacts.map((item) => item.id)).toEqual([
      'early-artifact',
    ]);
    await act(async () => {
      liveLoad.resolve({ artifacts: [artifact('live-artifact')] });
      await liveLoad.promise;
    });
    expect(latestState?.artifacts.map((item) => item.id)).toEqual([
      'live-artifact',
    ]);
  });

  it('does not leak the previous session snapshot after an optimistic switch to a session without artifacts', async () => {
    sdkMock.connection = {
      status: 'connected',
      sessionId: 'session-a',
      capabilities: { features: ['session_artifacts'] },
      catchingUp: true,
      restoredArtifacts: [artifact('a-only')],
      restoredArtifactsSessionId: 'session-a',
    };
    await renderHookHost();
    expect(latestState?.artifacts.map((item) => item.id)).toEqual(['a-only']);

    // Optimistic switch: sessionId moves to B while the snapshot still carries
    // A's id (the provider spreads ...current). B has no artifacts, so no new
    // snapshot lands and the gated fetch stays blocked by catchingUp.
    sdkMock.connection = {
      ...sdkMock.connection,
      sessionId: 'session-b',
    };
    await rerenderHookHost();
    expect(latestState?.artifacts).toEqual([]);
  });

  it('keeps the load-embedded snapshot when the first gated fetch fails', async () => {
    sdkMock.connection = {
      status: 'connected',
      sessionId: 'session-a',
      capabilities: { features: ['session_artifacts'] },
      catchingUp: true,
      restoredArtifacts: [artifact('early-artifact')],
      restoredArtifactsSessionId: 'session-a',
    };
    const failedLoad = deferred<{ artifacts: DaemonSessionArtifact[] }>();
    sdkMock.actions.loadArtifacts.mockReturnValueOnce(failedLoad.promise);

    await renderHookHost();
    expect(latestState?.artifacts.map((item) => item.id)).toEqual([
      'early-artifact',
    ]);

    // Catch-up clears and the gated fetch rejects once (a daemon restart or a
    // transient 5xx at exactly the moment this feature exploits). The snapshot
    // must keep showing: a cached [] would shadow it for the hook's whole life,
    // since ?? does not fall through on a defined empty array.
    sdkMock.connection.catchingUp = false;
    await rerenderHookHost();
    await act(async () => {
      failedLoad.reject(new Error('Failed to fetch'));
      await failedLoad.promise.catch(() => undefined);
    });
    expect(latestState?.artifacts.map((item) => item.id)).toEqual([
      'early-artifact',
    ]);

    // A *successful* fetch still wins over the snapshot — even an empty one,
    // because success records a hydrated owner (the fix keys on that, not on
    // the snapshot's presence alone).
    const recoveryLoad = deferred<{ artifacts: DaemonSessionArtifact[] }>();
    sdkMock.actions.loadArtifacts.mockReturnValueOnce(recoveryLoad.promise);
    sdkMock.artifactsVersion = 1;
    await rerenderHookHost();
    await act(async () => {
      recoveryLoad.resolve({ artifacts: [] });
      await recoveryLoad.promise;
    });
    expect(latestState?.artifacts).toEqual([]);
    expect(latestState?.hydrated).toBe(true);
  });

  describe('click-time artifact count hint', () => {
    it('exposes the hint while no authoritative data exists', async () => {
      sdkMock.connection = {
        status: 'connecting',
        sessionId: 'session-b',
        capabilities: { features: ['session_artifacts'] },
        artifactCountHint: 4,
        artifactCountHintSessionId: 'session-b',
      };
      await renderHookHost();
      expect(latestState?.artifactCountHint).toBe(4);
      expect(latestState?.artifacts).toEqual([]);
      expect(sdkMock.actions.loadArtifacts).not.toHaveBeenCalled();
    });

    it('withholds the hint when it belongs to another session (optimistic switch)', async () => {
      sdkMock.connection = {
        status: 'connecting',
        sessionId: 'session-b',
        capabilities: { features: ['session_artifacts'] },
        artifactCountHint: 4,
        artifactCountHintSessionId: 'session-a',
      };
      await renderHookHost();
      expect(latestState?.artifactCountHint).toBeUndefined();
    });

    it('ignores a zero hint (no entry to show)', async () => {
      sdkMock.connection = {
        status: 'connecting',
        sessionId: 'session-b',
        capabilities: { features: ['session_artifacts'] },
        artifactCountHint: 0,
        artifactCountHintSessionId: 'session-b',
      };
      await renderHookHost();
      expect(latestState?.artifactCountHint).toBeUndefined();
    });

    it('retires the hint once the keyed restored snapshot lands', async () => {
      sdkMock.connection = {
        status: 'connected',
        sessionId: 'session-b',
        capabilities: { features: ['session_artifacts'] },
        catchingUp: true,
        artifactCountHint: 4,
        artifactCountHintSessionId: 'session-b',
      };
      await renderHookHost();
      expect(latestState?.artifactCountHint).toBe(4);

      sdkMock.connection.restoredArtifacts = [artifact('restored')];
      sdkMock.connection.restoredArtifactsSessionId = 'session-b';
      await rerenderHookHost();
      expect(latestState?.artifactCountHint).toBeUndefined();
      expect(latestState?.artifacts.map((item) => item.id)).toEqual([
        'restored',
      ]);
    });

    it('retires the hint once the gated fetch caches a list, even an empty one', async () => {
      sdkMock.connection = {
        status: 'connected',
        sessionId: 'session-b',
        capabilities: { features: ['session_artifacts'] },
        catchingUp: false,
        artifactCountHint: 4,
        artifactCountHintSessionId: 'session-b',
      };
      const load = deferred<{ artifacts: DaemonSessionArtifact[] }>();
      sdkMock.actions.loadArtifacts.mockReturnValueOnce(load.promise);
      await renderHookHost();
      expect(latestState?.artifactCountHint).toBe(4);

      await act(async () => {
        load.resolve({ artifacts: [] });
        await load.promise;
      });
      expect(latestState?.artifactCountHint).toBeUndefined();
      expect(latestState?.artifacts).toEqual([]);
    });
  });
});
