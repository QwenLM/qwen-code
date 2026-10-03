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
import {
  AGENT_VIEW_WORKER_ENV_KEYS,
  QWEN_AGENT_VIEW_INITIAL_PROMPT,
  createAgentViewWorkerSidebandEnv,
} from './worker-sideband.js';
import {
  buildCurrentQwenCliArgv,
  getCurrentQwenCliEntrypoint,
} from './current-cli-argv.js';

interface DispatchOptions {
  globalDir?: string;
  sidebandEndpoint?: string;
  token?: string;
  publishRoster?: boolean;
  /**
   * The dispatching client's environment, forwarded over the dispatch RPC:
   * the supervisor is process-global and long-lived, so without this the
   * worker inherits whichever shell first started the supervisor. Keys
   * colliding with AGENT_VIEW_WORKER_ENV_KEYS are dropped — the sideband
   * identity is minted here, never by the client.
   */
  env?: Record<string, string>;
}

// activity.json is re-read on every list() poll; keep the summary a
// display-sized preview, matching the queued-prompt preview cap.
const MAX_ACTIVITY_SUMMARY_CHARS = 500;
// The prompt travels in the worker's environment; the cap keeps the env
// block bounded (env size is shared with everything else the OS allows).
const MAX_LAUNCH_PROMPT_BYTES = 16 * 1024;

function filterClientEnv(
  env: Record<string, string> | undefined,
): Record<string, string> {
  if (!env) return {};
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if ((AGENT_VIEW_WORKER_ENV_KEYS as readonly string[]).includes(key)) {
      continue;
    }
    filtered[key] = value;
  }
  return filtered;
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
  if (Buffer.byteLength(prompt, 'utf8') > MAX_LAUNCH_PROMPT_BYTES) {
    throw new Error(
      `Agent View prompt is too large to launch (${MAX_LAUNCH_PROMPT_BYTES} UTF-8 bytes maximum).`,
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
        argv: buildNativeWorkerArgv(sessionId),
        // The prompt and the launcher's environment travel here, not in
        // argv: argv is world-readable via /proc/<pid>/cmdline for the
        // whole worker lifetime, while /proc/<pid>/environ is owner-only.
        // The sideband env and the prompt are minted here and win any
        // collision with the client's set.
        env: {
          ...filterClientEnv(options.env),
          ...createAgentViewWorkerSidebandEnv({
            sessionId,
            sidebandEndpoint: options.sidebandEndpoint ?? '',
            token,
            activeCwd: resolvedCwd,
          }),
          [QWEN_AGENT_VIEW_INITIAL_PROMPT]: prompt,
        },
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

function buildNativeWorkerArgv(sessionId: string): string[] {
  // No prompt in argv: it is world-readable for the worker's whole life.
  // The worker reads QWEN_AGENT_VIEW_INITIAL_PROMPT from its environment
  // (owner-only) into the same --prompt-interactive handling.
  return buildCurrentQwenCliArgv(['--session-id', sessionId]);
}
