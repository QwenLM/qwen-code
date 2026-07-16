/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application, Request, Response } from 'express';
import {
  fetchGitDiff,
  fetchGitDiffHunksForFile,
  type GitDiffHunk,
  type GitDiffResult,
} from '@qwen-code/qwen-code-core';
import type { SendBridgeError } from '../server/error-response.js';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from '../workspace-registry.js';
import {
  requireTrustedWorkspaceRuntime,
  resolveWorkspaceRuntimeFromParam,
} from '../workspace-route-runtime.js';
import { applyReadHeaders } from './workspace-file-read.js';

// NOTE: unlike the file-read routes, the single-file diff route does NOT resolve
// the `?path` through the workspace filesystem factory. A diff path can name a
// file that was deleted in the working tree (still present in HEAD, so it must
// still diff), which the factory's `'read'` intent rejects with ENOENT. Instead
// the path is contained by three layers: (1) the qualified route requires a
// trusted workspace; (2) `fetchGitDiffHunksForFile` normalizes the path to a
// git-root-relative form and rejects absolute paths, drive letters, and `..`
// traversal; (3) git itself only diffs inside the repository, the untracked
// synthesis reads with `O_NOFOLLOW`, and it only runs for paths git confirms as
// untracked (`ls-files --others` never lists files reached through a symlinked
// directory). The route is read-only, so this is adequate without realpath
// resolution.

function buildDiffList(
  workspaceCwd: string,
  result: GitDiffResult | null,
): Record<string, unknown> {
  if (!result) {
    return {
      v: 1,
      workspaceCwd,
      available: false,
      filesCount: 0,
      linesAdded: 0,
      linesRemoved: 0,
      files: [],
      hiddenCount: 0,
    };
  }
  const files = [...result.perFileStats.entries()].map(([path, s]) => ({
    path,
    added: s.added,
    removed: s.removed,
    isBinary: s.isBinary,
    isUntracked: s.isUntracked ?? false,
    isDeleted: s.isDeleted ?? false,
    truncated: s.truncated ?? false,
  }));
  return {
    v: 1,
    workspaceCwd,
    available: true,
    filesCount: result.stats.filesCount,
    linesAdded: result.stats.linesAdded,
    linesRemoved: result.stats.linesRemoved,
    files,
    hiddenCount: Math.max(
      0,
      result.stats.filesCount - result.perFileStats.size,
    ),
  };
}

function buildFileHunks(
  workspaceCwd: string,
  queryPath: string,
  hunks: GitDiffHunk[] | null,
): Record<string, unknown> {
  return {
    v: 1,
    workspaceCwd,
    path: queryPath,
    available: hunks !== null && hunks.length > 0,
    hunks: (hunks ?? []).map((h) => ({
      oldStart: h.oldStart,
      oldLines: h.oldLines,
      newStart: h.newStart,
      newLines: h.newLines,
      lines: h.lines,
    })),
  };
}

async function handleDiffList(
  res: Response,
  workspaceCwd: string,
  sendBridgeError: SendBridgeError,
  route: string,
): Promise<void> {
  try {
    applyReadHeaders(res);
    res
      .status(200)
      .json(buildDiffList(workspaceCwd, await fetchGitDiff(workspaceCwd)));
  } catch (err) {
    sendBridgeError(res, err, { route });
  }
}

async function handleDiffFile(
  req: Request,
  res: Response,
  workspaceCwd: string,
  sendBridgeError: SendBridgeError,
  route: string,
): Promise<void> {
  const queryPath = req.query['path'];
  if (typeof queryPath !== 'string' || queryPath.length === 0) {
    applyReadHeaders(res);
    res.status(400).json({
      errorKind: 'parse_error',
      error: 'path query parameter is required',
      status: 400,
    });
    return;
  }
  try {
    const hunks = await fetchGitDiffHunksForFile(workspaceCwd, queryPath);
    applyReadHeaders(res);
    res.status(200).json(buildFileHunks(workspaceCwd, queryPath, hunks));
  } catch (err) {
    sendBridgeError(res, err, { route });
  }
}

export function registerWorkspaceGitDiffRoutes(
  app: Application,
  deps: { boundWorkspace: string; sendBridgeError: SendBridgeError },
): void {
  app.get('/workspace/git/diff', (_req, res) => {
    void handleDiffList(
      res,
      deps.boundWorkspace,
      deps.sendBridgeError,
      'GET /workspace/git/diff',
    );
  });
  app.get('/workspace/git/diff/file', (req, res) => {
    void handleDiffFile(
      req,
      res,
      deps.boundWorkspace,
      deps.sendBridgeError,
      'GET /workspace/git/diff/file',
    );
  });
}

function resolveTrustedRuntime(
  registry: WorkspaceRegistry,
  req: Request,
  res: Response,
): WorkspaceRuntime | null {
  const runtime = resolveWorkspaceRuntimeFromParam(registry, req, res);
  if (!runtime) return null;
  return requireTrustedWorkspaceRuntime(runtime, res) ? runtime : null;
}

export function registerWorkspaceQualifiedGitDiffRoutes(
  app: Application,
  deps: {
    workspaceRegistry: WorkspaceRegistry;
    sendBridgeError: SendBridgeError;
  },
): void {
  app.get('/workspaces/:workspace/git/diff', (req, res) => {
    const runtime = resolveTrustedRuntime(deps.workspaceRegistry, req, res);
    if (!runtime) return;
    void handleDiffList(
      res,
      runtime.workspaceCwd,
      deps.sendBridgeError,
      'GET /workspaces/:workspace/git/diff',
    );
  });
  app.get('/workspaces/:workspace/git/diff/file', (req, res) => {
    const runtime = resolveTrustedRuntime(deps.workspaceRegistry, req, res);
    if (!runtime) return;
    void handleDiffFile(
      req,
      res,
      runtime.workspaceCwd,
      deps.sendBridgeError,
      'GET /workspaces/:workspace/git/diff/file',
    );
  });
}
