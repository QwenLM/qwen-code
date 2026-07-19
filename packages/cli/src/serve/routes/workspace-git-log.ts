/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application, Request, Response } from 'express';
import {
  fetchGitLog,
  fetchGitCommitDetail,
  MAX_LOG_LIMIT,
  DEFAULT_LOG_LIMIT,
  type GitLogResult,
  type GitCommitDetail,
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

function buildLogList(
  workspaceCwd: string,
  result: GitLogResult | null,
): Record<string, unknown> {
  if (!result) {
    return {
      v: 1,
      workspaceCwd,
      available: false,
      entries: [],
      hasMore: false,
    };
  }
  return {
    v: 1,
    workspaceCwd,
    available: true,
    entries: result.entries.map((e) => ({
      sha: e.sha,
      shortSha: e.shortSha,
      authorName: e.authorName,
      authorEmail: e.authorEmail,
      authorDate: e.authorDate,
      subject: e.subject,
      ...(e.refs ? { refs: e.refs } : {}),
      parents: e.parents,
    })),
    hasMore: result.hasMore,
  };
}

function buildCommitDetail(
  workspaceCwd: string,
  result: GitCommitDetail | null,
): Record<string, unknown> {
  if (!result) {
    return { v: 1, workspaceCwd, available: false };
  }
  return {
    v: 1,
    workspaceCwd,
    available: true,
    sha: result.sha,
    shortSha: result.shortSha,
    authorName: result.authorName,
    authorEmail: result.authorEmail,
    authorDate: result.authorDate,
    subject: result.subject,
    body: result.body,
    ...(result.refs ? { refs: result.refs } : {}),
    parents: result.parents,
    files: result.files.map((f) => ({
      path: f.path,
      added: f.added,
      removed: f.removed,
      isBinary: f.isBinary,
    })),
    filesCount: result.filesCount,
    linesAdded: result.linesAdded,
    linesRemoved: result.linesRemoved,
    hiddenCount: result.hiddenCount,
  };
}

function parsePagination(req: Request): { limit: number; skip: number } {
  const rawLimit = req.query['limit'];
  const rawSkip = req.query['skip'];
  const limit = Math.min(
    Math.max(
      typeof rawLimit === 'string'
        ? parseInt(rawLimit, 10) || DEFAULT_LOG_LIMIT
        : DEFAULT_LOG_LIMIT,
      1,
    ),
    MAX_LOG_LIMIT,
  );
  const skip = Math.max(
    typeof rawSkip === 'string' ? parseInt(rawSkip, 10) || 0 : 0,
    0,
  );
  return { limit, skip };
}

async function handleLogList(
  req: Request,
  res: Response,
  workspaceCwd: string,
  sendBridgeError: SendBridgeError,
  route: string,
): Promise<void> {
  try {
    applyReadHeaders(res);
    const { limit, skip } = parsePagination(req);
    const result = await fetchGitLog(workspaceCwd, { limit, skip });
    res.status(200).json(buildLogList(workspaceCwd, result));
  } catch (err) {
    sendBridgeError(res, err, { route });
  }
}

async function handleCommitDetail(
  req: Request,
  res: Response,
  workspaceCwd: string,
  sendBridgeError: SendBridgeError,
  route: string,
): Promise<void> {
  const sha = req.query['sha'];
  if (
    typeof sha !== 'string' ||
    sha.length === 0 ||
    !/^[0-9a-f]{7,40}$/i.test(sha)
  ) {
    applyReadHeaders(res);
    res.status(400).json({
      errorKind: 'parse_error',
      error: 'sha query parameter is required',
      status: 400,
    });
    return;
  }
  try {
    applyReadHeaders(res);
    const result = await fetchGitCommitDetail(workspaceCwd, sha);
    res.status(200).json(buildCommitDetail(workspaceCwd, result));
  } catch (err) {
    sendBridgeError(res, err, { route });
  }
}

export function registerWorkspaceGitLogRoutes(
  app: Application,
  deps: { boundWorkspace: string; sendBridgeError: SendBridgeError },
): void {
  app.get('/workspace/git/log', (req, res) => {
    void handleLogList(
      req,
      res,
      deps.boundWorkspace,
      deps.sendBridgeError,
      'GET /workspace/git/log',
    );
  });
  app.get('/workspace/git/log/commit', (req, res) => {
    void handleCommitDetail(
      req,
      res,
      deps.boundWorkspace,
      deps.sendBridgeError,
      'GET /workspace/git/log/commit',
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

export function registerWorkspaceQualifiedGitLogRoutes(
  app: Application,
  deps: {
    workspaceRegistry: WorkspaceRegistry;
    sendBridgeError: SendBridgeError;
  },
): void {
  app.get('/workspaces/:workspace/git/log', (req, res) => {
    const runtime = resolveTrustedRuntime(deps.workspaceRegistry, req, res);
    if (!runtime) return;
    void handleLogList(
      req,
      res,
      runtime.workspaceCwd,
      deps.sendBridgeError,
      'GET /workspaces/:workspace/git/log',
    );
  });
  app.get('/workspaces/:workspace/git/log/commit', (req, res) => {
    const runtime = resolveTrustedRuntime(deps.workspaceRegistry, req, res);
    if (!runtime) return;
    void handleCommitDetail(
      req,
      res,
      runtime.workspaceCwd,
      deps.sendBridgeError,
      'GET /workspaces/:workspace/git/log/commit',
    );
  });
}
