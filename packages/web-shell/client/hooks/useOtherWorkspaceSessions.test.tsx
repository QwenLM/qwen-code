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

function Harness() {
  latest = useOtherWorkspaceSessions();
  return null;
}

function render(): void {
  container = document.createElement('div');
  root = createRoot(container);
  act(() => root!.render(<Harness />));
}

// Flush the hook's async fan-out (Promise.allSettled + setState).
async function flush(): Promise<void> {
  await act(async () => {
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
});
