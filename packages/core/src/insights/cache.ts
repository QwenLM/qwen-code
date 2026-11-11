/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { getConfigHomeDir } from '../utils/paths.js';

const USAGE_DATA_DIR = 'usage-data';
const META_DIR = 'meta';
const FACETS_DIR = 'facets';

/**
 * Returns the base cache directory for insights data.
 * Path: `<configHome>/usage-data/`
 */
export function getCacheDir(): string {
  return path.join(getConfigHomeDir(), USAGE_DATA_DIR);
}

/**
 * Returns the meta cache directory.
 * Path: `<configHome>/usage-data/meta/`
 */
export function getMetaCacheDir(): string {
  return path.join(getCacheDir(), META_DIR);
}

/**
 * Returns the facets cache directory.
 * Path: `<configHome>/usage-data/facets/`
 */
export function getFacetsCacheDir(): string {
  return path.join(getCacheDir(), FACETS_DIR);
}

/**
 * Reads a cached JSON value by key from the specified subdirectory.
 * Returns null if the cache entry does not exist or cannot be parsed.
 */
export async function readCache<T>(
  subdir: 'meta' | 'facets',
  key: string,
): Promise<T | null> {
  const dir = subdir === 'meta' ? getMetaCacheDir() : getFacetsCacheDir();
  const filePath = path.join(dir, `${key}.json`);
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Writes a value to the cache as JSON.
 * Creates the directory structure if it does not exist.
 */
export async function writeCache<T>(
  subdir: 'meta' | 'facets',
  key: string,
  value: T,
): Promise<void> {
  const dir = subdir === 'meta' ? getMetaCacheDir() : getFacetsCacheDir();
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${key}.json`);
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), 'utf-8');
}

/**
 * Checks whether a cache entry exists and is newer than the given timestamp.
 * Useful for invalidating stale entries when a transcript file has been updated.
 */
export async function isCacheFresh(
  subdir: 'meta' | 'facets',
  key: string,
  referenceTimestamp: number,
): Promise<boolean> {
  const dir = subdir === 'meta' ? getMetaCacheDir() : getFacetsCacheDir();
  const filePath = path.join(dir, `${key}.json`);
  try {
    const stat = await fs.stat(filePath);
    return stat.mtime.getTime() >= referenceTimestamp;
  } catch {
    return false;
  }
}
