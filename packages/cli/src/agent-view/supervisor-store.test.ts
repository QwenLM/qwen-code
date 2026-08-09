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

  it('writes credential files without following a pre-placed symlink', async () => {
    if (process.platform === 'win32') return;
    const paths = getAgentViewStorePaths({ globalDir: tempDir });
    fs.mkdirSync(paths.daemonDir, { recursive: true });
    const symlinkTarget = path.join(tempDir, 'attacker-controlled.json');
    fs.writeFileSync(symlinkTarget, 'untouched');
    fs.symlinkSync(symlinkTarget, paths.supervisorPath);

    await writeAgentViewSupervisor(
      {
        schemaVersion: 1,
        pid: 1234,
        socketPath: path.join(tempDir, 'supervisor.sock'),
        authToken: 'secret-token',
        startedAt: '2026-07-17T00:00:00.000Z',
        updatedAt: '2026-07-17T00:00:00.000Z',
        protocolVersion: 1,
      },
      { globalDir: tempDir },
    );

    // The symlink target must not receive the auth token, and the store path
    // is replaced with a regular file rather than written through the link.
    expect(fs.readFileSync(symlinkTarget, 'utf8')).toBe('untouched');
    expect(fs.lstatSync(paths.supervisorPath).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(paths.supervisorPath, 'utf8')).toContain(
      'secret-token',
    );
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

  it('isolates an unreadable session entry instead of failing the list', async () => {
    await writeAgentViewSessionState(
      sessionState('healthy', { updatedAt: '2026-07-16T00:00:01.000Z' }),
      { globalDir: tempDir },
    );
    // A directory where state.json should be makes readFile fail with EISDIR,
    // which previously rejected the entire listing.
    const bad = getAgentViewSessionPaths('bad', { globalDir: tempDir });
    fs.mkdirSync(bad.statePath, { recursive: true });

    await expect(
      listAgentViewSessionStates({ globalDir: tempDir }),
    ).resolves.toMatchObject([{ sessionId: 'healthy' }]);
  });

  it('trusts the session directory name over the state file contents', async () => {
    const paths = getAgentViewStorePaths({ globalDir: tempDir });
    const sessionDir = path.join(paths.jobsDir, 'dir-alpha');
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, 'state.json'),
      JSON.stringify(sessionState('victim-session')),
    );

    const states = await listAgentViewSessionStates({ globalDir: tempDir });
    expect(states.map((state) => state.sessionId)).toEqual(['dir-alpha']);
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

  it('sanitizes a dot-only session id instead of escaping the jobs dir', () => {
    expect(
      getAgentViewSessionPaths('..', { globalDir: tempDir }).sessionDir,
    ).toBe(path.join(tempDir, 'jobs', '_'));
  });

  it('joins roster entries to snapshots case-insensitively', async () => {
    await writeAgentViewSessionState(sessionState('ABC123'), {
      globalDir: tempDir,
    });
    await upsertAgentViewRosterEntry(
      rosterEntry('ABC123', { displayName: 'Upper', pinned: true }),
      { globalDir: tempDir },
    );

    const snapshots = await listAgentViewSessionSnapshots({
      globalDir: tempDir,
    });

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      sessionId: 'abc123',
      rosterEntry: { sessionId: 'ABC123', displayName: 'Upper', pinned: true },
    });
  });

  it('preserves unknown fields from a prior writer when merging a write', async () => {
    const paths = getAgentViewSessionPaths('session-1', { globalDir: tempDir });
    fs.mkdirSync(paths.sessionDir, { recursive: true });
    fs.writeFileSync(
      paths.statePath,
      JSON.stringify({ ...sessionState('session-1'), futureField: 'keep' }),
    );

    await writeAgentViewSessionState(sessionState('session-1'), {
      globalDir: tempDir,
    });

    const raw = JSON.parse(fs.readFileSync(paths.statePath, 'utf8'));
    expect(raw.futureField).toBe('keep');
  });

  it('returns the sanitized directory name as sessionId from direct reads', async () => {
    await writeAgentViewSessionState(sessionState('MySession'), {
      globalDir: tempDir,
    });
    await writeAgentViewLaunch(
      {
        schemaVersion: 1,
        sessionId: 'MySession',
        argv: [],
        env: {},
        entrypoint: '/tmp/qwen',
        projectCwd: tempDir,
        activeCwd: tempDir,
        includeDirectories: [],
        terminal: { columns: 80, rows: 24 },
      },
      { globalDir: tempDir },
    );

    const state = await readAgentViewSessionState('MySession', {
      globalDir: tempDir,
    });
    expect(state?.sessionId).toBe('mysession');

    const launch = await readAgentViewLaunch('MySession', {
      globalDir: tempDir,
    });
    expect(launch?.sessionId).toBe('mysession');

    const listed = await listAgentViewSessionStates({ globalDir: tempDir });
    expect(listed[0]?.sessionId).toBe('mysession');
  });

  it('throws when a transient read error hits the roster during a mutation', async () => {
    const paths = getAgentViewStorePaths({ globalDir: tempDir });
    // A directory where roster.json should be makes readFile fail with EISDIR.
    fs.mkdirSync(paths.rosterPath, { recursive: true });

    await expect(
      upsertAgentViewRosterEntry(rosterEntry('one'), { globalDir: tempDir }),
    ).rejects.toThrow();
    await expect(
      removeAgentViewRosterEntry('one', { globalDir: tempDir }),
    ).rejects.toThrow();
    await expect(
      updateAgentViewRosterEntry('one', (e) => e, { globalDir: tempDir }),
    ).rejects.toThrow();
  });

  it('strips wrong-typed optional fields during activity normalization', async () => {
    const paths = getAgentViewSessionPaths('session-1', {
      globalDir: tempDir,
    });
    fs.mkdirSync(paths.sessionDir, { recursive: true });
    fs.writeFileSync(
      paths.activityPath,
      JSON.stringify({
        lastActivityAt: '2026-07-16T00:00:00.000Z',
        summary: 42,
        waitingFor: true,
        lastResult: ['wrong'],
      }),
    );

    const activity = await readAgentViewActivity('session-1', {
      globalDir: tempDir,
    });
    expect(activity?.summary).toBeUndefined();
    expect(activity?.waitingFor).toBeUndefined();
    expect(activity?.lastResult).toBeUndefined();
    expect(activity?.lastActivityAt).toBe('2026-07-16T00:00:00.000Z');
  });

  it('strips a wrong-typed authToken during supervisor normalization', async () => {
    const paths = getAgentViewStorePaths({ globalDir: tempDir });
    fs.mkdirSync(paths.daemonDir, { recursive: true });
    fs.writeFileSync(
      paths.supervisorPath,
      JSON.stringify({
        pid: 123,
        socketPath: path.join(tempDir, 'test.sock'),
        authToken: 42,
        startedAt: '2026-07-16T00:00:00.000Z',
        updatedAt: '2026-07-16T00:00:00.000Z',
      }),
    );

    const supervisor = await readAgentViewSupervisor({ globalDir: tempDir });
    expect(supervisor?.authToken).toBeUndefined();
    expect(supervisor?.pid).toBe(123);
  });

  it('deduplicates roster entries that differ only in case', async () => {
    await upsertAgentViewRosterEntry(
      rosterEntry('MySession', {
        displayName: 'First',
        updatedAt: '2026-07-16T00:00:00.000Z',
      }),
      { globalDir: tempDir },
    );
    await upsertAgentViewRosterEntry(
      rosterEntry('mysession', {
        displayName: 'Second',
        updatedAt: '2026-07-16T00:00:01.000Z',
      }),
      { globalDir: tempDir },
    );

    const roster = await readAgentViewRoster({ globalDir: tempDir });
    expect(roster.sessions).toHaveLength(1);
    expect(roster.sessions[0]).toMatchObject({
      sessionId: 'mysession',
      displayName: 'Second',
    });
  });

  it('removes roster entries case-insensitively', async () => {
    await upsertAgentViewRosterEntry(rosterEntry('MySession'), {
      globalDir: tempDir,
    });

    const next = await removeAgentViewRosterEntry('MYSESSION', {
      globalDir: tempDir,
    });
    expect(next.sessions).toHaveLength(0);
  });

  it('updates roster entries case-insensitively', async () => {
    await upsertAgentViewRosterEntry(rosterEntry('MySession'), {
      globalDir: tempDir,
    });

    const updated = await updateAgentViewRosterEntry(
      'MYSESSION',
      (entry) => ({ ...entry, displayName: 'Updated' }),
      { globalDir: tempDir },
    );
    expect(updated?.displayName).toBe('Updated');
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
