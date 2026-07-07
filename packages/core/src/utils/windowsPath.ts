const WINDOWS_PATH_DELIMITER = ';';
let cachedWindowsPathFingerprint: string | undefined;
let cachedMergedWindowsPath: string | undefined;

/**
 * Merges multiple PATH-like environment variable values into a single
 * deduplicated string, preserving the original order and removing duplicates.
 *
 * @param env - The environment object containing PATH-like keys
 * @param pathKeys - Ordered list of keys whose values should be merged
 * @returns The merged PATH string, or undefined if no entries were found
 */
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

/**
 * Returns a fingerprint string for the given PATH-like keys, used for caching.
 */
function getWindowsPathFingerprint(
  env: NodeJS.ProcessEnv,
  pathKeys: string[],
): string {
  return pathKeys.map((key) => `${key}=${env[key] ?? ''}`).join('\0');
}

/**
 * Sorts PATH-like keys so that uppercase `PATH` comes first, followed by
 * other casing variants in lexicographic order.
 */
function sortPathKeys(pathKeys: string[]): string[] {
  return [...pathKeys].sort((left, right) => {
    if (left === 'PATH') {
      return -1;
    }
    if (right === 'PATH') {
      return 1;
    }
    return left.localeCompare(right);
  });
}

/**
 * Normalizes PATH-like environment variables on Windows by merging all
 * case-variant keys (PATH, Path, path, etc.) into a single canonical `PATH`
 * key with deduplicated entries. On non-Windows platforms this is a no-op.
 *
 * Results are cached by fingerprint to avoid redundant merges when the
 * environment has not changed between calls.
 *
 * @param env - The environment object to normalize
 * @returns A new environment object with a single canonical `PATH` key
 */
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
