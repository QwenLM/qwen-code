/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application, Request, RequestHandler, Response } from 'express';
import type {
  AcpSessionBridge,
  BridgeWorkspaceMemoryRememberContextMode,
  BridgeWorkspaceMemoryRememberResult,
} from './acp-session-bridge.js';

export type WorkspaceMemoryRememberTaskStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed';

export interface WorkspaceMemoryRememberTaskSnapshot {
  taskId: string;
  status: WorkspaceMemoryRememberTaskStatus;
  contextMode: BridgeWorkspaceMemoryRememberContextMode;
  createdAt: string;
  updatedAt: string;
  result?: BridgeWorkspaceMemoryRememberResult;
  error?: {
    code: string;
    message: string;
  };
}

export interface WorkspaceRememberRouteDeps {
  bridge: AcpSessionBridge;
  mutate: (opts?: { strict?: boolean }) => RequestHandler;
  parseClientId: (req: Request, res: Response) => string | undefined | null;
  safeBody: (req: Request) => Record<string, unknown>;
}

const MAX_REMEMBER_CONTENT_BYTES = 64 * 1024;

function nowIso(): string {
  return new Date().toISOString();
}

function createRememberTaskId(): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `remember-${Date.now().toString(36)}-${random}`;
}

function cloneTask(
  task: WorkspaceMemoryRememberTaskSnapshot,
): WorkspaceMemoryRememberTaskSnapshot {
  return {
    ...task,
    result: task.result
      ? {
          ...task.result,
          filesTouched: [...task.result.filesTouched],
          touchedScopes: [...task.result.touchedScopes],
        }
      : undefined,
    error: task.error ? { ...task.error } : undefined,
  };
}

function errorCode(err: unknown): string {
  if (err && typeof err === 'object') {
    const record = err as Record<string, unknown>;
    if (typeof record['code'] === 'string') return record['code'];
    const data = record['data'];
    if (data && typeof data === 'object') {
      const dataRecord = data as Record<string, unknown>;
      if (typeof dataRecord['errorKind'] === 'string') {
        return dataRecord['errorKind'];
      }
      if (typeof dataRecord['code'] === 'string') return dataRecord['code'];
    }
  }
  return 'remember_failed';
}

function publicErrorMessage(code: string): string {
  if (code === 'managed_memory_unavailable') {
    return 'Managed memory is unavailable for this daemon workspace.';
  }
  if (code === 'remember_path_escape') {
    return 'Remember agent touched a path outside managed memory.';
  }
  return 'Workspace memory remember failed.';
}

class WorkspaceRememberTaskLane {
  private readonly tasks = new Map<
    string,
    WorkspaceMemoryRememberTaskSnapshot
  >();
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly bridge: AcpSessionBridge) {}

  enqueue(params: {
    content: string;
    contextMode: BridgeWorkspaceMemoryRememberContextMode;
    originatorClientId?: string;
  }): WorkspaceMemoryRememberTaskSnapshot {
    const task: WorkspaceMemoryRememberTaskSnapshot = {
      taskId: createRememberTaskId(),
      status: 'queued',
      contextMode: params.contextMode,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.tasks.set(task.taskId, task);

    const run = async () => {
      task.status = 'running';
      task.updatedAt = nowIso();
      try {
        const result = await this.bridge.runWorkspaceMemoryRemember({
          content: params.content,
          contextMode: params.contextMode,
        });
        task.status = 'completed';
        task.result = result;
        task.updatedAt = nowIso();
        this.bridge.publishWorkspaceEvent({
          type: 'memory_changed',
          data: {
            scope: 'managed',
            source: 'workspace_memory_remember',
            taskId: task.taskId,
            touchedScopes: result.touchedScopes,
          },
          ...(params.originatorClientId
            ? { originatorClientId: params.originatorClientId }
            : {}),
        });
      } catch (err) {
        const code = errorCode(err);
        task.status = 'failed';
        task.error = {
          code,
          message: publicErrorMessage(code),
        };
        task.updatedAt = nowIso();
      }
    };

    this.tail = this.tail.then(run, run);
    void this.tail.catch(() => undefined);
    return cloneTask(task);
  }

  get(taskId: string): WorkspaceMemoryRememberTaskSnapshot | undefined {
    const task = this.tasks.get(taskId);
    return task ? cloneTask(task) : undefined;
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

export function mountWorkspaceMemoryRememberRoutes(
  app: Application,
  deps: WorkspaceRememberRouteDeps,
): void {
  const lane = new WorkspaceRememberTaskLane(deps.bridge);

  app.post(
    '/workspace/memory/remember',
    deps.mutate({ strict: true }),
    async (req, res) => {
      const body = deps.safeBody(req);
      const content = body['content'];
      if (typeof content !== 'string' || !content.trim()) {
        res.status(400).json({
          error: '`content` must be a non-empty string',
          code: 'invalid_content',
        });
        return;
      }
      if (Buffer.byteLength(content, 'utf8') > MAX_REMEMBER_CONTENT_BYTES) {
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

      try {
        const available =
          await deps.bridge.isWorkspaceMemoryRememberAvailable();
        if (!available) {
          res.status(409).json({
            error: 'Managed memory is unavailable for this daemon workspace',
            code: 'managed_memory_unavailable',
          });
          return;
        }
      } catch {
        res.status(500).json({
          error: 'Workspace memory remember failed.',
          code: 'remember_failed',
        });
        return;
      }

      const task = lane.enqueue({
        content: content.trim(),
        contextMode: contextModeRaw,
        ...(originatorClientId ? { originatorClientId } : {}),
      });
      res.status(202).json(task);
    },
  );

  app.get('/workspace/memory/remember/:taskId', (req, res) => {
    const task = lane.get(req.params.taskId);
    if (!task) {
      res.status(404).json({
        error: 'Workspace memory remember task not found',
        code: 'remember_task_not_found',
      });
      return;
    }
    res.status(200).json(task);
  });
}
