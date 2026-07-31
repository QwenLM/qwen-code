/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createDebugLogger } from '../utils/debugLogger.js';
import { AUTO_MEMORY_TYPES, type AutoMemoryType } from './types.js';
import {
  AUTO_MEMORY_INDEX_FILENAME,
  getAutoMemoryRoot,
  getTeamAutoMemoryRoot,
  getUserAutoMemoryRoot,
} from './paths.js';

const debugLogger = createDebugLogger('AUTO_MEMORY_SCAN');

const MAX_SCANNED_MEMORY_FILES = 200;

export interface ScannedAutoMemoryDocument {
  type: AutoMemoryType;
  filePath: string;
  relativePath: string;
  filename: string;
  title: string;
  description: string;
  body: string;
  mtimeMs: number;
}

function parseFrontmatterValue(
  frontmatter: string,
  key: string,
): string | undefined {
  // `[^\S\n]*` = horizontal whitespace only. A plain `\s*` would cross the
  // newline and, for an empty value (`description:`), greedily capture the
  // NEXT frontmatter line as the value. `key` is escaped so a future key with
  // regex metacharacters can't silently match unintended text.
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = frontmatter.match(
    new RegExp(`^${escapedKey}:[^\\S\\n]*(.+)$`, 'm'),
  );
  return match?.[1]?.trim();
}

export function parseAutoMemoryTopicDocument(
  filePath: string,
  content: string,
  mtimeMs = 0,
  relativePath = path.basename(filePath),
): ScannedAutoMemoryDocument | null {
  // Normalize CRLF → LF before matching: the delimiter regex anchors on
  // `^---\n`, so a Windows checkout (`---\r\n`) would fail to parse and the file
  // would silently vanish from the shared team index. Team files are read raw
  // (utf-8) and git may hand them back with CRLF on Windows.
  const normalized = content.replace(/\r\n/g, '\n');
  const frontmatterMatch = normalized.match(
    /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/,
  );
  if (!frontmatterMatch) {
    return null;
  }

  const [, frontmatter, bodyContent] = frontmatterMatch;
  const rawType = parseFrontmatterValue(frontmatter, 'type');
  if (!rawType || !AUTO_MEMORY_TYPES.includes(rawType as AutoMemoryType)) {
    return null;
  }

  return {
    type: rawType as AutoMemoryType,
    filePath,
    relativePath,
    filename: path.basename(filePath),
    title:
      parseFrontmatterValue(frontmatter, 'name') ??
      parseFrontmatterValue(frontmatter, 'title') ??
      rawType,
    description: parseFrontmatterValue(frontmatter, 'description') ?? '',
    body: bodyContent.trim(),
    mtimeMs,
  };
}

async function listMarkdownFiles(root: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(root, { recursive: true });
    return (
      entries
        .filter(
          (entry): entry is string =>
            typeof entry === 'string' &&
            entry.endsWith('.md') &&
            path.basename(entry) !== AUTO_MEMORY_INDEX_FILENAME,
        )
        // Normalize to forward slashes so relative paths are valid URL segments
        // on all platforms (Windows readdir returns backslash-separated paths).
        .map((entry) => entry.replaceAll('\\', '/'))
        .sort()
    );
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

async function scanAutoMemoryDocumentsFromRoot(
  root: string,
  opts: { deterministic?: boolean } = {},
): Promise<ScannedAutoMemoryDocument[]> {
  const relativePaths = await listMarkdownFiles(root);
  const docs = await Promise.all(
    relativePaths.map(async (relativePath) => {
      const filePath = path.join(root, relativePath);
      try {
        const [content, stats] = await Promise.all([
          fs.readFile(filePath, 'utf-8'),
          fs.stat(filePath),
        ]);
        return parseAutoMemoryTopicDocument(
          filePath,
          content,
          stats.mtimeMs,
          relativePath,
        );
      } catch (error) {
        // One unreadable file (EACCES, or a TOCTOU delete mid-`git pull`) must
        // not reject the whole scan and wipe every memory from the index.
        debugLogger.debug(
          `skipping unreadable memory file ${relativePath}`,
          error,
        );
        return null;
      }
    }),
  );

  const valid = docs
    .filter((doc): doc is ScannedAutoMemoryDocument => doc !== null)
    .filter((doc) => AUTO_MEMORY_TYPES.includes(doc.type));
  // Shared (committed) tiers cap by code-unit path so the surviving subset is
  // identical across machines/locales — otherwise, past MAX_SCANNED_MEMORY_FILES,
  // two collaborators select different docs and the generated index churns,
  // wedging the ff-only sync. Private tiers keep mtime-recency (newest memories
  // win the cap), which is fine since they are never committed/shared.
  const ordered = opts.deterministic
    ? valid.sort((a, b) =>
        a.relativePath < b.relativePath
          ? -1
          : a.relativePath > b.relativePath
            ? 1
            : 0,
      )
    : valid.sort(
        (a, b) => b.mtimeMs - a.mtimeMs || a.filename.localeCompare(b.filename),
      );
  return ordered.slice(0, MAX_SCANNED_MEMORY_FILES);
}

export async function scanAutoMemoryTopicDocuments(
  projectRoot: string,
): Promise<ScannedAutoMemoryDocument[]> {
  return scanAutoMemoryDocumentsFromRoot(getAutoMemoryRoot(projectRoot));
}

/**
 * Scan the user-level (cross-project) auto-memory dir. Returns an empty
 * array when the dir does not exist yet, so callers can union with
 * project-level docs unconditionally.
 */
export async function scanUserAutoMemoryTopicDocuments(): Promise<
  ScannedAutoMemoryDocument[]
> {
  return scanAutoMemoryDocumentsFromRoot(getUserAutoMemoryRoot());
}

/**
 * Scan the team (in-repo, git-tracked) auto-memory dir. Returns an empty
 * array when the dir does not exist yet.
 */
export async function scanTeamAutoMemoryTopicDocuments(
  projectRoot: string,
): Promise<ScannedAutoMemoryDocument[]> {
  // Deterministic cap: the team index is committed and shared, so the subset
  // that survives MAX_SCANNED_MEMORY_FILES must be machine-independent.
  return scanAutoMemoryDocumentsFromRoot(getTeamAutoMemoryRoot(projectRoot), {
    deterministic: true,
  });
}
