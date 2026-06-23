/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import type { Application, Request, RequestHandler, Response } from 'express';
import type { AcpSessionBridge } from '../acp-session-bridge.js';
import type { BridgeEvent } from '../event-bus.js';
import { isFsError, type WorkspaceFileSystemFactory } from '../fs/index.js';
import {
  SetupGithubError,
  setupGithub,
  type SetupGithubFileOps,
  type SetupGithubResult,
} from '../../services/setup-github.js';
import { loadSettings } from '../../config/settings.js';
import { applyReadHeaders } from './workspace-file-read.js';

const ROUTE = 'POST /workspace/setup-github';

interface RegisterDeps {
  boundWorkspace: string;
  bridge: AcpSessionBridge;
  mutate: (opts?: { strict?: boolean }) => RequestHandler;
  parseClientId: (req: Request, res: Response) => string | undefined | null;
  safeBody: (req: Request) => Record<string, unknown>;
}

export function registerWorkspaceSetupGithubRoutes(
  app: Application,
  deps: RegisterDeps,
): void {
  app.post(
    '/workspace/setup-github',
    deps.mutate({ strict: true }),
    (req, res) => handleSetupGithub(req, res, deps),
  );
}

async function handleSetupGithub(
  req: Request,
  res: Response,
  deps: RegisterDeps,
): Promise<void> {
  const factory = getFsFactory(req, res);
  if (!factory) return;

  const body = deps.safeBody(req);
  if (body['consent'] !== true) {
    applyReadHeaders(res);
    res.status(400).json({
      error: '`consent` must be true',
      code: 'github_setup_consent_required',
      status: 400,
    });
    return;
  }

  const clientId = deps.parseClientId(req, res);
  if (clientId === null) return;
  const originatorClientId = validateClientId(clientId, deps, res);
  if (originatorClientId === null) return;

  try {
    const result = await setupGithub({
      cwd: deps.boundWorkspace,
      workspaceRoot: deps.boundWorkspace,
      proxy: resolveProxy(deps.boundWorkspace),
      abortSignal: requestAbortSignal(req, res),
      fileOps: createRouteFileOps(factory, originatorClientId),
    });
    deps.bridge.publishWorkspaceEvent({
      type: 'github_setup_completed',
      data: setupGithubEventData(result),
      ...(originatorClientId ? { originatorClientId } : {}),
    } as BridgeEvent);
    applyReadHeaders(res);
    res.status(200).json(result);
  } catch (error) {
    sendSetupGithubError(res, error);
  }
}

function getFsFactory(
  req: Request,
  res: Response,
): WorkspaceFileSystemFactory | null {
  const factory = (req.app.locals as { fsFactory?: WorkspaceFileSystemFactory })
    .fsFactory;
  if (!factory) {
    applyReadHeaders(res);
    res.status(500).json({
      error: 'workspace filesystem factory is not configured',
      code: 'internal_error',
      status: 500,
    });
    return null;
  }
  return factory;
}

function validateClientId(
  clientId: string | undefined,
  deps: RegisterDeps,
  res: Response,
): string | undefined | null {
  if (clientId === undefined) return undefined;
  if (!deps.bridge.knownClientIds().has(clientId)) {
    applyReadHeaders(res);
    res.status(400).json({
      error: `Client id "${clientId}" is not registered for this workspace`,
      code: 'invalid_client_id',
      clientId,
    });
    return null;
  }
  return clientId;
}

function createRouteFileOps(
  factory: WorkspaceFileSystemFactory,
  originatorClientId: string | undefined,
): SetupGithubFileOps {
  const fs = factory.forRequest({
    route: ROUTE,
    ...(originatorClientId ? { originatorClientId } : {}),
  });
  return {
    async ensureWorkflowDirectory(gitRepoRoot: string): Promise<void> {
      try {
        factory.assertCanWrite();
      } catch (error) {
        throw new SetupGithubError(
          'github_setup_untrusted_workspace',
          error instanceof Error
            ? error.message
            : 'workspace is not trusted; write operations are forbidden',
          403,
        );
      }
      await ensureDirectoryWithoutSymlink(gitRepoRoot, [
        '.github',
        'workflows',
      ]);
    },
    async writeTextFile(
      _gitRepoRoot: string,
      relativePath: string,
      content: string,
    ): Promise<{ sizeBytes: number }> {
      const resolved = await fs.resolve(relativePath, 'write');
      const out = await fs.writeTextOverwrite(resolved, content);
      return { sizeBytes: out.sizeBytes };
    },
    async readTextFile(
      _gitRepoRoot: string,
      relativePath: string,
    ): Promise<string | undefined> {
      try {
        const resolved = await fs.resolve(relativePath, 'read');
        const out = await fs.readText(resolved);
        return out.content;
      } catch (error) {
        if (isFsError(error) && error.kind === 'path_not_found') {
          return undefined;
        }
        throw error;
      }
    },
  };
}

async function ensureDirectoryWithoutSymlink(
  root: string,
  segments: string[],
): Promise<void> {
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      const stat = await fsp.lstat(current);
      if (stat.isSymbolicLink()) {
        throw new SetupGithubError(
          'github_setup_invalid_workspace',
          `${current} must not be a symlink.`,
          400,
        );
      }
      if (!stat.isDirectory()) {
        throw new SetupGithubError(
          'github_setup_invalid_workspace',
          `${current} must be a directory.`,
          400,
        );
      }
    } catch (error) {
      if (error instanceof SetupGithubError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      try {
        await fsp.mkdir(current, { mode: 0o755 });
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw mkdirError;
        }
      }
      const postStat = await fsp.lstat(current);
      if (postStat.isSymbolicLink()) {
        throw new SetupGithubError(
          'github_setup_invalid_workspace',
          `${current} must not be a symlink.`,
          400,
        );
      }
      if (!postStat.isDirectory()) {
        throw new SetupGithubError(
          'github_setup_invalid_workspace',
          `${current} must be a directory.`,
          400,
        );
      }
    }
  }
}

function sendSetupGithubError(res: Response, error: unknown): void {
  applyReadHeaders(res);
  if (error instanceof SetupGithubError) {
    res.status(error.status).json({
      error: error.message,
      code: error.code,
      status: error.status,
      ...(error.partial
        ? { partial: true, result: error.partialResult ?? null }
        : {}),
    });
    return;
  }
  res.status(500).json({
    error: error instanceof Error ? error.message : String(error),
    code: 'github_setup_failed',
    status: 500,
  });
}

function setupGithubEventData(
  result: SetupGithubResult,
): Record<string, unknown> {
  return {
    releaseTag: result.releaseTag,
    readmeUrl: result.readmeUrl,
    ...(result.secretsUrl ? { secretsUrl: result.secretsUrl } : {}),
    workflows: result.workflows,
    gitignore: result.gitignore,
    warnings: result.warnings,
  };
}

function resolveProxy(boundWorkspace: string): string | undefined {
  const settingsProxy = loadSettings(boundWorkspace).merged.proxy;
  return (
    settingsProxy ||
    process.env['HTTPS_PROXY'] ||
    process.env['https_proxy'] ||
    process.env['HTTP_PROXY'] ||
    process.env['http_proxy']
  );
}

function requestAbortSignal(req: Request, res: Response): AbortSignal {
  const controller = new AbortController();
  const abort = () => controller.abort();
  req.once('aborted', abort);
  res.once('close', () => {
    if (!res.writableEnded) abort();
  });
  return controller.signal;
}
