/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ExecutionLifecycleService } from '../services/executionLifecycleService.js';
import {
  getSubagentTranscriptDir,
  type SubagentArtifactContext,
} from '../services/subagent-transcript.js';
import {
  isFileAccessDeniedError,
  isNodeError,
  warnFileAccessDegraded,
} from '../utils/errors.js';
import type { CompletionBehavior } from '../services/executionLifecycleService.js';

export type AgentTaskStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export interface AgentTaskRecord {
  taskId: string;
  sessionId: string;
  executionId?: number;
  agentId: string;
  agentType: string;
  /** Agent 首次启动时解析出的模型。 */
  resolvedModel?: string;
  description: string;
  invocationName?: string;
  teamName?: string;
  parentToolUseId?: string;
  outputPath?: string;
  transcriptPath?: string;
  worktreePath?: string;
  completionBehavior?: CompletionBehavior;
  status: AgentTaskStatus;
  summary?: string;
  result?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface RegisterAgentTaskParams {
  projectRoot: SubagentArtifactContext;
  sessionId: string;
  taskId: string;
  executionId?: number;
  agentId: string;
  agentType: string;
  resolvedModel?: string;
  description: string;
  invocationName?: string;
  teamName?: string;
  parentToolUseId?: string;
  outputPath?: string;
  transcriptPath?: string;
  worktreePath?: string;
  completionBehavior?: CompletionBehavior;
  summary?: string;
}

type AgentTaskRecordUpdate = Partial<
  Omit<
    AgentTaskRecord,
    'taskId' | 'sessionId' | 'agentId' | 'agentType' | 'createdAt'
  >
>;

function getAgentTaskRecordPath(
  projectRoot: SubagentArtifactContext,
  sessionId: string,
  taskId: string,
): string {
  return path.join(
    getSubagentTranscriptDir(projectRoot, sessionId),
    `task-${taskId}.json`,
  );
}

function warnPersistenceUnavailable(
  operation: string,
  targetPath: string,
  error: unknown,
): void {
  warnFileAccessDegraded('agent.task', operation, targetPath, error);
}

async function writeRecord(
  projectRoot: SubagentArtifactContext,
  sessionId: string,
  record: AgentTaskRecord,
): Promise<void> {
  const recordPath = getAgentTaskRecordPath(
    projectRoot,
    sessionId,
    record.taskId,
  );
  try {
    await fs.mkdir(path.dirname(recordPath), { recursive: true });
    await fs.writeFile(recordPath, JSON.stringify(record), 'utf8');
  } catch (error) {
    if (!isFileAccessDeniedError(error)) {
      throw error;
    }
    warnPersistenceUnavailable('write', recordPath, error);
  }
}

export async function registerAgentTask(
  params: RegisterAgentTaskParams,
): Promise<AgentTaskRecord> {
  const now = Date.now();
  const record: AgentTaskRecord = {
    taskId: params.taskId,
    sessionId: params.sessionId,
    executionId: params.executionId,
    agentId: params.agentId,
    agentType: params.agentType,
    resolvedModel: params.resolvedModel,
    description: params.description,
    invocationName: params.invocationName,
    teamName: params.teamName,
    parentToolUseId: params.parentToolUseId,
    outputPath: params.outputPath,
    transcriptPath: params.transcriptPath,
    worktreePath: params.worktreePath,
    completionBehavior: params.completionBehavior,
    status: 'running',
    summary: params.summary,
    createdAt: now,
    updatedAt: now,
  };
  await writeRecord(params.projectRoot, params.sessionId, record);
  return record;
}

export async function readAgentTaskRecord(
  projectRoot: SubagentArtifactContext,
  sessionId: string,
  taskId: string,
): Promise<AgentTaskRecord | null> {
  const recordPath = getAgentTaskRecordPath(projectRoot, sessionId, taskId);
  try {
    const raw = await fs.readFile(recordPath, 'utf8');
    return JSON.parse(raw) as AgentTaskRecord;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return null;
    }
    if (isFileAccessDeniedError(error)) {
      warnPersistenceUnavailable('read', recordPath, error);
      return null;
    }
    throw error;
  }
}

export async function updateAgentTaskRecord(
  projectRoot: SubagentArtifactContext,
  sessionId: string,
  taskId: string,
  update: AgentTaskRecordUpdate,
): Promise<AgentTaskRecord | null> {
  const existing = await readAgentTaskRecord(projectRoot, sessionId, taskId);
  if (!existing) {
    return null;
  }

  const next: AgentTaskRecord = {
    ...existing,
    ...update,
    updatedAt: Date.now(),
  };
  await writeRecord(projectRoot, sessionId, next);
  return next;
}

export async function completeAgentTaskRecord(
  projectRoot: SubagentArtifactContext,
  sessionId: string,
  taskId: string,
  update: AgentTaskRecordUpdate = {},
): Promise<AgentTaskRecord | null> {
  return updateAgentTaskRecord(projectRoot, sessionId, taskId, {
    ...update,
    status: update.status ?? 'completed',
    completedAt: Date.now(),
  });
}

export async function deleteAgentTaskRecord(
  projectRoot: SubagentArtifactContext,
  sessionId: string,
  taskId: string,
): Promise<void> {
  const recordPath = getAgentTaskRecordPath(projectRoot, sessionId, taskId);
  try {
    await fs.rm(recordPath, { force: true });
  } catch (error) {
    if (!isFileAccessDeniedError(error)) {
      throw error;
    }
    warnPersistenceUnavailable('delete', recordPath, error);
  }
}

export async function loadAgentTaskRecords(
  projectRoot: SubagentArtifactContext,
  sessionId: string,
): Promise<AgentTaskRecord[]> {
  const dir = getSubagentTranscriptDir(projectRoot, sessionId);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return [];
    }
    if (isFileAccessDeniedError(error)) {
      warnPersistenceUnavailable('list', dir, error);
      return [];
    }
    throw error;
  }

  const taskIds = names
    .filter((name) => name.startsWith('task-') && name.endsWith('.json'))
    .map((name) => name.slice('task-'.length, -'.json'.length));

  const records = await Promise.all(
    taskIds.map((taskId) =>
      readAgentTaskRecord(projectRoot, sessionId, taskId),
    ),
  );

  return records
    .filter((record): record is AgentTaskRecord => record !== null)
    .sort((left, right) => left.createdAt - right.createdAt);
}

export async function reconcileAgentTaskRecords(
  projectRoot: SubagentArtifactContext,
  sessionId: string,
): Promise<AgentTaskRecord[]> {
  const records = await loadAgentTaskRecords(projectRoot, sessionId);
  const reconciled = await Promise.all(
    records.map(async (record) => {
      if (
        record.status !== 'running' ||
        record.executionId === undefined ||
        ExecutionLifecycleService.isActive(record.executionId)
      ) {
        return record;
      }

      return (
        (await completeAgentTaskRecord(projectRoot, sessionId, record.taskId, {
          status: 'interrupted',
          summary:
            record.summary ??
            `Agent task "${record.description}" stopped before it could finish.`,
          result:
            record.result ??
            'The process that owned this subagent task is no longer running.',
        })) ?? record
      );
    }),
  );

  return reconciled;
}
