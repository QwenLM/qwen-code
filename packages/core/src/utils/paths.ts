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
 * Special characters that need to be escaped in file paths for shell compatibility.
 * Includes: spaces, parentheses, brackets, braces, semicolons, ampersands, pipes,
 * asterisks, question marks, dollar signs, backticks, quotes, hash, and other shell metacharacters.
 */
export const SHELL_SPECIAL_CHARS = /[ \t()[\]{};|*?$`'"#&<>!~]/;

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
 */
export function unescapePath(filePath: string): string {
  return filePath.replace(
    new RegExp(`\\\\([${SHELL_SPECIAL_CHARS.source.slice(1, -1)}])`, 'g'),
    '$1',
  );
}

/**
 * Generates a unique hash for a project based on its root path.
 * @param projectRoot The absolute path to the project's root directory.
 * @returns A SHA256 hash of the project root path.
 */
export function getProjectHash(projectRoot: string): string {
  return crypto.createHash('sha256').update(projectRoot).digest('hex');
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
  const { allowFiles = false } = options;
  const workspaceContext = config.getWorkspaceContext();

  if (!workspaceContext.isPathWithinWorkspace(resolvedPath)) {
    throw new Error('Path is not within workspace');
  }

  try {
    const stats = fs.statSync(resolvedPath);
    if (!allowFiles && !stats.isDirectory()) {
      throw new Error(`Path is not a directory: ${resolvedPath}`);
    }
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new Error(`Path does not exist: ${resolvedPath}`);
    }
    throw error;
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
