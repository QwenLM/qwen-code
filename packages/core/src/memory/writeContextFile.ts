/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { Mutex } from 'async-mutex';
import { Storage } from '../config/storage.js';
import { DEFAULT_CONTEXT_FILENAME, MEMORY_SECTION_HEADER } from './const.js';

/**
 * Per-resolved-file mutex map. Two simultaneous `writeWorkspaceContextFile`
 * calls targeting the same file would otherwise race read-then-write:
 * both reads see the same existing content, both compose new content in
 * memory, and the later `fs.writeFile` overwrites the earlier append.
 * Result is a silently-lost entry with both callers observing success.
 *
 * Pattern mirrors `packages/core/src/utils/jsonl-utils.ts:36-46`. The
 * Map grows by one entry per unique resolved path; production has at
 * most two (workspace QWEN.md + global QWEN.md), so no cleanup is
 * required. Tests use tmpdirs and clean up with `afterEach` — the Map
 * keeps inert entries between tests but each entry is a single Mutex
 * that acquires no resources when idle.
 */
const fileLocks = new Map<string, Mutex>();

function getFileLock(filePath: string): Mutex {
  let lock = fileLocks.get(filePath);
  if (!lock) {
    lock = new Mutex();
    fileLocks.set(filePath, lock);
  }
  return lock;
}

export type WriteContextFileScope = 'workspace' | 'global';
export type WriteContextFileMode = 'append' | 'replace';

export interface WriteContextFileOptions {
  scope: WriteContextFileScope;
  mode: WriteContextFileMode;
  /**
   * Content to write. For `append`, this is added under the
   * `MEMORY_SECTION_HEADER` block. For `replace`, this becomes the
   * file's full contents.
   */
  content: string;
  /**
   * Absolute path to the workspace root (used when `scope === 'workspace'`).
   * Ignored for `global` writes.
   */
  projectRoot: string;
}

export interface WriteContextFileResult {
  filePath: string;
  bytesWritten: number;
  /**
   * `true` when the call actually mutated the file on disk; `false`
   * when the helper short-circuited because the requested write would
   * have been a no-op (e.g. `mode: 'append'` with whitespace-only
   * content). Callers like the `qwen serve` POST route use this to
   * suppress spurious `memory_changed` events that would otherwise
   * fan out for a write that didn't change anything.
   */
  changed: boolean;
}

/**
 * Append/replace `QWEN.md` for the workspace or the user's global
 * `~/.qwen/` directory. Used by the `qwen serve` daemon's
 * `POST /workspace/memory` route (issue #4175 PR 16) and any other
 * caller that needs to mutate hierarchical memory through code.
 *
 * Append mode preserves any prose already in the file: when a
 * `## Qwen Added Memories` section exists, the new content is
 * appended to the end of the file; when it doesn't, a fresh section
 * header is added before the content. This matches the shape the
 * agent-side `save_memory` tool produces, so files written through
 * the daemon route round-trip cleanly with the existing CLI surface.
 *
 * Replace mode overwrites the whole file with `content` verbatim.
 * Callers should canonicalize/validate `content` before passing.
 *
 * Path safety: `projectRoot` MUST be absolute. Callers are expected
 * to pass a daemon-canonicalized workspace path (the bridge's
 * `boundWorkspace`); this helper does not re-canonicalize.
 */
export async function writeWorkspaceContextFile(
  options: WriteContextFileOptions,
): Promise<WriteContextFileResult> {
  if (!path.isAbsolute(options.projectRoot)) {
    throw new Error(
      `writeWorkspaceContextFile: projectRoot must be absolute, got "${options.projectRoot}"`,
    );
  }
  const filePath = resolveContextFilePath(options.scope, options.projectRoot);

  // Append-mode no-op detection BEFORE acquiring the lock or
  // creating directories. Re-writing the same bytes would bump
  // mtime + the parent dir mtime AND fan out a misleading
  // `memory_changed` event; whitespace-only POSTs from a flaky
  // pipeline shouldn't reach the filesystem at all.
  if (options.mode === 'append' && isWhitespaceOnly(options.content)) {
    let bytes = 0;
    try {
      const stat = await fs.stat(filePath);
      bytes = stat.size;
    } catch (err) {
      if (!isEnoent(err)) throw err;
    }
    return { filePath, bytesWritten: bytes, changed: false };
  }

  // Hold the per-file mutex for the entire read-compose-write sequence.
  // Concurrent `POST /workspace/memory` appends from different SSE
  // clients would otherwise interleave reads and lose entries on the
  // later `fs.writeFile`. `replace` mode also acquires the lock so a
  // concurrent `replace` + `append` against the same file produces a
  // deterministic last-write rather than a partial composite.
  return await getFileLock(filePath).runExclusive(async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    if (options.mode === 'replace') {
      await fs.writeFile(filePath, options.content, {
        encoding: 'utf8',
        mode: 0o644,
      });
      return {
        filePath,
        bytesWritten: Buffer.byteLength(options.content, 'utf8'),
        changed: true,
      };
    }

    const next = await composeAppendedContent(filePath, options.content);
    await fs.writeFile(filePath, next, { encoding: 'utf8', mode: 0o644 });
    return {
      filePath,
      bytesWritten: Buffer.byteLength(next, 'utf8'),
      changed: true,
    };
  });
}

function resolveContextFilePath(
  scope: WriteContextFileScope,
  projectRoot: string,
): string {
  if (scope === 'workspace') {
    return path.join(projectRoot, DEFAULT_CONTEXT_FILENAME);
  }
  return path.join(Storage.getGlobalQwenDir(), DEFAULT_CONTEXT_FILENAME);
}

async function composeAppendedContent(
  filePath: string,
  newContent: string,
): Promise<string> {
  let existing = '';
  try {
    existing = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if (!isEnoent(err)) throw err;
  }

  const trimmed = trimNewlines(newContent);
  if (trimmed.length === 0) return existing;

  if (existing.length === 0) {
    return `${MEMORY_SECTION_HEADER}\n${trimmed}\n`;
  }

  const sectionIdx = existing.indexOf(MEMORY_SECTION_HEADER);
  if (sectionIdx === -1) {
    const sep = existing.endsWith('\n') ? '' : '\n';
    return `${existing}${sep}\n${MEMORY_SECTION_HEADER}\n${trimmed}\n`;
  }

  const sep = existing.endsWith('\n') ? '' : '\n';
  return `${existing}${sep}${trimmed}\n`;
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === 'ENOENT'
  );
}

/**
 * Hand-rolled `^\s+|\s+$` substitute. CodeQL's polynomial-regex
 * detector flags `\s+` with anchors as a ReDoS risk on
 * attacker-controlled input; the linear loop sidesteps the rule
 * without changing behavior. Mirrors the same pattern used by
 * `auth.ts:120-125` for header-credential parsing.
 */
function isWhitespaceOnly(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    // ASCII space, tab, line feed, carriage return, form feed,
    // vertical tab. All non-printable whitespace control chars the
    // route's "no-op append" check should treat as empty content.
    if (
      c !== 0x20 &&
      c !== 0x09 &&
      c !== 0x0a &&
      c !== 0x0d &&
      c !== 0x0c &&
      c !== 0x0b
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Hand-rolled `^\n+|\n+$` substitute. Same CodeQL rationale as
 * `isWhitespaceOnly`. Trims only `\n` so the section-header insert
 * path keeps its newline framing semantics — a leading `\t` in
 * `newContent` is preserved as part of the user's bullet, while
 * `\n\n- entry\n` collapses to `- entry`.
 */
function trimNewlines(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && s.charCodeAt(start) === 0x0a) start++;
  while (end > start && s.charCodeAt(end - 1) === 0x0a) end--;
  return start === 0 && end === s.length ? s : s.slice(start, end);
}
