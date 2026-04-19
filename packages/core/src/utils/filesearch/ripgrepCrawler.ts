/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveRipgrep } from '../ripgrepUtils.js';
import type { Ignore } from './ignore.js';

export interface RipgrepCrawlOptions {
  /** Directory the crawl starts from. */
  crawlDirectory: string;
  /** Project's root; the returned paths are relative to this. */
  cwd: string;
  /** Hard cap on the number of paths materialised. Same safety valve as fdir. */
  maxFiles?: number;
  /** Extra directories to exclude beyond rg's gitignore handling (.qwenignore dirs, user ignoreDirs). */
  extraExcludeDirs?: string[];
  /**
   * Post-filter applied to each path that survives rg's own ignore handling.
   * Receives cwd-relative paths (both files and synthesised directories, the
   * latter with a trailing slash). Returns true to drop the entry.
   */
  fileFilter?: (cwdRelative: string) => boolean;
  onProgress?: (chunk: string[]) => void;
  progressChunkSize?: number; // default 2000
  progressFlushMs?: number; // default 50
  /** Abort signal propagated to the rg child process. */
  signal?: AbortSignal;
}

export interface RipgrepCrawlResult {
  files: string[];
  /** True if we hit `maxFiles` and truncated. */
  truncated: boolean;
}

/**
 * Lightweight guard: many shell metacharacters in user-supplied ignoreDir
 * strings would be safely passed to rg as arguments (execFile-style spawn),
 * but a dir name containing a NUL byte or a newline would confuse the NUL
 * splitter. Callers should normally pass clean relative dir names, so we
 * just pick those out here.
 */
function sanitiseExcludeDir(dir: string): string | null {
  if (!dir || dir.includes('\0') || dir.includes('\n')) return null;
  // Strip leading/trailing slashes for glob consistency.
  return dir.replace(/^\/+|\/+$/g, '');
}

function toPosixPath(p: string): string {
  return p.split(path.sep).join(path.posix.sep);
}

/**
 * Lists files under `crawlDirectory` via bundled ripgrep. Much faster than
 * the fdir fallback on large trees (100k files in <200ms on typical
 * workstations) because rg's Rust walker is parallel and it reuses the
 * same .gitignore parser it uses for content search. Falls back to the
 * caller's fdir path on failure — see crawler.ts.
 *
 * Semantic contract:
 *   - Returned paths are POSIX-style, relative to `cwd` (not `crawlDirectory`).
 *   - Both files and the directories containing them are returned. Directory
 *     entries carry a trailing slash, matching the pre-existing fdir output
 *     so tests and consumers don't need to distinguish code paths.
 *   - `.gitignore`, `.ignore`, and (rg-internal) global ignore files are
 *     honoured automatically; `.qwenignore` must be applied via `fileFilter`.
 *   - rg's own `.git/` auto-skip is defensive, but we also pass `--glob
 *     '!.git'` because `--hidden` would otherwise reveal `.git/`. Same for
 *     any caller-supplied `extraExcludeDirs`.
 */
export async function ripgrepCrawl(
  options: RipgrepCrawlOptions,
): Promise<RipgrepCrawlResult> {
  const selection = await resolveRipgrep();
  if (!selection) {
    throw new Error('ripgrep binary not available');
  }

  const chunkSize = options.progressChunkSize ?? 2000;
  const flushMs = options.progressFlushMs ?? 50;
  const maxFiles = options.maxFiles ?? Infinity;

  const args = [
    '--files',
    // Include dotfiles/dotdirs (except ones matched by the excludes below).
    '--hidden',
    // Allow rg to respect .gitignore even outside a git checkout (rg 13+).
    '--no-require-git',
    // Skip rg's parent-directory ignore lookup — we operate in the project
    // root by contract, and letting rg walk up to HOME produces surprising
    // results (user's global .gitignore becomes effective).
    '--no-ignore-parent',
    // NUL-separated output is safe for paths containing newlines or other
    // special characters; we split on \0 below.
    '-0',
    '--glob',
    '!.git',
  ];
  for (const dir of options.extraExcludeDirs ?? []) {
    const cleaned = sanitiseExcludeDir(dir);
    if (cleaned === null || cleaned === '') continue;
    args.push('--glob', `!${cleaned}`);
  }
  // Pass `.` as the path and set cwd=crawlDirectory in the spawn options.
  // rg reflects its input path back in the output, so passing an absolute
  // path here would yield absolute paths from stdout — which would break
  // the ignore-lib post-filter (it requires relative paths).
  args.push('.');

  const posixCwd = toPosixPath(options.cwd);
  const posixCrawlDirectory = toPosixPath(options.crawlDirectory);
  const relativeToCrawlDir = path.posix.relative(posixCwd, posixCrawlDirectory);
  const fileFilter = options.fileFilter;

  // Seed with `.` for parity with fdir's `.withDirs()` output — downstream
  // consumers skip it in their own filter loop but some callers (and the
  // pre-existing crawler tests) assert its presence.
  const files: string[] = ['.'];
  const dirSet = new Set<string>();
  let truncated = false;
  let progressBuffer: string[] = options.onProgress ? ['.'] : [];
  let lastFlushAt = Date.now();
  const flushProgress = () => {
    if (!options.onProgress || progressBuffer.length === 0) return;
    const toSend = progressBuffer;
    progressBuffer = [];
    lastFlushAt = Date.now();
    try {
      options.onProgress(toSend);
    } catch {
      // best-effort
    }
  };
  const pushAllowed = (value: string): boolean => {
    // Guard: both the file and every synthesised directory consume one
    // slot of the maxFiles budget, so we check before each individual push.
    // Returning false here signals the caller to stop streaming further
    // entries from rg.
    if (files.length >= maxFiles) {
      truncated = true;
      return false;
    }
    files.push(value);
    if (options.onProgress) progressBuffer.push(value);
    return true;
  };

  const recordPath = (p: string): boolean => {
    if (files.length >= maxFiles) {
      truncated = true;
      return false;
    }
    if (fileFilter && fileFilter(p)) return true; // filtered but keep going
    if (!pushAllowed(p)) return false;
    // Synthesise directory entries lazily so the output shape matches the
    // previous fdir-based crawl (`getFolderStructure` etc. expect `foo/`
    // entries). Only emit each unique directory once.
    let dirEnd = p.lastIndexOf('/');
    while (dirEnd > 0) {
      const dir = `${p.slice(0, dirEnd)}/`;
      if (dirSet.has(dir)) break;
      if (fileFilter && fileFilter(dir)) {
        dirSet.add(dir); // prevent re-checking filtered-out dirs
        break;
      }
      dirSet.add(dir);
      if (!pushAllowed(dir)) return false;
      dirEnd = p.lastIndexOf('/', dirEnd - 1);
    }
    if (
      options.onProgress &&
      (progressBuffer.length >= chunkSize ||
        Date.now() - lastFlushAt >= flushMs)
    ) {
      flushProgress();
    }
    return true;
  };

  await new Promise<void>((resolve, reject) => {
    const child = spawn(selection.command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: options.signal,
      cwd: options.crawlDirectory,
    });

    let stdoutBuf = '';
    let stderrBuf = '';
    let aborted = false;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (data: string) => {
      if (aborted) return;
      stdoutBuf += data;
      // Split on NUL; last segment may be partial and rejoins the buffer.
      let idx = stdoutBuf.indexOf('\0');
      while (idx !== -1) {
        const raw = stdoutBuf.slice(0, idx);
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (raw.length > 0) {
          // rg emits paths relative to the invocation dir with a leading
          // `./`. Strip it and translate through `relativeToCrawlDir` so
          // the final path is cwd-relative (matching the fdir contract).
          let p = raw.startsWith('./') ? raw.slice(2) : raw;
          p = toPosixPath(p);
          if (relativeToCrawlDir) {
            p = path.posix.join(relativeToCrawlDir, p);
          }
          if (!recordPath(p)) {
            aborted = true;
            child.kill('SIGTERM');
            break;
          }
        }
        idx = stdoutBuf.indexOf('\0');
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (data: string) => {
      stderrBuf += data;
    });

    child.on('error', (err) => reject(err));
    child.on('close', (code, signal) => {
      flushProgress();
      // stdin-open-but-closed code 0: fine. code 1: no matches (fine for --files).
      // code 2: usage error. We also accept SIGTERM when we deliberately killed it.
      if (aborted) return resolve();
      if (code === 0 || code === 1) return resolve();
      if (signal === 'SIGTERM' && options.signal?.aborted) return resolve();
      reject(
        new Error(
          `ripgrep exited with code=${code ?? 'null'} signal=${
            signal ?? 'null'
          }${stderrBuf ? `: ${stderrBuf.trim().split('\n')[0]}` : ''}`,
        ),
      );
    });
  });

  // ripgrep only lists files, so genuinely empty directories — or
  // directories whose entire contents are filtered away — never show up
  // in the stream. fdir's legacy output did include them via
  // `.withDirs()`, and callers (the @-picker, tests) assume the tree
  // structure is fully represented. Fill the gap with a directory-only
  // pass: fs.readdir is fast when we skip files, so even on large trees
  // this is a few tens of milliseconds. Any dir already synthesised from
  // a file path is deduped via `dirSet`.
  await enumerateEmptyDirs(
    options.crawlDirectory,
    relativeToCrawlDir,
    options.fileFilter,
    maxFiles,
    dirSet,
    (dir) => {
      if (files.length >= maxFiles) {
        truncated = true;
        return false;
      }
      files.push(dir);
      if (options.onProgress) progressBuffer.push(dir);
      return true;
    },
  );
  flushProgress();

  // Sort in breadth-first order to match fdir's default traversal shape.
  // Downstream fzf ranking breaks score ties using list position, so the
  // @-picker's suggestion order is stable only if we feed fzf a
  // deterministic, natural-feeling order. BFS puts `.` first, then
  // top-level entries alphabetically, then one-deep, and so on — the same
  // order a user would expect to see in a tree view.
  const depth = (p: string): number => {
    if (p === '.') return 0;
    let slashes = 0;
    for (let i = 0; i < p.length; i++) if (p[i] === '/') slashes++;
    return p.endsWith('/') ? slashes - 1 : slashes;
  };
  files.sort((a, b) => {
    if (a === '.' && b !== '.') return -1;
    if (b === '.' && a !== '.') return 1;
    const da = depth(a);
    const db = depth(b);
    if (da !== db) return da - db;
    return a < b ? -1 : a > b ? 1 : 0;
  });

  return { files, truncated };
}

/**
 * Walk the project tree with `fs.readdir` (dirs only, files skipped) to
 * capture directories that ripgrep didn't emit because they contain no
 * files. Honours the same `fileFilter` semantics as the main crawl so that
 * e.g. `.git`, `node_modules`, or anything covered by `.qwenignore` stays
 * excluded. Cheap in practice — a filesystem tree has orders of magnitude
 * fewer directories than files.
 */
async function enumerateEmptyDirs(
  crawlDirectory: string,
  relativeToCrawlDir: string,
  fileFilter: ((cwdRelative: string) => boolean) | undefined,
  maxFiles: number,
  dirSet: Set<string>,
  emit: (dir: string) => boolean,
): Promise<void> {
  const visit = async (absDir: string, relDir: string): Promise<boolean> => {
    let entries: Array<import('node:fs').Dirent>;
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return true; // unreadable dir; skip silently
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const childRel = relDir ? `${relDir}/${entry.name}` : entry.name;
      const cwdRelative = relativeToCrawlDir
        ? path.posix.join(relativeToCrawlDir, childRel)
        : childRel;
      const dirPath = `${cwdRelative}/`;
      // Prune like the main crawl does: rg already skipped .git etc., but
      // because we walk independently here we must re-apply the ignore
      // rules to match semantics.
      if (fileFilter && fileFilter(dirPath)) continue;
      if (!dirSet.has(dirPath)) {
        dirSet.add(dirPath);
        if (!emit(dirPath)) return false;
      }
      const absChild = path.join(absDir, entry.name);
      if (!(await visit(absChild, childRel))) return false;
      if (dirSet.size + 0 >= maxFiles) {
        // Defensive: the emit callback enforces maxFiles too.
        break;
      }
    }
    return true;
  };
  await visit(crawlDirectory, '');
}

/**
 * Adapter that accepts the same `Ignore` instance the fdir crawler uses and
 * returns a `fileFilter` suitable for `ripgrepCrawl`. Encapsulates the
 * handful of semantic differences:
 *
 *   1. `.qwenignore` is not part of the gitignore family rg reads, so we
 *      apply it via the post-filter.
 *   2. `fdir`'s `.withDirs()` also emits the crawl root as `'.'`; rg doesn't.
 *      Callers strip `.` at the consumer layer (see `FileIndexCore.search`).
 */
export function buildRipgrepFileFilter(
  ignore: Ignore,
): (cwdRelative: string) => boolean {
  const fileIgnore = ignore.getFileFilter();
  const dirIgnore = ignore.getDirectoryFilter();
  return (p: string) => {
    if (p === '') return true;
    // Directory entry (trailing slash) — consult the dir filter directly.
    if (p.endsWith('/')) {
      return dirIgnore(p);
    }
    // Walk ancestor directories: rg only honours .gitignore / .ignore, so a
    // .qwenignore rule like `dist/` (a directory pattern, stored only in the
    // dirIgnorer) must be enforced here by checking each parent directory.
    // Without this, `dist/ignored.js` slips through because `fileIgnore`
    // doesn't know about directory-only patterns.
    let slash = p.indexOf('/');
    while (slash !== -1) {
      if (dirIgnore(`${p.slice(0, slash)}/`)) return true;
      slash = p.indexOf('/', slash + 1);
    }
    return fileIgnore(p);
  };
}
