/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ENV_CONFIG_DIR } from '../../config/brand.js';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ENV_AGENT_TEAMS } from '../../config/brand.js';
import { makeFakeConfig } from '../../test-utils/config.js';
import { _resetConfigHomeDirCache } from '../../utils/paths.js';
import { deriveSessionTeamName } from './agent-teams-feature.js';
import { readAgentTeamConfig } from './agent-team-runtime.js';

describe('Agent Team session lifecycle', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'test-team-session-'));
    vi.stubEnv(ENV_CONFIG_DIR, tempDir);
    vi.stubEnv(ENV_AGENT_TEAMS, '1');
    _resetConfigHomeDirCache();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    _resetConfigHomeDirCache();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('creates the team before teammate registration and removes it on cleanup', async () => {
    const config = makeFakeConfig({ sessionId: 'session-root-1234' });
    const teamName = deriveSessionTeamName(config.getSessionId());

    expect(config.getTaskStore().taskListId).toBe(teamName);

    await expect(config.waitForAgentTeamSession()).rejects.toThrow(
      'is not initialized',
    );
    await expect(config.initializeAgentTeamSession()).resolves.toBe(teamName);
    await expect(config.waitForAgentTeamSession()).resolves.toBe(teamName);
    await expect(readAgentTeamConfig(teamName)).resolves.toMatchObject({
      name: teamName,
      leadSessionId: config.getSessionId(),
      members: [
        expect.objectContaining({
          name: 'team-lead',
          status: 'running',
        }),
      ],
    });

    await config.cleanupAgentTeamSessions();
    await expect(readAgentTeamConfig(teamName)).resolves.toBeNull();
  });
});
