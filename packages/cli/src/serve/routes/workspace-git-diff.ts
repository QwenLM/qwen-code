/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application, Request, Response } from 'express';
import {
  fetchGitDiff,
  fetchGitDiffHunksForFile,
  type GitDiffFileHunks,
  type GitDiffMode,
  type GitDiffOptions,
  type GitDiffResult,
} from '@qwen-code/qwen-code-core';
import type { SendBridgeError } from '../server/error-response.js';
import type { WorkspaceRegistry } from '../workspace-registry.js';
import {
  resolveContainedCwd,
  resolveTrustedRuntime,
  sendUntrustedWorkspaceResponse,
} from '../workspace-route-runtime.js';
import { applyReadHeaders } from './workspace-file-read.js';

// NOTE: unlike the file-read routes, the single-file diff route does NOT resolve
// the `?path` through the workspace filesystem factory. A diff path can name a
// file that was deleted relative to the selected comparison base, which the
// factory's `'read'` intent rejects with ENOENT. Instead the path is contained
// by three layers: (1) the qualified route requires a trusted workspace; (2)
// `fetchGitDiffHunksForFile` normalizes the path to a git-root-relative form and
// rejects absolute paths, drive letters, and `..` traversal; (3) git itself only
// diffs inside the repository, the untracked synthesis reads with `O_NOFOLLOW`,
// and it only runs for paths git confirms as untracked (`ls-files --others`
// never lists files reached through a symlinked directory). The route is
// read-only, so this is adequate without realpath resolution.

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
    oldPath: s.oldPath,
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
  result: GitDiffFileHunks | null,
): Record<string, unknown> {
  return {
    v: 1,
    workspaceCwd,
    path: queryPath,
    available: result !== null && result.hunks.length > 0,
    hunks: (result?.hunks ?? []).map((h) => ({
      oldStart: h.oldStart,
      oldLines: h.oldLines,
      newStart: h.newStart,
      newLines: h.newLines,
      lines: h.lines,
    })),
    // Only present when the per-file caps actually cut content, so the client
    // can label the diff incomplete; absent otherwise (additive to v=1).
    ...(result?.truncated ? { truncated: true } : {}),
  };
}

async function handleDiffList(
  req: Request,
  res: Response,
  workspaceCwd: string,
  sendBridgeError: SendBridgeError,
  route: string,
  assertGenerationOpen?: () => void,
): Promise<void> {
  const options = parseDiffOptions(req, res);
  if (options === null) return;
  try {
    assertGenerationOpen?.();
    applyReadHeaders(res);
    const result = options
      ? await fetchGitDiff(workspaceCwd, options)
      : await fetchGitDiff(workspaceCwd);
    assertGenerationOpen?.();
    res.status(200).json(buildDiffList(workspaceCwd, result));
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
  assertGenerationOpen?: () => void,
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
  // Optional pre-rename path: when present the diff is computed old→new with
  // rename detection so a renamed file shows its actual edit, not all-added.
  const queryOldPath = req.query['oldPath'];
  const oldPath =
    typeof queryOldPath === 'string' && queryOldPath.length > 0
      ? queryOldPath
      : undefined;
  const options = parseDiffOptions(req, res);
  if (options === null) return;
  try {
    assertGenerationOpen?.();
    // Apply the read headers before the await (as handleDiffList does) so the
    // no-store/nosniff headers are also present on the error response if the
    // fetch throws.
    applyReadHeaders(res);
    const result = options
      ? await fetchGitDiffHunksForFile(
          workspaceCwd,
          queryPath,
          oldPath,
          options,
        )
      : await fetchGitDiffHunksForFile(workspaceCwd, queryPath, oldPath);
    assertGenerationOpen?.();
    res.status(200).json(buildFileHunks(workspaceCwd, queryPath, result));
  } catch (err) {
    sendBridgeError(res, err, { route });
  }
}

const DIFF_MODES = new Set<GitDiffMode>([
  'uncommitted',
  'unstaged',
  'staged',
  'commit',
  'branch',
]);

function parseDiffOptions(
  req: Request,
  res: Response,
): GitDiffOptions | undefined | null {
  const rawMode = req.query['mode'];
  const rawRef = req.query['ref'];
  if (rawMode === undefined && rawRef === undefined) return undefined;
  if (typeof rawMode !== 'string' || !DIFF_MODES.has(rawMode as GitDiffMode)) {
    sendDiffParseError(res, 'invalid diff mode');
    return null;
  }
  const mode = rawMode as GitDiffMode;
  if (mode === 'commit' || mode === 'branch') {
    if (typeof rawRef !== 'string' || rawRef.trim().length === 0) {
      sendDiffParseError(res, 'ref query parameter is required for this mode');
      return null;
    }
    return { mode, ref: rawRef.trim() };
  }
  if (rawRef !== undefined) {
    sendDiffParseError(res, 'ref is only supported for commit or branch mode');
    return null;
  }
  return { mode };
}

function sendDiffParseError(res: Response, error: string): void {
  applyReadHeaders(res);
  res.status(400).json({ errorKind: 'parse_error', error, status: 400 });
}

export function registerWorkspaceGitDiffRoutes(
  app: Application,
  deps: {
    boundWorkspace: string;
    sendBridgeError: SendBridgeError;
    isWorkspaceTrusted?: () => boolean;
    captureGenerationAssertion?: () => (() => void) | undefined;
  },
): void {
  app.get('/workspace/git/diff', (req, res) => {
    if (deps.isWorkspaceTrusted?.() === false) {
      sendUntrustedWorkspaceResponse(res);
      return;
    }
    void handleDiffList(
      req,
      res,
      deps.boundWorkspace,
      deps.sendBridgeError,
      'GET /workspace/git/diff',
      deps.captureGenerationAssertion?.(),
    );
  });
  app.get('/workspace/git/diff/file', (req, res) => {
    if (deps.isWorkspaceTrusted?.() === false) {
      sendUntrustedWorkspaceResponse(res);
      return;
    }
    void handleDiffFile(
      req,
      res,
      deps.boundWorkspace,
      deps.sendBridgeError,
      'GET /workspace/git/diff/file',
      deps.captureGenerationAssertion?.(),
    );
  });
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
      req,
      res,
      resolveContainedCwd(req, runtime.workspaceCwd),
      deps.sendBridgeError,
      'GET /workspaces/:workspace/git/diff',
      () => runtime.generationGuard?.assertOpen(),
    );
  });
  app.get('/workspaces/:workspace/git/diff/file', (req, res) => {
    const runtime = resolveTrustedRuntime(deps.workspaceRegistry, req, res);
    if (!runtime) return;
    void handleDiffFile(
      req,
      res,
      resolveContainedCwd(req, runtime.workspaceCwd),
      deps.sendBridgeError,
      'GET /workspaces/:workspace/git/diff/file',
      () => runtime.generationGuard?.assertOpen(),
    );
  });
}
