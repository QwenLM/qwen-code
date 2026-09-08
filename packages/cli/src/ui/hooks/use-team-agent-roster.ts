/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentTask } from '@qwen-code/qwen-code-core/agents/background-tasks.js';
import {
  AgentStatus,
  isTerminalStatus,
} from '@qwen-code/qwen-code-core/agents/runtime/agent-types.js';
import {
  TeamEventType,
  type TeammateExitedEvent,
  type TeammateStatusChangeEvent,
} from '@qwen-code/qwen-code-core/agents/team/team-events.js';
import {
  listTasks,
  onTasksUpdated,
} from '@qwen-code/qwen-code-core/agents/team/tasks.js';
import type { TeamManager } from '@qwen-code/qwen-code-core/agents/team/TeamManager.js';
import type { SwarmTask } from '@qwen-code/qwen-code-core/agents/team/types.js';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';

export interface TeamAgentDialogEntry extends AgentTask {
  teamName: string;
  teamStatus: AgentStatus;
  teamColor?: string;
  teamTask?: SwarmTask;
}

export type LiveAgentDialogEntry = AgentTask | TeamAgentDialogEntry;

export function isTeamAgentDialogEntry(
  entry: LiveAgentDialogEntry,
): entry is TeamAgentDialogEntry {
  return 'teamName' in entry;
}

function panelStatus(status: AgentStatus): AgentTask['status'] {
  if (status === AgentStatus.IDLE) return 'paused';
  if (status === AgentStatus.INITIALIZING || status === AgentStatus.RUNNING) {
    return 'running';
  }
  return status;
}

export function buildTeamAgentRosterEntries(
  manager: TeamManager,
  tasks: readonly SwarmTask[],
  terminalEndTimes: Map<string, number>,
  registeredAgentIds: ReadonlySet<string>,
  now = Date.now(),
): TeamAgentDialogEntry[] {
  const team = manager.getTeamFile();
  return team.members.flatMap((member) => {
    if (!registeredAgentIds.has(member.agentId)) return [];
    const agent = manager.getAgentFromBackend(member.agentId);
    if (!agent) return [];
    const teamStatus = agent.getStatus();
    if (isTerminalStatus(teamStatus) && !terminalEndTimes.has(member.agentId)) {
      terminalEndTimes.set(member.agentId, now);
    }
    const task = tasks.find(
      (candidate) =>
        candidate.status === 'in_progress' &&
        (candidate.owner === member.agentId || candidate.owner === member.name),
    );
    return [
      {
        kind: 'agent',
        id: member.agentId,
        agentId: member.agentId,
        description:
          task?.activeForm ??
          task?.subject ??
          (teamStatus === AgentStatus.IDLE
            ? 'waiting for work'
            : (member.agentType ?? 'working')),
        status: panelStatus(teamStatus),
        startTime: member.joinedAt,
        ...(terminalEndTimes.has(member.agentId)
          ? { endTime: terminalEndTimes.get(member.agentId) }
          : {}),
        outputFile: '',
        outputOffset: 0,
        notified: false,
        abortController: new AbortController(),
        subagentType: member.name,
        model: member.model,
        isBackgrounded: false,
        pendingMessages: [],
        teamName: team.name,
        teamStatus,
        teamColor: member.color,
        teamTask: task,
      },
    ];
  });
}

/**
 * Shared identity for the no-team case. Returning a fresh `[]` would make
 * this hook's result change on every render, and `LiveAgentPanel` keys its
 * one-second elapsed-time interval on that array — a new identity each
 * render tears the interval down and recreates it before it can ever fire,
 * freezing elapsed times for every user, team or not.
 */
const NO_TEAM_ENTRIES: TeamAgentDialogEntry[] = [];

export function useTeamAgentRoster(
  config: Config | null,
  registeredAgents: ReadonlyMap<string, unknown>,
): TeamAgentDialogEntry[] {
  const [manager, setManager] = useState<TeamManager | null>(null);
  const [tasks, setTasks] = useState<SwarmTask[]>([]);
  const [revision, setRevision] = useState(0);
  const terminalEndTimes = useRef(new Map<string, number>());

  useEffect(() => {
    if (!config) return;
    let detachManager: (() => void) | undefined;
    let generation = 0;

    const attach = (next: TeamManager | null) => {
      detachManager?.();
      detachManager = undefined;
      generation += 1;
      const attachedGeneration = generation;
      terminalEndTimes.current.clear();
      setManager(next);
      setTasks([]);
      if (!next) return;

      const teamName = next.getTeamFile().name;
      const refreshTasks = () => {
        void listTasks(teamName)
          .then((snapshot) => {
            if (generation === attachedGeneration) setTasks(snapshot);
          })
          .catch(() => undefined);
      };
      const refresh = () => setRevision((value) => value + 1);
      const onStatus = (event: TeammateStatusChangeEvent) => {
        if (isTerminalStatus(event.newStatus)) {
          terminalEndTimes.current.set(event.agentId, event.timestamp);
        }
        refresh();
      };
      const onExit = (event: TeammateExitedEvent) => {
        terminalEndTimes.current.set(event.agentId, event.timestamp);
        refresh();
      };
      const emitter = next.getEventEmitter();
      emitter.on(TeamEventType.TEAMMATE_JOINED, refresh);
      emitter.on(TeamEventType.TEAMMATE_IDLE, refresh);
      emitter.on(TeamEventType.TEAMMATE_STATUS_CHANGE, onStatus);
      emitter.on(TeamEventType.TEAMMATE_EXITED, onExit);
      const unsubscribeTasks = onTasksUpdated((updatedTeamName) => {
        if (updatedTeamName === teamName) refreshTasks();
      });
      refreshTasks();
      detachManager = () => {
        emitter.off(TeamEventType.TEAMMATE_JOINED, refresh);
        emitter.off(TeamEventType.TEAMMATE_IDLE, refresh);
        emitter.off(TeamEventType.TEAMMATE_STATUS_CHANGE, onStatus);
        emitter.off(TeamEventType.TEAMMATE_EXITED, onExit);
        unsubscribeTasks();
      };
    };

    config.onTeamManagerChange(attach);
    attach(config.getTeamManager());
    return () => {
      generation += 1;
      detachManager?.();
      config.onTeamManagerChange(null, attach);
    };
  }, [config]);

  return useMemo(
    () =>
      manager
        ? buildTeamAgentRosterEntries(
            manager,
            tasks,
            terminalEndTimes.current,
            new Set(registeredAgents.keys()),
          )
        : NO_TEAM_ENTRIES,
    // `revision` is a change token, not an input: a teammate's status lives
    // on its backend agent rather than in props, so a lifecycle event is the
    // only thing that can tell this memo to re-read it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [manager, tasks, registeredAgents, revision],
  );
}
