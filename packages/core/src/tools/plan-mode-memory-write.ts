/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import type { Config } from '../config/config.js';
import { isAutoMemoryFile } from '../memory/structured-memory-store.js';
import { getSessionCwd } from '../utils/Shell.js';
import { rewritePosixDrivePath } from '../utils/paths.js';

function getRequestedAbsolutePath(config: Config, filePath: string): string {
  return path.resolve(getSessionCwd(config), rewritePosixDrivePath(filePath));
}

export function resolvePlanModeWritePath(
  config: Config,
  filePath: string,
  resolveDefaultPath?: () => string,
): string {
  if (!config.isPlanMode()) {
    return resolveDefaultPath?.() ?? getRequestedAbsolutePath(config, filePath);
  }

  const requestedPath = getRequestedAbsolutePath(config, filePath);
  if (isAutoMemoryFile(requestedPath, config)) {
    return requestedPath;
  }

  return path.join(config.storage.getPlansDir(), path.basename(filePath));
}
