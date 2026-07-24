/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application } from 'express';
import { fetchGitHubPullRequests } from '@qwen-code/qwen-code-core';
import type { SendBridgeError } from '../server/error-response.js';
import type { WorkspaceRegistry } from '../workspace-registry.js';
import {
  requireTrustedWorkspaceRuntime,
  resolveWorkspaceRuntimeFromParam,
} from '../workspace-route-runtime.js';
import { applyReadHeaders } from './workspace-file-read.js';

function sanitizeMessage(message: string, workspaceCwd: string): string {
  return message.split(workspaceCwd).join('<workspace>');
}

export function registerWorkspaceQualifiedGitHubPrsRoutes(
  app: Application,
  deps: {
    workspaceRegistry: WorkspaceRegistry;
    sendBridgeError: SendBridgeError;
  },
): void {
  app.get('/workspaces/:workspace/github/prs', async (req, res) => {
    const route = 'GET /workspaces/:workspace/github/prs';
    const runtime = resolveWorkspaceRuntimeFromParam(
      deps.workspaceRegistry,
      req,
      res,
    );
    if (!runtime) return;
    if (!requireTrustedWorkspaceRuntime(runtime, res)) return;

    applyReadHeaders(res);
    try {
      const result = await fetchGitHubPullRequests(runtime.workspaceCwd);
      switch (result.kind) {
        case 'ok':
          res.status(200).json({
            v: 1,
            workspaceCwd: runtime.workspaceCwd,
            available: true,
            pullRequests: result.pullRequests,
          });
          return;
        case 'not_a_repo':
          res.status(200).json({
            v: 1,
            workspaceCwd: runtime.workspaceCwd,
            available: false,
            pullRequests: [],
          });
          return;
        case 'cli_unavailable':
          res.status(502).json({
            error:
              'The GitHub CLI (gh) is not installed on the daemon host; install it and run `gh auth login`.',
            code: 'github_cli_unavailable',
            status: 502,
          });
          return;
        case 'failed':
          res.status(502).json({
            error: sanitizeMessage(result.message, runtime.workspaceCwd),
            code: 'github_prs_failed',
            status: 502,
          });
          return;
        default:
          throw new Error(
            `unexpected fetchGitHubPullRequests result: ${JSON.stringify(result)}`,
          );
      }
    } catch (err) {
      deps.sendBridgeError(res, err, { route });
    }
  });
}
