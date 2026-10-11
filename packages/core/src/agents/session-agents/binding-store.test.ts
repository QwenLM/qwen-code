/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Storage } from '../../config/storage.js';
import {
  MAX_TERMINAL_SESSION_AGENT_RUNS,
  findSessionAgentBinding,
  getSessionAgentsFilePath,
  isValidSessionAgentsSessionId,
  listSessionAgentsSessionIds,
  readSessionAgents,
  trimTerminalRuns,
  updateSessionAgents,
  canReuseNativeSession,
} from './binding-store.js';
import type { SessionAgentRun } from './contract.js';

const SESSION = '0f8fad5b-d9cb-469f-a165-70867728950e';
const OTHER = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const NATIVE = '16fd2706-8baf-433b-82eb-8c7fada847da';

function run(
  id: string,
  status: SessionAgentRun['status'],
  extra: Partial<SessionAgentRun> = {},
): SessionAgentRun {
  return {
    id,
    agentId: 'ag_1',
    status,
    triggerRecordIds: ['r1'],
    chainDepth: 0,
    createdAt: 1,
    attempts: 0,
    ...extra,
  };
}

describe('session agents binding store', () => {
  let runtimeDir: string;
  let projectRoot: string;

  beforeEach(async () => {
    runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-agents-'));
    projectRoot = path.join(runtimeDir, 'project');
    Storage.setRuntimeBaseDir(runtimeDir);
  });

  afterEach(async () => {
    Storage.setRuntimeBaseDir(null);
    await fs.rm(runtimeDir, { recursive: true, force: true });
  });

  it('validates session ids before building a path', () => {
    expect(isValidSessionAgentsSessionId(SESSION)).toBe(true);
    expect(isValidSessionAgentsSessionId('../etc/passwd')).toBe(false);
    expect(isValidSessionAgentsSessionId('abc')).toBe(false);
    expect(() => getSessionAgentsFilePath(projectRoot, '../x')).toThrow(
      /Invalid chat session id/,
    );
  });

  it('reads an absent file as empty and round-trips an update', async () => {
    expect(await readSessionAgents(projectRoot, SESSION)).toEqual({
      schemaVersion: 1,
      sessionId: SESSION,
      bindings: {},
      runs: [],
    });
    await updateSessionAgents(projectRoot, SESSION, (file) => {
      file.bindings['ag_1'] = { agentId: 'ag_1', readThroughRecordId: 'r9' };
      file.runs.push(run('sr_1', 'queued'));
    });
    const read = await readSessionAgents(projectRoot, SESSION);
    expect(read.bindings['ag_1']?.readThroughRecordId).toBe('r9');
    expect(read.runs.map((r) => r.id)).toEqual(['sr_1']);
    expect(await listSessionAgentsSessionIds(projectRoot)).toEqual([SESSION]);
  });

  it("round-trips squad engagements and a run's squadId", async () => {
    await updateSessionAgents(projectRoot, SESSION, (file) => {
      file.runs.push(run('sr_1', 'queued', { squadId: 'sq_1' }));
      file.squads = {
        sq_1: {
          leaderAgentId: 'ag_1',
          startedByRecordId: 'r1',
          outstandingRunIds: ['sr_2'],
          pendingWakeRunIds: ['sr_3'],
          active: true,
        },
      };
    });
    const read = await readSessionAgents(projectRoot, SESSION);
    expect(read.runs[0]?.squadId).toBe('sq_1');
    expect(read.squads?.['sq_1']).toEqual({
      leaderAgentId: 'ag_1',
      startedByRecordId: 'r1',
      outstandingRunIds: ['sr_2'],
      pendingWakeRunIds: ['sr_3'],
      active: true,
    });
    // A malformed engagement refuses the write rather than wedging reads.
    await expect(
      updateSessionAgents(projectRoot, SESSION, (file) => {
        file.squads = {
          sq_1: { leaderAgentId: 'ag_1' } as never,
        };
      }),
    ).rejects.toThrow(/Malformed/);
    await expect(
      updateSessionAgents(projectRoot, SESSION, (file) => {
        file.squads!['sq_1']!.pendingWakeRunIds = [3] as never;
      }),
    ).rejects.toThrow(/Malformed/);
  });

  it("round-trips a run's record state and refuses a malformed one", async () => {
    await updateSessionAgents(projectRoot, SESSION, (file) => {
      file.runs.push(run('sr_1', 'failed', { recorded: false }));
    });
    expect(
      (await readSessionAgents(projectRoot, SESSION)).runs[0],
    ).toMatchObject({ id: 'sr_1', recorded: false });
    await expect(
      updateSessionAgents(projectRoot, SESSION, (file) => {
        file.runs[0]!.recorded = 'no' as never;
      }),
    ).rejects.toThrow(/Malformed/);
  });

  it('writes the file with mode 0600', async () => {
    if (process.platform === 'win32') return;
    await updateSessionAgents(projectRoot, SESSION, () => {});
    const stat = await fs.stat(getSessionAgentsFilePath(projectRoot, SESSION));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('refuses a malformed file instead of treating it as empty', async () => {
    const filePath = getSessionAgentsFilePath(projectRoot, SESSION);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, '{"schemaVersion": 99}');
    await expect(readSessionAgents(projectRoot, SESSION)).rejects.toThrow(
      /schema version/,
    );
  });

  it('keeps live runs and the newest terminal runs', () => {
    const terminal = Array.from(
      { length: MAX_TERMINAL_SESSION_AGENT_RUNS + 5 },
      (_, index) => run(`t${index}`, 'completed', { endedAt: index }),
    );
    const live = run('live', 'running');
    const trimmed = trimTerminalRuns([live, ...terminal]);
    expect(trimmed).toHaveLength(MAX_TERMINAL_SESSION_AGENT_RUNS + 1);
    expect(trimmed[0]?.id).toBe('live');
    expect(trimmed.some((r) => r.id === 't0')).toBe(false);
    expect(trimmed.some((r) => r.id === `t${terminal.length - 1}`)).toBe(true);
  });

  it('never trims a terminal run whose reply was not recorded', () => {
    const terminal = Array.from(
      { length: MAX_TERMINAL_SESSION_AGENT_RUNS + 5 },
      (_, index) => run(`t${index}`, 'completed', { endedAt: index + 10 }),
    );
    const owed = run('owed', 'failed', { endedAt: 0, recorded: false });
    const trimmed = trimTerminalRuns([owed, ...terminal]);
    expect(trimmed.some((r) => r.id === 'owed')).toBe(true);
    expect(trimmed.filter((r) => r.recorded !== false)).toHaveLength(
      MAX_TERMINAL_SESSION_AGENT_RUNS,
    );
  });

  it('authorizes a planned native session only while a local run executes', async () => {
    await updateSessionAgents(projectRoot, OTHER, () => {});
    await updateSessionAgents(projectRoot, SESSION, (file) => {
      file.bindings['ag_1'] = { agentId: 'ag_1', nativeSessionId: NATIVE };
      file.runs.push(run('sr_1', 'queued'));
    });
    expect(
      await findSessionAgentBinding(projectRoot, NATIVE, 'ag_1'),
    ).toBeUndefined();

    await updateSessionAgents(projectRoot, SESSION, (file) => {
      file.runs[0]!.status = 'running';
    });
    expect(await findSessionAgentBinding(projectRoot, NATIVE, 'ag_1')).toEqual({
      chatSessionId: SESSION,
      agentId: 'ag_1',
      runId: 'sr_1',
      status: 'running',
    });
    expect(
      await findSessionAgentBinding(projectRoot, NATIVE, 'ag_2'),
    ).toBeUndefined();
    expect(
      await findSessionAgentBinding(projectRoot, undefined, 'ag_1'),
    ).toBeUndefined();

    // A leased (remote) run never authorizes a session in this daemon.
    await updateSessionAgents(projectRoot, SESSION, (file) => {
      file.runs[0]!.lease = {
        hostId: 'host_1',
        leaseId: 'l1',
        attempt: 1,
        expiresAt: 10,
      };
    });
    expect(
      await findSessionAgentBinding(projectRoot, NATIVE, 'ag_1'),
    ).toBeUndefined();
  });
});

describe('canReuseNativeSession', () => {
  it('keeps the cursor before any native session exists', () => {
    expect(canReuseNativeSession({}, 'host-b', 'claude')).toBe(true);
  });

  it('keeps the cursor on the same runtime and program', () => {
    expect(
      canReuseNativeSession(
        { runtimeId: 'host-a', program: 'claude' },
        'host-a',
        'claude',
      ),
    ).toBe(true);
  });

  it('drops the cursor when the agent moves to another runtime', () => {
    expect(
      canReuseNativeSession(
        { runtimeId: 'host-a', program: 'claude' },
        'host-b',
        'claude',
      ),
    ).toBe(false);
  });

  it('drops the cursor when the program changes', () => {
    expect(
      canReuseNativeSession(
        { runtimeId: 'host-a', program: 'claude' },
        'host-a',
        'codex',
      ),
    ).toBe(false);
  });
});
