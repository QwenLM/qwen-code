/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview MEMORY.md index management for the auto-memory system.
 *
 * MEMORY.md is owned by the fork agent — it is the sole writer for
 * day-to-day updates (adding/removing index lines as it creates/edits
 * memory files). This module provides only:
 *   - read access (loadMemoryIndex)
 *   - the truncation contract (truncateIndexContent)
 *   - one engineering hook for the TUI delete path (removeIndexEntry),
 *     which patches a single line out instead of rebuilding from disk.
 *
 * No rebuild-from-frontmatter path exists by design: there is no second
 * source of truth to reconcile against, so reconciliation is meaningless.
 * The TUI delete bypass uses removeIndexEntry to keep the index honest
 * without inventing a new format authority.
 */

import * as fs from 'node:fs/promises';
import {
  getMemoryIndexPath,
  type MemoryScope,
  type ScopedAutoMemoryDir,
} from './structured-memory-store.js';

const DEFAULT_MAX_LINES = 200;
const DEFAULT_MAX_BYTES = 25_000;
const textEncoder = new TextEncoder();

/**
 * Loads the MEMORY.md index content. Returns empty string if not found.
 */
export async function loadMemoryIndex(indexPath: string): Promise<string> {
  try {
    return await fs.readFile(indexPath, 'utf8');
  } catch {
    return '';
  }
}

/** A single scope's loaded (truncated, non-empty) MEMORY.md index. */
export interface ScopedMemoryIndex {
  scope: MemoryScope;
  /** Absolute path to this scope's MEMORY.md (so the model can resolve topic files). */
  indexPath: string;
  /** Truncated index content (always non-empty). */
  content: string;
}

/** Raw MEMORY.md file state used to seed readFileState for change detection. */
export interface ScopedMemoryIndexFileState {
  scope: MemoryScope;
  /** Absolute path to this scope's MEMORY.md. */
  indexPath: string;
  /** Raw on-disk content. Empty when the file does not exist yet. */
  content: string;
  /** Floor of the file's mtimeMs. Zero when the file does not exist yet. */
  timestamp: number;
  /** True when the file did not exist when this state was captured. */
  retainIfMissing?: boolean;
  /** True when the user-context view is truncated relative to raw disk bytes. */
  isPartialView?: boolean;
  /** Read/stat failure detail when the file exists but could not be loaded. */
  loadError?: string;
}

/**
 * Loads raw MEMORY.md file state for every active scope root. Missing files are
 * represented as retained empty states so the first later write can flow
 * through normal edited_text_file detection.
 */
export async function loadScopedMemoryIndexFileStates(
  dirs: readonly ScopedAutoMemoryDir[],
): Promise<ScopedMemoryIndexFileState[]> {
  const out: ScopedMemoryIndexFileState[] = [];
  for (const { scope, dir } of dirs) {
    const indexPath = getMemoryIndexPath(dir);
    try {
      const [stats, raw] = await Promise.all([
        fs.stat(indexPath),
        fs.readFile(indexPath, 'utf8'),
      ]);
      out.push({
        scope,
        indexPath,
        content: raw,
        timestamp: Math.floor(stats.mtimeMs),
        isPartialView: truncateIndexContent(raw) !== raw,
      });
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
      out.push({
        scope,
        indexPath,
        content: '',
        timestamp: 0,
        retainIfMissing: true,
        loadError:
          missing
            ? undefined
            : error instanceof Error
              ? error.message
              : String(error),
      });
    }
  }
  return out;
}

function toScopedMemoryIndexes(
  states: readonly ScopedMemoryIndexFileState[],
): ScopedMemoryIndex[] {
  return states
    .map(({ scope, indexPath, content }) => ({
      scope,
      indexPath,
      content: content ? truncateIndexContent(content) : '',
    }))
    .filter((index) => index.content.trim().length > 0);
}

export function renderScopedMemoryIndexFileStates(
  states: readonly ScopedMemoryIndexFileState[],
): string {
  return renderScopedMemoryIndexes(toScopedMemoryIndexes(states));
}

/**
 * Loads the MEMORY.md index for each active scope root, truncated to the
 * index size contract. Scopes with no (or empty) index are omitted.
 */
export async function loadScopedMemoryIndexes(
  dirs: readonly ScopedAutoMemoryDir[],
): Promise<ScopedMemoryIndex[]> {
  return toScopedMemoryIndexes(await loadScopedMemoryIndexFileStates(dirs));
}

/**
 * Renders loaded scope indexes into a single snapshot string — one labeled
 * block per scope, each naming its absolute MEMORY.md path. Shared by direct
 * index loading and the file-state path used for user-context rendering.
 * Returns '' when there is nothing.
 */
export function renderScopedMemoryIndexes(
  indexes: readonly ScopedMemoryIndex[],
): string {
  if (indexes.length === 0) return '';
  return indexes
    .map(
      ({ scope, indexPath, content }) =>
        `Contents of ${indexPath} (${scope}-scope auto-memory, persists across conversations):\n\n${content.trim()}`,
    )
    .join('\n\n');
}

/**
 * Removes any MEMORY.md line that references `filename`. Used by the TUI
 * delete path so the user-facing "delete this memory" action stays
 * consistent with what the fork would have done on its next pass. Does
 * NOT reorder, reformat, or re-read other entries — the fork remains the
 * sole authority on index shape.
 *
 * Match is whole-word on the bare filename inside `(...)`, so an entry
 * like `- [Title](feedback_x.md) — hook` is dropped without touching an
 * unrelated `- [Title](feedback_x_v2.md)`.
 */
export async function removeIndexEntry(
  dir: string,
  filename: string,
): Promise<void> {
  const indexPath = getMemoryIndexPath(dir);
  let content: string;
  try {
    content = await fs.readFile(indexPath, 'utf8');
  } catch {
    return;
  }
  const escaped = filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matcher = new RegExp(`\\(${escaped}\\)`);
  const kept = content.split('\n').filter((line) => !matcher.test(line));
  if (kept.length === content.split('\n').length) return;
  const next = truncateIndexContent(kept.join('\n').replace(/\n+$/, '') + '\n');
  await fs.writeFile(indexPath, next, 'utf8');
}

/**
 * Truncates index content to stay within size limits. When either cap
 * fires, appends a WARNING that names the original size and which limit
 * tripped without requesting changes to the index or memory files.
 */
export function truncateIndexContent(
  content: string,
  maxLines: number = DEFAULT_MAX_LINES,
  maxBytes: number = DEFAULT_MAX_BYTES,
): string {
  const originalLines = content.split('\n');
  const originalLineCount = originalLines.length;
  const originalByteCount = textEncoder.encode(content).length;

  const wasLineTruncated = originalLineCount > maxLines;
  const wasByteTruncated = originalByteCount > maxBytes;

  if (!wasLineTruncated && !wasByteTruncated) {
    return content;
  }

  let truncated = wasLineTruncated
    ? originalLines.slice(0, maxLines).join('\n')
    : content;

  if (textEncoder.encode(truncated).length > maxBytes) {
    const candidateLines = truncated.split('\n');
    let lo = 0;
    let hi = candidateLines.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      const candidate = candidateLines.slice(0, mid).join('\n');
      if (textEncoder.encode(candidate).length <= maxBytes) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    truncated = candidateLines.slice(0, lo).join('\n');
  }

  const reason =
    wasByteTruncated && !wasLineTruncated
      ? `${originalByteCount} bytes (limit: ${maxBytes})`
      : wasLineTruncated && !wasByteTruncated
        ? `${originalLineCount} lines (limit: ${maxLines})`
        : `${originalLineCount} lines and ${originalByteCount} bytes`;

  return (
    truncated +
    `\n\n> WARNING: MEMORY.md is ${reason}. Only part of it was loaded.`
  );
}
