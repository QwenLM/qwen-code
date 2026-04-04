/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { basename, dirname, join, sep } from 'node:path';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import type { Suggestion } from '../components/SuggestionsDisplay.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DirectoryEntry {
  name: string;
  path: string;
  type: 'directory';
}

export interface PathEntry {
  name: string;
  path: string;
  type: 'directory' | 'file';
}

export interface CompletionOptions {
  basePath?: string;
  maxResults?: number;
}

export interface PathCompletionOptions extends CompletionOptions {
  includeFiles?: boolean;
  includeHidden?: boolean;
}

interface ParsedPath {
  directory: string;
  prefix: string;
}

// ─── LRU Cache ───────────────────────────────────────────────────────────────

/**
 * Minimal LRU cache for directory scans.
 * Using a Map with size limiting as a simple LRU alternative
 * to avoid adding an external dependency.
 */
class SimpleLRUCache<K, V> {
  private cache = new Map<K, V>();
  private readonly maxSize: number;
  private readonly ttl: number;
  private readonly timestamps = new Map<K, number>();

  constructor(maxSize: number, ttlMs: number) {
    this.maxSize = maxSize;
    this.ttl = ttlMs;
  }

  get(key: K): V | undefined {
    const ts = this.timestamps.get(key);
    if (ts !== undefined && Date.now() - ts > this.ttl) {
      this.cache.delete(key);
      this.timestamps.delete(key);
      return undefined;
    }
    const value = this.cache.get(key);
    if (value !== undefined) {
      // Move to end (most recently used)
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    // Evict oldest entry if at capacity
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
        this.timestamps.delete(oldestKey);
      }
    }
    this.cache.set(key, value);
    this.timestamps.set(key, Date.now());
  }

  clear(): void {
    this.cache.clear();
    this.timestamps.clear();
  }
}

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * Maximum number of directory entries to return from a single scan.
 * Keeps the suggestion UI responsive and avoids excessive memory usage.
 */
const MAX_SCAN_RESULTS = 100;

// ─── Cache configuration ─────────────────────────────────────────────────────

const CACHE_SIZE = 500;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Initialize LRU caches
const directoryCache = new SimpleLRUCache<string, DirectoryEntry[]>(
  CACHE_SIZE,
  CACHE_TTL,
);
const pathCache = new SimpleLRUCache<string, PathEntry[]>(
  CACHE_SIZE,
  CACHE_TTL,
);

// ─── Path helpers ────────────────────────────────────────────────────────────

/**
 * Expands a path starting with ~ to the home directory
 */
function expandPath(partialPath: string): string {
  if (
    partialPath.startsWith('~') &&
    (partialPath.length === 1 ||
      partialPath[1] === sep ||
      partialPath[1] === '/')
  ) {
    const home = homedir();
    if (partialPath.length === 1) return home;
    return join(home, partialPath.slice(2));
  }
  return partialPath;
}

/**
 * Parses a partial path into directory and prefix components
 */
export function parsePartialPath(
  partialPath: string,
  basePath?: string,
): ParsedPath {
  // Handle empty input
  if (!partialPath) {
    const directory = basePath ?? process.cwd();
    return { directory, prefix: '' };
  }

  const resolved = expandPath(partialPath);

  // If path ends with separator, treat as directory with no prefix
  if (partialPath.endsWith('/') || partialPath.endsWith(sep)) {
    return { directory: resolved, prefix: '' };
  }

  // Split into directory and prefix
  const directory = dirname(resolved);
  const prefix = basename(partialPath);

  return { directory, prefix };
}

/**
 * Checks if a string looks like a path (starts with path-like prefixes)
 */
export function isPathLikeToken(token: string): boolean {
  return (
    token.startsWith('~/') ||
    token.startsWith('/') ||
    token.startsWith('./') ||
    token.startsWith('../') ||
    token === '~' ||
    token === '.' ||
    token === '..' ||
    // Also handle Windows paths
    (sep === '\\' && /^[a-zA-Z]:\\/.test(token))
  );
}

// ─── Directory scanning ──────────────────────────────────────────────────────

/**
 * Scans a directory and returns subdirectories
 * Uses LRU cache to avoid repeated filesystem calls
 */
export async function scanDirectory(
  dirPath: string,
): Promise<DirectoryEntry[]> {
  // Check cache first
  const cached = directoryCache.get(dirPath);
  if (cached) {
    return cached;
  }

  try {
    const entries = await readdir(dirPath, { withFileTypes: true });

    // Filter for directories only, exclude hidden directories
    const directories = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => ({
        name: entry.name,
        path: join(dirPath, entry.name),
        type: 'directory' as const,
      }))
      .slice(0, MAX_SCAN_RESULTS);

    // Cache the results
    directoryCache.set(dirPath, directories);

    return directories;
  } catch {
    return [];
  }
}

/**
 * Scans a directory and returns both files and subdirectories
 * Uses LRU cache to avoid repeated filesystem calls
 */
export async function scanDirectoryForPaths(
  dirPath: string,
  includeHidden = false,
): Promise<PathEntry[]> {
  const cacheKey = `${dirPath}:${includeHidden}`;
  const cached = pathCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  try {
    const entries = await readdir(dirPath, { withFileTypes: true });

    const paths: PathEntry[] = [];
    for (const entry of entries) {
      if (!includeHidden && entry.name.startsWith('.')) continue;

      let entryType: 'directory' | 'file';
      if (entry.isDirectory()) {
        entryType = 'directory';
      } else if (entry.isFile()) {
        entryType = 'file';
      } else {
        continue; // Skip symlinks, etc.
      }

      paths.push({
        name: entry.name,
        path: join(dirPath, entry.name),
        type: entryType,
      });
    }

    // Sort directories first, then alphabetically
    paths.sort((a, b) => {
      if (a.type === 'directory' && b.type !== 'directory') return -1;
      if (a.type !== 'directory' && b.type === 'directory') return 1;
      return a.name.localeCompare(b.name);
    });

    const limited = paths.slice(0, MAX_SCAN_RESULTS);
    pathCache.set(cacheKey, limited);
    return limited;
  } catch {
    return [];
  }
}

// ─── Completion functions ────────────────────────────────────────────────────

/**
 * Main function to get directory completion suggestions
 */
export async function getDirectoryCompletions(
  partialPath: string,
  options: CompletionOptions = {},
): Promise<Suggestion[]> {
  const { basePath = process.cwd(), maxResults = 10 } = options;

  const { directory, prefix } = parsePartialPath(partialPath, basePath);
  const entries = await scanDirectory(directory);
  const prefixLower = prefix.toLowerCase();
  const matches = entries
    .filter((entry) => entry.name.toLowerCase().startsWith(prefixLower))
    .slice(0, maxResults);

  return matches.map((entry) => ({
    label: entry.name + '/',
    value: entry.name + '/',
    description: 'directory',
  }));
}

/**
 * Get path completion suggestions for files and directories
 */
export async function getPathCompletions(
  partialPath: string,
  options: PathCompletionOptions = {},
): Promise<Suggestion[]> {
  const {
    basePath = process.cwd(),
    maxResults = 10,
    includeFiles = true,
    includeHidden = false,
  } = options;

  const { directory, prefix } = parsePartialPath(partialPath, basePath);
  const entries = await scanDirectoryForPaths(directory, includeHidden);
  const prefixLower = prefix.toLowerCase();

  const matches = entries
    .filter((entry) => {
      if (!includeFiles && entry.type === 'file') return false;
      return entry.name.toLowerCase().startsWith(prefixLower);
    })
    .slice(0, maxResults);

  // Construct relative path based on original partialPath
  // e.g., if partialPath is "src/c", directory portion is "src/"
  // Strip leading "./" since it's just used for cwd search
  const hasSeparator = partialPath.includes('/') || partialPath.includes(sep);
  let dirPortion = '';
  if (hasSeparator) {
    const lastSlash = partialPath.lastIndexOf('/');
    const lastSep = partialPath.lastIndexOf(sep);
    const lastSeparatorPos = Math.max(lastSlash, lastSep);
    dirPortion = partialPath.substring(0, lastSeparatorPos + 1);
  }
  if (dirPortion.startsWith('./') || dirPortion.startsWith('.' + sep)) {
    dirPortion = dirPortion.slice(2);
  }

  return matches.map((entry) => {
    const fullPath = dirPortion + entry.name;
    return {
      label: entry.type === 'directory' ? fullPath + '/' : fullPath,
      value: fullPath + (entry.type === 'directory' ? '/' : ''),
      description: entry.type === 'directory' ? 'directory' : 'file',
    };
  });
}

/**
 * Clears the directory cache
 */
export function clearDirectoryCache(): void {
  directoryCache.clear();
}

/**
 * Clears both directory and path caches
 */
export function clearPathCache(): void {
  directoryCache.clear();
  pathCache.clear();
}
