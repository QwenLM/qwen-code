import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getSourcePath } from '@craft-agent/session-tools-core';

/**
 * Credential cache entry format (matches main process format).
 * Written by Electron main process, read by this server.
 */
interface CredentialCacheEntry {
  value: string;
  expiresAt?: number;
}

export type CredentialCacheReadErrorLogger = (message: string) => void;

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

/**
 * Get the path to a source's credential cache file.
 * The main process writes decrypted credentials to these files.
 */
export function getCredentialCachePath(workspaceRootPath: string, sourceSlug: string): string {
  return join(getSourcePath(workspaceRootPath, sourceSlug), '.credential-cache.json');
}

/**
 * Read credentials from the cache file for a source.
 * Returns null if the cache doesn't exist, is unreadable, or is expired.
 *
 * Invalid source slugs throw before any filesystem access. That keeps slug
 * validation failures distinct from ordinary cache misses or corrupt JSON.
 */
export function readCredentialCache(
  workspaceRootPath: string,
  sourceSlug: string,
  onReadError?: CredentialCacheReadErrorLogger,
): string | null {
  const cachePath = getCredentialCachePath(workspaceRootPath, sourceSlug);

  try {
    const content = readFileSync(cachePath, 'utf-8');
    const cache = JSON.parse(content) as CredentialCacheEntry;

    if (cache.expiresAt && Date.now() > cache.expiresAt) {
      return null;
    }

    return cache.value || null;
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }

    onReadError?.(
      `Failed to read credential cache for source ${JSON.stringify(sourceSlug)}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return null;
  }
}
