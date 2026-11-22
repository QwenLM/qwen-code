/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeProjectRoot } from '../packages/cli/src/config/approval-project-root.js';
import { readProjectEnvFiles } from '../packages/cli/src/config/environment.js';
import { hashProjectHooks } from '../packages/cli/src/config/hook-approvals.js';

/**
 * Records the approval a user would give in the project hooks dialog, which
 * an ACP or headless run cannot show, keyed and hashed exactly as the CLI
 * reads it.
 */
export function approveProjectHooks(qwenHome: string, workspaceDir: string) {
  const { hooks, env } = JSON.parse(
    readFileSync(join(workspaceDir, '.qwen', 'settings.json'), 'utf8'),
  ) as { hooks: Record<string, unknown>; env?: unknown };
  const root = normalizeProjectRoot(workspaceDir);
  writeFileSync(
    join(qwenHome, 'hookApprovals.json'),
    JSON.stringify({
      [root]: {
        hash: hashProjectHooks({
          hooks,
          env: { files: readProjectEnvFiles({}, root), settings: env ?? null },
        }),
        status: 'approved',
      },
    }),
  );
}
