/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Records the approval a user would give in the project hooks dialog, which
 * an ACP or headless run cannot show: bound to the sorted-key SHA-256 of the
 * workspace's `.qwen/settings.json` hooks block.
 */
export function approveProjectHooks(qwenHome: string, workspaceDir: string) {
  const { hooks } = JSON.parse(
    readFileSync(join(workspaceDir, '.qwen', 'settings.json'), 'utf8'),
  ) as { hooks: Record<string, unknown> };
  const stable = JSON.stringify(hooks, (_key, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((k) => [k, (value as Record<string, unknown>)[k]]),
        )
      : value,
  );
  writeFileSync(
    join(qwenHome, 'hookApprovals.json'),
    JSON.stringify({
      [resolve(workspaceDir)]: {
        hash: createHash('sha256').update(stable).digest('hex'),
        status: 'approved',
      },
    }),
  );
}
