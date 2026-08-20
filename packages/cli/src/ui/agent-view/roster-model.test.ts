/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { buildAgentRosterRows } from './roster-model.js';
import type {
  AgentViewActivityFile,
  AgentViewLaunchFile,
  AgentViewRosterEntry,
  AgentViewSessionStateFile,
  AgentViewWorkerFile,
} from '../../agent-view/protocol.js';

const now = '2026-07-17T10:00:00.000Z';

describe('buildAgentRosterRows', () => {
  it('projects session state into display rows with activity and worker data', () => {
    const rows = buildAgentRosterRows({
      sessions: [
        session('alpha', {
          activeCwd: '/workspace/qwen-code/packages/cli',
          createdAt: '2026-07-17T08:30:00.000Z',
          processState: 'alive',
          sessionState: 'needs_input',
        }),
      ],
      activities: {
        alpha: activity({
          summary: 'Waiting on approval',
          waitingFor: 'user',
          lastResult: 'edited files',
          lastActivityAt: '2026-07-17T09:55:00.000Z',
        }),
      },
      workers: {
        alpha: worker({
          lastHeartbeatAt: '2026-07-17T09:59:59.000Z',
        }),
      },
      now,
    });

    expect(rows).toEqual([
      expect.objectContaining({
        sessionId: 'alpha',
        state: 'needs_input',
        stateLabel: 'Needs Input',
        stateGroup: 'needs_input',
        project: 'qwen-code',
        projectCwd: '/workspace/qwen-code',
        activeCwd: '/workspace/qwen-code/packages/cli',
        cwd: '/workspace/qwen-code/packages/cli',
        ageMs: 90 * 60 * 1000,
        ageLabel: '1h',
        alive: true,
        aliveIndicator: 'alive',
        summary: 'Waiting on approval',
        waitingFor: 'user',
        lastResult: 'edited files',
        lastActivityAt: '2026-07-17T09:55:00.000Z',
        lastHeartbeatAt: '2026-07-17T09:59:59.000Z',
      }),
    ]);
  });

  it('sorts rows by state groups, then newest first within a group', () => {
    const rows = buildAgentRosterRows({
      sessions: [
        session('failed-new', {
          sessionState: 'failed',
          createdAt: '2026-07-17T09:59:00.000Z',
        }),
        session('idle-old', {
          sessionState: 'idle',
          createdAt: '2026-07-17T08:00:00.000Z',
        }),
        session('working-old', {
          sessionState: 'working',
          createdAt: '2026-07-17T08:30:00.000Z',
        }),
        session('needs-input', {
          sessionState: 'needs_input',
          createdAt: '2026-07-17T09:00:00.000Z',
        }),
        session('working-new', {
          sessionState: 'starting',
          createdAt: '2026-07-17T09:30:00.000Z',
        }),
        session('completed', {
          sessionState: 'completed',
          createdAt: '2026-07-17T09:57:00.000Z',
        }),
        session('stopped', {
          sessionState: 'stopped',
          createdAt: '2026-07-17T09:56:00.000Z',
        }),
      ],
      now,
    });

    expect(rows.map((row) => row.sessionId)).toEqual([
      'needs-input',
      'working-new',
      'working-old',
      'failed-new',
      'completed',
      'stopped',
      'idle-old',
    ]);
  });

  it('renders an unparseable createdAt as a zero age instead of ~56 years', () => {
    const rows = buildAgentRosterRows({
      sessions: [session('broken', { createdAt: 'not-a-date' })],
      now,
    });

    expect(rows[0]).toMatchObject({ ageMs: 0, ageLabel: '0s' });
  });

  it('filters by text across identity, cwd, and summaries', () => {
    const rows = buildAgentRosterRows({
      sessions: [
        session('alpha', {
          projectCwd: '/workspace/qwen-code',
          activeCwd: '/workspace/qwen-code/packages/cli',
        }),
        session('beta', {
          projectCwd: '/workspace/other',
          activeCwd: '/workspace/other',
        }),
      ],
      activities: {
        beta: activity({ summary: 'Fix renderer crash' }),
      },
      filter: 'renderer',
      now,
    });

    expect(rows.map((row) => row.sessionId)).toEqual(['beta']);
  });

  it('filters by the title and subtitle rendered in the roster', () => {
    const byTitle = buildAgentRosterRows({
      sessions: [session('alpha')],
      launches: {
        alpha: launch('alpha', { initialPrompt: 'refactor auth module' }),
      },
      activities: {
        alpha: activity({ summary: 'Working' }),
      },
      filter: 'auth',
      now,
    });
    const bySubtitle = buildAgentRosterRows({
      sessions: [session('stopped', { sessionState: 'stopped' })],
      filter: 'stopped by user',
      now,
    });

    expect(byTitle.map((row) => row.sessionId)).toEqual(['alpha']);
    expect(bySubtitle.map((row) => row.sessionId)).toEqual(['stopped']);
  });

  it('combines text filters with s:state filters', () => {
    const rows = buildAgentRosterRows({
      sessions: [
        session('alpha', {
          sessionState: 'working',
          projectCwd: '/workspace/qwen-code',
        }),
        session('beta', {
          sessionState: 'idle',
          projectCwd: '/workspace/qwen-code',
        }),
        session('gamma', {
          sessionState: 'working',
          projectCwd: '/workspace/other',
          activeCwd: '/workspace/other',
        }),
      ],
      filter: 'qwen s:working',
      now,
    });

    expect(rows.map((row) => row.sessionId)).toEqual(['alpha']);
  });

  it('supports Claude-style s:blocked and s:done state filters', () => {
    const sessions = [
      session('blocked', { sessionState: 'needs_input' }),
      session('idle', { sessionState: 'idle' }),
      session('completed', { sessionState: 'completed' }),
      session('stopped', { sessionState: 'stopped' }),
      session('failed', { sessionState: 'failed' }),
      session('working', { sessionState: 'working' }),
    ];

    expect(
      buildAgentRosterRows({ sessions, filter: 's:blocked', now }).map(
        (row) => row.sessionId,
      ),
    ).toEqual(['blocked']);
    expect(
      buildAgentRosterRows({ sessions, filter: 's:done', now }).map(
        (row) => row.sessionId,
      ),
    ).toEqual(['completed', 'failed', 'idle', 'stopped']);
  });

  it('matches the whole Working group with s:working, including starting', () => {
    const rows = buildAgentRosterRows({
      sessions: [
        session('working-one', { sessionState: 'working' }),
        session('starting-one', { sessionState: 'starting' }),
        session('done-one', { sessionState: 'completed' }),
      ],
      filter: 's:working',
      now,
    });

    expect(rows.map((row) => row.sessionId)).toEqual([
      'starting-one',
      'working-one',
    ]);
  });

  it('sorts pinned rows first and searches display names from roster entries', () => {
    const rows = buildAgentRosterRows({
      sessions: [
        session('alpha', {
          sessionState: 'failed',
          updatedAt: '2026-07-17T09:00:00.000Z',
        }),
        session('beta', {
          sessionState: 'needs_input',
          updatedAt: '2026-07-17T09:59:00.000Z',
        }),
      ],
      rosterEntries: [
        rosterEntry('alpha', {
          displayName: 'Launchpad',
          pinned: true,
        }),
      ],
      now,
    });

    expect(rows.map((row) => row.sessionId)).toEqual(['alpha', 'beta']);
    expect(rows[0]).toMatchObject({
      sessionId: 'alpha',
      displayName: 'Launchpad',
      pinned: true,
      project: 'qwen-code',
    });

    const filtered = buildAgentRosterRows({
      sessions: [
        session('alpha'),
        session('beta', { projectCwd: '/workspace/other' }),
      ],
      rosterEntries: [rosterEntry('alpha', { displayName: 'Launchpad' })],
      filter: 'launchpad',
      now,
    });
    expect(filtered.map((row) => row.sessionId)).toEqual(['alpha']);
  });

  it('reports hibernating and offline process states without a worker summary', () => {
    const rows = buildAgentRosterRows({
      sessions: [
        session('sleeping', { processState: 'hibernated' }),
        session('gone', { processState: 'exited' }),
      ],
      now,
    });

    expect(rows).toEqual([
      expect.objectContaining({
        sessionId: 'gone',
        alive: false,
        aliveIndicator: 'offline',
      }),
      expect.objectContaining({
        sessionId: 'sleeping',
        alive: false,
        aliveIndicator: 'hibernating',
      }),
    ]);
  });
});

function session(
  sessionId: string,
  overrides: Partial<AgentViewSessionStateFile> = {},
): AgentViewSessionStateFile {
  return {
    schemaVersion: 1,
    sessionId,
    ownership: 'managed',
    sessionState: 'working',
    processState: 'alive',
    attachState: 'detached',
    projectCwd: '/workspace/qwen-code',
    originalCwd: '/workspace/qwen-code',
    activeCwd: '/workspace/qwen-code',
    createdAt: '2026-07-17T09:00:00.000Z',
    updatedAt: '2026-07-17T09:00:00.000Z',
    worktree: { mode: 'none' },
    ...overrides,
  };
}

function activity(
  overrides: Partial<AgentViewActivityFile> = {},
): AgentViewActivityFile {
  return {
    schemaVersion: 1,
    lastActivityAt: '2026-07-17T09:00:00.000Z',
    capabilities: [],
    ...overrides,
  };
}

function launch(
  sessionId: string,
  overrides: Partial<AgentViewLaunchFile> = {},
): AgentViewLaunchFile {
  return {
    schemaVersion: 1,
    sessionId,
    argv: [],
    env: {},
    entrypoint: '/tmp/qwen',
    projectCwd: '/workspace/qwen-code',
    activeCwd: '/workspace/qwen-code',
    includeDirectories: [],
    terminal: { columns: 80, rows: 24 },
    ...overrides,
  };
}

function worker(
  overrides: Partial<AgentViewWorkerFile> = {},
): AgentViewWorkerFile {
  return {
    schemaVersion: 1,
    protocolVersion: 1,
    platform: 'darwin',
    recentOutputBytes: 0,
    ...overrides,
  };
}

function rosterEntry(
  sessionId: string,
  overrides: Partial<AgentViewRosterEntry> = {},
): AgentViewRosterEntry {
  return {
    sessionId,
    projectCwd: '/workspace/qwen-code',
    activeCwd: '/workspace/qwen-code',
    createdAt: '2026-07-17T09:00:00.000Z',
    updatedAt: '2026-07-17T09:00:00.000Z',
    ...overrides,
  };
}
