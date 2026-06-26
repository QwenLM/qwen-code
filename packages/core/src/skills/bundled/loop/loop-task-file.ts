/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createDebugLogger } from '../../../utils/debugLogger.js';

const debugLogger = createDebugLogger('LOOP_TASK_FILE');

export const LOOP_TASK_FILE_MAX_BYTES = 25_000;

export type LoopTaskFileResult =
  | {
      status: 'found';
      path: string;
      content: string;
      truncated: boolean;
    }
  | {
      status: 'missing';
      checkedPaths: string[];
    };

export interface ReadLoopTaskFileOptions {
  projectRoot: string;
  homeDir: string;
  /**
   * Pre-resolved `fs.realpath(projectRoot)`. projectRoot is stable for a
   * resolver's lifetime, so the resolver resolves it once and passes it here
   * to avoid a realpath syscall every tick. Omit to resolve inline.
   */
  realProjectRoot?: string;
}

/**
 * Read at most `LOOP_TASK_FILE_MAX_BYTES + 1` bytes — the one extra byte is the
 * truncation signal and the only thing we need past the cap, so a huge/malicious
 * loop.md is never fully read or decoded. Returns `null` for a non-regular node
 * (e.g. a directory at the loop.md path) so the caller skips to the next
 * candidate. Symlink/escape filtering is the caller's job and already done.
 */
async function readBoundedTaskFile(filePath: string): Promise<Buffer | null> {
  const handle = await fs.open(filePath, 'r');
  try {
    if (!(await handle.stat()).isFile()) {
      return null;
    }
    const cap = LOOP_TASK_FILE_MAX_BYTES + 1;
    const buffer = Buffer.alloc(cap);
    let total = 0;
    // A single read() may return short even before EOF; loop until cap or EOF.
    while (total < cap) {
      const { bytesRead } = await handle.read(
        buffer,
        total,
        cap - total,
        total,
      );
      if (bytesRead === 0) {
        break;
      }
      total += bytesRead;
    }
    return buffer.subarray(0, total);
  } finally {
    await handle.close();
  }
}

/**
 * Reads `.qwen/loop.md`, project before home, byte-capped at 25 KB. A missing,
 * directory, non-directory-component, or empty (whitespace-only) path is skipped
 * to the next candidate rather than treated as present; all candidates exhausted
 * → missing. Only the byte cap lives here — the fire-time resolver owns the
 * user-facing truncation notice so the byte-vs-line nuance stays in one place.
 *
 * The project candidate is workspace-confined: its canonical real path must stay
 * inside the project root. `fs.realpath` resolves `..` and every symlink —
 * including an *ancestor* like a checked-in `.qwen -> /outside`, which a
 * final-component `lstat` cannot catch — so a project loop.md cannot read a file
 * outside the workspace. The home candidate is the user's own and intentionally
 * outside the workspace, so it only refuses a directly-symlinked file.
 */
export async function readLoopTaskFile({
  projectRoot,
  homeDir,
  realProjectRoot,
}: ReadLoopTaskFileOptions): Promise<LoopTaskFileResult> {
  const projectFile = path.join(projectRoot, '.qwen', 'loop.md');
  const homeFile = path.join(homeDir, '.qwen', 'loop.md');
  const checkedPaths = [projectFile, homeFile];

  for (const filePath of checkedPaths) {
    let buffer: Buffer | null;
    try {
      if (filePath === projectFile) {
        const realRoot = realProjectRoot ?? (await fs.realpath(projectRoot));
        const real = await fs.realpath(filePath);
        if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
          // Skip silently to the next candidate, but leave a debug trail so a
          // symlink quietly redirecting loop.md outside the workspace is traceable.
          debugLogger.debug(
            'skipping project loop.md that escapes the workspace',
            {
              filePath,
              resolved: real,
            },
          );
          continue;
        }
        buffer = await readBoundedTaskFile(real);
      } else {
        // lstat (not stat) so a directly symlinked home loop.md is detected
        // rather than followed.
        const stat = await fs.lstat(filePath);
        if (stat.isSymbolicLink()) {
          continue;
        }
        buffer = await readBoundedTaskFile(filePath);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Absent (ENOENT), a directory (EISDIR), or a non-directory path component
      // (ENOTDIR, e.g. a stray file where `.qwen` should be) → try the next
      // candidate. Anything else (permissions, I/O) is a real error and surfaces.
      if (code === 'ENOENT' || code === 'EISDIR' || code === 'ENOTDIR') {
        continue;
      }
      throw error;
    }

    // A non-regular node (e.g. a directory where loop.md was expected) → skip.
    if (buffer === null) {
      continue;
    }

    // A whitespace-only file is not a task list; fall through to the next path.
    if (buffer.toString('utf8').trim().length === 0) {
      continue;
    }

    const truncated = buffer.byteLength > LOOP_TASK_FILE_MAX_BYTES;
    let content: string;
    if (truncated) {
      // Cap by bytes on a UTF-8 boundary: back off any trailing continuation
      // bytes from a mid-character cut, then re-clamp the decoded string so
      // malformed input (an orphan lead byte decoding to U+FFFD) still can't
      // exceed the cap.
      let end = LOOP_TASK_FILE_MAX_BYTES;
      while (end > 0 && (buffer[end] & 0xc0) === 0x80) {
        end--;
      }
      content = buffer.subarray(0, end).toString('utf8');
      while (Buffer.byteLength(content, 'utf8') > LOOP_TASK_FILE_MAX_BYTES) {
        content = content.slice(0, -1);
      }
    } else {
      content = buffer.toString('utf8');
    }

    return {
      status: 'found',
      path: filePath,
      content,
      truncated,
    };
  }

  return {
    status: 'missing',
    checkedPaths,
  };
}
