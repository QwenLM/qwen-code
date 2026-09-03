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
import type { DaemonSessionArtifact } from '@qwen-code/sdk/daemon';
import {
  useSessionArtifacts,
  type SessionArtifactsState,
} from './useSessionArtifacts';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

const sdkMock = vi.hoisted(() => ({
  ownerVersion: 0,
  ownerGuard: { capture: vi.fn() },
  actions: {
    loadArtifacts: vi.fn(),
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
  return null;
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
  it('clears stale artifacts while loading a different session', async () => {
    const sessionA = deferred<{ artifacts: DaemonSessionArtifact[] }>();
    const sessionB = deferred<{ artifacts: DaemonSessionArtifact[] }>();
    sdkMock.actions.loadArtifacts
      .mockReturnValueOnce(sessionA.promise)
      .mockReturnValueOnce(sessionB.promise);

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

    expect(latestState?.loading).toBe(true);
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
    // artifacts endpoint) never sets `loadedOwnerRef`, so the hook must hand
    // back one stable empty array. A fresh literal per render changes
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

  it('ignores loading cleanup from superseded artifact refresh failures', async () => {
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
    expect(latestState?.loading).toBe(true);

    sdkMock.artifactsVersion = 2;
    await rerenderHookHost();
    // The stale failure lands while the superseding load is still in
    // flight — the requestId guard must keep its cleanup from clearing
    // `loading` prematurely (R2-2, #7427 review).
    await act(async () => {
      staleLoad.reject(new Error('Failed to fetch'));
      await staleLoad.promise.catch(() => undefined);
    });
    expect(latestState?.loading).toBe(true);
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
    expect(latestState?.loading).toBe(true);
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
});
