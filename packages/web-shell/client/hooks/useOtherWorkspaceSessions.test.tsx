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
import { SESSION_CATALOG_ERROR_RETRY_MS } from '../session-catalog/session-catalog-store';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/* eslint-disable @typescript-eslint/no-explicit-any */
let capabilities: any;
let listWorkspaceSessionsPage: ReturnType<typeof vi.fn>;
// Stable client object (per test) — the real `useWorkspace().client` is a
// memoized `DaemonClient`, and the hook depends on its identity, so an unstable
// mock would re-fire the load effect on every render (infinite loop).
let client: { listWorkspaceSessionsPage: ReturnType<typeof vi.fn> };

vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
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
  listWorkspaceSessionsPage = vi.fn(async () => ({ sessions: [] }));
  client = { listWorkspaceSessionsPage };
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
    expect(listWorkspaceSessionsPage).not.toHaveBeenCalled();
    // A disabled fan-out certifies nothing about the other workspaces: it must
    // not report any cwd not-ready (that would block every prune in a
    // workspace-locked split).
    expect(latest.loading).toBe(false);
    expect(latest.notReadyCwds).toEqual([]);
    expect(latest.queriedCwds).toEqual([]);
  });

  it('returns [] and never queries the daemon without a workspaces list', async () => {
    render();
    await flush();
    expect(latest.sessions).toEqual([]);
    expect(listWorkspaceSessionsPage).not.toHaveBeenCalled();
  });

  it('lists only non-primary, trusted workspaces (live/active)', async () => {
    capabilities = {
      workspaces: [
        ws('/w', true, true), // primary → skipped
        ws('/b', false, true), // listed
        ws('/c', false, false), // untrusted → skipped
      ],
    };
    listWorkspaceSessionsPage.mockImplementation(async (cwd: string) =>
      cwd === '/b' ? { sessions: [session('b1', '/b')] } : { sessions: [] },
    );
    render();
    await flush();
    expect(listWorkspaceSessionsPage).toHaveBeenCalledTimes(1);
    expect(listWorkspaceSessionsPage).toHaveBeenCalledWith('/b', {
      pageSize: SESSION_LIST_PAGE_SIZE,
      archiveState: 'active',
      sourceType: 'default',
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
    listWorkspaceSessionsPage.mockImplementation(async (cwd: string) => {
      if (cwd === '/b') return { sessions: [session('b1', '/b')] };
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
    listWorkspaceSessionsPage.mockResolvedValue({
      sessions: [session('b1', '/b')],
    });
    render();
    await flush();
    expect(listWorkspaceSessionsPage).toHaveBeenCalledTimes(1);
    // The callers drive refresh via reload() (poll tick / picker open) — it must
    // fetch again.
    await act(async () => {
      await latest.reload();
    });
    expect(listWorkspaceSessionsPage).toHaveBeenCalledTimes(2);
    expect(latest.sessions.map((s) => s.sessionId)).toEqual(['b1']);
  });

  it('discards a stale in-flight fetch when the target set changes', async () => {
    // /b resolves slowly; after the target set switches to /c (a workspace is
    // (un)registered mid-flight), the stale /b result must not overwrite /c's.
    let resolveB: (v: { sessions: DaemonSessionSummary[] }) => void = () => {};
    const bPending = new Promise<{ sessions: DaemonSessionSummary[] }>((r) => {
      resolveB = r;
    });
    listWorkspaceSessionsPage.mockImplementation(async (cwd: string) => {
      if (cwd === '/b') return bPending;
      if (cwd === '/c') return { sessions: [session('c1', '/c')] };
      return { sessions: [] };
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
    // Background catalog loads intentionally share one slot, so /c waits
    // until the obsolete /b request releases it.
    expect(latest.sessions).toEqual([]);

    // Now resolve the stale /b fetch — its `cancelled` guard must drop it, so
    // the list stays on /c's result rather than reverting to /b's.
    await act(async () => {
      resolveB({ sessions: [session('b1', '/b')] });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(latest.sessions.map((s) => s.sessionId)).toEqual(['c1']);
  });

  it('reports a failed first fetch as settled-but-not-ready, then settles once the retry lands', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      capabilities = {
        workspaces: [ws('/w', true, true), ws('/b', false, true)],
      };
      let calls = 0;
      listWorkspaceSessionsPage.mockImplementation(async () => {
        calls += 1;
        if (calls === 1) throw new Error('first fetch failed');
        return { sessions: [session('b1', '/b')] };
      });
      render();
      await flush();
      // The first fetch failed: the workspace is settled (not in flight), so
      // `loading` must NOT be pinned — but it is not-ready (errored with no
      // page), so a consumer must not trust an absence from its list.
      expect(latest.loading).toBe(false);
      expect(latest.notReadyCwds).toEqual(['/b']);
      expect(latest.sessions).toEqual([]);
      // Advance past the store's error-retry window: it re-fetches /b and the
      // retry lands a page, so the fan-out can prove absence again.
      await act(async () => {
        vi.advanceTimersByTime(SESSION_CATALOG_ERROR_RETRY_MS);
      });
      await flush();
      await flush();
      expect(latest.notReadyCwds).toEqual([]);
      expect(latest.loading).toBe(false);
      expect(latest.sessions.map((s) => s.sessionId)).toEqual(['b1']);
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it('treats a truncated fan-out page as not-ready for its cwd', async () => {
    capabilities = {
      workspaces: [ws('/w', true, true), ws('/b', false, true)],
    };
    listWorkspaceSessionsPage.mockResolvedValue({
      sessions: [session('b1', '/b')],
      truncated: true,
    });
    render();
    await flush();
    // A bounded page is not proof of absence: the cwd stays not-ready even
    // though its sessions landed.
    expect(latest.queriedCwds).toEqual(['/b']);
    expect(latest.notReadyCwds).toEqual(['/b']);
    expect(latest.loading).toBe(false);
    expect(latest.sessions.map((s) => s.sessionId)).toEqual(['b1']);
  });

  it('treats a fan-out page with a next cursor as not-ready for its cwd', async () => {
    capabilities = {
      workspaces: [ws('/w', true, true), ws('/b', false, true)],
    };
    listWorkspaceSessionsPage.mockResolvedValue({
      sessions: [session('b1', '/b')],
      nextCursor: 'cursor-2',
    });
    render();
    await flush();
    expect(latest.queriedCwds).toEqual(['/b']);
    expect(latest.notReadyCwds).toEqual(['/b']);
  });

  it('treats a fan-out page whose live merge failed as not-ready for its cwd', async () => {
    capabilities = {
      workspaces: [ws('/w', true, true), ws('/b', false, true)],
    };
    listWorkspaceSessionsPage.mockResolvedValue({
      sessions: [session('b1', '/b')],
      liveMergeFailed: true,
    });
    render();
    await flush();
    expect(latest.queriedCwds).toEqual(['/b']);
    expect(latest.notReadyCwds).toEqual(['/b']);
  });

  it('treats a never-landed fan-out page as not-ready, then ready once it lands', async () => {
    capabilities = {
      workspaces: [ws('/w', true, true), ws('/b', false, true)],
    };
    let resolveB: (v: { sessions: DaemonSessionSummary[] }) => void = () => {};
    listWorkspaceSessionsPage.mockImplementation(
      () =>
        new Promise<{ sessions: DaemonSessionSummary[] }>((resolve) => {
          resolveB = resolve;
        }),
    );
    render();
    await flush();
    // The page never landed: absence from the (empty) list proves nothing.
    expect(latest.notReadyCwds).toEqual(['/b']);
    expect(latest.loading).toBe(true);
    resolveB({ sessions: [session('b1', '/b')] });
    await flush();
    expect(latest.notReadyCwds).toEqual([]);
    expect(latest.sessions.map((s) => s.sessionId)).toEqual(['b1']);
  });

  it('keeps a stale-retained fan-out page not-ready after a failed refresh', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    capabilities = {
      workspaces: [ws('/w', true, true), ws('/b', false, true)],
    };
    let calls = 0;
    listWorkspaceSessionsPage.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) return { sessions: [session('b1', '/b')] };
      throw new Error('refresh failed');
    });
    render();
    await flush();
    // A fresh, complete page: absence can be proven.
    expect(latest.notReadyCwds).toEqual([]);
    // A failed refresh retains the page but marks it stale: it is no longer a
    // fresh answer from the daemon, so absence from it proves nothing.
    await act(async () => {
      await latest.reload();
    });
    await flush();
    expect(latest.notReadyCwds).toEqual(['/b']);
    expect(latest.sessions.map((s) => s.sessionId)).toEqual(['b1']);
    warn.mockRestore();
  });

  it('treats a fan-out page mid-refresh as not-ready for its cwd', async () => {
    capabilities = {
      workspaces: [ws('/w', true, true), ws('/b', false, true)],
    };
    let calls = 0;
    listWorkspaceSessionsPage.mockImplementation(() => {
      calls += 1;
      if (calls === 1)
        return Promise.resolve({ sessions: [session('b1', '/b')] });
      return new Promise(() => {});
    });
    render();
    await flush();
    expect(latest.notReadyCwds).toEqual([]);
    // The store marks the retained page stale the moment a refresh starts,
    // with no error yet: absence from it proves nothing until it lands.
    act(() => {
      void latest.reload();
    });
    expect(latest.notReadyCwds).toEqual(['/b']);
    expect(latest.sessions.map((s) => s.sessionId)).toEqual(['b1']);
  });
});
