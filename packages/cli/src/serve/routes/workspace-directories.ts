/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application, Request, RequestHandler, Response } from 'express';
import * as path from 'node:path';
import { SERVE_CONTROL_EXT_METHODS } from '@qwen-code/acp-bridge/status';
import { loadSettings } from '../../config/settings.js';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import {
  requireTrustedWorkspaceRuntime,
  resolveWorkspaceRuntimeFromParam,
} from '../workspace-route-runtime.js';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from '../workspace-registry.js';

export interface WorkspaceDirectoriesRouteDeps {
  workspaceRegistry: WorkspaceRegistry;
  mutate: (opts?: { strict?: boolean }) => RequestHandler;
}

interface DirectoriesResult {
  primaryDirectory: string;
  directories: string[];
  changed: boolean;
  warnings: string[];
}

const SSH_WORKSPACE_PREFIX = 'ssh://';

/** Extra directories persisted at workspace scope. */
function readWorkspaceDirectories(workspaceCwd: string): string[] {
  const settings = loadSettings(workspaceCwd, { skipLoadEnvironment: true });
  const configured =
    settings.workspace.originalSettings.context?.includeDirectories;
  return Array.isArray(configured)
    ? configured.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function readBridgeErrorKind(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const data = (error as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null) return undefined;
  const kind = (data as { errorKind?: unknown }).errorKind;
  return typeof kind === 'string' ? kind : undefined;
}

function sendBridgeError(res: Response, error: unknown, route: string): void {
  switch (readBridgeErrorKind(error)) {
    case 'untrusted_workspace':
      res.status(403).json({
        error: 'Workspace is not trusted.',
        code: 'untrusted_workspace',
      });
      return;
    case 'restrictive_sandbox':
      res.status(409).json({
        error: 'Restrictive sandbox mode is active.',
        code: 'restrictive_sandbox',
      });
      return;
    case 'directory_not_found':
      res
        .status(404)
        .json({ error: 'Directory not found.', code: 'directory_not_found' });
      return;
    case 'initial_directory':
      res.status(400).json({
        error: 'The primary workspace directory cannot be removed.',
        code: 'initial_directory',
      });
      return;
    case 'directory_management_unsupported':
      res.status(409).json({
        error: 'This workspace cannot manage extra directories.',
        code: 'directory_management_unsupported',
      });
      return;
    default:
      break;
  }
  if ((error as { code?: unknown }).code === -32602) {
    res
      .status(400)
      .json({ error: 'Invalid directory request.', code: 'invalid_path' });
    return;
  }
  writeStderrLine(
    `qwen serve: ${route} error: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  res.status(500).json({
    error: 'Failed to update workspace directories',
    code: 'runtime_error',
  });
}

function sendUnsupported(res: Response): void {
  res.status(409).json({
    error: 'This workspace cannot manage extra directories.',
    code: 'directory_management_unsupported',
  });
}

function resolveTarget(
  deps: WorkspaceDirectoriesRouteDeps,
  req: Request,
  res: Response,
): WorkspaceRuntime | null {
  const runtime = resolveWorkspaceRuntimeFromParam(
    deps.workspaceRegistry,
    req,
    res,
  );
  if (!runtime || !requireTrustedWorkspaceRuntime(runtime, res)) return null;
  // SSH workspaces validate paths on the remote host; the daemon cannot stat
  // them, and the CLI blocks /directory for them as well.
  if (runtime.workspaceCwd.startsWith(SSH_WORKSPACE_PREFIX)) {
    sendUnsupported(res);
    return null;
  }
  return runtime;
}

function readAbsolutePath(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\0') ||
    !path.isAbsolute(value)
  ) {
    return null;
  }
  return value;
}

export function registerWorkspaceDirectoriesRoutes(
  app: Application,
  deps: WorkspaceDirectoriesRouteDeps,
): void {
  app.get('/workspaces/:workspace/directories', (req, res) => {
    const runtime = resolveTarget(deps, req, res);
    if (!runtime) return;
    try {
      res.status(200).json({
        v: 1,
        primaryDirectory: runtime.workspaceCwd,
        directories: readWorkspaceDirectories(runtime.workspaceCwd),
      });
    } catch (error) {
      writeStderrLine(
        `qwen serve: GET /workspaces/:workspace/directories error: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      res.status(500).json({
        error: 'Failed to read workspace directories',
        code: 'internal_error',
      });
    }
  });

  app.post(
    '/workspaces/:workspace/directories',
    deps.mutate({ strict: true }),
    async (req: Request, res: Response) => {
      const runtime = resolveTarget(deps, req, res);
      if (!runtime) return;
      const target = readAbsolutePath(
        (req.body as { path?: unknown } | undefined)?.path,
      );
      if (!target) {
        res.status(400).json({
          error: 'path must be an absolute directory path',
          code: 'invalid_path',
        });
        return;
      }
      try {
        const result =
          await runtime.bridge.invokeWorkspaceCommand<DirectoriesResult>(
            SERVE_CONTROL_EXT_METHODS.workspaceDirectories,
            { action: 'add', path: target },
          );
        res.status(200).json({ v: 1, ...result });
      } catch (error) {
        sendBridgeError(res, error, 'POST /workspaces/:workspace/directories');
      }
    },
  );

  app.delete(
    '/workspaces/:workspace/directories',
    deps.mutate({ strict: true }),
    async (req: Request, res: Response) => {
      const runtime = resolveTarget(deps, req, res);
      if (!runtime) return;
      const target = readAbsolutePath(req.query['path']);
      if (!target) {
        res.status(400).json({
          error: 'path must be an absolute directory path',
          code: 'invalid_path',
        });
        return;
      }
      try {
        const result =
          await runtime.bridge.invokeWorkspaceCommand<DirectoriesResult>(
            SERVE_CONTROL_EXT_METHODS.workspaceDirectories,
            { action: 'remove', path: target },
          );
        res.status(200).json({ v: 1, ...result });
      } catch (error) {
        sendBridgeError(
          res,
          error,
          'DELETE /workspaces/:workspace/directories',
        );
      }
    },
  );
}
