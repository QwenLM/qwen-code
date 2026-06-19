/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as os from 'node:os';
import * as path from 'node:path';

export function resolvePath(p: string): string {
  if (!p) {
    return '';
  }
  let expandedPath = p;
  if (p.toLowerCase().startsWith('%userprofile%')) {
    expandedPath = os.homedir() + p.substring('%userprofile%'.length);
  } else if (p === '~' || p.startsWith('~/')) {
    expandedPath = os.homedir() + p.substring(1);
  } else if (p.startsWith('~\\')) {
    expandedPath = path.join(
      os.homedir(),
      ...p
        .substring(2)
        .split(/[/\\]+/)
        .filter(Boolean),
    );
  }
  return path.normalize(expandedPath);
}
