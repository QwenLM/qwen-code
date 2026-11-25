/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';

/**
 * Returns whether `candidate` is the same path as `root` or is contained by it.
 *
 * Callers that need symlink-aware containment must pass canonical paths from
 * `realpath`; this helper deliberately handles only path comparison.
 */
export function isPathContained(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}
