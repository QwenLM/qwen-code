/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application, Request, RequestHandler, Response } from 'express';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SERVE_CONTROL_EXT_METHODS } from '@qwen-code/acp-bridge/status';
import { expandHomeDir } from '@qwen-code/qwen-code-core/utils/paths.js';
import { readSettingsSnapshot } from '../../config/settings.js';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import type { SendBridgeError } from '../server/error-response.js';
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
  /**
   * Shared bridge-error mapper, used as the fallback for failures this route
   * does not classify itself. A freshly opened workspace spawns its control
   * channel on the first mutation, and that spawn can time out, be refused
   * while the child starts, or hit the child cap; those carry none of this
   * feature's error kinds, and a flat 500 would hide a retryable state the
   * shared mapper answers as 503/504 with `Retry-After`.
   */
  sendBridgeError?: SendBridgeError;
}

interface DirectoriesResult {
  primaryDirectory: string;
  directories: string[];
  changed: boolean;
  warnings: string[];
}

/** Resolve a persisted entry the way runtime configuration reads it. */
function resolveWorkspaceDirectory(
  workspaceCwd: string,
  entry: string,
): string {
  const expanded = expandHomeDir(entry);
  const absolute = path.isAbsolute(expanded)
    ? expanded
    : path.resolve(workspaceCwd, expanded);
  try {
    return fs.realpathSync(absolute);
  } catch {
    return absolute;
  }
}

/** Extra directories persisted at workspace scope. */
function readWorkspaceDirectories(
  workspaceCwd: string,
  environment: Readonly<NodeJS.ProcessEnv>,
  workspaceTrusted: boolean,
): string[] {
  // Read through the selected runtime's environment, not the daemon's: a
  // variable defined only in the workspace's `.env` reaches the ACP child and
  // its settings but not the daemon process, so resolving against `process.env`
  // would list the unresolved placeholder while live sessions use the real
  // directory.
  const settings = readSettingsSnapshot(workspaceCwd, {
    environment,
    workspaceTrusted,
  });
  const configured = settings.workspace.settings.context?.includeDirectories;
  return Array.isArray(configured)
    ? configured
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => resolveWorkspaceDirectory(workspaceCwd, entry))
    : [];
}

function readBridgeErrorKind(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const data = (error as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null) return undefined;
  const kind = (data as { errorKind?: unknown }).errorKind;
  return typeof kind === 'string' ? kind : undefined;
}

function sendDirectoriesError(
  res: Response,
  error: unknown,
  route: string,
  sendBridgeError?: SendBridgeError,
): void {
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
    case 'primary_directory':
      res.status(400).json({
        error:
          'The primary workspace directory is already part of the workspace.',
        code: 'primary_directory',
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
  if (sendBridgeError) {
    // Lifecycle and transport failures (a control-channel spawn that times
    // out, a runtime still starting, the child cap) carry none of the kinds
    // above; the shared mapper answers them with their retryable semantics.
    sendBridgeError(res, error, { route });
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
  // them, and the CLI blocks /directory for them as well. Registration rewrites
  // an `ssh://` URL to a local mirror directory, so the cwd never carries that
  // scheme: the runtime's own SSH marker is the signal the rest of the tree
  // uses (`capabilities.ts`, `memory-import.ts`).
  if (runtime.routeFileSystemFactory.sshWorkspace) {
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

/**
 * Removal accepts the spelling GET returned or a relative/`~` entry persisted
 * by settings; the runtime resolves it against the workspace root.
 */
function readRemovalPath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
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
        // Only the runtime overlay carries a workspace `.env`. A
        // parent-process runtime without one has no overlay to offer, and the
        // route must not fall back to the daemon's ambient `process.env`.
        directories: readWorkspaceDirectories(
          runtime.workspaceCwd,
          runtime.env.effectiveEnv ?? {},
          runtime.trusted,
        ),
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
        sendDirectoriesError(
          res,
          error,
          'POST /workspaces/:workspace/directories',
          deps.sendBridgeError,
        );
      }
    },
  );

  app.delete(
    '/workspaces/:workspace/directories',
    deps.mutate({ strict: true }),
    async (req: Request, res: Response) => {
      const runtime = resolveTarget(deps, req, res);
      if (!runtime) return;
      const target = readRemovalPath(req.query['path']);
      if (!target) {
        res.status(400).json({
          error: 'path is required',
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
        sendDirectoriesError(
          res,
          error,
          'DELETE /workspaces/:workspace/directories',
          deps.sendBridgeError,
        );
      }
    },
  );
}
