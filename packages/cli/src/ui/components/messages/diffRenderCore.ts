/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Diff rendering core: caching layer for ColorDiff/ColorFile results.
 *
 * Separates parse/render/cache from React components, enabling both
 * block-level (bulk RawAnsi) and line-level (ScrollableList) renderers
 * to share the same cached ANSI output without re-running highlight.js
 * or word-diff on every render cycle.
 */

import { LRUCache } from 'mnemonist';
import { parsePatch } from 'diff';
import {
  ColorDiff,
  ColorFile,
  maxLineNumber,
  type Hunk,
} from '../../utils/color-diff.js';
import sliceAnsi from '../../../ink/stubs/sliceAnsi.js';

// ---------------------------------------------------------------------------
// Cache types
// ---------------------------------------------------------------------------

export interface DiffRenderCacheEntry {
  /** Fully rendered ANSI lines (null when gutterWidth > 0 to save memory) */
  lines: string[] | null;
  /** Gutter width (0 when split is not requested) */
  gutterWidth: number;
  /** Sliced gutter columns (null when gutterWidth === 0) */
  gutters: string[] | null;
  /** Sliced content columns (null when gutterWidth === 0) */
  contents: string[] | null;
}

// ---------------------------------------------------------------------------
// Cache key helpers
// ---------------------------------------------------------------------------

/**
 * Build a collision-safe key by JSON-encoding all render parameters.
 */
function buildCacheKey(
  hunkId: string,
  theme: string,
  width: number,
  disableColor: boolean,
  splitGutter: boolean,
  filePath: string,
  firstLine: string | null,
): string {
  return JSON.stringify([
    hunkId,
    theme,
    width,
    disableColor,
    splitGutter,
    filePath,
    firstLine,
  ]);
}

function buildFileCacheKey(
  fileId: string,
  theme: string,
  width: number,
  disableColor: boolean,
): string {
  return JSON.stringify([fileId, theme, width, disableColor]);
}

// ---------------------------------------------------------------------------
// Hunk identity — WeakMap to avoid re-joining on every lookup
// ---------------------------------------------------------------------------

const hunkIdentityCache = new WeakMap<Hunk, string>();

/**
 * Includes hunk coordinates (oldStart/newStart/oldLines/newLines) because
 * ColorDiff.render() uses them for line numbering and gutter width.
 * Two hunks with identical lines but different positions must not share cache.
 */
function getHunkIdentity(hunk: Hunk): string {
  let id = hunkIdentityCache.get(hunk);
  if (!id) {
    id = JSON.stringify([
      hunk.oldStart,
      hunk.oldLines,
      hunk.newStart,
      hunk.newLines,
      hunk.lines,
    ]);
    hunkIdentityCache.set(hunk, id);
  }
  return id;
}

// ---------------------------------------------------------------------------
// Cache storage — using LRUCache from mnemonist (consistent with codebase)
// ---------------------------------------------------------------------------

// 1024 = up to 256 unique hunks × 4 width/theme variants
const HUNK_CACHE = new LRUCache<string, DiffRenderCacheEntry>(1024);

// 256 = up to 64 unique files × 4 variants
const FILE_CACHE = new LRUCache<string, string[]>(256);

// Parse cache for parsePatch results (avoids re-parsing on repeated renders)
const PARSE_CACHE = new LRUCache<string, Hunk[]>(32);

// ---------------------------------------------------------------------------
// File identity
// ---------------------------------------------------------------------------

function buildFileIdentity(code: string, filePath: string): string {
  return JSON.stringify([code, filePath]);
}

// ---------------------------------------------------------------------------
// Public API: cached hunk rendering
// ---------------------------------------------------------------------------

/**
 * Compute gutter width for a hunk: marker (1) + space + right-aligned
 * line number (max_digits) + space.
 */
export function computeGutterWidth(hunk: Hunk): number {
  return maxLineNumber(hunk).toString().length + 3;
}

/**
 * Render a single hunk through the cache. Returns null if ColorDiff
 * returns null (e.g. hljs not loaded yet).
 */
export function renderHunkCached(
  hunk: Hunk,
  firstLine: string | null,
  filePath: string,
  theme: string,
  width: number,
  disableColor: boolean,
  splitGutter: boolean,
): DiffRenderCacheEntry | null {
  const hunkId = getHunkIdentity(hunk);
  const key = buildCacheKey(
    hunkId,
    theme,
    width,
    disableColor,
    splitGutter,
    filePath,
    firstLine,
  );

  const cached = HUNK_CACHE.get(key);
  if (cached) return cached;

  const lines = new ColorDiff(hunk, firstLine, filePath).render(
    theme,
    width,
    disableColor,
  );
  if (!lines) return null;

  const rawGutterWidth = splitGutter ? computeGutterWidth(hunk) : 0;
  const gutterWidth =
    rawGutterWidth > 0 && rawGutterWidth < width ? rawGutterWidth : 0;

  let entry: DiffRenderCacheEntry;

  if (gutterWidth > 0) {
    // Store only gutters/contents — callers never use `lines` when split
    const gutters = lines.map((line) => sliceAnsi(line, 0, gutterWidth));
    const contents = lines.map((line) => sliceAnsi(line, gutterWidth));
    entry = { lines: null, gutterWidth, gutters, contents };
  } else {
    entry = { lines, gutterWidth: 0, gutters: null, contents: null };
  }

  HUNK_CACHE.set(key, entry);
  return entry;
}

// ---------------------------------------------------------------------------
// Public API: cached new-file rendering
// ---------------------------------------------------------------------------

/**
 * Render a new file (ColorFile) through the cache.
 * Returns null if ColorFile returns null.
 */
export function renderNewFileCached(
  code: string,
  filePath: string,
  theme: string,
  width: number,
  disableColor: boolean,
): string[] | null {
  const fileId = buildFileIdentity(code, filePath);
  const key = buildFileCacheKey(fileId, theme, width, disableColor);

  const cached = FILE_CACHE.get(key);
  if (cached) return cached;

  const rendered = new ColorFile(code, filePath).render(
    theme,
    width,
    disableColor,
  );
  if (!rendered) return null;

  FILE_CACHE.set(key, rendered);
  return rendered;
}

// ---------------------------------------------------------------------------
// Public API: parsePatch with cache
// ---------------------------------------------------------------------------

/**
 * Parse a unified diff string into hunks, with LRU caching.
 */
export function getHunksFromDiffString(diffContent: string): Hunk[] {
  const cached = PARSE_CACHE.get(diffContent);
  if (cached) return cached;

  let hunks: Hunk[] = [];
  try {
    const patches = parsePatch(diffContent);
    // SVN-style diffs may produce multiple patches (first with no hunks).
    for (const patch of patches) {
      if (patch.hunks && patch.hunks.length > 0) {
        hunks = patch.hunks as Hunk[];
        break;
      }
    }
  } catch {
    // Malformed or truncated diff strings (e.g. from a corrupted transcript
    // restored via /resume) can cause parsePatch() to throw.  Return an empty
    // array so callers fall back gracefully instead of crashing the UI.
    hunks = [];
  }

  PARSE_CACHE.set(diffContent, hunks);
  return hunks;
}

// ---------------------------------------------------------------------------
// Utility: clear caches (for testing)
// ---------------------------------------------------------------------------

export function clearDiffRenderCache(): void {
  HUNK_CACHE.clear();
  FILE_CACHE.clear();
  PARSE_CACHE.clear();
}
