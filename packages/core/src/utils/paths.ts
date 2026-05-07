/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as crypto from 'node:crypto';
import type { Config } from '../config/config.js';
import { isNodeError } from './errors.js';

export const QWEN_DIR = '.qwen';
export const GOOGLE_ACCOUNTS_FILENAME = 'google_accounts.json';

/**
 * Cache for `validatePath`'s isDirectory check. Only positive results are
 * cached — ENOENT and other errors fall through every time so a freshly
 * created file is picked up immediately. Same path validated by back-to-back
 * tool calls (very common: model reads several files in one dir) used to
 * cost one syscall each.
 *
 * **Known tradeoff:** if a path is deleted and recreated as a different
 * type (dir→file or file→dir) within the same process, the cache returns
 * the stale type. The downstream tool will then hit a meaningful error
 * (e.g., "not a directory") instead of a clean "does not exist", but no
 * files are corrupted. This is rare enough in model-driven workflows that
 * we accept the staleness for the common-case perf win.
 */
const isDirectoryCache = new Map<string, boolean>();
const VALIDATE_PATH_CACHE_MAX = 1024;

/**
 * Test-only: clear the validatePath stat cache. Module-level state would
 * otherwise leak across vitest cases — `beforeEach(() => _resetValidatePathCacheForTest())`.
 */
export function _resetValidatePathCacheForTest(): void {
  isDirectoryCache.clear();
}

/**
 * Special characters that need to be escaped in file paths for shell compatibility.
 * Includes: spaces, parentheses, brackets, braces, semicolons, ampersands, pipes,
 * asterisks, question marks, dollar signs, backticks, quotes, hash, and other shell metacharacters.
 */
export const SHELL_SPECIAL_CHARS = /[ \t()[\]{};|*?$`'"#&<>!~]/;

// Single shared list of path-argument keys used across file tools.
// file_path (Edit, ReadFile, WriteFile), path (Glob, Grep, Ls, RipGrep),
// filePath (Lsp), notebook_path.
export const PATH_ARG_KEYS = [
  'file_path',
  'path',
  'filePath',
  'notebook_path',
] as const;

/** Compiled regex for unescapePath — hoisted to avoid re-compilation per call. */
const UNESCAPE_REGEX = (() => {
  const inner = SHELL_SPECIAL_CHARS.source.slice(1, -1);
  return new RegExp(`\\\\([${inner}])`, 'g');
})();

/**
 * Replaces the home directory with a tilde.
 * @param path - The path to tildeify.
 * @returns The tildeified path.
 */
export function tildeifyPath(path: string): string {
  const homeDir = os.homedir();
  if (path.startsWith(homeDir)) {
    return path.replace(homeDir, '~');
  }
  return path;
}

/**
 * Expands tilde (~) and Windows-style %userprofile% to the full home directory path.
 * @param p - The path to expand.
 * @returns The expanded path.
 */
export function expandHomeDir(p: string): string {
  if (!p) {
    return '';
  }
  let expandedPath = p;
  if (p.toLowerCase().startsWith('%userprofile%')) {
    expandedPath = os.homedir() + p.substring('%userprofile%'.length);
  } else if (p === '~' || p.startsWith('~/')) {
    expandedPath = os.homedir() + p.substring(1);
  }
  return path.normalize(expandedPath);
}

/**
 * Shortens a path string if it exceeds maxLen, prioritizing the start and end segments.
 * Shows root + first segment + "..." + end segments when middle segments are omitted.
 * Example: /path/to/a/very/long/file.txt -> /path/.../long/file.txt
 */
export function shortenPath(filePath: string, maxLen: number = 80): string {
  if (filePath.length <= maxLen) {
    return filePath;
  }

  const separator = path.sep;
  const ellipsis = '...';

  // Simple fallback for very short maxLen
  if (maxLen < 10) {
    return filePath.substring(0, maxLen - 3) + ellipsis;
  }

  const parsedPath = path.parse(filePath);
  const root = parsedPath.root;
  const relativePath = filePath.substring(root.length);
  const segments = relativePath.split(separator).filter((s) => s !== '');

  // Handle edge cases: no segments or single segment
  if (segments.length === 0) {
    return root.length <= maxLen
      ? root
      : root.substring(0, maxLen - 3) + ellipsis;
  }

  if (segments.length === 1) {
    const full = root + segments[0];
    if (full.length <= maxLen) {
      return full;
    }
    const keepLen = Math.floor((maxLen - 3) / 2);
    const start = full.substring(0, keepLen);
    const end = full.substring(full.length - keepLen);
    return `${start}${ellipsis}${end}`;
  }

  // For 2+ segments: build from start and end, insert "..." if there's a gap
  const startPart = root + segments[0]; // Always include root and first segment

  // Collect segments from the end, working backwards
  const endSegments: string[] = [];

  for (let i = segments.length - 1; i >= 1; i--) {
    const segment = segments[i];

    // Calculate what the total would be if we add this segment
    const endPart = [segment, ...endSegments].join(separator);
    const needsEllipsis = i > 1; // If we're not at segment[1], there's a gap

    let candidateResult: string;
    if (needsEllipsis) {
      candidateResult = startPart + separator + ellipsis + separator + endPart;
    } else {
      candidateResult = startPart + separator + endPart;
    }

    if (candidateResult.length <= maxLen) {
      endSegments.unshift(segment);

      // If we've reached segment[1], we have all segments - return immediately
      if (i === 1) {
        return candidateResult;
      }
    } else {
      break; // Can't add more segments
    }
  }

  // Build final result
  if (endSegments.length === 0) {
    // Couldn't fit any end segments - use simple truncation
    const keepLen = Math.floor((maxLen - 3) / 2);
    const start = filePath.substring(0, keepLen);
    const end = filePath.substring(filePath.length - keepLen);
    return `${start}${ellipsis}${end}`;
  }

  // We have some end segments but not all - there's a gap, insert ellipsis
  return (
    startPart + separator + ellipsis + separator + endSegments.join(separator)
  );
}

/**
 * Calculates the relative path from a root directory to a target path.
 * Ensures both paths are resolved before calculating.
 * Returns '.' if the target path is the same as the root directory.
 *
 * @param targetPath The absolute or relative path to make relative.
 * @param rootDirectory The absolute path of the directory to make the target path relative to.
 * @returns The relative path from rootDirectory to targetPath.
 */
export function makeRelative(
  targetPath: string,
  rootDirectory: string,
): string {
  const resolvedTargetPath = path.resolve(targetPath);
  const resolvedRootDirectory = path.resolve(rootDirectory);

  if (!isSubpath(resolvedRootDirectory, resolvedTargetPath)) {
    return resolvedTargetPath;
  }

  const relativePath = path.relative(resolvedRootDirectory, resolvedTargetPath);

  // If the paths are the same, path.relative returns '', return '.' instead
  return relativePath || '.';
}

/**
 * Escapes special characters in a file path like macOS terminal does.
 * Escapes: spaces, parentheses, brackets, braces, semicolons, ampersands, pipes,
 * asterisks, question marks, dollar signs, backticks, quotes, hash, and other shell metacharacters.
 */
export function escapePath(filePath: string): string {
  let result = '';
  for (let i = 0; i < filePath.length; i++) {
    const char = filePath[i];

    // Count consecutive backslashes before this character
    let backslashCount = 0;
    for (let j = i - 1; j >= 0 && filePath[j] === '\\'; j--) {
      backslashCount++;
    }

    // Character is already escaped if there's an odd number of backslashes before it
    const isAlreadyEscaped = backslashCount % 2 === 1;

    // Only escape if not already escaped
    if (!isAlreadyEscaped && SHELL_SPECIAL_CHARS.test(char)) {
      result += '\\' + char;
    } else {
      result += char;
    }
  }
  return result;
}

/**
 * Unescapes special characters in a file path.
 * Removes backslash escaping from shell metacharacters.
 *
 * On Windows, backslashes are path separators, not shell escape characters
 * (PowerShell uses backtick, cmd.exe uses caret). Skipping unescaping on
 * win32 avoids corrupting valid absolute paths like C:\(v2)\file.txt.
 */
export function unescapePath(filePath: string): string {
  if (os.platform() === 'win32') {
    return filePath;
  }
  const unescaped = filePath.replace(UNESCAPE_REGEX, '$1');
  return unescaped;
}

/**
 * Generates a unique hash for a project based on its root path.
 * On Windows, paths are case-insensitive, so we normalize to lowercase
 * to ensure the same physical path always produces the same hash.
 * @param projectRoot The absolute path to the project's root directory.
 * @returns A SHA256 hash of the project root path.
 */
export function getProjectHash(projectRoot: string): string {
  // On Windows, normalize path to lowercase for case-insensitive matching
  const normalizedPath =
    os.platform() === 'win32' ? projectRoot.toLowerCase() : projectRoot;
  return crypto.createHash('sha256').update(normalizedPath).digest('hex');
}

/**
 * Sanitizes a directory path to create a safe project ID.
 *
 * - On Windows: normalizes to lowercase for case-insensitive matching
 * - Replaces all non-alphanumeric characters with hyphens
 *
 * This is used for:
 * - Creating project-specific directories
 * - Generating session IDs for debug logging during startup
 *
 * @param cwd - The directory path to sanitize
 * @returns A sanitized string safe for use as a project identifier
 */
export function sanitizeCwd(cwd: string): string {
  // On Windows, normalize to lowercase for case-insensitive matching
  const normalizedCwd = os.platform() === 'win32' ? cwd.toLowerCase() : cwd;
  return normalizedCwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Checks if a path is a subpath of another path.
 * @param parentPath The parent path.
 * @param childPath The child path.
 * @returns True if childPath is a subpath of parentPath, false otherwise.
 */
export function isSubpath(parentPath: string, childPath: string): boolean {
  const isWindows = os.platform() === 'win32';
  const pathModule = isWindows ? path.win32 : path;

  // On Windows, path.relative is case-insensitive. On POSIX, it's case-sensitive.
  const relative = pathModule.relative(parentPath, childPath);

  return (
    !relative.startsWith(`..${pathModule.sep}`) &&
    relative !== '..' &&
    !pathModule.isAbsolute(relative)
  );
}

export function isSubpaths(parentPath: string[], childPath: string): boolean {
  return parentPath.some((p) => isSubpath(p, childPath));
}

/**
 * Resolves a path with tilde (~) expansion and relative path resolution.
 * Handles tilde expansion for home directory and resolves relative paths
 * against the provided base directory or current working directory.
 *
 * @param baseDir The base directory to resolve relative paths against (defaults to current working directory)
 * @param relativePath The path to resolve (can be relative, absolute, or tilde-prefixed)
 * @returns The resolved absolute path
 */
export function resolvePath(
  baseDir: string | undefined = process.cwd(),
  relativePath: string,
): string {
  const homeDir = os.homedir();

  if (relativePath === '~') {
    return homeDir;
  } else if (relativePath.startsWith('~/')) {
    return path.join(homeDir, relativePath.slice(2));
  } else if (path.isAbsolute(relativePath)) {
    return relativePath;
  } else {
    return path.resolve(baseDir, relativePath);
  }
}

export interface PathValidationOptions {
  /**
   * If true, allows both files and directories. If false (default), only allows directories.
   */
  allowFiles?: boolean;

  /**
   * If true, allows paths outside the workspace boundaries.
   * The caller is responsible for adjusting permissions (e.g. 'ask') for
   * external paths.
   */
  allowExternalPaths?: boolean;
}

/**
 * Validates that a resolved path exists within the workspace boundaries.
 *
 * @param config The configuration object containing workspace context
 * @param resolvedPath The absolute path to validate
 * @param options Validation options
 * @throws Error if the path is outside workspace boundaries, doesn't exist, or is not a directory (when allowFiles is false)
 */
export function validatePath(
  config: Config,
  resolvedPath: string,
  options: PathValidationOptions = {},
): void {
  const { allowFiles = false, allowExternalPaths = false } = options;
  const workspaceContext = config.getWorkspaceContext();
  const isWithinWorkspace =
    workspaceContext.isPathWithinWorkspace(resolvedPath);

  if (!allowExternalPaths && !isWithinWorkspace) {
    throw new Error('Path is not within workspace');
  }

  // For external paths where allowExternalPaths is true, skip filesystem checks.
  // The path may not exist locally on the current machine, and permissions for
  // external paths are handled at runtime rather than at validation time.
  if (allowExternalPaths && !isWithinWorkspace) {
    return;
  }

  let isDirectory = isDirectoryCache.get(resolvedPath);
  if (isDirectory === undefined) {
    try {
      isDirectory = fs.statSync(resolvedPath).isDirectory();
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        throw new Error(`Path does not exist: ${resolvedPath}`);
      }
      throw error;
    }
    if (isDirectoryCache.size >= VALIDATE_PATH_CACHE_MAX) {
      const oldest = isDirectoryCache.keys().next().value;
      if (oldest !== undefined) isDirectoryCache.delete(oldest);
    }
    isDirectoryCache.set(resolvedPath, isDirectory);
  }
  if (!allowFiles && !isDirectory) {
    throw new Error(`Path is not a directory: ${resolvedPath}`);
  }
}

/**
 * Resolves a path relative to the workspace root and verifies that it exists
 * within the workspace boundaries defined in the config.
 *
 * @param config The configuration object
 * @param relativePath The relative path to resolve (optional, defaults to target directory)
 * @param options Validation options (e.g., allowFiles to permit file paths)
 */
export function resolveAndValidatePath(
  config: Config,
  relativePath?: string,
  options: PathValidationOptions = {},
): string {
  const targetDir = config.getTargetDir();

  if (!relativePath) {
    return targetDir;
  }

  const resolvedPath = resolvePath(targetDir, relativePath);
  validatePath(config, resolvedPath, options);
  return resolvedPath;
}
