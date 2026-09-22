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
  /**
   * Confinement root for the home candidate's resolved (symlink-followed)
   * target — a target escaping this dir (e.g. `-> /etc/passwd`) is refused while
   * an in-root dotfile symlink is followed. Pass `$QWEN_HOME` when set, else
   * `$HOME` (see `homeQwenDir`).
   */
  homeDir: string;
  /**
   * Directory holding the home/global `loop.md` candidate (`<homeQwenDir>/loop.md`).
   * Pass the QWEN_HOME-aware global dir (`Storage.getGlobalQwenDir()`) so a
   * relocated config home is honored instead of always reading the real OS home.
   * Defaults to `<homeDir>/.qwen` so a direct barrel caller keeps the `~/.qwen`
   * layout.
   */
  homeQwenDir?: string;
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
  /**
   * Per-resolver cache for the boundary `fs.realpath()` results. LoopTickResolver
   * passes its own instance-scoped Map so the cache lifetime is tied to the
   * resolver (rebuilt on `/cd`, cleared by `resetCache()`) instead of living
   * forever at module scope. Omitted by direct barrel callers, who fall back to a
   * process-lifetime cache. Eviction-on-failure is preserved either way.
   */
  realDirCache?: Map<string, Promise<string>>;
}

/**
 * Process-lifetime fallback `fs.realpath(dir)` cache for the two confinement
 * boundaries — the workspace root and the home dir. Used only by direct callers
 * of this re-exported function that don't supply their own cache; resolver-driven
 * ticks pass an instance-scoped cache (see `ReadLoopTaskFileOptions.realDirCache`)
 * so the boundary realpath stays invalidatable and a long-lived process can't pin
 * a stale boundary after a `/cd` or symlink re-point. Keyed by the TRUSTED dir the
 * caller passes (never a path derived from file contents), so a caller can't widen
 * a boundary with a stale/broader path.
 */
const moduleRealDirCache = new Map<string, Promise<string>>();

function resolveRealDir(
  dir: string,
  cache: Map<string, Promise<string>>,
): Promise<string> {
  let real = cache.get(dir);
  if (real === undefined) {
    real = fs.realpath(dir);
    // Don't pin a rejection: a transient failure (EACCES, ENOENT) must be
    // retried next tick rather than cached, preserving per-tick error semantics.
    real.catch(() => cache.delete(dir));
    cache.set(dir, real);
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
    const stat = await handle.stat();
    if (!stat.isFile()) {
      return null;
    }
    const cap = LOOP_TASK_FILE_MAX_BYTES + 1;
    // Size the buffer to the file (+1 to still detect a file that exceeds the
    // cap), never above cap — so a small loop.md doesn't zero-fill 25 KB every
    // tick. `read` below is bounded by this length too, so a file that grows
    // past `stat.size` between stat and read is still read safely (its tail just
    // isn't seen this tick).
    const allocSize = Math.min(cap, stat.size + 1);
    const buffer = Buffer.alloc(allocSize);
    let total = 0;
    // A single read() may return short even before EOF; loop until full or EOF.
    while (total < allocSize) {
      const { bytesRead } = await handle.read(
        buffer,
        total,
        allocSize - total,
        total,
      );
      if (bytesRead === 0) {
        break;
      }
      total += bytesRead;
    }
    return buffer.subarray(0, total);
  } finally {
    // Guard the close so a close failure (e.g. EBADF) can't replace an in-flight
    // read/stat error (e.g. EIO) — JS would otherwise surface the close error and
    // mask the original. Swallow it (debug-log only) and let the original throw.
    try {
      await handle.close();
    } catch (closeErr) {
      debugLogger.debug('failed to close loop.md handle', { closeErr });
    }
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
 * Home candidate: `<homeQwenDir>/loop.md` (the QWEN_HOME-aware global dir, not
 * always the real `~/.qwen`). It is the user's own dotfile, so a symlink IS
 * followed (a common, legitimate setup — e.g. into a synced dotfiles repo), but
 * the resolved target must be a regular file AND stay within the home
 * confinement root (`homeDir`: `$QWEN_HOME` or `$HOME`) so a FIFO/device/dir
 * can't hang the tick and an escaping symlink (e.g. `-> /etc/passwd`) can't be
 * exfiltrated.
 */
export async function readLoopTaskFile({
  projectRoot,
  homeDir,
  homeQwenDir = path.join(homeDir, '.qwen'),
  allowProjectFile = false,
  realDirCache = moduleRealDirCache,
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
    { source: 'home', path: path.join(homeQwenDir, 'loop.md') },
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
        // A hard-linked loop.md is an ordinary regular file (lstat sees no
        // symlink) but shares a sensitive target's inode (e.g. `ln .env
        // .qwen/loop.md`), so confinement passes on the same fs and the secret
        // would be read every tick. `nlink > 1` is the only tell — refuse it,
        // mirroring canonicalizeKeytermsFile.
        if (projectStat.nlink > 1) {
          debugLogger.debug('skipping hard-linked project loop.md', {
            filePath,
          });
          continue;
        }
        // A final-component lstat can't see an ANCESTOR symlink (e.g. a
        // checked-in `.qwen -> /outside`); realpath resolves it, so confine the
        // canonical path to the workspace root before reading.
        const realRoot = await resolveRealDir(projectRoot, realDirCache);
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
        // Same hard-link guard as the project candidate: a `nlink > 1` regular
        // file shares another inode's content (e.g. `ln ~/.ssh/id_ed25519
        // ~/.qwen/loop.md`) and would otherwise be read and fed to the model.
        if (homeStat.nlink > 1) {
          debugLogger.debug('skipping hard-linked home loop.md', { filePath });
          continue;
        }
        // A home symlink IS followed, but its target must stay WITHIN $HOME:
        // otherwise `~/.qwen/loop.md -> /etc/passwd` (or `-> /dev/...`) would be
        // read and fed to the model every tick. In-home dotfile symlinks (e.g.
        // `-> ~/dotfiles/loop.md`) still resolve inside $HOME and are allowed.
        const realHome = await resolveRealDir(homeDir, realDirCache);
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
    // Log it (like every other skip branch) so a present-but-empty loop.md is
    // distinguishable from an absent one in debug logs.
    if (buffer.toString('utf8').trim().length === 0) {
      debugLogger.debug('skipping whitespace-only loop.md', {
        source,
        filePath,
      });
      continue;
    }

    const truncated = buffer.byteLength > LOOP_TASK_FILE_MAX_BYTES;
    let content: string;
    if (truncated) {
      // Cap by bytes on a UTF-8 char boundary. First back off any trailing
      // continuation bytes (10xxxxxx) left by a mid-character cut at the cap...
      let end = LOOP_TASK_FILE_MAX_BYTES;
      while (end > 0 && (buffer[end] & 0xc0) === 0x80) {
        end--;
      }
      // ...then drop any malformed trailing unit. `lead` is the last
      // non-continuation byte, and the back-off skipped exactly the continuation
      // bytes after it, so the trailing character is well-formed iff its declared
      // width reaches `end` exactly. A mismatch is either an INCOMPLETE lead (too
      // few continuations, `lead + width > end`) or an ORPHAN lead whose stray
      // continuations belong to nothing (`lead + width < end`) — e.g. a width
      // check that only tests `> end` keeps `c3 41 80 80 80` (orphan `c3` plus
      // stray continuations after the `41`). Drop the unit and re-check, since
      // several malformed units can stack. Each surviving orphan decodes to a
      // trailing U+FFFD the byte-length re-clamp below cannot remove, so this loop
      // is load-bearing and the re-clamp is a pure safety net.
      while (end > 0) {
        let lead = end - 1;
        while (lead >= 0 && (buffer[lead] & 0xc0) === 0x80) {
          lead--;
        }
        if (lead < 0) {
          break;
        }
        const b = buffer[lead];
        const width =
          (b & 0x80) === 0x00
            ? 1
            : (b & 0xe0) === 0xc0
              ? 2
              : (b & 0xf0) === 0xe0
                ? 3
                : (b & 0xf8) === 0xf0
                  ? 4
                  : 1; // invalid lead (0xC0/0xC1/0xF8–0xFF): treat as a 1-byte unit
        if (lead + width === end) {
          break; // a complete, well-formed trailing character
        }
        end = lead;
      }
      content = buffer.subarray(0, end).toString('utf8');
      while (Buffer.byteLength(content, 'utf8') > LOOP_TASK_FILE_MAX_BYTES) {
        content = content.slice(0, -1);
      }
    } else {
      content = buffer.toString('utf8');
    }

    // The one happy-path trace (all other logs here are skip/failure) so oncall
    // can confirm a tick actually picked up a file. Logs the relative source
    // label and byte count, never the absolute path (which would leak the OS
    // username / dir layout into debug logs).
    debugLogger.debug('read loop.md', {
      source,
      bytes: buffer.byteLength,
      truncated,
    });

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
