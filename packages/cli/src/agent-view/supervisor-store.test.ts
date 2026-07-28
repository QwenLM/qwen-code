/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getAgentViewSessionPaths,
  getAgentViewStorePaths,
  listAgentViewSessionSnapshots,
  listAgentViewSessionStates,
  readAgentViewRoster,
  readAgentViewSessionState,
  removeAgentViewRosterEntry,
  updateAgentViewRosterEntry,
  upsertAgentViewRosterEntry,
  writeAgentViewActivity,
  writeAgentViewLaunch,
  writeAgentViewSessionState,
  writeAgentViewSupervisor,
  writeAgentViewWorker,
  readAgentViewActivity,
  readAgentViewLaunch,
  readAgentViewSupervisor,
  readAgentViewWorker,
} from './supervisor-store.js';
import type {
  AgentViewActivityFile,
  AgentViewLaunchFile,
  AgentViewRosterEntry,
  AgentViewSessionStateFile,
  AgentViewSupervisorFile,
  AgentViewWorkerFile,
} from './protocol.js';

describe('agent view supervisor store', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-agent-view-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('uses daemon and jobs directories under the global qwen dir', () => {
    expect(getAgentViewStorePaths({ globalDir: tempDir })).toEqual({
      globalDir: tempDir,
      daemonDir: path.join(tempDir, 'daemon'),
      rosterPath: path.join(tempDir, 'daemon', 'roster.json'),
      supervisorPath: path.join(tempDir, 'daemon', 'supervisor.json'),
      daemonLogPath: path.join(tempDir, 'daemon', 'daemon.log'),
      jobsDir: path.join(tempDir, 'jobs'),
    });
    expect(
      getAgentViewSessionPaths('../bad/id', { globalDir: tempDir }),
    ).toEqual({
      sessionDir: path.join(tempDir, 'jobs', 'id'),
      statePath: path.join(tempDir, 'jobs', 'id', 'state.json'),
      launchPath: path.join(tempDir, 'jobs', 'id', 'launch.json'),
      activityPath: path.join(tempDir, 'jobs', 'id', 'activity.json'),
      workerPath: path.join(tempDir, 'jobs', 'id', 'worker.json'),
      tmpDir: path.join(tempDir, 'jobs', 'id', 'tmp'),
    });
  });

  it('returns an empty roster when the file is missing or corrupt', async () => {
    await expect(readAgentViewRoster({ globalDir: tempDir })).resolves.toEqual({
      schemaVersion: 1,
      updatedAt: expect.any(String),
      sessions: [],
    });

    const paths = getAgentViewStorePaths({ globalDir: tempDir });
    fs.mkdirSync(path.dirname(paths.rosterPath), { recursive: true });
    fs.writeFileSync(paths.rosterPath, 'not json');

    await expect(readAgentViewRoster({ globalDir: tempDir })).resolves.toEqual({
      schemaVersion: 1,
      updatedAt: expect.any(String),
      sessions: [],
    });
  });

  it('upserts, sorts, and removes roster entries while preserving fields', async () => {
    await upsertAgentViewRosterEntry(
      rosterEntry('one', {
        updatedAt: '2026-07-16T00:00:00.000Z',
        custom: 'keep',
      }),
      { globalDir: tempDir },
    );
    await upsertAgentViewRosterEntry(
      rosterEntry('two', {
        pinned: true,
        updatedAt: '2026-07-16T00:00:01.000Z',
      }),
      { globalDir: tempDir },
    );
    await upsertAgentViewRosterEntry(
      rosterEntry('one', {
        displayName: 'Renamed',
        updatedAt: '2026-07-16T00:00:02.000Z',
      }),
      { globalDir: tempDir },
    );
    await upsertAgentViewRosterEntry(
      rosterEntry('three', {
        pinned: false,
        updatedAt: '2026-07-16T00:00:03.000Z',
      }),
      { globalDir: tempDir },
    );

    const roster = await readAgentViewRoster({ globalDir: tempDir });
    expect(roster.sessions.map((entry) => entry.sessionId)).toEqual([
      'two',
      'three',
      'one',
    ]);
    expect(roster.sessions[2]).toMatchObject({
      sessionId: 'one',
      displayName: 'Renamed',
      custom: 'keep',
    });

    const next = await removeAgentViewRosterEntry('two', {
      globalDir: tempDir,
    });
    expect(next.sessions.map((entry) => entry.sessionId)).toEqual([
      'three',
      'one',
    ]);
  });

  it('updates roster entries and keeps pinned entries first', async () => {
    await upsertAgentViewRosterEntry(
      rosterEntry('one', {
        updatedAt: '2026-07-16T00:00:00.000Z',
      }),
      { globalDir: tempDir },
    );
    await upsertAgentViewRosterEntry(
      rosterEntry('two', {
        updatedAt: '2026-07-16T00:00:01.000Z',
      }),
      { globalDir: tempDir },
    );

    await expect(
      updateAgentViewRosterEntry(
        'missing',
        (entry) => ({ ...entry, displayName: 'Missing' }),
        { globalDir: tempDir },
      ),
    ).resolves.toBeUndefined();

    await expect(
      updateAgentViewRosterEntry(
        'one',
        (entry) => ({
          ...entry,
          pinned: true,
          displayName: 'Pinned',
          updatedAt: '2026-07-16T00:00:02.000Z',
        }),
        { globalDir: tempDir },
      ),
    ).resolves.toMatchObject({
      sessionId: 'one',
      displayName: 'Pinned',
      pinned: true,
    });

    const roster = await readAgentViewRoster({ globalDir: tempDir });
    expect(roster.sessions.map((entry) => entry.sessionId)).toEqual([
      'one',
      'two',
    ]);
  });

  it('writes session files and preserves unknown fields on updates', async () => {
    await writeAgentViewSessionState(
      sessionState('session-1', {
        customState: 'keep',
      }),
      { globalDir: tempDir },
    );
    await writeAgentViewSessionState(
      sessionState('session-1', {
        sessionState: 'completed',
      }),
      { globalDir: tempDir },
    );

    await expect(
      readAgentViewSessionState('session-1', { globalDir: tempDir }),
    ).resolves.toMatchObject({
      sessionId: 'session-1',
      sessionState: 'completed',
      processState: 'alive',
      customState: 'keep',
    });
    expect(
      fs.existsSync(
        getAgentViewSessionPaths('session-1', { globalDir: tempDir }).tmpDir,
      ),
    ).toBe(true);
  });

  it('lists valid session states sorted by most recent update', async () => {
    await writeAgentViewSessionState(
      sessionState('older', {
        updatedAt: '2026-07-16T00:00:00.000Z',
      }),
      { globalDir: tempDir },
    );
    await writeAgentViewSessionState(
      sessionState('newer', {
        updatedAt: '2026-07-16T00:00:01.000Z',
      }),
      { globalDir: tempDir },
    );
    const invalid = getAgentViewSessionPaths('invalid', {
      globalDir: tempDir,
    });
    fs.mkdirSync(invalid.sessionDir, { recursive: true });
    fs.writeFileSync(invalid.statePath, '{"sessionId":"invalid"}');
    const paths = getAgentViewStorePaths({ globalDir: tempDir });
    fs.mkdirSync(paths.jobsDir, { recursive: true });
    fs.writeFileSync(path.join(paths.jobsDir, '.DS_Store'), 'ignored');

    const states = await listAgentViewSessionStates({ globalDir: tempDir });
    expect(states.map((state) => state.sessionId)).toEqual(['newer', 'older']);
  });

  it('includes roster entries in session snapshots', async () => {
    await writeAgentViewSessionState(sessionState('session-1'), {
      globalDir: tempDir,
    });
    await upsertAgentViewRosterEntry(
      rosterEntry('session-1', {
        displayName: 'Build Fix',
        pinned: true,
      }),
      { globalDir: tempDir },
    );

    const snapshots = await listAgentViewSessionSnapshots({
      globalDir: tempDir,
    });

    expect(snapshots[0]).toMatchObject({
      sessionId: 'session-1',
      rosterEntry: {
        sessionId: 'session-1',
        displayName: 'Build Fix',
        pinned: true,
      },
    });
  });

  it('round trips launch, activity, worker, and supervisor files', async () => {
    const launch: AgentViewLaunchFile = {
      schemaVersion: 1,
      sessionId: 'session-1',
      argv: ['--resume', 'session-1'],
      env: { QWEN_AGENT_VIEW_WORKER: '1' },
      entrypoint: '/tmp/qwen',
      projectCwd: tempDir,
      activeCwd: tempDir,
      includeDirectories: [],
      terminal: { columns: 120, rows: 40 },
      customLaunch: 'keep',
    };
    const activity: AgentViewActivityFile = {
      schemaVersion: 1,
      summary: 'done',
      lastActivityAt: '2026-07-16T00:00:00.000Z',
      capabilities: ['state'],
      customActivity: 'keep',
    };
    const worker: AgentViewWorkerFile = {
      schemaVersion: 1,
      hostPid: 123,
      hostAuthToken: 'host-secret',
      protocolVersion: 1,
      platform: process.platform,
      recentOutputBytes: 1024,
      customWorker: 'keep',
    };
    const supervisor: AgentViewSupervisorFile = {
      schemaVersion: 1,
      pid: 456,
      socketPath: path.join(tempDir, 'daemon.sock'),
      authToken: 'supervisor-secret',
      startedAt: '2026-07-16T00:00:00.000Z',
      updatedAt: '2026-07-16T00:00:00.000Z',
      protocolVersion: 1,
      customSupervisor: 'keep',
    };

    await writeAgentViewLaunch(launch, { globalDir: tempDir });
    await writeAgentViewActivity('session-1', activity, { globalDir: tempDir });
    await writeAgentViewWorker('session-1', worker, { globalDir: tempDir });
    await writeAgentViewSupervisor(supervisor, { globalDir: tempDir });

    await expect(
      readAgentViewLaunch('session-1', { globalDir: tempDir }),
    ).resolves.toMatchObject(launch);
    await expect(
      readAgentViewActivity('session-1', { globalDir: tempDir }),
    ).resolves.toMatchObject(activity);
    await expect(
      readAgentViewWorker('session-1', { globalDir: tempDir }),
    ).resolves.toMatchObject(worker);
    await expect(
      readAgentViewSupervisor({ globalDir: tempDir }),
    ).resolves.toMatchObject(supervisor);
  });

  it('normalizes session ids for case-insensitive filesystems', () => {
    expect(getAgentViewSessionPaths('ABC123', { globalDir: tempDir })).toEqual(
      getAgentViewSessionPaths('abc123', { globalDir: tempDir }),
    );
  });
});

function rosterEntry(
  sessionId: string,
  overrides: Partial<AgentViewRosterEntry> = {},
): AgentViewRosterEntry {
  return {
    sessionId,
    projectCwd: process.cwd(),
    activeCwd: process.cwd(),
    createdAt: '2026-07-16T00:00:00.000Z',
    updatedAt: '2026-07-16T00:00:00.000Z',
    ...overrides,
  };
}

function sessionState(
  sessionId: string,
  overrides: Partial<AgentViewSessionStateFile> = {},
): AgentViewSessionStateFile {
  return {
    schemaVersion: 1,
    sessionId,
    ownership: 'managed',
    sessionState: 'idle',
    processState: 'alive',
    attachState: 'detached',
    projectCwd: process.cwd(),
    originalCwd: process.cwd(),
    activeCwd: process.cwd(),
    createdAt: '2026-07-16T00:00:00.000Z',
    updatedAt: '2026-07-16T00:00:00.000Z',
    worktree: { mode: 'none' },
    ...overrides,
  };
}
