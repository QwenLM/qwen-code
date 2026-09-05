/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef, useState } from 'react';
import {
  AgentStatus,
  TeamEventType,
  isTerminalStatus,
  listTasks,
  onTasksUpdated,
  type AgentTask,
  type Config,
  type SwarmTask,
  type TeamManager,
  type TeammateExitedEvent,
  type TeammateStatusChangeEvent,
} from '@qwen-code/qwen-code-core';

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

export function useTeamAgentRoster(
  config: Config | null,
  registeredAgents: ReadonlyMap<string, unknown>,
): TeamAgentDialogEntry[] {
  const [manager, setManager] = useState<TeamManager | null>(null);
  const [tasks, setTasks] = useState<SwarmTask[]>([]);
  const [, setRevision] = useState(0);
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

  return manager
    ? buildTeamAgentRosterEntries(
        manager,
        tasks,
        terminalEndTimes.current,
        new Set(registeredAgents.keys()),
      )
    : [];
}
