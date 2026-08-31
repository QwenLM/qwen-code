/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  buildBackgroundEntryLabel,
  type AgentTask,
  type Config,
  type MonitorTask,
  type ShellTask,
  type WorkflowSnapshot,
  type WorkflowTask,
} from '@qwen-code/qwen-code-core';
import {
  STATUS_SCHEMA_VERSION,
  type ServeSessionAgentTaskStatus,
  type ServeSessionMonitorTaskStatus,
  type ServeSessionShellTaskStatus,
  type ServeSessionTaskStatus,
  type ServeSessionTasksStatus,
  type ServeSessionWorkflowTaskStatus,
} from '@qwen-code/acp-bridge/status';

function runtimeMs(
  entry: { startTime: number; endTime?: number },
  now: number,
): number {
  return Math.max(0, (entry.endTime ?? now) - entry.startTime);
}

/** Include `{key: value}` in a spread only when `value` is defined; empty object otherwise. */
function optionalField<K extends string, V>(
  key: K,
  value: V | undefined,
): { [P in K]: V } | Record<string, never> {
  return value !== undefined
    ? ({ [key]: value } as { [P in K]: V })
    : ({} as Record<string, never>);
}

function serializeAgentTask(
  entry: AgentTask,
  now: number,
): ServeSessionAgentTaskStatus {
  return {
    kind: 'agent',
    id: entry.id,
    label: buildBackgroundEntryLabel(entry),
    description: entry.description,
    status: entry.status,
    startTime: entry.startTime,
    runtimeMs: runtimeMs(entry, now),
    outputFile: entry.outputFile,
    ...optionalField('endTime', entry.endTime),
    ...optionalField('subagentType', entry.subagentType),
    isBackgrounded: entry.isBackgrounded,
    // Nested-agent lineage for client-side tree rendering. AgentTask uses
    // `null` parentAgentId for top-level launches — normalize to absent.
    ...optionalField('parentAgentId', entry.parentAgentId ?? undefined),
    ...optionalField('parentName', entry.parentName),
    ...optionalField('depth', entry.depth),
    ...optionalField('error', entry.error),
    ...optionalField('resumeBlockedReason', entry.resumeBlockedReason),
    ...optionalField('stats', entry.stats),
    ...(entry.recentActivities && entry.recentActivities.length > 0
      ? {
          recentActivities: entry.recentActivities.map((a) => ({
            name: a.name,
            description: a.description,
            at: a.at,
          })),
        }
      : {}),
    ...optionalField('prompt', entry.prompt),
    ...optionalField('toolUseId', entry.toolUseId),
  };
}

function serializeShellTask(
  entry: ShellTask,
  now: number,
): ServeSessionShellTaskStatus {
  return {
    kind: 'shell',
    id: entry.id,
    label: entry.command,
    description: entry.description,
    status: entry.status,
    startTime: entry.startTime,
    runtimeMs: runtimeMs(entry, now),
    outputFile: entry.outputFile,
    command: entry.command,
    cwd: entry.cwd,
    ...optionalField('endTime', entry.endTime),
    ...optionalField('pid', entry.pid),
    ...optionalField('exitCode', entry.exitCode),
    ...optionalField('error', entry.error),
  };
}

function serializeMonitorTask(
  entry: MonitorTask,
  now: number,
): ServeSessionMonitorTaskStatus {
  return {
    kind: 'monitor',
    id: entry.id,
    label: entry.description,
    description: entry.description,
    status: entry.status,
    startTime: entry.startTime,
    runtimeMs: runtimeMs(entry, now),
    command: entry.command,
    eventCount: entry.eventCount,
    lastEventTime: entry.lastEventTime,
    droppedLines: entry.droppedLines,
    ...optionalField('endTime', entry.endTime),
    ...optionalField('pid', entry.pid),
    ...optionalField('exitCode', entry.exitCode),
    ...optionalField('error', entry.error),
    ...optionalField('ownerAgentId', entry.ownerAgentId),
    ...optionalField('toolUseId', entry.toolUseId),
  };
}

function serializeWorkflowTask(
  entry: WorkflowTask,
  now: number,
): ServeSessionWorkflowTaskStatus {
  return {
    kind: 'workflow',
    id: entry.runId,
    ...optionalField('toolUseId', entry.toolUseId),
    ...optionalField('workflowName', entry.workflowName),
    ...optionalField('sourceRunId', entry.sourceRunId),
    ...optionalField('startMode', entry.startMode),
    label: entry.meta?.name ?? entry.description ?? entry.runId,
    description: entry.meta?.description ?? entry.description,
    status: entry.status,
    startTime: entry.startTime,
    runtimeMs: runtimeMs(entry, now),
    outputFile: entry.outputFile,
    ...optionalField('endTime', entry.endTime),
    isBackgrounded: entry.isBackgrounded === true,
    currentPhase: entry.currentPhase,
    phaseVisits: entry.phaseVisits.map((visit) => ({ ...visit })),
    dispatches: entry.dispatches.map((dispatch) => ({
      ...dispatch,
      dependsOn: [...dispatch.dependsOn],
    })),
    agentsDispatched: entry.agentsDispatched,
    agentsCompleted: entry.agentsCompleted,
    tokensSpent: entry.tokensSpent,
    tokenBudgetTotal: entry.tokenBudgetTotal,
    recentLogs: [...entry.recentLogs],
    events: entry.events.map((event) => ({ ...event })),
    pendingApprovalCount: entry.pendingApprovals.length,
    pendingApprovals: entry.pendingApprovals.map((approval) => ({
      approvalId: approval.approvalId,
      subagentId: approval.subagentId,
      name: approval.name,
      description: approval.description,
      at: approval.at,
    })),
    ...optionalField('error', entry.error),
  };
}

function serializeWorkflowSnapshot(
  snapshot: WorkflowSnapshot,
): ServeSessionWorkflowTaskStatus {
  return {
    kind: 'workflow',
    id: snapshot.runId,
    isHistorical: true,
    ...optionalField('workflowName', snapshot.workflowName),
    ...optionalField('sourceRunId', snapshot.sourceRunId),
    ...optionalField('startMode', snapshot.startMode),
    label: snapshot.meta?.name ?? snapshot.description ?? snapshot.runId,
    description:
      snapshot.meta?.description ?? snapshot.description ?? snapshot.runId,
    status: snapshot.status,
    startTime: snapshot.startTime,
    ...optionalField('endTime', snapshot.endTime),
    runtimeMs: runtimeMs(snapshot, snapshot.endTime ?? snapshot.startTime),
    isBackgrounded: false,
    currentPhase: snapshot.phases.at(-1) ?? null,
    phaseVisits: (snapshot.phaseVisits ?? []).map((visit) => ({ ...visit })),
    dispatches: (snapshot.dispatches ?? []).map((dispatch) => ({
      ...dispatch,
      dependsOn: [...dispatch.dependsOn],
    })),
    agentsDispatched: snapshot.agentsDispatched,
    agentsCompleted: snapshot.agentsCompleted,
    tokensSpent: snapshot.tokensSpent,
    tokenBudgetTotal: snapshot.tokenBudgetTotal,
    recentLogs: [...snapshot.recentLogs],
    ...optionalField(
      'events',
      snapshot.events?.map((event) => ({ ...event })),
    ),
    pendingApprovalCount: 0,
    ...optionalField('error', snapshot.error),
  };
}

export function buildSessionTasksStatus(
  sessionId: string,
  config: Config,
  now = Date.now(),
  workflowHistory: readonly WorkflowSnapshot[] = [],
  options: { includeWorkflows?: boolean } = {},
): ServeSessionTasksStatus {
  const includeWorkflows = options.includeWorkflows === true;
  const workflowTasks = includeWorkflows
    ? config.getWorkflowRunRegistry().list()
    : [];
  const inMemoryWorkflowIds = new Set(
    workflowTasks.map((entry) => entry.runId),
  );
  const tasks: ServeSessionTaskStatus[] = [
    ...config
      .getBackgroundTaskRegistry()
      .getAll()
      .map((entry) => serializeAgentTask(entry, now)),
    ...config
      .getBackgroundShellRegistry()
      .getAll()
      .map((entry) => serializeShellTask(entry, now)),
    ...config
      .getMonitorRegistry()
      .getAll()
      .map((entry) => serializeMonitorTask(entry, now)),
    ...(includeWorkflows
      ? workflowTasks.map((entry) => serializeWorkflowTask(entry, now))
      : []),
    ...(includeWorkflows
      ? workflowHistory
          .filter((snapshot) => !inMemoryWorkflowIds.has(snapshot.runId))
          .map(serializeWorkflowSnapshot)
      : []),
  ].sort((a, b) => a.startTime - b.startTime);

  return {
    v: STATUS_SCHEMA_VERSION,
    sessionId,
    now,
    tasks,
  };
}
