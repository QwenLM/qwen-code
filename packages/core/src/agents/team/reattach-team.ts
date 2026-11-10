/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import type { Config } from '../../config/config.js';
import { InProcessBackend } from '../backends/InProcessBackend.js';
import { atomicWriteJSON } from '../../utils/atomicFileWrite.js';
import { isPidAlive } from '../../utils/process-liveness.js';
import { getTeamFilePath, listTeamNames } from './teamHelpers.js';
import { unassignTeammateTasks } from './tasks.js';
import { clearInbox } from './mailbox.js';
import { TeamManager } from './TeamManager.js';
import { LEADER_NAME, type TeamFile } from './types.js';

export type ReattachTeamResult =
  | { status: 'owned_elsewhere'; teamName: string }
  | {
      status: 'reattached';
      teamName: string;
      deadMembers: string[];
      unassignedTaskCount: number;
    };

/**
 * Re-bind the team a previous process led for this session. Teammates ran
 * inside that process, so they are gone: the member list is emptied and
 * their in-progress tasks go back to pending, while the leader inbox keeps
 * any unread reports for the new manager to deliver.
 *
 * Returns null when the session has nothing to reattach (or lost the
 * rewrite race to another process).
 */
export async function reattachTeamForSession(
  config: Config,
): Promise<ReattachTeamResult | null> {
  if (!config.isAgentTeamEnabled() || config.getTeamManager()) return null;

  const sessionId = config.getSessionId();
  let teamFile: (TeamFile & { leadPid: number }) | undefined;
  let inspectedRaw = '';
  let bestCreatedAt = -Infinity;
  for (const name of await listTeamNames()) {
    const raw = await fs
      .readFile(getTeamFilePath(name), 'utf-8')
      .catch(() => undefined);
    if (raw === undefined) continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        parsed === null ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed)
      ) {
        continue;
      }
      const candidate = parsed as Partial<TeamFile>;
      if (
        candidate.leadSessionId !== sessionId ||
        candidate.name !== name ||
        typeof candidate.leadAgentId !== 'string' ||
        !Array.isArray(candidate.members) ||
        typeof candidate.leadPid !== 'number' ||
        candidate.leadPid <= 0
      ) {
        continue;
      }
      const createdAt =
        typeof candidate.createdAt === 'number' &&
        Number.isFinite(candidate.createdAt)
          ? candidate.createdAt
          : 0;
      if (createdAt >= bestCreatedAt) {
        teamFile = candidate as TeamFile & { leadPid: number };
        inspectedRaw = raw;
        bestCreatedAt = createdAt;
      }
    } catch {
      continue;
    }
  }
  if (!teamFile) return null;

  const teamName = teamFile.name;
  if (teamFile.leadPid !== process.pid && isPidAlive(teamFile.leadPid)) {
    return { status: 'owned_elsewhere', teamName };
  }

  const configPath = getTeamFilePath(teamName);
  const deadMembers = teamFile.members.map((m) => m.name);
  const reattached: TeamFile = {
    ...teamFile,
    leadPid: process.pid,
    members: [],
  };
  // Same generation safety as tryReclaimStaleTeam: only rewrite the exact
  // config that was inspected, otherwise another process already took it.
  const currentRaw = await fs.readFile(configPath, 'utf-8').catch(() => null);
  if (currentRaw !== inspectedRaw) return null;
  await atomicWriteJSON(configPath, reattached);

  const released = await Promise.all(
    teamFile.members.map((m) => unassignTeammateTasks(teamName, m.agentId)),
  );
  // A respawned teammate reuses the name, so it must not inherit mail that
  // was addressed to the one that died. The leader inbox is left intact.
  await Promise.all(
    teamFile.members
      .filter((m) => m.name && m.name !== LEADER_NAME)
      .map((m) => clearInbox(teamName, m.name)),
  );

  const backend = new InProcessBackend(config);
  await backend.init();
  config.setTeamManager(
    new TeamManager(backend, reattached, config.getSubagentManager(), {
      maxTeammates: config.getAgentsSettings().team?.maxTeammates,
    }),
  );
  config.setTeamContext({
    teamName,
    leadAgentId: reattached.leadAgentId,
    teammates: {},
  });

  return {
    status: 'reattached',
    teamName,
    deadMembers,
    unassignedTaskCount: released.reduce((a, b) => a + b, 0),
  };
}
