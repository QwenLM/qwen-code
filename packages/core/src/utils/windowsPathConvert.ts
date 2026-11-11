/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure string conversion between native Windows paths and the POSIX-style
 * paths Git Bash / MSYS2 use. Dependency-free on purpose: `paths.ts` needs
 * the posix→windows direction and must not pull in the shell-setup half of
 * `windowsPaths.ts` (which imports the logger stack that imports paths.ts
 * back, closing a cycle).
 */

// Bounded caches for path conversions (FIFO eviction — good enough for a
// small, stable set of project/system paths).
const posixCache = new Map<string, string>();
const windowsCache = new Map<string, string>();
const CACHE_MAX = 500;

function cacheSet(
  cache: Map<string, string>,
  key: string,
  value: string,
): void {
  if (cache.size >= CACHE_MAX) {
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) {
      cache.delete(firstKey);
    }
  }
  cache.set(key, value);
}

/** Reset the conversion caches. Test-only. */
export function _resetConversionCachesForTest(): void {
  posixCache.clear();
  windowsCache.clear();
}

/**
 * Convert a native Windows path to a POSIX path for use inside Git Bash.
 *
 * - `C:\Users\foo`   → `/c/Users/foo`
 * - `\\server\share` → `//server/share`  (UNC paths)
 * - `relative\path`  → `relative/path`   (flip backslashes only)
 */
export function windowsPathToPosixPath(windowsPath: string): string {
  const cached = posixCache.get(windowsPath);
  if (cached !== undefined) return cached;

  let result: string;

  // Handle UNC paths: \\server\share -> //server/share
  if (windowsPath.startsWith('\\\\')) {
    result = windowsPath.replace(/\\/g, '/');
  }
  // Handle drive letter paths: C:\Users\foo -> /c/Users/foo
  else {
    const match = windowsPath.match(/^([A-Za-z]):[/\\]/);
    if (match) {
      const driveLetter = match[1].toLowerCase();
      result = '/' + driveLetter + windowsPath.slice(2).replace(/\\/g, '/');
    } else {
      // Already POSIX or relative — just flip slashes
      result = windowsPath.replace(/\\/g, '/');
    }
  }

  cacheSet(posixCache, windowsPath, result);
  return result;
}

/**
 * Convert a POSIX path (as output by Git Bash / MSYS2) back to a native
 * Windows path for Node.js file I/O.
 *
 * - `/c/Users/foo`         → `C:\Users\foo`
 * - `/cygdrive/c/Users/foo` → `C:\Users\foo`
 * - `//server/share`       → `\\server\share`  (UNC paths)
 * - `relative/path`        → `relative\path`   (flip slashes only)
 */
export function posixPathToWindowsPath(posixPath: string): string {
  const cached = windowsCache.get(posixPath);
  if (cached !== undefined) return cached;

  let result: string;

  // Handle UNC paths: //server/share -> \\server\share
  if (posixPath.startsWith('//')) {
    result = posixPath.replace(/\//g, '\\');
  }
  // Handle /cygdrive/c/... format (Cygwin)
  else {
    const cygdriveMatch = posixPath.match(/^\/cygdrive\/([A-Za-z])(\/|$)/);
    if (cygdriveMatch) {
      const driveLetter = cygdriveMatch[1].toUpperCase();
      const rest = posixPath.slice(('/cygdrive/' + cygdriveMatch[1]).length);
      result = driveLetter + ':' + (rest || '\\').replace(/\//g, '\\');
    }
    // Handle /c/... format (MSYS2/Git Bash)
    else {
      const driveMatch = posixPath.match(/^\/([A-Za-z])(\/|$)/);
      if (driveMatch) {
        const driveLetter = driveMatch[1].toUpperCase();
        const rest = posixPath.slice(2);
        result = driveLetter + ':' + (rest || '\\').replace(/\//g, '\\');
      }
      // Already Windows or relative — just flip slashes
      else {
        result = posixPath.replace(/\//g, '\\');
      }
    }
  }

  cacheSet(windowsCache, posixPath, result);
  return result;
}

/** Matches `/c/...` or `/cygdrive/c/...` (drive-anchored POSIX paths). */
const POSIX_DRIVE_PATH_SHAPE = /^\/(?:cygdrive\/)?[A-Za-z](?:\/|$)/;

/**
 * Windows only: rewrite a Git-Bash-style drive path to native form,
 * `/d/...` → `D:\...`. Node's `path.resolve`/`path.isAbsolute` otherwise
 * treat `/d/...` as rooted at the *current* drive (`D:\d\...`), which makes
 * realpath fabricate mirror paths and file I/O land in the wrong place.
 * Non-drive shapes are returned unchanged. No-op off Windows.
 */
export function rewritePosixDrivePath(inputPath: string): string {
  if (process.platform !== 'win32') return inputPath;
  if (!POSIX_DRIVE_PATH_SHAPE.test(inputPath)) return inputPath;
  return posixPathToWindowsPath(inputPath);
}
