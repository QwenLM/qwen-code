/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { globSync } from 'glob';

function toGlobPath(filePath) {
  return filePath.replaceAll('\\', '/');
}

export function getWorkspacePackageJsonPaths(root, workspaces) {
  const packageJsonPaths = new Set();

  for (const workspace of workspaces) {
    const isExcluded = workspace.startsWith('!');
    const pattern = toGlobPath(isExcluded ? workspace.slice(1) : workspace);
    const matches = globSync(`${pattern}/package.json`, { cwd: root });

    for (const match of matches) {
      const packageJsonPath = toGlobPath(match);

      if (isExcluded) {
        packageJsonPaths.delete(packageJsonPath);
      } else {
        packageJsonPaths.add(packageJsonPath);
      }
    }
  }

  return [...packageJsonPaths].sort();
}
