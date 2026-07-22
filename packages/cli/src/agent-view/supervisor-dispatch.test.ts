/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dispatchAgentViewSession } from './supervisor-dispatch.js';
import {
  readAgentViewLaunch,
  readAgentViewRoster,
  readAgentViewSessionState,
} from './supervisor-store.js';

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

  it('does not leave a roster entry when persistence fails', async () => {
    await fs.writeFile(path.join(tempDir, 'jobs'), 'blocked', 'utf8');

    await expect(
      dispatchAgentViewSession('write tests', '/repo/pkg', {
        globalDir: tempDir,
      }),
    ).rejects.toThrow();

    await expect(
      readAgentViewRoster({ globalDir: tempDir }),
    ).resolves.toEqual(expect.objectContaining({ sessions: [] }));
  });
});
