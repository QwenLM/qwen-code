/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Home-directory expansion.
 *
 * Lives in utils because it is plain path arithmetic that both permission checks
 * and unrelated code (the plugin cache, for one) need; keeping it in the
 * permission domain made those callers import the whole domain for one line.
 */

import { homedir } from 'node:os';

/**
 * Expand a leading `~` to the home directory. `~/path` and, on Windows,
 * `~\path` are expanded; anything else is returned unchanged.
 *
 * `~username` is deliberately not supported: resolving another user's home
 * would mean a lookup whose answer can change between the check and the use.
 */
export function expandTilde(path: string): string {
  if (
    path === '~' ||
    path.startsWith('~/') ||
    (process.platform === 'win32' && path.startsWith('~\\'))
  ) {
    return homedir() + path.slice(1);
  }
  return path;
}
