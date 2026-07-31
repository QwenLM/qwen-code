import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertValidSourceSlug } from '@craft-agent/session-tools-core';

/**
 * Credential cache entry format (matches main process format).
 * Written by Electron main process, read by this server.
 */
interface CredentialCacheEntry {
  value: string;
  expiresAt?: number;
}

/**
 * Get the path to a source's credential cache file.
 * The main process writes decrypted credentials to these files.
 */
export function getCredentialCachePath(workspaceRootPath: string, sourceSlug: string): string {
  assertValidSourceSlug(sourceSlug);
  return join(workspaceRootPath, 'sources', sourceSlug, '.credential-cache.json');
}

/**
 * Read credentials from the cache file for a source.
 * Returns null if the cache doesn't exist, the slug is invalid, or the cache is expired.
 */
export function readCredentialCache(workspaceRootPath: string, sourceSlug: string): string | null {
  try {
    const cachePath = getCredentialCachePath(workspaceRootPath, sourceSlug);
    if (!existsSync(cachePath)) {
      return null;
    }

    const content = readFileSync(cachePath, 'utf-8');
    const cache = JSON.parse(content) as CredentialCacheEntry;

    if (cache.expiresAt && Date.now() > cache.expiresAt) {
      return null;
    }

    return cache.value || null;
  } catch {
    return null;
  }
}
