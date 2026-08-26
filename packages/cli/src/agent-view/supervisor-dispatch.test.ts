/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchAgentViewSession } from './supervisor-dispatch.js';
import {
  getAgentViewStorePaths,
  readAgentViewLaunch,
  readAgentViewRoster,
  readAgentViewSessionState,
} from './supervisor-store.js';

const injected = vi.hoisted(() => ({ failActivityWrite: false }));

vi.mock('./supervisor-store.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('./supervisor-store.js')>();
  return {
    ...original,
    writeAgentViewActivity: (
      ...args: Parameters<typeof original.writeAgentViewActivity>
    ) =>
      injected.failActivityWrite
        ? Promise.reject(new Error('injected activity write failure'))
        : original.writeAgentViewActivity(...args),
  };
});

describe('dispatchAgentViewSession', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-agent-view-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('writes shared-cwd launch and roster metadata', async () => {
    const result = await dispatchAgentViewSession('write tests', '/repo/pkg', {
      globalDir: tempDir,
      token: 'token',
      sidebandEndpoint: '/tmp/agent-view.sock',
    });

    const state = await readAgentViewSessionState(result.sessionId, {
      globalDir: tempDir,
    });
    const launch = await readAgentViewLaunch(result.sessionId, {
      globalDir: tempDir,
    });
    const roster = await readAgentViewRoster({ globalDir: tempDir });

    expect(state).toMatchObject({
      sessionId: result.sessionId,
      projectCwd: path.resolve('/repo/pkg'),
      originalCwd: path.resolve('/repo/pkg'),
      activeCwd: path.resolve('/repo/pkg'),
      worktree: { mode: 'none' },
    });
    expect(launch).toMatchObject({
      sessionId: result.sessionId,
      projectCwd: path.resolve('/repo/pkg'),
      activeCwd: path.resolve('/repo/pkg'),
      env: {
        QWEN_AGENT_VIEW_ACTIVE_CWD: path.resolve('/repo/pkg'),
        QWEN_AGENT_VIEW_SIDEBAND: '/tmp/agent-view.sock',
      },
    });
    expect(roster.sessions[0]).toMatchObject({
      sessionId: result.sessionId,
      projectCwd: path.resolve('/repo/pkg'),
      activeCwd: path.resolve('/repo/pkg'),
    });
  });

  it('rolls back session files and roster when a mid-dispatch write fails', async () => {
    // Fail the activity write: the session-state and launch writes have
    // already succeeded at that point, so rollback must actually remove the
    // partially written session directory. The roster upsert is the last
    // persistence step, so the roster must stay empty; this pins the
    // upsert-last ordering the rollback relies on.
    injected.failActivityWrite = true;
    try {
      await expect(
        dispatchAgentViewSession('write tests', '/repo/pkg', {
          globalDir: tempDir,
          token: 'token',
          sidebandEndpoint: '/tmp/agent-view.sock',
        }),
      ).rejects.toThrow('injected activity write failure');
    } finally {
      injected.failActivityWrite = false;
    }

    const paths = getAgentViewStorePaths({ globalDir: tempDir });
    const jobs = await fs.readdir(paths.jobsDir);
    expect(jobs).toEqual([]);
    await expect(readAgentViewRoster({ globalDir: tempDir })).resolves.toEqual(
      expect.objectContaining({ sessions: [] }),
    );
  });

  it('removes session files when roster persistence fails', async () => {
    const paths = getAgentViewStorePaths({ globalDir: tempDir });
    await fs.mkdir(path.join(paths.daemonDir, 'roster.json'), {
      recursive: true,
    });

    await expect(
      dispatchAgentViewSession('write tests', '/repo/pkg', {
        globalDir: tempDir,
        token: 'token',
        sidebandEndpoint: '/tmp/agent-view.sock',
      }),
    ).rejects.toThrow();

    const jobs = await fs.readdir(paths.jobsDir);
    expect(jobs).toEqual([]);
  });

  it('rejects oversized UTF-8 argv prompts before creating a session', async () => {
    const prompt = '你'.repeat(Math.floor((16 * 1024) / 3) + 1);

    await expect(
      dispatchAgentViewSession(prompt, '/repo/pkg', {
        globalDir: tempDir,
      }),
    ).rejects.toThrow('too large for argv');

    const paths = getAgentViewStorePaths({ globalDir: tempDir });
    await expect(fs.access(paths.jobsDir)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(readAgentViewRoster({ globalDir: tempDir })).resolves.toEqual(
      expect.objectContaining({ sessions: [] }),
    );
  });
});
