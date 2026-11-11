/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { homedir, CONFIG_DIR } from '../utils/paths.js';
import { runLogger } from '../utils/runLogger.js';
import {
  readBrandEnv,
  ENV_WRITE_SYSTEM_MD,
} from '../config/brand.js';

export type ResolvedPath = {
  isSwitch: boolean;
  value: string | null;
  isDisabled: boolean;
};

/**
 * Resolves a path or switch value from an environment variable.
 */
export function resolvePathFromEnv(envVar?: string): ResolvedPath {
  const trimmedEnvVar = envVar?.trim();
  if (!trimmedEnvVar) {
    return { isSwitch: false, value: null, isDisabled: false };
  }

  const lowerEnvVar = trimmedEnvVar.toLowerCase();
  if (['0', 'false', '1', 'true'].includes(lowerEnvVar)) {
    const isDisabled = ['0', 'false'].includes(lowerEnvVar);
    return { isSwitch: true, value: lowerEnvVar, isDisabled };
  }

  let customPath = trimmedEnvVar;
  if (customPath.startsWith('~/') || customPath === '~') {
    try {
      const home = homedir();
      if (customPath === '~') {
        customPath = home;
      } else {
        customPath = path.join(home, customPath.slice(2));
      }
    } catch (error) {
      runLogger.warn(
        `Could not resolve home directory for path: ${trimmedEnvVar}`,
        error,
      );
      return { isSwitch: false, value: null, isDisabled: false };
    }
  }

  return {
    isSwitch: false,
    value: path.resolve(customPath),
    isDisabled: false,
  };
}

/**
 * If ENV_WRITE_SYSTEM_MD is set, writes the final prompt to the specified
 * path. Debug-only: lets developers inspect the assembled system prompt on disk.
 */
export function maybeWriteSystemMd(renderPrompt: () => string): void {
  const resolution = resolvePathFromEnv(
    readBrandEnv(ENV_WRITE_SYSTEM_MD),
  );
  if (!resolution.value || resolution.isDisabled) return;
  const defaultPath = path.resolve(path.join(CONFIG_DIR, 'system.md'));
  const writePath = resolution.isSwitch ? defaultPath : resolution.value;
  fs.mkdirSync(path.dirname(writePath), { recursive: true });
  fs.writeFileSync(writePath, renderPrompt());
}
