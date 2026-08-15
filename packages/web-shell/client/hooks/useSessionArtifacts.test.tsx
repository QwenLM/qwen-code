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
  },
  promptStatus: 'idle',
  artifactsVersion: 0,
}));

vi.mock('@qwen-code/webui/daemon-react-sdk', () => ({
  useActions: () => sdkMock.actions,
  useConnection: () => sdkMock.connection,
  usePromptStatus: () => sdkMock.promptStatus,
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
  };
  sdkMock.promptStatus = 'idle';
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
    sdkMock.actions.loadArtifacts
      .mockRejectedValueOnce(new Error('Failed to fetch'))
      .mockResolvedValueOnce({ artifacts: [artifact('current-artifact')] })
      .mockRejectedValueOnce(new Error('Failed to fetch'))
      .mockRejectedValueOnce(new Error('Failed to fetch'))
      .mockResolvedValueOnce({ artifacts: [artifact('recovered-artifact')] });

    await renderHookHost();
    expect(sdkMock.actions.loadArtifacts).toHaveBeenCalledTimes(1);

    // Automatic refresh #1: initial mount fails before any last-good data exists.
    await act(async () => {
      await Promise.resolve();
    });
    expect(latestState?.loading).toBe(false);
    expect(latestState?.error).toBeNull();
    expect(latestState?.artifacts).toEqual([]);

    // Automatic refresh #2: artifactsVersion recovers and establishes last-good.
    sdkMock.artifactsVersion = 1;
    await rerenderHookHost();
    expect(sdkMock.actions.loadArtifacts).toHaveBeenCalledTimes(2);
    await act(async () => {
      await Promise.resolve();
    });
    expect(latestState?.artifacts.map((item) => item.id)).toEqual([
      'current-artifact',
    ]);
    expect(latestState?.loading).toBe(false);

    // Automatic refresh #3: prompt settling back to idle fails transiently.
    sdkMock.promptStatus = 'streaming';
    await rerenderHookHost();
    expect(sdkMock.actions.loadArtifacts).toHaveBeenCalledTimes(2);
    sdkMock.promptStatus = 'idle';
    await rerenderHookHost();
    expect(sdkMock.actions.loadArtifacts).toHaveBeenCalledTimes(3);
    await act(async () => {
      await Promise.resolve();
    });
    expect(latestState?.loading).toBe(false);
    expect(latestState?.error).toBeNull();
    expect(latestState?.artifacts.map((item) => item.id)).toEqual([
      'current-artifact',
    ]);

    // Automatic refresh #4: artifactsVersion fails and still keeps last-good.
    sdkMock.artifactsVersion = 2;
    await rerenderHookHost();
    expect(sdkMock.actions.loadArtifacts).toHaveBeenCalledTimes(4);
    await act(async () => {
      await Promise.resolve();
    });
    expect(latestState?.loading).toBe(false);
    expect(latestState?.error).toBeNull();
    expect(latestState?.artifacts.map((item) => item.id)).toEqual([
      'current-artifact',
    ]);

    // Re-rendering the same version is not a new automatic refresh.
    await rerenderHookHost();
    expect(sdkMock.actions.loadArtifacts).toHaveBeenCalledTimes(4);

    // The panel is not wedged: the next automatic refresh recovers.
    sdkMock.artifactsVersion = 3;
    await rerenderHookHost();
    expect(sdkMock.actions.loadArtifacts).toHaveBeenCalledTimes(5);
    await act(async () => {
      await Promise.resolve();
    });
    expect(latestState?.artifacts.map((item) => item.id)).toEqual([
      'recovered-artifact',
    ]);
  });

  it('ignores loading cleanup from superseded artifact refresh failures', async () => {
    const staleLoad = deferred<{ artifacts: DaemonSessionArtifact[] }>();
    sdkMock.actions.loadArtifacts
      .mockResolvedValueOnce({ artifacts: [artifact('current-artifact')] })
      .mockReturnValueOnce(staleLoad.promise)
      .mockResolvedValueOnce({ artifacts: [artifact('replacement')] });

    await renderHookHost();
    await act(async () => {
      await Promise.resolve();
    });

    sdkMock.artifactsVersion = 1;
    await rerenderHookHost();
    expect(latestState?.loading).toBe(true);

    sdkMock.artifactsVersion = 2;
    await rerenderHookHost();
    await act(async () => {
      await Promise.resolve();
    });
    expect(latestState?.loading).toBe(false);
    expect(latestState?.artifacts.map((item) => item.id)).toEqual([
      'replacement',
    ]);

    await act(async () => {
      staleLoad.reject(new Error('Failed to fetch'));
      await staleLoad.promise.catch(() => undefined);
    });
    expect(latestState?.loading).toBe(false);
    expect(latestState?.artifacts.map((item) => item.id)).toEqual([
      'replacement',
    ]);
  });
});
