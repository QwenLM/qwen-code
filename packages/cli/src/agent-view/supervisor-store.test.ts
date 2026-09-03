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
  patchAgentViewSessionState,
  patchAgentViewSessionStateIf,
  readAgentViewRoster,
  readAgentViewSessionState,
  removeAgentViewRosterEntry,
  upsertAgentViewRosterEntry,
  writeAgentViewRoster,
  writeAgentViewActivity,
  writeAgentViewLaunch,
  writeAgentViewSessionState,
  writeAgentViewSupervisor,
  writeAgentViewWorker,
  readAgentViewActivity,
  readAgentViewLaunch,
  readAgentViewSupervisor,
  readAgentViewWorker,
  updateAgentViewRosterEntry,
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

  it('serializes concurrent roster upserts', async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        upsertAgentViewRosterEntry(
          rosterEntry(`session-${index}`, {
            updatedAt: `2026-07-16T00:00:${String(index).padStart(2, '0')}.000Z`,
          }),
          { globalDir: tempDir },
        ),
      ),
    );

    const roster = await readAgentViewRoster({ globalDir: tempDir });
    expect(roster.sessions).toHaveLength(20);
    expect(new Set(roster.sessions.map((entry) => entry.sessionId)).size).toBe(
      20,
    );
  });

  it('matches roster entries by sanitized session id', async () => {
    await upsertAgentViewRosterEntry(rosterEntry('MySession'), {
      globalDir: tempDir,
    });
    await upsertAgentViewRosterEntry(
      rosterEntry('mysession', {
        displayName: 'lowercase',
        updatedAt: '2026-07-16T00:00:01.000Z',
      }),
      { globalDir: tempDir },
    );
    await expect(readAgentViewRoster({ globalDir: tempDir })).resolves.toEqual(
      expect.objectContaining({
        sessions: [expect.objectContaining({ sessionId: 'mysession' })],
      }),
    );

    await expect(
      updateAgentViewRosterEntry(
        'MYSESSION',
        (entry) => ({
          ...entry,
          pinned: true,
          updatedAt: '2026-07-16T00:00:02.000Z',
        }),
        { globalDir: tempDir },
      ),
    ).resolves.toMatchObject({ sessionId: 'mysession', pinned: true });
    await expect(
      updateAgentViewRosterEntry('missing', (entry) => entry, {
        globalDir: tempDir,
      }),
    ).resolves.toBeUndefined();
    await expect(
      removeAgentViewRosterEntry('MySession', { globalDir: tempDir }),
    ).resolves.toMatchObject({ sessions: [] });
  });

  it('collapses pre-existing case-variant roster duplicates on update', async () => {
    await writeAgentViewRoster(
      {
        schemaVersion: 1,
        updatedAt: '2026-07-16T00:00:00.000Z',
        sessions: [
          rosterEntry('MySession', {
            displayName: 'upper',
            updatedAt: '2026-07-16T00:00:00.000Z',
          }),
          rosterEntry('mysession', {
            displayName: 'lower',
            updatedAt: '2026-07-16T00:00:01.000Z',
          }),
        ],
      },
      { globalDir: tempDir },
    );

    await updateAgentViewRosterEntry(
      'MYSESSION',
      (entry) => ({
        ...entry,
        displayName: 'merged',
        updatedAt: '2026-07-16T00:00:02.000Z',
      }),
      { globalDir: tempDir },
    );

    const roster = await readAgentViewRoster({ globalDir: tempDir });
    expect(roster.sessions).toEqual([
      expect.objectContaining({
        sessionId: 'mysession',
        displayName: 'merged',
      }),
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

  it('patches only the specified session state fields', async () => {
    await writeAgentViewSessionState(
      sessionState('session-1', {
        customState: 'keep',
        sessionState: 'idle',
      }),
      { globalDir: tempDir },
    );

    await patchAgentViewSessionState(
      'session-1',
      { sessionState: 'completed', updatedAt: '2026-07-16T00:00:01.000Z' },
      { globalDir: tempDir },
    );

    await expect(
      readAgentViewSessionState('session-1', { globalDir: tempDir }),
    ).resolves.toMatchObject({
      sessionId: 'session-1',
      sessionState: 'completed',
      processState: 'alive',
      customState: 'keep',
      updatedAt: '2026-07-16T00:00:01.000Z',
    });
  });

  it('does nothing when patching a session that has no state file', async () => {
    await expect(
      patchAgentViewSessionState(
        'missing',
        { sessionState: 'completed' },
        { globalDir: tempDir },
      ),
    ).resolves.toBeUndefined();
  });

  it('rejects a conditional verdict write when state is corrupt', async () => {
    const paths = getAgentViewSessionPaths('corrupt', {
      globalDir: tempDir,
    });
    fs.mkdirSync(paths.sessionDir, { recursive: true });
    fs.writeFileSync(paths.statePath, '{');

    await expect(
      patchAgentViewSessionStateIf(
        'corrupt',
        () => ({ processState: 'exited' }),
        { globalDir: tempDir },
      ),
    ).rejects.toThrow('is corrupt');
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

    const states = await listAgentViewSessionStates({ globalDir: tempDir });
    expect(states.map((state) => state.sessionId)).toEqual(['newer', 'older']);
  });

  it('isolates an unreadable session entry instead of failing the list', async () => {
    await writeAgentViewSessionState(sessionState('healthy'), {
      globalDir: tempDir,
    });
    const unreadable = getAgentViewSessionPaths('unreadable', {
      globalDir: tempDir,
    });
    fs.mkdirSync(unreadable.statePath, { recursive: true });

    const states = await listAgentViewSessionStates({ globalDir: tempDir });
    expect(states.map((state) => state.sessionId)).toEqual(['healthy']);
  });

  it('includes roster entries in session snapshots', async () => {
    await writeAgentViewSessionState(sessionState('session-1'), {
      globalDir: tempDir,
    });
    await writeAgentViewLaunch(
      {
        schemaVersion: 1,
        sessionId: 'session-1',
        argv: ['qwen'],
        env: { QWEN_AGENT_VIEW_TOKEN: 'secret' },
        entrypoint: '/tmp/qwen',
        projectCwd: tempDir,
        activeCwd: tempDir,
        includeDirectories: [],
        terminal: { columns: 80, rows: 24 },
      },
      { globalDir: tempDir },
    );
    await upsertAgentViewRosterEntry(
      rosterEntry('session-1', {
        displayName: 'Build Fix',
        pinned: true,
      }),
      { globalDir: tempDir },
    );
    await writeAgentViewWorker(
      'session-1',
      {
        schemaVersion: 1,
        hostAuthToken: 'host-secret',
        protocolVersion: 1,
        platform: process.platform,
        recentOutputBytes: 0,
      },
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
      launch: expect.objectContaining({
        env: {},
      }),
    });
    expect(snapshots[0]?.worker).toMatchObject({
      protocolVersion: 1,
      recentOutputBytes: 0,
    });
    expect(snapshots[0]?.worker).not.toHaveProperty('hostAuthToken');
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

  it('strips wrong-typed optional fields during normalization', async () => {
    const paths = getAgentViewSessionPaths('session-1', {
      globalDir: tempDir,
    });
    fs.mkdirSync(paths.sessionDir, { recursive: true });
    fs.writeFileSync(
      paths.activityPath,
      JSON.stringify({
        schemaVersion: 1,
        summary: 42,
        waitingFor: true,
        queuedPromptCount: '1',
        lastActivityAt: '2026-07-16T00:00:00.000Z',
        capabilities: ['state'],
      }),
    );
    fs.writeFileSync(
      paths.launchPath,
      JSON.stringify({
        schemaVersion: 1,
        sessionId: 'session-1',
        argv: ['qwen'],
        env: {},
        entrypoint: '/tmp/qwen',
        initialPrompt: 42,
        projectCwd: tempDir,
        activeCwd: tempDir,
        includeDirectories: [],
        terminal: { columns: 80, rows: 24 },
      }),
    );

    const activity = await readAgentViewActivity('session-1', {
      globalDir: tempDir,
    });
    expect(activity).not.toHaveProperty('summary');
    expect(activity).not.toHaveProperty('waitingFor');
    expect(activity).not.toHaveProperty('queuedPromptCount');
    const launch = await readAgentViewLaunch('session-1', {
      globalDir: tempDir,
    });
    expect(launch).not.toHaveProperty('initialPrompt');
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
