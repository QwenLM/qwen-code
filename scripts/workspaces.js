/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { join } from 'node:path';
import { globSync } from 'glob';

export function getWorkspacePackageJsonPaths(root, workspaces) {
  const packageJsonPaths = new Set();

  for (const workspace of workspaces) {
    const isExcluded = workspace.startsWith('!');
    const pattern = isExcluded ? workspace.slice(1) : workspace;
    const matches = globSync(join(pattern, 'package.json'), { cwd: root });

    for (const match of matches) {
      if (isExcluded) {
        packageJsonPaths.delete(match);
      } else {
        packageJsonPaths.add(match);
      }
    }
  }

  return [...packageJsonPaths].sort();
}
