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

/** Which candidate a found loop.md came from. The caller maps this to a label
 * (an exhaustive map fails closed if a new candidate is added). */
export type LoopTaskFileSource = 'project' | 'home';

export type LoopTaskFileResult =
  | {
      status: 'found';
      path: string;
      source: LoopTaskFileSource;
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
   * When false, the project `.qwen/loop.md` candidate is skipped entirely — it
   * is repo-controlled, so an untrusted workspace must not read it and feed it
   * to the model (mirrors the folder-trust gate on project hooks). The
   * home/global `~/.qwen/loop.md` is user-owned and always allowed.
   *
   * Defaults to false (fail-secure): this function is re-exported from the core
   * barrel, so a caller that omits the option must NOT silently read an
   * untrusted workspace's repo-controlled file — callers opt IN by passing the
   * trust-derived value explicitly.
   */
  allowProjectFile?: boolean;
}

/**
 * `fs.realpath(dir)` cache for the two confinement boundaries — the workspace
 * root and the home dir. Each is stable for the process, so resolve it once per
 * dir instead of every tick. Keyed by the TRUSTED dir the caller passes (never a
 * path derived from file contents), so an external caller of this re-exported
 * function can't widen a boundary with a stale/broader path.
 */
const realDirCache = new Map<string, Promise<string>>();

function resolveRealDir(dir: string): Promise<string> {
  let real = realDirCache.get(dir);
  if (real === undefined) {
    real = fs.realpath(dir);
    // Don't pin a rejection: a transient failure (EACCES, ENOENT) must be
    // retried next tick rather than cached, preserving per-tick error semantics.
    real.catch(() => realDirCache.delete(dir));
    realDirCache.set(dir, real);
  }
  return real;
}

/**
 * True when `real` is `root` itself or a descendant of it — the prefix
 * confinement shared by the project and home candidates. The separator isn't
 * double-appended: at a filesystem root `root` is already `/` (or `C:\`), so
 * `root + path.sep` would be `//` / `C:\\`, which no descendant startsWith,
 * wrongly refusing everything — so `real === root` is allowed too.
 */
function isWithin(root: string, real: string): boolean {
  if (real === root) {
    return true;
  }
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return real.startsWith(prefix);
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
 * directory, non-regular, or empty (whitespace-only) path is skipped to the next
 * candidate rather than treated as present; all candidates exhausted → missing.
 * Only the byte cap lives here — the fire-time resolver owns the user-facing
 * truncation notice so the byte-vs-line nuance stays in one place.
 *
 * Project candidate: must be a real regular file at the literal path, and is
 * stat'd BEFORE the blocking open. A symlinked `.qwen/loop.md` is refused
 * outright — a repo-controlled symlink such as `-> ../.env` resolves *inside*
 * the workspace, so confinement alone would pass and exfiltrate that file to the
 * model. A FIFO/socket/device/dir is refused too, so a named pipe can never
 * wedge the tick (a blocking `open` on a FIFO waits for a writer) or be read as
 * a task list. The canonical path is still confined to the workspace root to
 * catch an *ancestor* symlink like a checked-in `.qwen -> /outside` that a
 * final-component `lstat` cannot see. When `allowProjectFile` is false (untrusted
 * folder) the candidate is dropped entirely.
 *
 * Home candidate: the user's own dotfile, so a symlink IS followed (a common,
 * legitimate setup — e.g. into a synced dotfiles repo), but the resolved target
 * must be a regular file AND stay within $HOME so a FIFO/device/dir can't hang
 * the tick and an escaping symlink (e.g. `-> /etc/passwd`) can't be exfiltrated.
 */
export async function readLoopTaskFile({
  projectRoot,
  homeDir,
  allowProjectFile = false,
}: ReadLoopTaskFileOptions): Promise<LoopTaskFileResult> {
  if (!allowProjectFile) {
    // Repo-controlled file in an untrusted folder — never read it (the
    // candidate is dropped below; this is the trace for why).
    debugLogger.debug('skipping project loop.md: folder is untrusted');
  }
  const candidates: ReadonlyArray<{
    source: LoopTaskFileSource;
    path: string;
  }> = [
    ...(allowProjectFile
      ? [
          {
            source: 'project' as const,
            path: path.join(projectRoot, '.qwen', 'loop.md'),
          },
        ]
      : []),
    { source: 'home', path: path.join(homeDir, '.qwen', 'loop.md') },
  ];

  for (const { source, path: filePath } of candidates) {
    let buffer: Buffer | null;
    try {
      if (source === 'project') {
        // lstat WITHOUT following the final component, BEFORE the blocking open.
        // A symlinked loop.md is the exfiltration vector (it may point at an
        // in-workspace `.env`, which confinement would wave through), so refuse
        // it; a FIFO/socket/device/dir is refused too so open can never block.
        const projectStat = await fs.lstat(filePath);
        if (projectStat.isSymbolicLink()) {
          debugLogger.debug('skipping symlinked project loop.md', { filePath });
          continue;
        }
        if (!projectStat.isFile()) {
          debugLogger.debug('skipping non-regular project loop.md', {
            filePath,
          });
          continue;
        }
        // A final-component lstat can't see an ANCESTOR symlink (e.g. a
        // checked-in `.qwen -> /outside`); realpath resolves it, so confine the
        // canonical path to the workspace root before reading.
        const realRoot = await resolveRealDir(projectRoot);
        const real = await fs.realpath(filePath);
        if (!isWithin(realRoot, real)) {
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
        // Home loop.md is the user's own dotfile: a symlink is a legitimate,
        // common setup, so follow it (stat, not lstat). But require the resolved
        // target to be a regular file so a FIFO/device/dir can neither hang the
        // tick on a blocking open nor be decoded as a task list.
        const homeStat = await fs.stat(filePath);
        if (!homeStat.isFile()) {
          debugLogger.debug('skipping non-regular home loop.md', { filePath });
          continue;
        }
        // A home symlink IS followed, but its target must stay WITHIN $HOME:
        // otherwise `~/.qwen/loop.md -> /etc/passwd` (or `-> /dev/...`) would be
        // read and fed to the model every tick. In-home dotfile symlinks (e.g.
        // `-> ~/dotfiles/loop.md`) still resolve inside $HOME and are allowed.
        const realHome = await resolveRealDir(homeDir);
        const real = await fs.realpath(filePath);
        if (!isWithin(realHome, real)) {
          debugLogger.debug(
            'skipping home loop.md that escapes the home directory',
            { filePath, resolved: real },
          );
          continue;
        }
        buffer = await readBoundedTaskFile(real);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // None of these name a readable loop.md, so try the next candidate:
      // absent (ENOENT), a directory (EISDIR), a non-directory path component
      // (ENOTDIR, e.g. a stray file where `.qwen` should be), a symlink loop
      // (ELOOP, e.g. a self-referential `~/.qwen/loop.md`), or an over-long path
      // (ENAMETOOLONG). Anything else (EACCES permissions, real I/O) surfaces
      // rather than being silently swallowed.
      if (
        code === 'ENOENT' ||
        code === 'EISDIR' ||
        code === 'ENOTDIR' ||
        code === 'ELOOP' ||
        code === 'ENAMETOOLONG'
      ) {
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
      source,
      content,
      truncated,
    };
  }

  return {
    status: 'missing',
    checkedPaths: candidates.map((c) => c.path),
  };
}
