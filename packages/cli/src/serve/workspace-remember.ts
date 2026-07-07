/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application, Request, RequestHandler, Response } from 'express';
import { createDebugLogger } from '@qwen-code/qwen-code-core';
import { randomUUID } from 'node:crypto';
import type {
  AcpSessionBridge,
  BridgeAutoMemoryTopic,
  BridgeWorkspaceMemoryDreamResult,
  BridgeWorkspaceMemoryForgetResult,
  BridgeWorkspaceMemoryRememberContextMode,
  BridgeWorkspaceMemoryRememberResult,
} from './acp-session-bridge.js';
import {
  extractRememberErrorCode,
  shouldSuppressRememberErrorDetails,
  workspaceMemoryFailureCode,
  workspaceMemoryFailureDiagnostics,
} from './workspace-remember-errors.js';
import { MAX_REMEMBER_CONTENT_BYTES } from './workspace-memory-remember-constants.js';
import {
  formatWorkspaceMemoryDreamSummary,
  formatWorkspaceMemoryForgetSummary,
} from './workspace-memory-summaries.js';

const debugLogger = createDebugLogger('WORKSPACE_REMEMBER');

export type WorkspaceMemoryTaskStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed';

/** @deprecated Use WorkspaceMemoryTaskStatus. */
export type WorkspaceMemoryRememberTaskStatus = WorkspaceMemoryTaskStatus;

export type WorkspaceMemoryTaskKind = 'remember' | 'forget' | 'dream';

interface WorkspaceMemoryTaskBaseSnapshot {
  taskId: string;
  status: WorkspaceMemoryTaskStatus;
  createdAt: string;
  updatedAt: string;
  error?: {
    code: string;
    message: string;
    details?: string;
  };
}

export interface WorkspaceMemoryRememberTaskSnapshot
  extends WorkspaceMemoryTaskBaseSnapshot {
  contextMode: BridgeWorkspaceMemoryRememberContextMode;
  result?: BridgeWorkspaceMemoryRememberResult;
}

export interface WorkspaceMemoryForgetTaskSnapshot
  extends WorkspaceMemoryTaskBaseSnapshot {
  result?: BridgeWorkspaceMemoryForgetResult;
}

export interface WorkspaceMemoryDreamTaskSnapshot
  extends WorkspaceMemoryTaskBaseSnapshot {
  result?: BridgeWorkspaceMemoryDreamResult;
}

type WorkspaceMemoryTaskRecord = (
  | ({ kind: 'remember' } & WorkspaceMemoryRememberTaskSnapshot)
  | ({ kind: 'forget' } & WorkspaceMemoryForgetTaskSnapshot)
  | ({ kind: 'dream' } & WorkspaceMemoryDreamTaskSnapshot)
) & {
  originatorClientId?: string;
};

export interface WorkspaceRememberRouteDeps {
  bridge: AcpSessionBridge;
  lane: WorkspaceRememberTaskLane;
  mutate: (opts?: { strict?: boolean }) => RequestHandler;
  parseClientId: (req: Request, res: Response) => string | undefined | null;
  safeBody: (req: Request) => Record<string, unknown>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function createMemoryTaskId(kind: WorkspaceMemoryTaskRecord['kind']): string {
  return `${kind}-${randomUUID()}`;
}

function touchedScopesFromTopics(
  topics: BridgeAutoMemoryTopic[],
): Array<'user' | 'project'> {
  const scopes = new Set<'user' | 'project'>();
  for (const topic of topics) {
    scopes.add(topic === 'user' || topic === 'feedback' ? 'user' : 'project');
  }
  return [...scopes];
}

function cloneTask(
  task: WorkspaceMemoryTaskRecord,
):
  | WorkspaceMemoryRememberTaskSnapshot
  | WorkspaceMemoryForgetTaskSnapshot
  | WorkspaceMemoryDreamTaskSnapshot {
  const base = {
    taskId: task.taskId,
    status: task.status,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    error: task.error ? { ...task.error } : undefined,
  };
  if (task.kind === 'remember') {
    return {
      ...base,
      contextMode: task.contextMode,
      result: task.result
        ? {
            ...task.result,
            filesTouched: [...task.result.filesTouched],
            touchedScopes: [...task.result.touchedScopes],
          }
        : undefined,
    };
  }
  if (task.kind === 'forget') {
    return {
      ...base,
      result: task.result
        ? {
            ...task.result,
            removedEntries: task.result.removedEntries.map((entry) => ({
              ...entry,
            })),
            touchedTopics: [...task.result.touchedTopics],
          }
        : undefined,
    };
  }
  return {
    ...base,
    result: task.result
      ? {
          ...task.result,
          touchedTopics: [...task.result.touchedTopics],
        }
      : undefined,
  };
}

export function publicErrorMessage(
  code: string,
  kind: WorkspaceMemoryTaskKind,
): string {
  if (code === 'managed_memory_unavailable') {
    return 'Managed memory is unavailable for this daemon workspace.';
  }
  if (code === 'remember_path_escape') {
    return 'Remember agent touched a path outside managed memory.';
  }
  if (code === 'remember_queue_full') {
    return kind === 'remember'
      ? 'Workspace memory remember queue is full.'
      : 'Workspace memory task queue is full.';
  }
  if (
    code === 'remember_timeout' ||
    code === 'forget_timeout' ||
    code === 'dream_timeout'
  ) {
    return `Workspace memory ${kind} timed out.`;
  }
  return `Workspace memory ${kind} failed.`;
}

export function publicErrorStatus(code: string): number {
  if (code === 'remember_queue_full') return 429;
  if (code === 'managed_memory_unavailable') return 409;
  return 500;
}

function createTaskError(
  code: string,
  kind: WorkspaceMemoryTaskKind,
  details?: string,
): WorkspaceMemoryTaskBaseSnapshot['error'] {
  const error: WorkspaceMemoryTaskBaseSnapshot['error'] = {
    code,
    message: publicErrorMessage(code, kind),
  };
  if (shouldSuppressRememberErrorDetails(code)) return error;
  return {
    ...error,
    ...(details ? { details } : {}),
  };
}

function logWorkspaceMemoryExtractionError(target: string, err: unknown): void {
  debugLogger.warn(`Failed to extract workspace memory error ${target}:`, {
    extractionError: err instanceof Error ? err.message : String(err),
  });
}

export class WorkspaceRememberTaskLane {
  private static readonly MAX_TASKS = 1000;
  private static readonly TERMINAL_TASK_TTL_MS = 5 * 60_000;
  // Two-tier pending capacity: all tasks share the global cap, while
  // forget/dream share a smaller sub-cap so bursts cannot starve remember.
  private static readonly MAX_PENDING = 16;
  private static readonly MAX_NON_REMEMBER_PENDING = 8;
  private static readonly NON_REMEMBER_KINDS = new Set<WorkspaceMemoryTaskKind>(
    ['forget', 'dream'],
  );
  private readonly tasks = new Map<string, WorkspaceMemoryTaskRecord>();
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly bridge: AcpSessionBridge) {}

  private pendingCounts(): { total: number; nonRemember: number } {
    let total = 0;
    let nonRemember = 0;
    for (const task of this.tasks.values()) {
      if (task.status !== 'queued' && task.status !== 'running') continue;
      total++;
      if (WorkspaceRememberTaskLane.NON_REMEMBER_KINDS.has(task.kind)) {
        nonRemember++;
      }
    }
    return { total, nonRemember };
  }

  private evictTerminalTasks(nowMs = Date.now()): void {
    const cutoffMs = nowMs - WorkspaceRememberTaskLane.TERMINAL_TASK_TTL_MS;
    for (const [id, task] of this.tasks) {
      if (task.status !== 'completed' && task.status !== 'failed') continue;
      const updatedAtMs = Date.parse(task.updatedAt);
      if (!Number.isNaN(updatedAtMs) && updatedAtMs <= cutoffMs) {
        this.tasks.delete(id);
      } else if (Number.isNaN(updatedAtMs)) {
        debugLogger.warn(
          'Task with unparseable updatedAt skipped for TTL eviction:',
          {
            taskId: id,
            updatedAt: task.updatedAt,
          },
        );
      }
    }

    if (this.tasks.size <= WorkspaceRememberTaskLane.MAX_TASKS) return;
    for (const [id, task] of this.tasks) {
      if (task.status === 'completed' || task.status === 'failed') {
        this.tasks.delete(id);
        if (this.tasks.size <= WorkspaceRememberTaskLane.MAX_TASKS) break;
      }
    }
  }

  private assertCapacity(kind: WorkspaceMemoryTaskRecord['kind']): void {
    const pending = this.pendingCounts();
    if (pending.total >= WorkspaceRememberTaskLane.MAX_PENDING) {
      throw Object.assign(new Error('Workspace memory task queue is full'), {
        code: 'remember_queue_full',
      });
    }
    // Keep forget/dream from occupying the whole serial lane so remember stays
    // available during heavier destructive or compaction bursts.
    if (
      WorkspaceRememberTaskLane.NON_REMEMBER_KINDS.has(kind) &&
      pending.nonRemember >= WorkspaceRememberTaskLane.MAX_NON_REMEMBER_PENDING
    ) {
      throw Object.assign(new Error('Workspace memory task queue is full'), {
        code: 'remember_queue_full',
      });
    }
  }

  private queue(
    task: WorkspaceMemoryTaskRecord,
    run: () => Promise<void>,
  ):
    | WorkspaceMemoryRememberTaskSnapshot
    | WorkspaceMemoryForgetTaskSnapshot
    | WorkspaceMemoryDreamTaskSnapshot {
    this.tasks.set(task.taskId, task);
    this.evictTerminalTasks();

    this.tail = this.tail.then(run, run);
    void this.tail.catch((err: unknown) => {
      debugLogger.error('Unhandled task lane error:', err);
    });
    return cloneTask(task);
  }

  private publishManagedMemoryChanged(params: {
    source: string;
    taskId: string;
    touchedScopes: Array<'user' | 'project'>;
    originatorClientId?: string;
  }): void {
    if (params.touchedScopes.length === 0) return;
    try {
      this.bridge.publishWorkspaceEvent({
        type: 'memory_changed',
        data: {
          scope: 'managed',
          source: params.source,
          taskId: params.taskId,
          touchedScopes: params.touchedScopes,
        },
        ...(params.originatorClientId
          ? { originatorClientId: params.originatorClientId }
          : {}),
      });
    } catch (err) {
      debugLogger.error('Failed to publish memory_changed event:', err);
    }
  }

  enqueue(params: {
    content: string;
    contextMode: BridgeWorkspaceMemoryRememberContextMode;
    originatorClientId?: string;
  }): WorkspaceMemoryRememberTaskSnapshot {
    this.assertCapacity('remember');
    const task: WorkspaceMemoryTaskRecord = {
      kind: 'remember',
      taskId: createMemoryTaskId('remember'),
      status: 'queued',
      contextMode: params.contextMode,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      ...(params.originatorClientId
        ? { originatorClientId: params.originatorClientId }
        : {}),
    };
    const run = async () => {
      task.status = 'running';
      task.updatedAt = nowIso();
      try {
        const result = await this.bridge.runWorkspaceMemoryRemember({
          content: params.content,
          contextMode: params.contextMode,
        });
        task.status = 'completed';
        task.result = {
          summary:
            result.filesTouched.length > 0
              ? 'Memory update completed.'
              : 'No memory files updated.',
          filesTouched: result.filesTouched,
          touchedScopes: result.touchedScopes,
        };
        task.updatedAt = nowIso();
      } catch (err) {
        const code = workspaceMemoryFailureCode(
          err,
          'remember_failed',
          logWorkspaceMemoryExtractionError,
        );
        const diagnostics = workspaceMemoryFailureDiagnostics(
          err,
          logWorkspaceMemoryExtractionError,
        );
        debugLogger.error('Workspace memory remember task failed:', {
          taskId: task.taskId,
          code,
          details: diagnostics.debugDetails,
          ...(diagnostics.stack ? { stack: diagnostics.stack } : {}),
        });
        task.status = 'failed';
        task.error = createTaskError(code, task.kind, diagnostics.details);
        task.updatedAt = nowIso();
      }
      try {
        if (task.status === 'completed' && task.result) {
          this.publishManagedMemoryChanged({
            source: 'workspace_memory_remember',
            taskId: task.taskId,
            touchedScopes: task.result.touchedScopes,
            ...(params.originatorClientId
              ? { originatorClientId: params.originatorClientId }
              : {}),
          });
        }
      } finally {
        this.evictTerminalTasks();
      }
    };

    return this.queue(task, run) as WorkspaceMemoryRememberTaskSnapshot;
  }

  enqueueForget(params: {
    query: string;
    originatorClientId?: string;
  }): WorkspaceMemoryForgetTaskSnapshot {
    this.assertCapacity('forget');
    const task: WorkspaceMemoryTaskRecord = {
      kind: 'forget',
      taskId: createMemoryTaskId('forget'),
      status: 'queued',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      ...(params.originatorClientId
        ? { originatorClientId: params.originatorClientId }
        : {}),
    };

    const run = async () => {
      task.status = 'running';
      task.updatedAt = nowIso();
      try {
        const result = await this.bridge.runWorkspaceMemoryForget({
          query: params.query,
        });
        task.status = 'completed';
        task.result = {
          summary:
            result.summary ??
            formatWorkspaceMemoryForgetSummary(result.removedEntries.length),
          removedEntries: result.removedEntries,
          touchedTopics: result.touchedTopics,
        };
        task.updatedAt = nowIso();
      } catch (err) {
        const code = workspaceMemoryFailureCode(
          err,
          'forget_failed',
          logWorkspaceMemoryExtractionError,
        );
        const diagnostics = workspaceMemoryFailureDiagnostics(
          err,
          logWorkspaceMemoryExtractionError,
        );
        debugLogger.error('Workspace memory forget task failed:', {
          taskId: task.taskId,
          code,
          details: diagnostics.debugDetails,
          ...(diagnostics.stack ? { stack: diagnostics.stack } : {}),
        });
        task.status = 'failed';
        task.error = createTaskError(code, task.kind, diagnostics.details);
        task.updatedAt = nowIso();
      }
      try {
        if (task.status === 'completed' && task.result) {
          this.publishManagedMemoryChanged({
            source: 'workspace_memory_forget',
            taskId: task.taskId,
            touchedScopes: touchedScopesFromTopics(task.result.touchedTopics),
            ...(params.originatorClientId
              ? { originatorClientId: params.originatorClientId }
              : {}),
          });
        }
      } finally {
        this.evictTerminalTasks();
      }
    };

    return this.queue(task, run) as WorkspaceMemoryForgetTaskSnapshot;
  }

  enqueueDream(params: {
    originatorClientId?: string;
  }): WorkspaceMemoryDreamTaskSnapshot {
    this.assertCapacity('dream');
    const task: WorkspaceMemoryTaskRecord = {
      kind: 'dream',
      taskId: createMemoryTaskId('dream'),
      status: 'queued',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      ...(params.originatorClientId
        ? { originatorClientId: params.originatorClientId }
        : {}),
    };

    const run = async () => {
      task.status = 'running';
      task.updatedAt = nowIso();
      try {
        const result = await this.bridge.runWorkspaceMemoryDream();
        task.status = 'completed';
        task.result = {
          summary:
            result.summary ??
            formatWorkspaceMemoryDreamSummary(result.touchedTopics.length),
          touchedTopics: result.touchedTopics,
          dedupedEntries: result.dedupedEntries,
        };
        task.updatedAt = nowIso();
      } catch (err) {
        const code = workspaceMemoryFailureCode(
          err,
          'dream_failed',
          logWorkspaceMemoryExtractionError,
        );
        const diagnostics = workspaceMemoryFailureDiagnostics(
          err,
          logWorkspaceMemoryExtractionError,
        );
        debugLogger.error('Workspace memory dream task failed:', {
          taskId: task.taskId,
          code,
          details: diagnostics.debugDetails,
          ...(diagnostics.stack ? { stack: diagnostics.stack } : {}),
        });
        task.status = 'failed';
        task.error = createTaskError(code, task.kind, diagnostics.details);
        task.updatedAt = nowIso();
      }
      try {
        if (task.status === 'completed' && task.result) {
          this.publishManagedMemoryChanged({
            source: 'workspace_memory_dream',
            taskId: task.taskId,
            touchedScopes: touchedScopesFromTopics(task.result.touchedTopics),
            ...(params.originatorClientId
              ? { originatorClientId: params.originatorClientId }
              : {}),
          });
        }
      } finally {
        this.evictTerminalTasks();
      }
    };

    return this.queue(task, run) as WorkspaceMemoryDreamTaskSnapshot;
  }

  get(
    taskId: string,
    requesterClientId?: string,
    kind?: WorkspaceMemoryTaskRecord['kind'],
  ):
    | WorkspaceMemoryRememberTaskSnapshot
    | WorkspaceMemoryForgetTaskSnapshot
    | WorkspaceMemoryDreamTaskSnapshot
    | undefined {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
    if (kind && task.kind !== kind) return undefined;
    if (task.originatorClientId) {
      if (task.originatorClientId !== requesterClientId) return undefined;
    } else if (requesterClientId) {
      return undefined;
    }
    return cloneTask(task);
  }
}

function validateOriginatorClientId(
  deps: WorkspaceRememberRouteDeps,
  req: Request,
  res: Response,
): string | undefined | null {
  const clientId = deps.parseClientId(req, res);
  if (clientId === null) return null;
  if (clientId === undefined) return undefined;
  const known = deps.bridge.knownClientIds();
  if (!known.has(clientId)) {
    res.status(400).json({
      error: `Client id "${clientId}" is not registered for this workspace`,
      code: 'invalid_client_id',
      clientId,
    });
    return null;
  }
  return clientId;
}

async function validateManagedMemoryAvailable(
  deps: WorkspaceRememberRouteDeps,
  res: Response,
  kind: WorkspaceMemoryTaskKind,
): Promise<boolean> {
  try {
    const available = await deps.bridge.isWorkspaceMemoryRememberAvailable();
    if (!available) {
      res.status(409).json({
        error: 'Managed memory is unavailable for this daemon workspace',
        code: 'managed_memory_unavailable',
      });
      return false;
    }
    return true;
  } catch (err) {
    debugLogger.error('Availability check failed:', err);
    const code = `${kind}_failed`;
    res.status(500).json({
      error: publicErrorMessage(code, kind),
      code,
    });
    return false;
  }
}

export function mountWorkspaceMemoryRememberRoutes(
  app: Application,
  deps: WorkspaceRememberRouteDeps,
): void {
  app.post(
    '/workspace/memory/remember',
    deps.mutate({ strict: true }),
    async (req, res) => {
      const body = deps.safeBody(req);
      const content = body['content'];
      const trimmedContent = typeof content === 'string' ? content.trim() : '';
      if (!trimmedContent) {
        res.status(400).json({
          error: '`content` must be a non-empty string',
          code: 'invalid_content',
        });
        return;
      }
      if (
        Buffer.byteLength(trimmedContent, 'utf8') > MAX_REMEMBER_CONTENT_BYTES
      ) {
        res.status(400).json({
          error: `\`content\` exceeds the ${MAX_REMEMBER_CONTENT_BYTES}-byte limit`,
          code: 'invalid_content',
        });
        return;
      }

      const contextModeRaw = body['contextMode'] ?? 'workspace';
      if (contextModeRaw !== 'workspace' && contextModeRaw !== 'clean') {
        res.status(400).json({
          error: '`contextMode` must be "workspace", "clean", or omitted',
          code: 'invalid_context_mode',
        });
        return;
      }

      const originatorClientId = validateOriginatorClientId(deps, req, res);
      if (originatorClientId === null) return;

      if (!(await validateManagedMemoryAvailable(deps, res, 'remember'))) {
        return;
      }

      let task: WorkspaceMemoryRememberTaskSnapshot;
      try {
        task = deps.lane.enqueue({
          content: trimmedContent,
          contextMode: contextModeRaw,
          ...(originatorClientId ? { originatorClientId } : {}),
        });
      } catch (err) {
        const code = extractRememberErrorCode(err);
        res.status(publicErrorStatus(code)).json({
          error: publicErrorMessage(code, 'remember'),
          code,
        });
        return;
      }
      res.status(202).json(task);
    },
  );

  app.get(
    '/workspace/memory/remember/:taskId',
    deps.mutate({ strict: true }),
    (req, res) => {
      const requesterClientId = validateOriginatorClientId(deps, req, res);
      if (requesterClientId === null) return;
      const task = deps.lane.get(
        req.params['taskId'],
        requesterClientId,
        'remember',
      );
      if (!task) {
        res.status(404).json({
          error: 'Workspace memory remember task not found',
          code: 'remember_task_not_found',
        });
        return;
      }
      res.status(200).json(task);
    },
  );

  app.post(
    '/workspace/memory/forget',
    deps.mutate({ strict: true }),
    async (req, res) => {
      const body = deps.safeBody(req);
      const query = body['query'];
      const trimmedQuery = typeof query === 'string' ? query.trim() : '';
      if (!trimmedQuery) {
        res.status(400).json({
          error: '`query` must be a non-empty string',
          code: 'invalid_query',
        });
        return;
      }
      if (
        Buffer.byteLength(trimmedQuery, 'utf8') > MAX_REMEMBER_CONTENT_BYTES
      ) {
        res.status(400).json({
          error: `\`query\` exceeds the ${MAX_REMEMBER_CONTENT_BYTES}-byte limit`,
          code: 'invalid_query',
        });
        return;
      }

      const originatorClientId = validateOriginatorClientId(deps, req, res);
      if (originatorClientId === null) return;
      if (!(await validateManagedMemoryAvailable(deps, res, 'forget'))) return;

      try {
        const task = deps.lane.enqueueForget({
          query: trimmedQuery,
          ...(originatorClientId ? { originatorClientId } : {}),
        });
        res.status(202).json(task);
      } catch (err) {
        const code = extractRememberErrorCode(err, 'forget_failed');
        res.status(publicErrorStatus(code)).json({
          error: publicErrorMessage(code, 'forget'),
          code,
        });
      }
    },
  );

  app.get(
    '/workspace/memory/forget/:taskId',
    deps.mutate({ strict: true }),
    (req, res) => {
      const requesterClientId = validateOriginatorClientId(deps, req, res);
      if (requesterClientId === null) return;
      const task = deps.lane.get(
        req.params['taskId'],
        requesterClientId,
        'forget',
      );
      if (!task) {
        res.status(404).json({
          error: 'Workspace memory forget task not found',
          code: 'forget_task_not_found',
        });
        return;
      }
      res.status(200).json(task);
    },
  );

  app.post(
    '/workspace/memory/dream',
    deps.mutate({ strict: true }),
    async (req, res) => {
      const originatorClientId = validateOriginatorClientId(deps, req, res);
      if (originatorClientId === null) return;
      if (!(await validateManagedMemoryAvailable(deps, res, 'dream'))) return;

      try {
        const task = deps.lane.enqueueDream({
          ...(originatorClientId ? { originatorClientId } : {}),
        });
        res.status(202).json(task);
      } catch (err) {
        const code = extractRememberErrorCode(err, 'dream_failed');
        res.status(publicErrorStatus(code)).json({
          error: publicErrorMessage(code, 'dream'),
          code,
        });
      }
    },
  );

  app.get(
    '/workspace/memory/dream/:taskId',
    deps.mutate({ strict: true }),
    (req, res) => {
      const requesterClientId = validateOriginatorClientId(deps, req, res);
      if (requesterClientId === null) return;
      const task = deps.lane.get(
        req.params['taskId'],
        requesterClientId,
        'dream',
      );
      if (!task) {
        res.status(404).json({
          error: 'Workspace memory dream task not found',
          code: 'dream_task_not_found',
        });
        return;
      }
      res.status(200).json(task);
    },
  );
}
