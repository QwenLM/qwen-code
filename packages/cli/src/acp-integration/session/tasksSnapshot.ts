/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  buildBackgroundEntryLabel,
  getSubagentSessionDir,
  MAX_AGENT_TRACE_NODES,
  MAX_RETAINED_TERMINAL_AGENTS,
  readAgentMetaAsync,
  sanitizeFilenameComponent,
  type AgentTask,
  type Config,
  type MonitorTask,
  type ShellTask,
  type WorkflowSnapshot,
  type WorkflowTask,
} from '@qwen-code/qwen-code-core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import pLimit from 'p-limit';
import {
  STATUS_SCHEMA_VERSION,
  type ServeSessionAgentsStatus,
  type ServeSessionAgentTaskStatus,
  type ServeSessionMonitorTaskStatus,
  type ServeSessionShellTaskStatus,
  type ServeSessionTaskStatus,
  type ServeSessionTasksStatus,
  type ServeSessionWorkflowTaskStatus,
} from '@qwen-code/acp-bridge/status';

const MAX_AGENT_SIDECAR_CACHE_ENTRIES = 20;
const MAX_AGENT_SIDECAR_READ_CONCURRENCY = 8;
const agentSidecarCache = new Map<
  string,
  {
    directoryMtimeNs: bigint;
    tasks: ServeSessionAgentTaskStatus[];
    metaSignatures: Map<string, string>;
  }
>();

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

function retainAgentTasks(
  tasks: ServeSessionAgentTaskStatus[],
): ServeSessionAgentTaskStatus[] {
  const pausedIds = new Set(
    tasks
      .filter((task) => task.status === 'paused')
      .sort(
        (a, b) =>
          (b.endTime ?? b.startTime) - (a.endTime ?? a.startTime) ||
          b.id.localeCompare(a.id),
      )
      .slice(0, MAX_RETAINED_TERMINAL_AGENTS)
      .map((task) => task.id),
  );
  const terminalIds = new Set(
    tasks
      .filter(
        (task) =>
          task.status === 'completed' ||
          task.status === 'failed' ||
          task.status === 'cancelled',
      )
      .sort(
        (a, b) =>
          (b.endTime ?? b.startTime) - (a.endTime ?? a.startTime) ||
          b.startTime - a.startTime ||
          b.id.localeCompare(a.id),
      )
      .slice(0, MAX_RETAINED_TERMINAL_AGENTS)
      .map((task) => task.id),
  );
  return tasks
    .filter(
      (task) =>
        task.status === 'running' ||
        pausedIds.has(task.id) ||
        terminalIds.has(task.id),
    )
    .sort((a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id));
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

export async function buildSessionAgentsStatus(
  sessionId: string,
  config: Config,
  now = Date.now(),
): Promise<ServeSessionAgentsStatus> {
  const projectDir = config.storage.getProjectDir();
  const dir = getSubagentSessionDir(projectDir, sessionId);
  const agents = new Map<string, ServeSessionAgentTaskStatus>();
  const metaSignatures = new Map<string, string>();
  let directoryMtimeNs: bigint | undefined;
  let files: string[] = [];
  try {
    directoryMtimeNs = (await fs.promises.stat(dir, { bigint: true })).mtimeNs;
    const cached = agentSidecarCache.get(dir);
    const cachedSidecarsUnchanged =
      cached?.directoryMtimeNs === directoryMtimeNs &&
      (
        await Promise.all(
          [...cached.metaSignatures].map(async ([agentId, signature]) => {
            const meta = await readAgentMetaAsync(
              path.join(
                dir,
                `agent-${sanitizeFilenameComponent(agentId)}.meta.json`,
              ),
            );
            return meta !== undefined && JSON.stringify(meta) === signature;
          }),
        )
      ).every(Boolean);
    if (cached && cachedSidecarsUnchanged) {
      for (const task of cached.tasks) {
        agents.set(task.id, task);
      }
    } else {
      files = (await fs.promises.readdir(dir))
        .filter((fileName) => fileName.endsWith('.meta.json'))
        .sort()
        .slice(0, MAX_AGENT_TRACE_NODES);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const limitAgentSidecarRead = pLimit(MAX_AGENT_SIDECAR_READ_CONCURRENCY);
  await Promise.all(
    files.map((fileName) =>
      limitAgentSidecarRead(async () => {
        if (!fileName.endsWith('.meta.json')) return;
        const meta = await readAgentMetaAsync(path.join(dir, fileName));
        if (
          !meta ||
          typeof meta.agentId !== 'string' ||
          meta.agentId.length === 0 ||
          typeof meta.agentType !== 'string' ||
          typeof meta.description !== 'string' ||
          typeof meta.createdAt !== 'string' ||
          meta.parentSessionId !== sessionId ||
          (meta.subagentName !== undefined &&
            typeof meta.subagentName !== 'string') ||
          (meta.lastUpdatedAt !== undefined &&
            typeof meta.lastUpdatedAt !== 'string') ||
          (meta.lastError !== undefined &&
            typeof meta.lastError !== 'string') ||
          (meta.toolUseId !== undefined &&
            typeof meta.toolUseId !== 'string') ||
          (meta.parentAgentId !== null &&
            typeof meta.parentAgentId !== 'string') ||
          (meta.depth !== undefined && !Number.isFinite(meta.depth)) ||
          (meta.isBackgrounded !== undefined &&
            typeof meta.isBackgrounded !== 'boolean') ||
          fileName !==
            `agent-${sanitizeFilenameComponent(meta.agentId)}.meta.json` ||
          (meta.status !== undefined &&
            !['running', 'paused', 'completed', 'failed', 'cancelled'].includes(
              meta.status,
            ))
        ) {
          return;
        }
        const startTime = Date.parse(meta.createdAt);
        if (!Number.isFinite(startTime) || !meta.status) return;
        if (meta.status === 'running' && meta.isBackgrounded !== true) return;
        const status = meta.status === 'running' ? 'paused' : meta.status;
        metaSignatures.set(meta.agentId, JSON.stringify(meta));
        const endTime = Date.parse(meta.lastUpdatedAt ?? meta.createdAt);
        const subagentType = meta.subagentName ?? meta.agentType;
        agents.set(meta.agentId, {
          kind: 'agent',
          id: meta.agentId,
          label: buildBackgroundEntryLabel({
            description: meta.description,
            subagentType,
          }),
          description: meta.description,
          status,
          startTime,
          ...(Number.isFinite(endTime) ? { endTime } : {}),
          runtimeMs: Math.max(
            0,
            (Number.isFinite(endTime) ? endTime : startTime) - startTime,
          ),
          outputFile: path.join(
            dir,
            `agent-${sanitizeFilenameComponent(meta.agentId)}.jsonl`,
          ),
          subagentType,
          isBackgrounded: meta.isBackgrounded === true,
          ...optionalField('error', meta.lastError),
          ...optionalField('toolUseId', meta.toolUseId),
          ...optionalField('parentAgentId', meta.parentAgentId ?? undefined),
          ...optionalField('depth', meta.depth),
        });
      }),
    ),
  );

  if (directoryMtimeNs !== undefined && files.length > 0) {
    const tasks = retainAgentTasks([...agents.values()]);
    const retainedIds = new Set(tasks.map((task) => task.id));
    agentSidecarCache.delete(dir);
    agentSidecarCache.set(dir, {
      directoryMtimeNs,
      tasks,
      metaSignatures: new Map(
        [...metaSignatures].filter(([agentId]) => retainedIds.has(agentId)),
      ),
    });
    while (agentSidecarCache.size > MAX_AGENT_SIDECAR_CACHE_ENTRIES) {
      const oldest = agentSidecarCache.keys().next().value;
      if (!oldest) break;
      agentSidecarCache.delete(oldest);
    }
  }

  for (const entry of config.getBackgroundTaskRegistry().getAll()) {
    agents.set(entry.id, serializeAgentTask(entry, now));
  }

  return {
    v: STATUS_SCHEMA_VERSION,
    sessionId,
    now,
    tasks: retainAgentTasks([...agents.values()]),
  };
}
