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
import { loadSettings, type Settings } from '../../config/settings.js';
import { getWorkspaceTrustStatus } from '../../config/trustedFolders.js';
import { applyReadHeaders } from './workspace-file-read.js';
import { writeStderrLine } from '../../utils/stdioHelpers.js';

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
      proxy: resolveSetupGithubProxy(deps.boundWorkspace),
      abortSignal: requestAbortSignal(req, res),
      fileOps: createSetupGithubFileOps(factory, ROUTE, originatorClientId),
    });
    deps.bridge.publishWorkspaceEvent({
      type: 'github_setup_completed',
      data: setupGithubEventData(result),
      ...(originatorClientId ? { originatorClientId } : {}),
    } as BridgeEvent);
    applyReadHeaders(res);
    res.status(200).json(result);
  } catch (error) {
    sendSetupGithubError(res, error, deps.boundWorkspace);
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

export function createSetupGithubFileOps(
  factory: WorkspaceFileSystemFactory,
  route: string,
  originatorClientId: string | undefined,
): SetupGithubFileOps {
  const fs = factory.forRequest({
    route,
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
  await assertDirectoryWithoutSymlink(root, 'Repository root');
  let current = root;
  const checkedSegments: string[] = [];
  for (const segment of segments) {
    current = path.join(current, segment);
    checkedSegments.push(segment);
    const label = `Workspace path "${checkedSegments.join('/')}"`;
    try {
      const stat = await fsp.lstat(current);
      if (stat.isSymbolicLink()) {
        throw new SetupGithubError(
          'github_setup_invalid_workspace',
          `${label} must not be a symlink.`,
          400,
        );
      }
      if (!stat.isDirectory()) {
        throw new SetupGithubError(
          'github_setup_invalid_workspace',
          `${label} must be a directory.`,
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
          `${label} must not be a symlink.`,
          400,
        );
      }
      if (!postStat.isDirectory()) {
        throw new SetupGithubError(
          'github_setup_invalid_workspace',
          `${label} must be a directory.`,
          400,
        );
      }
    }
  }
}

async function assertDirectoryWithoutSymlink(
  target: string,
  label: string,
): Promise<void> {
  const stat = await fsp.lstat(target);
  if (stat.isSymbolicLink()) {
    throw new SetupGithubError(
      'github_setup_invalid_workspace',
      `${label} must not be a symlink.`,
      400,
    );
  }
  if (!stat.isDirectory()) {
    throw new SetupGithubError(
      'github_setup_invalid_workspace',
      `${label} must be a directory.`,
      400,
    );
  }
}

export function sanitizeSetupGithubMessage(
  message: string,
  boundWorkspace: string,
): string {
  return message.split(boundWorkspace).join('<workspace>');
}

function sendSetupGithubError(
  res: Response,
  error: unknown,
  boundWorkspace: string,
): void {
  applyReadHeaders(res);
  if (error instanceof SetupGithubError) {
    res.status(error.status).json({
      error: sanitizeSetupGithubMessage(error.message, boundWorkspace),
      code: error.code,
      status: error.status,
      ...(error.partial
        ? { partial: true, result: error.partialResult ?? null }
        : {}),
    });
    return;
  }
  writeStderrLine(
    `[setup-github] unexpected error: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  res.status(500).json({
    error: 'An internal error occurred during GitHub setup.',
    code: 'github_setup_failed',
    status: 500,
  });
}

export function setupGithubEventData(
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

export function resolveSetupGithubProxy(
  boundWorkspace: string,
): string | undefined {
  const settings = loadSettings(boundWorkspace, { skipLoadEnvironment: true });
  const trustState = getWorkspaceTrustStatus(
    settingsForSetupGithubTrust(settings),
    boundWorkspace,
  ).effective.state;
  const settingsProxy =
    trustState === 'trusted'
      ? settings.merged.proxy
      : settings.user.settings.proxy ||
        settings.system.settings.proxy ||
        settings.systemDefaults.settings.proxy;
  return (
    settingsProxy ||
    process.env['HTTPS_PROXY'] ||
    process.env['https_proxy'] ||
    process.env['HTTP_PROXY'] ||
    process.env['http_proxy']
  );
}

function settingsForSetupGithubTrust(
  settings: ReturnType<typeof loadSettings>,
): Settings {
  const userFolderTrust = settings.user.settings.security?.folderTrust;
  const systemFolderTrust = settings.system.settings.security?.folderTrust;
  if (!userFolderTrust && !systemFolderTrust) return {};
  return {
    security: {
      folderTrust: {
        ...systemFolderTrust,
        ...userFolderTrust,
      },
    },
  };
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
