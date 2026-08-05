/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { AGENT_VIEW_PROTOCOL_VERSION } from './protocol.js';
import {
  getAgentViewSessionPaths,
  removeAgentViewRosterEntry,
  upsertAgentViewRosterEntry,
  writeAgentViewActivity,
  writeAgentViewLaunch,
  writeAgentViewSessionState,
  writeAgentViewWorker,
} from './supervisor-store.js';
import { createAgentViewWorkerSidebandEnv } from './worker-sideband.js';
import {
  buildCurrentQwenCliArgv,
  getCurrentQwenCliEntrypoint,
} from './current-cli-argv.js';

interface DispatchOptions {
  globalDir?: string;
  sidebandEndpoint?: string;
  token?: string;
}

export async function dispatchAgentViewSession(
  prompt: string,
  cwd: string,
  options: DispatchOptions = {},
): Promise<{ sessionId: string; state: 'created' }> {
  const sessionId = randomUUID();
  const token = options.token ?? randomUUID();
  const now = new Date().toISOString();
  const resolvedCwd = path.resolve(cwd);
  const state = {
    schemaVersion: 1 as const,
    sessionId,
    ownership: 'managed' as const,
    sessionState: 'starting' as const,
    processState: 'starting' as const,
    attachState: 'detached' as const,
    projectCwd: resolvedCwd,
    originalCwd: resolvedCwd,
    activeCwd: resolvedCwd,
    createdAt: now,
    updatedAt: now,
    worktree: { mode: 'none' as const },
  };
  try {
    await writeAgentViewSessionState(state, options);
    await writeAgentViewLaunch(
      {
        schemaVersion: 1,
        sessionId,
        argv: buildNativeWorkerArgv(sessionId, prompt),
        env: createAgentViewWorkerSidebandEnv({
          sessionId,
          sidebandEndpoint: options.sidebandEndpoint ?? '',
          token,
          activeCwd: resolvedCwd,
        }),
        entrypoint: getCurrentQwenCliEntrypoint(),
        projectCwd: resolvedCwd,
        activeCwd: resolvedCwd,
        includeDirectories: [],
        terminal: {
          columns: process.stdout.columns ?? 80,
          rows: process.stdout.rows ?? 24,
        },
        initialPrompt: prompt,
      },
      options,
    );
    await writeAgentViewActivity(
      sessionId,
      {
        schemaVersion: 1,
        summary: prompt,
        lastActivityAt: now,
        capabilities: [],
      },
      options,
    );
    await writeAgentViewWorker(
      sessionId,
      {
        schemaVersion: 1,
        protocolVersion: AGENT_VIEW_PROTOCOL_VERSION,
        platform: process.platform,
        ...(options.sidebandEndpoint
          ? { endpoint: options.sidebandEndpoint }
          : {}),
        tokenDigest: digestToken(token),
        recentOutputBytes: 0,
      },
      options,
    );
    await upsertAgentViewRosterEntry(
      {
        sessionId,
        projectCwd: resolvedCwd,
        activeCwd: resolvedCwd,
        createdAt: now,
        updatedAt: now,
      },
      options,
    );
  } catch (error) {
    await cleanupFailedDispatchCreation(sessionId, state, options);
    throw error;
  }
  return { sessionId, state: 'created' };
}

async function cleanupFailedDispatchCreation(
  sessionId: string,
  state: {
    schemaVersion: 1;
    sessionId: string;
    ownership: 'managed';
    sessionState: 'starting';
    processState: 'starting';
    attachState: 'detached';
    projectCwd: string;
    originalCwd: string;
    activeCwd: string;
    createdAt: string;
    updatedAt: string;
    worktree: { mode: 'none' };
  },
  options: DispatchOptions,
): Promise<void> {
  try {
    await writeAgentViewSessionState(
      {
        ...state,
        ownership: 'unmanaged',
        sessionState: 'failed',
        processState: 'exited',
        updatedAt: new Date().toISOString(),
      },
      options,
    );
  } catch {
    // Best-effort rollback only.
  }

  try {
    await removeAgentViewRosterEntry(sessionId, options);
  } catch {
    // Best-effort rollback only.
  }

  try {
    await fs.rm(getAgentViewSessionPaths(sessionId, options).sessionDir, {
      recursive: true,
      force: true,
    });
  } catch {
    // Best-effort rollback only.
  }
}

function digestToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function buildNativeWorkerArgv(sessionId: string, prompt: string): string[] {
  return buildCurrentQwenCliArgv([
    '--session-id',
    sessionId,
    '--prompt-interactive',
    prompt,
  ]);
}
