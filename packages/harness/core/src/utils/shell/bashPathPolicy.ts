/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { windowsPathToPosixPath } from '../windowsPaths.js';
import { ENV_CONFIG_DIR } from '../../config/brand.js';

export interface BashPathPolicyInput {
  basePath?: string;
  requestPath?: string;
  configEnv?: Record<string, string | undefined>;
  pluginBinPaths?: string[];
  isWindows: boolean;
  includeExistingShellPath?: boolean;
}

export interface BashPathPolicyResult {
  path: string | undefined;
  exportCommand: string | null;
}

/**
 * Returns configured user config `bin/` directories that should keep priority
 * over the user's ambient PATH inside Bash tool executions.
 *
 * SDK integrations can supply the brand's dedicated CONFIG_DIR whose `bin/`
 * contains dispatcher executables. Windows Git Bash snapshots capture the
 * shell-internal PATH and can lose the parent process ordering, so we restore
 * these paths after sourcing the snapshot.
 * This helper reads only the selected brand's environment variable; it does
 * not resolve --config-dir or SDK config_dir overrides.
 */
export function getConfigBinPathsFromEnv(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const configDir = env[ENV_CONFIG_DIR]?.trim();
  return configDir ? [path.join(configDir, 'bin')] : [];
}

function splitPathList(pathList: string | undefined, isWindows: boolean): string[] {
  if (!pathList) {
    return [];
  }

  if (isWindows) {
    if (pathList.includes(';')) {
      return pathList.split(';');
    }
    if (/^[A-Za-z]:[\\/]/.test(pathList)) {
      return [pathList];
    }
  }

  return pathList.split(':');
}

function toBashPath(pathEntry: string, isWindows: boolean): string {
  const trimmed = pathEntry.trim();
  return isWindows ? windowsPathToPosixPath(trimmed) : trimmed;
}

function appendPathEntries(
  target: string[],
  seen: Set<string>,
  entries: Iterable<string | undefined>,
  isWindows: boolean,
): void {
  for (const entry of entries) {
    if (!entry) {
      continue;
    }

    const bashPath = toBashPath(entry, isWindows);
    if (!bashPath || seen.has(bashPath)) {
      continue;
    }

    seen.add(bashPath);
    target.push(bashPath);
  }
}

function quotePathForBash(pathToQuote: string): string {
  return `'${pathToQuote.replace(/'/g, "'\\''")}'`;
}

export function buildBashPathPolicy(
  input: BashPathPolicyInput,
): BashPathPolicyResult {
  const isWindows = input.isWindows;
  const entries: string[] = [];
  const seen = new Set<string>();

  appendPathEntries(
    entries,
    seen,
    getConfigBinPathsFromEnv(input.configEnv),
    isWindows,
  );
  appendPathEntries(entries, seen, input.pluginBinPaths ?? [], isWindows);
  appendPathEntries(
    entries,
    seen,
    splitPathList(input.requestPath, isWindows),
    isWindows,
  );
  appendPathEntries(
    entries,
    seen,
    splitPathList(input.basePath, isWindows),
    isWindows,
  );

  const includeExistingShellPath = input.includeExistingShellPath ?? false;
  if (entries.length === 0) {
    return {
      path: undefined,
      exportCommand: null,
    };
  }

  const quotedEntries = entries.map(quotePathForBash);
  const exportValue = includeExistingShellPath
    ? `${quotedEntries.join(':')}:"$PATH"`
    : quotedEntries.join(':');

  return {
    path: entries.join(':'),
    exportCommand: `export PATH=${exportValue}`,
  };
}
