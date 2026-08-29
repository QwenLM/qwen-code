/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type {
  DaemonChannelsSnapshot,
  DaemonSessionSummary,
  DaemonWorkspaceMcpServerStatus,
  DaemonWorkspaceMcpStatus,
} from '@qwen-code/sdk/daemon';
import {
  isOverviewFacetKnown,
  isRuntimeDiscoveredFacet,
  mergeOverviewSnapshots,
  overviewFacetHasIssue,
  summarizeChannels,
  summarizeExtensions,
  summarizeHooks,
  summarizeMcp,
  summarizeSessions,
  summarizeSkills,
  type WorkspaceOverviewSnapshot,
} from './workspaceOverviewModel';

function server(
  overrides: Partial<DaemonWorkspaceMcpServerStatus>,
): DaemonWorkspaceMcpServerStatus {
  return {
    kind: 'mcp_server',
    name: 'srv',
    status: 'ok',
    transport: 'stdio',
    disabled: false,
    ...overrides,
  } as DaemonWorkspaceMcpServerStatus;
}

function mcpStatus(
  overrides: Partial<DaemonWorkspaceMcpStatus>,
): DaemonWorkspaceMcpStatus {
  return {
    v: 1,
    workspaceCwd: '/tmp/ws',
    initialized: true,
    discoveryState: 'completed',
    servers: [],
    ...overrides,
  };
}

describe('summarizeSessions', () => {
  it('counts running and attention-needing sessions', () => {
    const sessions = [
      { sessionId: 'a', workspaceCwd: '/w', hasActivePrompt: true },
      { sessionId: 'b', workspaceCwd: '/w', isWaitingForPermission: true },
      {
        sessionId: 'c',
        workspaceCwd: '/w',
        hasActivePrompt: true,
        pendingInteractionCount: 2,
      },
      { sessionId: 'd', workspaceCwd: '/w' },
    ] as DaemonSessionSummary[];
    expect(summarizeSessions(sessions, true)).toEqual({
      total: 4,
      running: 2,
      attention: 2,
      truncated: true,
    });
  });

  it('counts a session waiting on a user question as needing attention', () => {
    // Live state carries isWaitingForUserQuestion without a pending
    // interaction count, so the flag must count on its own.
    const sessions = [
      { sessionId: 'a', workspaceCwd: '/w', isWaitingForUserQuestion: true },
    ] as DaemonSessionSummary[];
    expect(summarizeSessions(sessions)).toEqual({
      total: 1,
      running: 0,
      attention: 1,
      truncated: false,
    });
  });
});

describe('summarizeHooks', () => {
  it('counts hooks and carries the disabled flag', () => {
    expect(
      summarizeHooks({
        v: 1,
        workspaceCwd: '/w',
        initialized: true,
        disabled: true,
        hooks: [{ name: 'a' }, { name: 'b' }] as never,
        events: { BeforeTool: {} } as never,
      }),
    ).toEqual({ initialized: true, count: 2, disabled: true });
  });

  it('keeps an uninitialized runtime unknown', () => {
    const snapshot: WorkspaceOverviewSnapshot = {
      hooks: summarizeHooks({
        v: 1,
        workspaceCwd: '/w',
        initialized: false,
        disabled: false,
        hooks: [],
        events: {},
      }),
      fetchedAt: 1,
    };
    expect(isOverviewFacetKnown(snapshot, 'hooks')).toBe(false);
    expect(
      isOverviewFacetKnown(
        {
          hooks: { initialized: true, count: 0, disabled: false },
          fetchedAt: 1,
        },
        'hooks',
      ),
    ).toBe(true);
  });
});

describe('isRuntimeDiscoveredFacet', () => {
  it('separates ACP-discovered facets from daemon-side ones', () => {
    expect(
      (['mcp', 'skills', 'hooks'] as const).map(isRuntimeDiscoveredFacet),
    ).toEqual([true, true, true]);
    expect(
      (['extensions', 'channels', 'context'] as const).map(
        isRuntimeDiscoveredFacet,
      ),
    ).toEqual([false, false, false]);
  });
});

describe('context facet', () => {
  it('treats the daemon answer for a workspace without context files as a known zero', () => {
    // The memory route is filesystem-only: `initialized: false` with no files
    // is its definitive "nothing here", not a runtime still starting.
    const snapshot: WorkspaceOverviewSnapshot = {
      context: { initialized: false, fileCount: 0, ruleCount: 0 },
      fetchedAt: 1,
    };
    expect(isOverviewFacetKnown(snapshot, 'context')).toBe(true);
    expect(isOverviewFacetKnown({ fetchedAt: 1 }, 'context')).toBe(false);
  });
});

describe('summarizeMcp', () => {
  it('separates connected, failed and disabled servers', () => {
    const summary = summarizeMcp(
      mcpStatus({
        servers: [
          server({ name: 'a', mcpStatus: 'connected' }),
          server({ name: 'b', mcpStatus: 'disconnected', status: 'error' }),
          server({ name: 'c', disabled: true, status: 'error' }),
          server({ name: 'd', mcpStatus: 'connecting' }),
        ],
      }),
    );
    expect(summary).toEqual({
      initialized: true,
      discoveryState: 'completed',
      configured: 4,
      connected: 1,
      failed: 1,
      disabled: 1,
    });
  });

  it('keeps the idle placeholder unknown rather than reporting zero', () => {
    const snapshot: WorkspaceOverviewSnapshot = {
      mcp: summarizeMcp(
        mcpStatus({ initialized: false, discoveryState: undefined }),
      ),
      fetchedAt: 1,
    };
    expect(isOverviewFacetKnown(snapshot, 'mcp')).toBe(false);
    expect(overviewFacetHasIssue(snapshot, 'mcp')).toBe(false);
  });

  it('flags an issue when a server failed or never came up after discovery', () => {
    const failed: WorkspaceOverviewSnapshot = {
      mcp: summarizeMcp(
        mcpStatus({
          servers: [server({ mcpStatus: 'disconnected', status: 'error' })],
        }),
      ),
      fetchedAt: 1,
    };
    expect(overviewFacetHasIssue(failed, 'mcp')).toBe(true);

    const notUp: WorkspaceOverviewSnapshot = {
      mcp: summarizeMcp(
        mcpStatus({
          servers: [
            server({ name: 'a', mcpStatus: 'connected' }),
            server({ name: 'b', mcpStatus: 'disconnected' }),
          ],
        }),
      ),
      fetchedAt: 1,
    };
    expect(overviewFacetHasIssue(notUp, 'mcp')).toBe(true);

    const stillDiscovering: WorkspaceOverviewSnapshot = {
      mcp: summarizeMcp(
        mcpStatus({
          discoveryState: 'in_progress',
          servers: [server({ mcpStatus: 'connecting' })],
        }),
      ),
      fetchedAt: 1,
    };
    expect(overviewFacetHasIssue(stillDiscovering, 'mcp')).toBe(false);

    // While discovery is still running, a not-yet-connected but healthy
    // server is neither failed nor an issue.
    const spinningUp = summarizeMcp(
      mcpStatus({
        discoveryState: 'in_progress',
        servers: [server({ mcpStatus: 'disconnected', status: 'ok' })],
      }),
    );
    expect(spinningUp.failed).toBe(0);
    expect(spinningUp.connected).toBe(0);
    expect(
      overviewFacetHasIssue({ mcp: spinningUp, fetchedAt: 1 }, 'mcp'),
    ).toBe(false);

    const disabledOnly: WorkspaceOverviewSnapshot = {
      mcp: summarizeMcp(mcpStatus({ servers: [server({ disabled: true })] })),
      fetchedAt: 1,
    };
    expect(overviewFacetHasIssue(disabledOnly, 'mcp')).toBe(false);
  });
});

describe('summarizeSkills / summarizeExtensions / summarizeChannels', () => {
  it('counts enabled skills', () => {
    expect(
      summarizeSkills({
        v: 1,
        workspaceCwd: '/w',
        initialized: true,
        skills: [{ name: 'a' }, { name: 'b', disabledReason: 'hard' }] as never,
      }),
    ).toEqual({ initialized: true, total: 2, enabled: 1 });
  });

  it('counts active extensions from the projection', () => {
    expect(
      summarizeExtensions({
        v: 1,
        workspaceId: 'w',
        workspaceCwd: '/w',
        trusted: true,
        desiredGeneration: 0,
        appliedGeneration: 0,
        extensions: [
          { extensionId: 'a', effectiveActivation: 'enabled' },
          { extensionId: 'b', effectiveActivation: 'disabled' },
        ] as never,
      }),
    ).toEqual({ total: 2, active: 1 });
  });

  it('counts connected and failed channel instances', () => {
    const snapshot: DaemonChannelsSnapshot = {
      revision: '1',
      instances: {
        gh: { runtime: { state: 'connected' } },
        gl: { runtime: { state: 'partial' } },
        qq: { runtime: { state: 'error', lastError: 'boom' } },
        off: { runtime: { state: 'stopped' } },
      } as never,
    };
    expect(summarizeChannels(snapshot)).toEqual({
      configured: 4,
      connected: 2,
      failed: 1,
    });
    expect(
      overviewFacetHasIssue(
        { channels: summarizeChannels(snapshot), fetchedAt: 1 },
        'channels',
      ),
    ).toBe(true);
  });
});

describe('mergeOverviewSnapshots', () => {
  it('keeps a facet from the previous round when the new round did not answer', () => {
    const previous: WorkspaceOverviewSnapshot = {
      mcp: {
        initialized: true,
        configured: 1,
        connected: 1,
        failed: 0,
        disabled: 0,
      },
      skills: { initialized: true, total: 3, enabled: 3 },
      fetchedAt: 1,
    };
    const next: WorkspaceOverviewSnapshot = {
      skills: { initialized: true, total: 4, enabled: 4 },
      fetchedAt: 2,
    };
    expect(
      mergeOverviewSnapshots(previous, next, new Set(['mcp', 'skills'])),
    ).toEqual({
      mcp: previous.mcp,
      skills: next.skills,
      fetchedAt: 2,
    });
  });

  it('drops facets that are no longer requested', () => {
    const previous: WorkspaceOverviewSnapshot = {
      skills: { initialized: true, total: 3, enabled: 3 },
      context: { initialized: true, fileCount: 1, ruleCount: 2 },
      fetchedAt: 1,
    };
    expect(
      mergeOverviewSnapshots(
        previous,
        { skills: previous.skills, fetchedAt: 2 },
        new Set(['skills']),
      ),
    ).toEqual({ skills: previous.skills, fetchedAt: 2 });
  });
});
