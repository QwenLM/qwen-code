/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Stats } from 'node:fs';
import { lstat } from 'node:fs/promises';

// Windows stat modes are synthetic (directories report 0o777) and
// process.getuid is undefined there, so the POSIX privacy checks apply only
// where the bits are real. On POSIX the current-user ownership check runs at
// every strictness level; 'none' relaxes only the mode bits. Shared inside
// qwen-live by the monitor debug store ('owner-only') and live discovery
// ('exact-0700', or 'none' for a non-private base). Equivalent gates in
// packages/cli and packages/live-host keep their own copies:
// privateDirectoryStat is not in qwen-live's exports map.
export async function privateDirectoryStat(
  directory: string,
  modeCheck: 'none' | 'owner-only' | 'exact-0700',
): Promise<Stats | undefined> {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return undefined;
  if (
    process.platform !== 'win32' &&
    ((modeCheck === 'owner-only' && (stat.mode & 0o077) !== 0) ||
      (modeCheck === 'exact-0700' && (stat.mode & 0o777) !== 0o700) ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid()))
  )
    return undefined;
  return stat;
}
