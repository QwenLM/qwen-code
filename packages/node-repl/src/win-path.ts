/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Standalone copy of qwen-code core's `normalizePathEnvForWindows`.
 *
 * On Windows, environment variables are case-insensitive but Node exposes every
 * casing variant (PATH, Path, path). When we spawn the kernel child we merge all
 * case-variant PATH keys into a single canonical `PATH` with deduplicated
 * entries. On non-Windows platforms this is a no-op.
 */
const WINDOWS_PATH_DELIMITER = ';';
let cachedWindowsPathFingerprint: string | undefined;
let cachedMergedWindowsPath: string | undefined;

export function mergeWindowsPathValues(
  env: NodeJS.ProcessEnv,
  pathKeys: string[],
): string | undefined {
  const mergedEntries: string[] = [];
  const seenEntries = new Set<string>();

  for (const key of pathKeys) {
    const value = env[key];
    if (value === undefined) {
      continue;
    }

    for (const entry of value.split(WINDOWS_PATH_DELIMITER)) {
      if (seenEntries.has(entry)) {
        continue;
      }
      seenEntries.add(entry);
      mergedEntries.push(entry);
    }
  }

  return mergedEntries.length > 0
    ? mergedEntries.join(WINDOWS_PATH_DELIMITER)
    : undefined;
}

function getWindowsPathFingerprint(
  env: NodeJS.ProcessEnv,
  pathKeys: string[],
): string {
  return pathKeys.map((key) => `${key}=${env[key] ?? ''}`).join('\0');
}

function sortPathKeys(pathKeys: string[]): string[] {
  return [...pathKeys].sort((left, right) => {
    if (left === 'PATH') {
      return -1;
    }
    if (right === 'PATH') {
      return 1;
    }
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

export function normalizePathEnvForWindows(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  if (process.platform !== 'win32') {
    return env;
  }

  const normalized: NodeJS.ProcessEnv = { ...env };
  const pathKeys = Object.keys(normalized).filter(
    (key) => key.toLowerCase() === 'path',
  );

  if (pathKeys.length === 0) {
    return normalized;
  }

  const orderedPathKeys = sortPathKeys(pathKeys);

  const fingerprint = getWindowsPathFingerprint(normalized, orderedPathKeys);
  const canonicalValue =
    fingerprint === cachedWindowsPathFingerprint
      ? cachedMergedWindowsPath
      : mergeWindowsPathValues(normalized, orderedPathKeys);

  if (fingerprint !== cachedWindowsPathFingerprint) {
    cachedWindowsPathFingerprint = fingerprint;
    cachedMergedWindowsPath = canonicalValue;
  }

  for (const key of pathKeys) {
    if (key !== 'PATH') {
      delete normalized[key];
    }
  }

  if (canonicalValue !== undefined) {
    normalized['PATH'] = canonicalValue;
  }

  return normalized;
}
