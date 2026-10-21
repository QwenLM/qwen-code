/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createWebShellDaemonScenario,
  type WebShellDaemonScenario,
} from './mockDaemon';

const GIT_WORKSPACE_CWD = '/tmp/qwen-web-shell-e2e';

/**
 * A scenario with a trusted primary workspace that reports a git branch, so
 * the composer git chip and the sidebar git pill render. Shared by the git
 * specs and the git screenshot script so the workspace/gitStatus shape
 * cannot drift between them.
 */
export function createGitWorkspaceScenario(
  overrides: Parameters<typeof createWebShellDaemonScenario>[0] = {},
): WebShellDaemonScenario {
  return createWebShellDaemonScenario({
    capabilities: {
      workspaces: [
        {
          id: 'primary',
          cwd: GIT_WORKSPACE_CWD,
          primary: true,
          trusted: true,
        },
      ],
    },
    gitStatus: { v: 2, workspaceCwd: GIT_WORKSPACE_CWD, branch: 'main' },
    ...overrides,
  });
}
