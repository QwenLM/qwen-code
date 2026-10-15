/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { AGENT_VIEW_PROTOCOL_VERSION } from './protocol.js';
import {
  digestAgentViewWorkerToken,
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
  publishRoster?: boolean;
  promptInArgv?: boolean;
}

// activity.json is re-read on every list() poll; keep the summary a
// display-sized preview, matching the queued-prompt preview cap.
const MAX_ACTIVITY_SUMMARY_CHARS = 500;
const MAX_ARGV_PROMPT_BYTES = 16 * 1024;

export async function dispatchAgentViewSession(
  prompt: string,
  cwd: string,
  options: DispatchOptions = {},
): Promise<{ sessionId: string; state: 'created' }> {
  const sessionId = randomUUID();
  const token = options.token ?? randomUUID();
  const now = new Date().toISOString();
  const resolvedCwd = path.resolve(cwd);
  if (
    options.promptInArgv !== false &&
    Buffer.byteLength(prompt, 'utf8') > MAX_ARGV_PROMPT_BYTES
  ) {
    throw new Error(
      `Agent View prompt is too large for argv (${MAX_ARGV_PROMPT_BYTES} UTF-8 bytes maximum).`,
    );
  }
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
        argv: buildNativeWorkerArgv(
          sessionId,
          options.promptInArgv === false ? undefined : prompt,
        ),
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
        summary: prompt.slice(0, MAX_ACTIVITY_SUMMARY_CHARS),
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
        tokenDigest: digestAgentViewWorkerToken(token),
        recentOutputBytes: 0,
      },
      options,
    );
    if (options.publishRoster ?? true) {
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
    }
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
    if (options.publishRoster ?? true) {
      await removeAgentViewRosterEntry(sessionId, options);
    }
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

function buildNativeWorkerArgv(sessionId: string, prompt?: string): string[] {
  return buildCurrentQwenCliArgv([
    '--session-id',
    sessionId,
    // Attached-value form: a bare token after the flag would be re-parsed
    // by yargs when the prompt starts with '-', turning e.g. '-y' into
    // flags instead of prompt text.
    ...(prompt ? [`--prompt-interactive=${prompt}`] : []),
  ]);
}
