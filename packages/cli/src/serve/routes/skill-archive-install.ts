/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Request, Response } from 'express';
import type { PathMutexRegistry } from '../fs/path-mutex-registry.js';
import {
  acquireSkillArchive,
  validateSkillZipFileSource,
  type PreparedSkillArchive,
  type SkillZipFileSource,
} from '../skill-archive-input.js';
import {
  SKILL_INSTALL_BUDGET_MS,
  validateSkillInstallAttemptId,
  type SkillInstallAttempt,
  type SkillInstallAttemptStore,
} from '../skill-install-attempts.js';
import {
  MAX_SKILL_ARCHIVE_BYTES,
  WorkspaceSkillManagementError,
  WorkspaceSkillRecoveryError,
  validateWorkspaceSkillName,
  type WorkspaceSkillInstallOptions,
  type WorkspaceSkillInstallRequest,
  type WorkspaceSkillMutationResult,
  type WorkspaceSkillScope,
} from '../workspace-skill-management.js';

export interface SkillArchiveRequest {
  name: string;
  scope: WorkspaceSkillScope;
  attemptId: string;
  source?: SkillZipFileSource;
}

export function parseSkillArchiveRequest(
  req: Request,
  body: Record<string, unknown>,
  scope: WorkspaceSkillScope,
  raw: boolean,
): SkillArchiveRequest {
  const name = raw ? req.query['name'] : body['name'];
  if (typeof name !== 'string') {
    throw new WorkspaceSkillManagementError(
      'invalid_skill_name',
      'Skill name is required',
    );
  }
  const attemptId = validateSkillInstallAttemptId(
    raw ? req.query['attemptId'] : body['attemptId'],
  );
  let source: SkillZipFileSource | undefined;
  if (raw) {
    if (
      !req.is('application/octet-stream') ||
      req.headers['content-encoding'] !== undefined
    ) {
      throw new WorkspaceSkillManagementError(
        'invalid_skill_archive_media_type',
        'Use application/octet-stream without Content-Encoding',
        415,
      );
    }
    const length = req.headers['content-length'];
    if (
      length !== undefined &&
      (!/^\d+$/.test(length) || Number(length) > MAX_SKILL_ARCHIVE_BYTES)
    ) {
      throw new WorkspaceSkillManagementError(
        'skill_archive_too_large',
        'ZIP archive exceeds 50 MiB',
        413,
      );
    }
  } else {
    if (body['scope'] !== scope) {
      throw new WorkspaceSkillManagementError(
        scope === 'global'
          ? 'workspace_scope_requires_qualified_workspace'
          : 'global_scope_requires_singular_owner',
        'Skill scope does not match this config route',
      );
    }
    const value = body['source'];
    if (
      !value ||
      typeof value !== 'object' ||
      !('type' in value) ||
      value.type !== 'zip-file' ||
      !('path' in value) ||
      typeof value.path !== 'string' ||
      ('sha256' in value &&
        value.sha256 !== undefined &&
        typeof value.sha256 !== 'string')
    ) {
      throw new WorkspaceSkillManagementError(
        'invalid_skill_source',
        'zip-file requires an absolute path and an optional SHA-256',
      );
    }
    source = {
      type: 'zip-file',
      path: value.path,
      ...('sha256' in value && typeof value.sha256 === 'string'
        ? { sha256: value.sha256 }
        : {}),
    };
    validateSkillZipFileSource(source);
  }
  return { name: validateWorkspaceSkillName(name), scope, attemptId, source };
}

export function sendSkillArchiveError(
  res: Response,
  error: unknown,
  attemptId?: string,
): void {
  if (res.destroyed || res.writableEnded) return;
  const failure = describeError(error);
  const status =
    error instanceof WorkspaceSkillManagementError
      ? error.statusCode
      : error instanceof Error &&
          error.name === 'WorkspaceGenerationClosedError'
        ? 409
        : 500;
  if (status === 429) res.setHeader('Retry-After', '1');
  res.status(status).json({
    error: failure.message,
    code: failure.code,
    ...(failure.retainedPaths ? { retainedPaths: failure.retainedPaths } : {}),
    ...(attemptId ? { attemptId } : {}),
  });
}

function describeError(
  error: unknown,
): NonNullable<SkillInstallAttempt['error']> {
  return {
    code:
      error instanceof WorkspaceSkillManagementError
        ? error.code
        : error instanceof Error &&
            error.name === 'WorkspaceGenerationClosedError'
          ? 'workspace_generation_closed'
          : 'skill_install_failed',
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof WorkspaceSkillRecoveryError
      ? { retainedPaths: error.retainedPaths }
      : {}),
  };
}

export async function runSkillArchiveInstall(
  req: Request,
  res: Response,
  input: SkillArchiveRequest,
  context: {
    store: SkillInstallAttemptStore;
    owner: string;
    workspaceId: string;
    generationId?: number;
    locks: PathMutexRegistry;
    lockKey: string;
    assertActive(): void;
    install(
      request: WorkspaceSkillInstallRequest,
      options: WorkspaceSkillInstallOptions,
    ): Promise<WorkspaceSkillMutationResult>;
    reconcile(): 'deferred' | 'reconciling';
  },
): Promise<void> {
  const started = performance.now();
  context.assertActive();
  const receipt = context.store.reserve(context.owner, {
    attemptId: input.attemptId,
    scope: input.scope,
    skillName: input.name,
    workspaceId: context.workspaceId,
    generationId: context.generationId,
    phase: input.source ? 'copying' : 'receiving',
  });
  const controller = new AbortController();
  const { signal } = controller;
  let publishing = false;
  const timeoutError = () =>
    new WorkspaceSkillManagementError(
      'skill_install_timeout',
      'Skill installation exceeded its 120 second publication budget',
      408,
    );
  const timer = setTimeout(() => {
    if (!publishing) controller.abort(timeoutError());
  }, SKILL_INSTALL_BUDGET_MS);
  timer.unref();
  const cancel = () => {
    if (!publishing && !res.writableFinished)
      controller.abort(
        new WorkspaceSkillManagementError(
          'skill_install_cancelled',
          'Skill installation request was cancelled',
          499,
        ),
      );
  };
  req.once('aborted', cancel);
  res.once('close', cancel);
  if (req.aborted || res.destroyed) cancel();
  let archive: PreparedSkillArchive | undefined;
  let failure: unknown;
  try {
    archive = await acquireSkillArchive(input.source ?? req, signal);
    receipt.archiveSha256 = archive.sha256;
    context.assertActive();
    receipt.phase = 'waiting';
    const source = { type: 'prepared-zip' as const, path: archive.path };
    const result = await context.locks.runExclusive(
      context.lockKey,
      async () => {
        context.assertActive();
        receipt.phase = 'extracting';
        return context.install(
          { name: input.name, scope: input.scope, source },
          {
            signal,
            beforePublish: () => {
              signal.throwIfAborted();
              if (performance.now() - started >= SKILL_INSTALL_BUDGET_MS)
                throw timeoutError();
              context.assertActive();
              publishing = true;
              receipt.phase = 'publishing';
              clearTimeout(timer);
            },
            onCommitted: (result) => {
              receipt.state = 'committed';
              receipt.result = result;
            },
          },
        );
      },
      signal,
    );
    receipt.result = { ...result, activation: context.reconcile() };
  } catch (error) {
    if (receipt.state === 'committed' && receipt.result) {
      receipt.result = {
        ...receipt.result,
        activation: 'deferred',
        activationWarning:
          error instanceof Error ? error.message : String(error),
      };
    } else {
      failure = signal.aborted && !publishing ? signal.reason : error;
      receipt.state =
        failure instanceof WorkspaceSkillRecoveryError
          ? 'recovery_required'
          : 'not_committed';
      receipt.error = describeError(failure);
    }
  } finally {
    receipt.phase = 'cleanup';
    try {
      await archive?.dispose();
    } catch (error) {
      receipt.error ??= {
        code: 'skill_archive_cleanup_failed',
        message: error instanceof Error ? error.message : String(error),
      };
    }
    clearTimeout(timer);
    req.removeListener('aborted', cancel);
    res.removeListener('close', cancel);
    context.store.settle(context.owner, input.attemptId);
    if (!req.complete && !res.headersSent) res.setHeader('Connection', 'close');
    req.resume();
  }
  if (failure !== undefined)
    sendSkillArchiveError(res, failure, input.attemptId);
  else if (!res.destroyed && !res.writableEnded)
    res.status(200).json({
      ...receipt.result,
      attemptId: receipt.attemptId,
      archiveSha256: receipt.archiveSha256,
    });
}
