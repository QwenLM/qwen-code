/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeProjectRoot } from '../packages/cli/src/config/approval-project-root.js';
import { hashProjectHooks } from '../packages/cli/src/config/hook-approvals.js';

/**
 * Records the approval a user would give in the project hooks dialog, which
 * an ACP or headless run cannot show, keyed and hashed exactly as the CLI
 * reads it.
 */
export function approveProjectHooks(qwenHome: string, workspaceDir: string) {
  const { hooks } = JSON.parse(
    readFileSync(join(workspaceDir, '.qwen', 'settings.json'), 'utf8'),
  ) as { hooks: Record<string, unknown> };
  writeFileSync(
    join(qwenHome, 'hookApprovals.json'),
    JSON.stringify({
      [normalizeProjectRoot(workspaceDir)]: {
        hash: hashProjectHooks(hooks),
        status: 'approved',
      },
    }),
  );
}
