// @vitest-environment jsdom
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  DaemonSessionSummary,
  DaemonWorkspaceCapability,
} from '@qwen-code/sdk/daemon';
import { SESSION_LIST_PAGE_SIZE } from '../constants/sessions';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/* eslint-disable @typescript-eslint/no-explicit-any */
let capabilities: any;
let listWorkspaceSessions: ReturnType<typeof vi.fn>;
// Stable client object (per test) — the real `useWorkspace().client` is a
// memoized `DaemonClient`, and the hook depends on its identity, so an unstable
// mock would re-fire the load effect on every render (infinite loop).
let client: { listWorkspaceSessions: ReturnType<typeof vi.fn> };

vi.mock('@qwen-code/webui/daemon-react-sdk', () => ({
  useWorkspace: () => ({ client, capabilities }),
}));

const { useOtherWorkspaceSessions } = await import(
  './useOtherWorkspaceSessions'
);

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let latest: ReturnType<typeof useOtherWorkspaceSessions>;
let enabled = true;

function Harness() {
  latest = useOtherWorkspaceSessions(enabled);
  return null;
}

function render(): void {
  container = document.createElement('div');
  root = createRoot(container);
  act(() => root!.render(<Harness />));
}

// Flush the hook's async fan-out (Promise.allSettled + the effect's `.then`
// setState). Three ticks so the React state update lands inside `act`.
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function ws(
  cwd: string,
  primary: boolean,
  trusted: boolean,
): DaemonWorkspaceCapability {
  return { id: cwd, cwd, primary, trusted };
}

function session(id: string, cwd: string): DaemonSessionSummary {
  return { sessionId: id, workspaceCwd: cwd };
}

beforeEach(() => {
  enabled = true;
  capabilities = {};
  listWorkspaceSessions = vi.fn(async () => []);
  client = { listWorkspaceSessions };
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container = null;
});

describe('useOtherWorkspaceSessions', () => {
  it('does not query other workspaces when disabled', async () => {
    enabled = false;
    capabilities = {
      workspaces: [ws('/w', true, true), ws('/b', false, true)],
    };

    render();
    await flush();

    expect(latest.sessions).toEqual([]);
    expect(listWorkspaceSessions).not.toHaveBeenCalled();
  });

  it('returns [] and never queries the daemon without a workspaces list', async () => {
    render();
    await flush();
    expect(latest.sessions).toEqual([]);
    expect(listWorkspaceSessions).not.toHaveBeenCalled();
  });

  it('lists only non-primary, trusted workspaces (live/active)', async () => {
    capabilities = {
      workspaces: [
        ws('/w', true, true), // primary → skipped
        ws('/b', false, true), // listed
        ws('/c', false, false), // untrusted → skipped
      ],
    };
    listWorkspaceSessions.mockImplementation(async (cwd: string) =>
      cwd === '/b' ? [session('b1', '/b')] : [],
    );
    render();
    await flush();
    expect(listWorkspaceSessions).toHaveBeenCalledTimes(1);
    expect(listWorkspaceSessions).toHaveBeenCalledWith('/b', {
      pageSize: SESSION_LIST_PAGE_SIZE,
      archiveState: 'active',
    });
    expect(latest.sessions.map((s) => s.sessionId)).toEqual(['b1']);
  });

  it('merges workspaces and keeps the ones that respond when another fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    capabilities = {
      workspaces: [
        ws('/w', true, true),
        ws('/b', false, true),
        ws('/c', false, true),
      ],
    };
    listWorkspaceSessions.mockImplementation(async (cwd: string) => {
      if (cwd === '/b') return [session('b1', '/b')];
      throw new Error('workspace /c is unreachable');
    });
    render();
    await flush();
    // /b's session survives even though /c rejected.
    expect(latest.sessions.map((s) => s.sessionId)).toEqual(['b1']);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('re-fetches the target workspaces when reload() is called', async () => {
    capabilities = {
      workspaces: [ws('/w', true, true), ws('/b', false, true)],
    };
    listWorkspaceSessions.mockResolvedValue([session('b1', '/b')]);
    render();
    await flush();
    expect(listWorkspaceSessions).toHaveBeenCalledTimes(1);
    // The callers drive refresh via reload() (poll tick / picker open) — it must
    // fetch again.
    await act(async () => {
      await latest.reload();
    });
    expect(listWorkspaceSessions).toHaveBeenCalledTimes(2);
    expect(latest.sessions.map((s) => s.sessionId)).toEqual(['b1']);
  });

  it('discards a stale in-flight fetch when the target set changes', async () => {
    // /b resolves slowly; after the target set switches to /c (a workspace is
    // (un)registered mid-flight), the stale /b result must not overwrite /c's.
    let resolveB: (v: DaemonSessionSummary[]) => void = () => {};
    const bPending = new Promise<DaemonSessionSummary[]>((r) => {
      resolveB = r;
    });
    listWorkspaceSessions.mockImplementation(async (cwd: string) => {
      if (cwd === '/b') return bPending;
      if (cwd === '/c') return [session('c1', '/c')];
      return [];
    });

    capabilities = {
      workspaces: [ws('/w', true, true), ws('/b', false, true)],
    };
    render();
    // Do not flush — /b's fetch is still in flight (bPending is unresolved).

    // Switch the target set to /c before /b resolves.
    capabilities = {
      workspaces: [ws('/w', true, true), ws('/c', false, true)],
    };
    await act(async () => {
      root!.render(<Harness />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(latest.sessions.map((s) => s.sessionId)).toEqual(['c1']);

    // Now resolve the stale /b fetch — its `cancelled` guard must drop it, so
    // the list stays on /c's result rather than reverting to /b's.
    await act(async () => {
      resolveB([session('b1', '/b')]);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(latest.sessions.map((s) => s.sessionId)).toEqual(['c1']);
  });
});
