/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import {
  isFsTouchUnsafePath,
  isWithinRoot,
  isHeadlessMode,
  type HeadlessModeOptions,
} from '@qwen-code/core';
import type { Settings } from './settings.js';

export interface TrustResult {
  isTrusted: boolean | undefined;
  source: 'file' | undefined;
}

const realPathCache = new Map<string, string>();

/**
 * FOR TESTING PURPOSES ONLY.
 * Clears the real path cache.
 */
export function clearRealPathCacheForTesting(): void {
  realPathCache.clear();
}

function getRealPath(location: string): string {
  let realPath = realPathCache.get(location);
  if (realPath !== undefined) {
    return realPath;
  }

  // SECURITY + consistency: a network location is registered elsewhere under
  // the spelling the operator supplied. realpathSync would resolve a DFS alias
  // or a mapped drive to a different UNC host, so the isWithinRoot comparison
  // below would miss and trust would silently not apply. It also performs an
  // SMB/NTLM handshake, so do not probe these shapes at all.
  if (isFsTouchUnsafePath(location)) {
    realPathCache.set(location, location);
    return location;
  }

  try {
    realPath = fs.existsSync(location) ? fs.realpathSync(location) : location;
  } catch {
    realPath = location;
  }

  realPathCache.set(location, realPath);
  return realPath;
}

/** Is folder trust feature enabled per the current applied settings */
export function isFolderTrustEnabled(settings: Settings): boolean {
  const folderTrustSetting = settings.security?.folderTrust?.enabled ?? true;
  return folderTrustSetting;
}

function getWorkspaceTrustFromLocalConfig(
  workspaceDir: string,
  settings: Settings,
): TrustResult {

  const trustedDirs: string[] = [
    ...((settings.permissions?.trustDirectories as string[]) ?? []),
    ...((settings.permissions?.additionalDirectories as string[]) ?? []),
  ];

  const realWorkspace = getRealPath(workspaceDir);

  let longestTrustedLen = -1;
  for (const dir of trustedDirs) {
    const real = getRealPath(dir);
    if (isWithinRoot(realWorkspace, real) && dir.length > longestTrustedLen) {
      longestTrustedLen = dir.length;
    }
  }

  if (longestTrustedLen >= 0) {
    return { isTrusted: true, source: 'file' };
  }

  return { isTrusted: undefined, source: undefined };
}

export function isWorkspaceTrusted(
  settings: Settings,
  workspaceDir: string = process.cwd(),
  _trustConfig?: Record<string, string>,
  headlessOptions?: HeadlessModeOptions,
  headless = isHeadlessMode(headlessOptions),
): TrustResult {
  if (headless) {
    return { isTrusted: true, source: undefined };
  }

  if (!isFolderTrustEnabled(settings)) {
    return { isTrusted: true, source: undefined };
  }

  return getWorkspaceTrustFromLocalConfig(
    workspaceDir,
    settings,
  );
}
