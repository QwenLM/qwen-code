/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { isNodeError } from '@qwen-code/qwen-code-core/utils/errors.js';
import {
  isSubpath,
  SHELL_SPECIAL_CHARS,
} from '@qwen-code/qwen-code-core/utils/paths.js';

// Preserve leading Windows root prefixes (`C:\`, `\\server\`, or `\`) so
// unescaping does not strip the root separator before a folder whose name
// starts with a shell metacharacter (e.g. `C:\(v2)\file.txt`).
const WINDOWS_ROOT_PREFIX = /^([A-Za-z]:\\|\\\\[^\\]+\\|\\)(.*)$/s;

const CLOSING_DELIMITERS = new Set([')', ']', '}']);

function isWhitespace(char: string): boolean {
  return char === ' ' || char === '\t';
}

/**
 * Single-pass O(n) check for whether `value` could be produced by `escapePath`:
 * every character matching `SHELL_SPECIAL_CHARS` must be preceded by an odd
 * number of consecutive backslashes.
 */
function hasOnlyEscapedShellSpecials(value: string): boolean {
  let backslashes = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (ch === '\\') {
      backslashes++;
      continue;
    }
    if (backslashes % 2 === 0 && SHELL_SPECIAL_CHARS.test(ch)) {
      return false;
    }
    backslashes = 0;
  }
  return true;
}

/**
 * Single-pass O(n) unescaper for `SHELL_SPECIAL_CHARS` that only strips a
 * backslash at index >= `minUnescapeIndex` when preceded by an odd run of
 * backslashes (so root separators and `\\<meta>` are never collapsed).
 *
 * When `preserveInteriorSeparators` is true, an interior `\` before a
 * non-whitespace, non-closing metacharacter that still has a path separator
 * later in `value` is kept as a directory separator (e.g.
 * `C:\Users\John\ Doe\Docs\(draft\)\a.txt` becomes
 * `C:\Users\John Doe\Docs\(draft)\a.txt` rather than folding `Docs\(` into
 * `Docs(`).
 */
function findLastDirectorySeparatorIndex(value: string): number {
  for (let i = value.length - 1; i >= 0; i--) {
    const ch = value[i]!;
    if (ch === '/') {
      return i;
    }
    if (ch === '\\') {
      const next = i + 1 < value.length ? value[i + 1]! : '';
      if (next !== '' && !isWhitespace(next) && !CLOSING_DELIMITERS.has(next)) {
        return i;
      }
    }
  }
  return -1;
}

function unescapeShellToken(
  value: string,
  minUnescapeIndex: number,
  preserveInteriorSeparators: boolean,
): string {
  const lastSepIndex = preserveInteriorSeparators
    ? findLastDirectorySeparatorIndex(value)
    : -1;
  const out: string[] = [];
  let backslashes = 0;

  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (ch === '\\') {
      backslashes++;
      out.push(ch);
      continue;
    }
    const backslashIndex = i - 1;
    if (
      backslashes % 2 === 1 &&
      backslashIndex >= minUnescapeIndex &&
      SHELL_SPECIAL_CHARS.test(ch)
    ) {
      const prevCharBeforeBackslash =
        backslashIndex > 0 ? (out[out.length - 2] ?? '') : '';
      const isInteriorDirSeparator =
        preserveInteriorSeparators &&
        backslashIndex > 0 &&
        backslashIndex < lastSepIndex &&
        !isWhitespace(ch) &&
        !CLOSING_DELIMITERS.has(ch) &&
        !isWhitespace(prevCharBeforeBackslash) &&
        prevCharBeforeBackslash !== '\\' &&
        prevCharBeforeBackslash !== '/';
      if (!isInteriorDirSeparator) {
        out.pop();
      }
    }
    out.push(ch);
    backslashes = 0;
  }

  return out.join('');
}

/**
 * Returns candidate paths to try when resolving an `@`-referenced path.
 *
 * On POSIX, `parseAllAtCommands` already unescapes paths via `unescapePath`,
 * so only the input path is returned.
 *
 * On Windows, `unescapePath` leaves backslashes intact so literal paths like
 * `C:\(v2)\file.txt` keep their directory separators. However, `@` autocomplete
 * and drag-and-drop still emit backslash-escaped shell characters via
 * `escapePath` (for example `my\ file.txt`, `doc\ \(1\).md`, or `\#notes.md`).
 * Returning the literal path first, then separator-preserving unescaped
 * candidates, and finally full-fold candidates only when every shell
 * metacharacter in the token is escaped preserves real literal paths and
 * nested metacharacter folders while allowing escaped `@`-paths to resolve.
 */
export function getAtPathCandidates(
  pathSpec: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform !== 'win32') {
    return [pathSpec];
  }
  const candidates: string[] = [pathSpec];
  const pushUnique = (candidate: string): void => {
    if (!candidates.includes(candidate)) {
      candidates.push(candidate);
    }
  };
  const allowFullFold = hasOnlyEscapedShellSpecials(pathSpec);
  const addFrom = (minIndex: number): void => {
    pushUnique(unescapeShellToken(pathSpec, minIndex, true));
    if (allowFullFold) {
      pushUnique(unescapeShellToken(pathSpec, minIndex, false));
    }
  };

  const rootMatch = WINDOWS_ROOT_PREFIX.exec(pathSpec);
  if (rootMatch) {
    const prefix = rootMatch[1]!;
    addFrom(prefix.length);
    // A bare leading `\` can be either a drive-relative root (`\#v2\...`) or
    // `escapePath`'s escape of a leading shell metacharacter (`\#notes.md`,
    // `\(v2\)/a.md`). Drive roots (`C:\`) and UNC prefixes (`\\server\`) must
    // not be fully unescaped or their root separator would be stripped.
    if (prefix === '\\') {
      addFrom(0);
    }
  } else {
    addFrom(0);
  }

  return candidates;
}

function isWithinAllowedRoots(
  target: string,
  allowedRoots?: readonly string[],
): boolean {
  if (!allowedRoots || allowedRoots.length === 0) {
    return true;
  }
  return allowedRoots.some(
    (root) => root.length > 0 && isSubpath(root, target),
  );
}

function getProbeTargets(
  candidate: string,
  workspaceDirs: readonly string[],
  allowedRoots?: readonly string[],
): string[] {
  if (workspaceDirs.length === 0) {
    return path.isAbsolute(candidate) &&
      isWithinAllowedRoots(candidate, allowedRoots)
      ? [candidate]
      : [];
  }
  const targets: string[] = [];
  for (const dir of workspaceDirs) {
    const resolved = path.resolve(dir, candidate);
    if (!isWithinAllowedRoots(resolved, allowedRoots)) {
      continue;
    }
    if (!targets.includes(resolved)) {
      targets.push(resolved);
    }
  }
  return targets;
}

/**
 * Selects the first existing `@`-path candidate asynchronously using `lstat`.
 *
 * Falls back to the next candidate only on `ENOENT`; any other error (such as
 * `EACCES`/`EPERM`) returns the current candidate so the caller's own per-path
 * error reporting runs instead of silently substituting an unescaped sibling.
 * When `allowedRoots` is provided, probe targets lexically outside those roots
 * (e.g. a drive-root entry shadowing a workspace-relative leading-metacharacter
 * file) are skipped without calling `realpath`, so denied or dangling links
 * inside the workspace still reach `lstat`.
 */
export async function selectAtPathCandidate(
  candidates: readonly string[],
  workspaceDirs: readonly string[],
  allowedRoots?: readonly string[],
): Promise<string> {
  const fallback = candidates[0] ?? '';
  if (candidates.length <= 1) {
    return fallback;
  }
  for (const candidate of candidates) {
    for (const target of getProbeTargets(
      candidate,
      workspaceDirs,
      allowedRoots,
    )) {
      try {
        await fsPromises.lstat(target);
        return candidate;
      } catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT') {
          continue;
        }
        return candidate;
      }
    }
  }
  return fallback;
}

/**
 * Synchronous mirror of `selectAtPathCandidate` for callers inside synchronous
 * message-building callbacks (e.g. ACP prompt text extraction).
 */
export function selectAtPathCandidateSync(
  candidates: readonly string[],
  workspaceDirs: readonly string[],
  allowedRoots?: readonly string[],
): string {
  const fallback = candidates[0] ?? '';
  if (candidates.length <= 1) {
    return fallback;
  }
  for (const candidate of candidates) {
    for (const target of getProbeTargets(
      candidate,
      workspaceDirs,
      allowedRoots,
    )) {
      try {
        fs.lstatSync(target);
        return candidate;
      } catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT') {
          continue;
        }
        return candidate;
      }
    }
  }
  return fallback;
}
