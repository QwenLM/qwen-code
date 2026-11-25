/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type WorkflowProgressItem,
  type WorkflowUnifiedTask,
} from '@qwen-code/core';

export type WorkflowPhaseView = {
  id: string;
  index: number;
  title: string;
  detail?: string;
  totalAgents: number;
  doneAgents: number;
  status: 'pending' | 'running' | 'done' | 'error';
};

export type WorkflowAgentView = {
  id: string;
  index: number;
  label: string;
  phaseId?: string;
  phaseTitle?: string;
  state: Extract<WorkflowProgressItem, { type: 'workflow_agent' }>['state'];
  status: 'pending' | 'running' | 'done' | 'error' | 'skipped';
  agentId?: string;
  agentType?: string;
  model?: string;
  promptPreview?: string;
  resultPreview?: string;
  error?: string;
  cached?: boolean;
  skipped?: boolean;
  attempt?: number;
  maxAttempts?: number;
  prompt?: string;
  journalKey?: string;
  tokens?: number;
  toolCalls?: number;
  lastToolName?: string;
  lastToolSummary?: string;
  recentToolActivities?: string[];
  outputPath?: string;
  transcriptPath?: string;
  attemptTranscriptPaths?: string[];
  startedAt?: number;
  lastProgressAt?: number;
  durationMs?: number;
};

export type WorkflowRunView = {
  taskId: string;
  runId: string;
  name: string;
  description: string;
  status: WorkflowUnifiedTask['status'];
  elapsedMs: number;
  phases: WorkflowPhaseView[];
  agents: WorkflowAgentView[];
  agentDoneCount: number;
  agentCount: number;
  logs: string[];
  result?: unknown;
  error?: string;
  transcriptDir: string;
};

export type WorkflowRailSummary = {
  label: string;
  description: string;
  status: WorkflowUnifiedTask['status'];
  elapsed: string;
  doneAgents: number;
  agentCount: number;
};

type AgentEvent = Extract<WorkflowProgressItem, { type: 'workflow_agent' }>;
type PhaseEvent = Extract<WorkflowProgressItem, { type: 'workflow_phase' }>;

const WORKFLOW_ALL_PHASE_ID = '__all__';

export function buildWorkflowRunView(
  task: WorkflowUnifiedTask,
  now = Date.now(),
): WorkflowRunView {
  const phaseByIndex = new Map<number, WorkflowPhaseView>();

  for (const seed of task.phases ?? []) {
    const index = phaseByIndex.size + 1;
    phaseByIndex.set(index, {
      id: String(index),
      index,
      title: seed.title,
      detail: seed.detail,
      totalAgents: 0,
      doneAgents: 0,
      status: 'pending',
    });
  }

  const agentByIndex = new Map<number, WorkflowAgentView>();
  for (const item of task.progress) {
    if (isWorkflowPhaseEvent(item)) {
      phaseByIndex.set(item.index, {
        id: String(item.index),
        index: item.index,
        title: item.title,
        detail: item.detail,
        totalAgents: 0,
        doneAgents: 0,
        status: 'pending',
      });
      continue;
    }
    if (!isWorkflowAgentEvent(item)) continue;
    const previous = agentByIndex.get(item.index);
    agentByIndex.set(item.index, mergeAgentView(previous, agentEventToView(item)));
    if (
      item.phaseIndex !== undefined &&
      item.phaseTitle &&
      !phaseByIndex.has(item.phaseIndex)
    ) {
      phaseByIndex.set(item.phaseIndex, {
        id: String(item.phaseIndex),
        index: item.phaseIndex,
        title: item.phaseTitle,
        totalAgents: 0,
        doneAgents: 0,
        status: 'pending',
      });
    }
  }

  const agents = [...agentByIndex.values()].sort((a, b) => a.index - b.index);
  const phases = [...phaseByIndex.values()].sort((a, b) => a.index - b.index);
  const phaseById = new Map(phases.map((phase) => [phase.id, phase]));
  const agentsByPhase = new Map<string, WorkflowAgentView[]>();

  for (const agent of agents) {
    if (!agent.phaseId) continue;
    const phase = phaseById.get(agent.phaseId);
    if (!phase) continue;
    phase.totalAgents += 1;
    if (agent.status === 'done' || agent.status === 'skipped') {
      phase.doneAgents += 1;
    }
    const bucket = agentsByPhase.get(agent.phaseId);
    if (bucket) bucket.push(agent);
    else agentsByPhase.set(agent.phaseId, [agent]);
  }

  for (const phase of phases) {
    phase.status = derivePhaseStatus(agentsByPhase.get(phase.id) ?? []);
  }

  const fallbackAgentCount = agents.length;
  const agentCount = Math.max(task.agentCount, fallbackAgentCount);
  const agentDoneCount = agents.filter(
    (agent) => agent.status === 'done' || agent.status === 'skipped',
  ).length;

  return {
    taskId: task.id,
    runId: task.workflowRunId,
    name: task.title ?? task.workflowName,
    description: task.description,
    status: task.status,
    elapsedMs: Math.max(
      0,
      (task.status === 'running' || task.status === 'pending'
        ? now
        : task.endTime ?? now) - task.startTime,
    ),
    phases,
    agents,
    agentDoneCount,
    agentCount,
    logs: task.logs,
    result: task.result,
    error: task.error,
    transcriptDir: task.transcriptDir,
  };
}

function mergeAgentView(
  previous: WorkflowAgentView | undefined,
  next: WorkflowAgentView,
): WorkflowAgentView {
  if (!previous) return next;
  return {
    ...previous,
    ...next,
    phaseId: next.phaseId ?? previous.phaseId,
    phaseTitle: next.phaseTitle ?? previous.phaseTitle,
    agentId: next.agentId ?? previous.agentId,
    agentType: next.agentType ?? previous.agentType,
    model: next.model ?? previous.model,
    promptPreview: next.promptPreview ?? previous.promptPreview,
    resultPreview: next.resultPreview ?? previous.resultPreview,
    error: next.error ?? previous.error,
    cached: next.cached ?? previous.cached,
    skipped: next.skipped ?? previous.skipped,
    attempt: next.attempt ?? previous.attempt,
    maxAttempts: next.maxAttempts ?? previous.maxAttempts,
    prompt: next.prompt ?? previous.prompt,
    journalKey: next.journalKey ?? previous.journalKey,
    tokens: next.tokens ?? previous.tokens,
    toolCalls: next.toolCalls ?? previous.toolCalls,
    lastToolName: next.lastToolName ?? previous.lastToolName,
    lastToolSummary: next.lastToolSummary ?? previous.lastToolSummary,
    recentToolActivities:
      next.recentToolActivities ?? previous.recentToolActivities,
    outputPath: next.outputPath ?? previous.outputPath,
    transcriptPath: next.transcriptPath ?? previous.transcriptPath,
    attemptTranscriptPaths:
      next.attemptTranscriptPaths ?? previous.attemptTranscriptPaths,
    startedAt: next.startedAt ?? previous.startedAt,
    lastProgressAt: next.lastProgressAt ?? previous.lastProgressAt,
    durationMs: next.durationMs ?? previous.durationMs,
  };
}

export function filterWorkflowAgentsByPhase(
  view: WorkflowRunView,
  phaseId: string | undefined,
): WorkflowAgentView[] {
  if (!phaseId || phaseId === WORKFLOW_ALL_PHASE_ID) return view.agents;
  return view.agents.filter((agent) => agent.phaseId === phaseId);
}

export function getWorkflowRailSummary(
  task: WorkflowUnifiedTask,
  now = Date.now(),
): WorkflowRailSummary {
  const view = buildWorkflowRunView(task, now);
  return {
    label: view.name,
    description: view.description,
    status: view.status,
    elapsed: formatWorkflowDuration(view.elapsedMs),
    doneAgents: view.agentDoneCount,
    agentCount: view.agentCount,
  };
}

export function formatWorkflowDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m${seconds.toString().padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${(minutes % 60).toString().padStart(2, '0')}m`;
}

export function workflowAllPhaseId(): string {
  return WORKFLOW_ALL_PHASE_ID;
}

function isWorkflowPhaseEvent(item: WorkflowProgressItem): item is PhaseEvent {
  return item.type === 'workflow_phase';
}

function isWorkflowAgentEvent(item: WorkflowProgressItem): item is AgentEvent {
  return item.type === 'workflow_agent';
}

function agentEventToView(event: AgentEvent): WorkflowAgentView {
  const status = (() => {
    switch (event.state) {
      case 'done':
        return 'done';
      case 'error':
        return 'error';
      case 'skipped':
        return 'skipped';
      case 'start':
      case 'progress':
      case 'retry':
      default:
        return 'running';
    }
  })();

  return {
    id: String(event.index),
    index: event.index,
    label: event.label,
    phaseId:
      event.phaseIndex === undefined ? undefined : String(event.phaseIndex),
    phaseTitle: event.phaseTitle,
    state: event.state,
    status,
    agentId: event.agentId,
    agentType: event.agentType,
    model: event.model,
    promptPreview: event.promptPreview,
    resultPreview: event.resultPreview,
    error: event.error,
    cached: event.cached,
    skipped: event.skipped,
    attempt: event.attempt,
    maxAttempts: event.maxAttempts,
    prompt: event.prompt,
    journalKey: event.journalKey,
    tokens: event.tokens,
    toolCalls: event.toolCalls,
    lastToolName: event.lastToolName,
    lastToolSummary: event.lastToolSummary,
    recentToolActivities: event.recentToolActivities,
    outputPath: event.outputPath,
    transcriptPath: event.transcriptPath,
    attemptTranscriptPaths: event.attemptTranscriptPaths,
    startedAt: event.startedAt,
    lastProgressAt: event.lastProgressAt,
    durationMs: event.durationMs,
  };
}

function derivePhaseStatus(
  agents: WorkflowAgentView[],
): WorkflowPhaseView['status'] {
  if (agents.some((agent) => agent.status === 'error')) return 'error';
  if (agents.length === 0) return 'pending';
  if (
    agents.every(
      (agent) => agent.status === 'done' || agent.status === 'skipped',
    )
  ) {
    return 'done';
  }
  return 'running';
}
