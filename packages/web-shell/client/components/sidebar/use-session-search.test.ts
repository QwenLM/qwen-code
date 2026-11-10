/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonClient, DaemonSessionSummary } from '@qwen-code/sdk/daemon';
import {
  useSessionSearch,
  type SessionSearchOptions,
} from './use-session-search';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const listWorkspaceSessionsPage =
  vi.fn<DaemonClient['listWorkspaceSessionsPage']>();
const listStandaloneSessionsPage =
  vi.fn<DaemonClient['listStandaloneSessionsPage']>();
const searchWorkspaceSessions =
  vi.fn<DaemonClient['searchWorkspaceSessions']>();
const client = {
  listWorkspaceSessionsPage,
  listStandaloneSessionsPage,
  searchWorkspaceSessions,
} as unknown as DaemonClient;
let root: Root;
let container: HTMLDivElement;
let result: ReturnType<typeof useSessionSearch>;
const session = (
  sessionId: string,
  workspaceCwd = '/a',
): DaemonSessionSummary => ({
  sessionId,
  workspaceCwd,
  displayName: 'Needle session',
});
const defaults: SessionSearchOptions = {
  client,
  workspaces: [
    { cwd: '/a' },
    { cwd: '/b' },
    { cwd: '/untrusted', trusted: false },
  ],
  primaryWorkspaceCwd: '/a',
  initialSessions: [],
  includeStandalone: false,
  organizationEnabled: true,
  qualified: true,
  query: '',
};

function Host(props: SessionSearchOptions) {
  result = useSessionSearch(props);
  return null;
}
async function render(overrides: Partial<SessionSearchOptions> = {}) {
  await act(async () =>
    root.render(React.createElement(Host, { ...defaults, ...overrides })),
  );
}
async function advance(ms = 300) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  listWorkspaceSessionsPage.mockReset().mockResolvedValue({ sessions: [] });
  listStandaloneSessionsPage.mockReset().mockResolvedValue({ sessions: [] });
  searchWorkspaceSessions.mockReset().mockResolvedValue({ results: [] });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe('useSessionSearch', () => {
  it('keeps duplicate IDs qualified and never reads untrusted workspaces', async () => {
    listWorkspaceSessionsPage.mockImplementation(async (cwd) => ({
      sessions: [session('same', cwd)],
    }));
    await render();
    await advance();
    expect(result.entries.map((entry) => entry.workspaceCwd)).toEqual([
      '/a',
      '/b',
    ]);
    expect(listWorkspaceSessionsPage.mock.calls.map(([cwd]) => cwd)).toEqual([
      '/a',
      '/b',
    ]);
    expect(result.loading).toBe(false);
  });

  it('walks all pages for title queries, including pinned results', async () => {
    listWorkspaceSessionsPage.mockImplementation(async (cwd, options) => ({
      sessions:
        cwd === '/b'
          ? []
          : options?.cursor
            ? [{ ...session('older'), isPinned: true }]
            : [{ ...session('recent'), displayName: 'Other' }],
      ...(cwd === '/a' && !options?.cursor ? { nextCursor: 'next' } : {}),
    }));
    await render({ query: 'needle' });
    await advance(299);
    expect(listWorkspaceSessionsPage).not.toHaveBeenCalled();
    await advance(1);
    expect(result.entries.map((entry) => entry.session.sessionId)).toEqual([
      'older',
    ]);
    expect(listWorkspaceSessionsPage).toHaveBeenCalledWith(
      '/a',
      expect.objectContaining({
        cursor: 'next',
        view: 'organized',
        group: 'all',
        archiveState: 'active',
      }),
    );
  });

  it('preserves successful and local results on partial failure and retries', async () => {
    listWorkspaceSessionsPage.mockImplementation(async (cwd) => {
      if (cwd === '/b') throw new Error('unavailable');
      return { sessions: [session('remote')] };
    });
    await render({ initialSessions: [session('fallback', '/b')] });
    await advance();
    expect(result.failed).toBe(true);
    expect(
      result.entries.map((entry) => entry.session.sessionId).sort(),
    ).toEqual(['fallback', 'remote']);
    listWorkspaceSessionsPage.mockResolvedValue({ sessions: [] });
    await act(async () => result.retry());
    await advance();
    expect(result.failed).toBe(false);
  });

  it('drops old query responses and aborts their content request', async () => {
    let resolveOld:
      | ((value: {
          results: { session: DaemonSessionSummary; snippet: string }[];
        }) => void)
      | undefined;
    searchWorkspaceSessions.mockImplementation((cwd, query) =>
      query === 'old' && cwd === '/a'
        ? new Promise((resolve) => {
            resolveOld = resolve;
          })
        : Promise.resolve({ results: [] }),
    );
    await render({ query: 'old' });
    await advance();
    const signal = searchWorkspaceSessions.mock.calls[0][2]?.signal;
    await render({ query: 'new' });
    expect(signal?.aborted).toBe(true);
    await advance();
    await act(async () =>
      resolveOld?.({
        results: [{ session: session('stale'), snippet: 'old' }],
      }),
    );
    expect(result.entries).toEqual([]);
    expect(result.loading).toBe(false);
  });

  it('includes standalone results without a workspace route and respects source scope', async () => {
    listStandaloneSessionsPage.mockResolvedValue({
      sessions: [
        {
          ...session('standalone'),
          sourceType: 'standalone',
          context: { kind: 'standalone' },
        },
      ],
    });
    listWorkspaceSessionsPage.mockResolvedValue({
      sessions: [
        { ...session('channel'), sourceType: 'channel' },
        { ...session('live'), sourceType: 'qwen-live' },
      ],
    });
    await render({
      includeStandalone: true,
      source: 'default',
      query: 'needle',
    });
    await advance();
    expect(
      result.entries.some((entry) => entry.session.sessionId === 'channel'),
    ).toBe(false);
    const standalone = result.entries.find(
      (entry) => entry.session.sessionId === 'standalone',
    );
    expect(standalone).toBeDefined();
    expect(standalone?.workspaceCwd).toBeUndefined();
    expect(
      result.entries.some((entry) => entry.session.sessionId === 'live'),
    ).toBe(true);
  });

  it('limits legacy daemons to the primary workspace and uses local fallback', async () => {
    await render({
      client: {} as DaemonClient,
      qualified: false,
      initialSessions: [session('local'), session('secondary', '/b')],
    });
    await advance();
    expect(result.entries.map((entry) => entry.session.sessionId)).toEqual([
      'local',
    ]);
    expect(result.loading).toBe(false);
  });

  it('keeps content-only hits in their requested workspace and excludes archived hits', async () => {
    searchWorkspaceSessions.mockImplementation(async (cwd) => ({
      results: [
        {
          session: { ...session('content', cwd), displayName: 'Other title' },
          snippet: 'needle in history',
        },
        {
          session: { ...session('archived', cwd), isArchived: true },
          snippet: 'needle',
        },
      ],
    }));
    await render({ query: 'needle', source: 'default' });
    await advance();
    expect(
      result.entries.map((entry) => [
        entry.session.sessionId,
        entry.workspaceCwd,
      ]),
    ).toEqual([
      ['content', '/a'],
      ['content', '/b'],
    ]);
    await render({
      query: 'needle',
      workspaces: [{ cwd: '/a', trusted: false }, { cwd: '/b' }],
      source: 'default',
    });
    expect(result.entries).toEqual([]);
    await advance();
    expect(result.entries.map((entry) => entry.workspaceCwd)).toEqual(['/b']);
  });
});
