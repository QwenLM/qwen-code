/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  SessionService,
  type SessionListItem,
} from '@qwen-code/qwen-code-core';
import {
  listAgentViewSessionSnapshots,
  readAgentViewSessionState,
} from '../agent-view/supervisor-store.js';
import { readAgentViewWorkerSidebandEnv } from '../agent-view/worker-sideband.js';

export type AgentViewResumeSessionListItem = SessionListItem & {
  agentViewManaged?: boolean;
  agentViewLastResult?: string;
};

export async function listManagedAgentViewResumeSessions(): Promise<
  AgentViewResumeSessionListItem[]
> {
  const snapshots = await listAgentViewSessionSnapshots();
  return snapshots
    .filter((snapshot) => snapshot.state.ownership === 'managed')
    .map((snapshot) => {
      const prompt =
        snapshot.rosterEntry?.displayName ??
        snapshot.activity?.summary ??
        snapshot.launch?.initialPrompt ??
        snapshot.sessionId;
      return {
        sessionId: snapshot.sessionId,
        cwd: snapshot.state.projectCwd,
        startTime: snapshot.state.createdAt,
        mtime: toMtime(
          snapshot.activity?.lastActivityAt ?? snapshot.state.updatedAt,
        ),
        prompt,
        filePath: '',
        agentViewManaged: true,
        ...(snapshot.activity?.lastResult
          ? { agentViewLastResult: snapshot.activity.lastResult }
          : {}),
        ...(snapshot.rosterEntry?.displayName
          ? {
              customTitle: snapshot.rosterEntry.displayName,
              titleSource: 'manual' as const,
            }
          : {}),
      };
    });
}

export async function listAgentViewProjectResumeSessions(): Promise<
  SessionListItem[]
> {
  const sessionService = await getAgentViewProjectSessionService();
  if (!sessionService) return [];

  const result = await sessionService.listSessions({
    size: 100,
  });
  return result.items;
}

export async function getAgentViewProjectSessionService(): Promise<
  SessionService | undefined
> {
  const worker = readAgentViewWorkerSidebandEnv();
  if (!worker) return undefined;

  const state = await readAgentViewSessionState(worker.sessionId);
  if (!state?.projectCwd || state.projectCwd === state.activeCwd) {
    return undefined;
  }

  return new SessionService(state.projectCwd);
}

function toMtime(value: string): number {
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? Date.now() : time;
}
