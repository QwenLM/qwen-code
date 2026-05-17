/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { Storage } from '../config/storage.js';
import { DEFAULT_CONTEXT_FILENAME, MEMORY_SECTION_HEADER } from './const.js';

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

  // Append mode. When the trimmed content is empty (whitespace-only
  // input from a flaky pipeline / accidental empty POST), short-circuit
  // BEFORE re-writing the file. Re-writing the same bytes would still
  // bump mtime AND trigger `memory_changed` SSE fan-out across every
  // subscribed client — a misleading "memory just changed" toast for a
  // request that changed nothing.
  if (options.content.replace(/^\s+|\s+$/g, '').length === 0) {
    let bytes = 0;
    try {
      const stat = await fs.stat(filePath);
      bytes = stat.size;
    } catch (err) {
      if (!isEnoent(err)) throw err;
    }
    return { filePath, bytesWritten: bytes, changed: false };
  }

  const next = await composeAppendedContent(filePath, options.content);
  await fs.writeFile(filePath, next, { encoding: 'utf8', mode: 0o644 });
  return {
    filePath,
    bytesWritten: Buffer.byteLength(next, 'utf8'),
    changed: true,
  };
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

  const trimmed = newContent.replace(/^\n+|\n+$/g, '');
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
