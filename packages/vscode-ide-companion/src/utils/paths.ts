/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import * as os from 'node:os';

/**
 * Expands tilde and resolves relative paths to absolute.
 * Mirrors Storage.resolvePath() in packages/core.
 */
function resolvePath(dir: string): string {
  let resolved = dir;
  if (
    resolved === '~' ||
    resolved.startsWith('~/') ||
    resolved.startsWith('~\\')
  ) {
    const relativeSegments =
      resolved === '~'
        ? []
        : resolved
            .slice(2)
            .split(/[/\\]+/)
            .filter(Boolean);
    resolved = path.join(os.homedir(), ...relativeSegments);
  }
  if (!path.isAbsolute(resolved)) {
    resolved = path.resolve(resolved);
  }
  return resolved;
}

/**
 * Returns the global Qwen home directory (config, credentials, etc.).
 *
 * Priority: QWEN_HOME env var > ~/.qwen
 */
export function getGlobalQwenDir(): string {
  const envDir = process.env['QWEN_HOME'];
  if (envDir) {
    return resolvePath(envDir);
  }
  const homeDir = os.homedir();
  return homeDir
    ? path.join(homeDir, '.qwen')
    : path.join(os.tmpdir(), '.qwen');
}

/**
 * Returns the runtime base directory for ephemeral data (tmp, debug, IDE
 * lock files, sessions, etc.).
 *
 * Priority: QWEN_RUNTIME_DIR env var > QWEN_HOME env var > ~/.qwen
 *
 * This mirrors the fallback chain in packages/core Storage.getRuntimeBaseDir()
 * without importing from core to avoid cross-package dependencies.
 */
export function getRuntimeBaseDir(): string {
  const runtimeDir = process.env['QWEN_RUNTIME_DIR'];
  if (runtimeDir) {
    return resolvePath(runtimeDir);
  }
  return getGlobalQwenDir();
}
