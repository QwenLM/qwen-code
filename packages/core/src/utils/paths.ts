/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import os from 'os';
import * as crypto from 'crypto';

export const QWEN_DIR = '.qwen';
export const GOOGLE_ACCOUNTS_FILENAME = 'google_accounts.json';
const TMP_DIR_NAME = 'tmp';
const COMMANDS_DIR_NAME = 'commands';

/**
 * Special characters that need to be escaped in file paths for shell compatibility.
 * Includes: spaces, parentheses, brackets, braces, semicolons, ampersands, pipes,
 * asterisks, question marks, dollar signs, backticks, quotes, hash, and other shell metacharacters.
 */
export const SHELL_SPECIAL_CHARS = /[ \t()[\]{};|*?$`'"#&<>!~]/;

/**
 * Replaces the user's home directory with a tilde (`~`) in a given path.
 * @param path The path to "tilde-ify".
 * @returns The path with the home directory replaced by a tilde, or the original path if it's not in the home directory.
 */
export function tildeifyPath(path: string): string {
  const homeDir = os.homedir();
  if (path.startsWith(homeDir)) {
    return path.replace(homeDir, '~');
  }
  return path;
}

/**
 * Shortens a file path to a maximum length, preserving the beginning and end of the path.
 * For example, `/a/very/long/path/to/a/file.txt` might become `/a/.../to/a/file.txt`.
 *
 * @param filePath The file path to shorten.
 * @param maxLen The maximum length of the shortened path. Defaults to 35.
 * @returns The shortened path, or the original path if it's already shorter than `maxLen`.
 */
export function shortenPath(filePath: string, maxLen: number = 35): string {
  if (filePath.length <= maxLen) {
    return filePath;
  }

  const parsedPath = path.parse(filePath);
  const root = parsedPath.root;
  const separator = path.sep;

  // Get segments of the path *after* the root
  const relativePath = filePath.substring(root.length);
  const segments = relativePath.split(separator).filter((s) => s !== ''); // Filter out empty segments

  // Handle cases with no segments after root (e.g., "/", "C:\") or only one segment
  if (segments.length <= 1) {
    // Fall back to simple start/end truncation for very short paths or single segments
    const keepLen = Math.floor((maxLen - 3) / 2);
    // Ensure keepLen is not negative if maxLen is very small
    if (keepLen <= 0) {
      return filePath.substring(0, maxLen - 3) + '...';
    }
    const start = filePath.substring(0, keepLen);
    const end = filePath.substring(filePath.length - keepLen);
    return `${start}...${end}`;
  }

  const firstDir = segments[0];
  const lastSegment = segments[segments.length - 1];
  const startComponent = root + firstDir;

  const endPartSegments: string[] = [];
  // Base length: separator + "..." + lastDir
  let currentLength = separator.length + lastSegment.length;

  // Iterate backwards through segments (excluding the first one)
  for (let i = segments.length - 2; i >= 0; i--) {
    const segment = segments[i];
    // Length needed if we add this segment: current + separator + segment
    const lengthWithSegment = currentLength + separator.length + segment.length;

    if (lengthWithSegment <= maxLen) {
      endPartSegments.unshift(segment); // Add to the beginning of the end part
      currentLength = lengthWithSegment;
    } else {
      break;
    }
  }

  let result = endPartSegments.join(separator) + separator + lastSegment;

  if (currentLength > maxLen) {
    return result;
  }

  // Construct the final path
  result = startComponent + separator + result;

  // As a final check, if the result is somehow still too long
  // truncate the result string from the beginning, prefixing with "...".
  if (result.length > maxLen) {
    return '...' + result.substring(result.length - maxLen - 3);
  }

  return result;
}

/**
 * Calculates the relative path from a root directory to a target path.
 * It ensures both paths are resolved before calculating the relative path.
 * If the target path is the same as the root directory, it returns `.`.
 *
 * @param targetPath The absolute or relative path to make relative.
 * @param rootDirectory The absolute path of the directory to make the target path relative to.
 * @returns The relative path from `rootDirectory` to `targetPath`.
 */
export function makeRelative(
  targetPath: string,
  rootDirectory: string,
): string {
  const resolvedTargetPath = path.resolve(targetPath);
  const resolvedRootDirectory = path.resolve(rootDirectory);

  const relativePath = path.relative(resolvedRootDirectory, resolvedTargetPath);

  // If the paths are the same, path.relative returns '', return '.' instead
  return relativePath || '.';
}

/**
 * Escapes special shell characters in a file path to make it safe for use in shell commands.
 * It adds a backslash (`\`) before characters that have special meaning in the shell.
 *
 * @param filePath The file path to escape.
 * @returns The escaped file path.
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
 * Unescapes special shell characters in a file path.
 * It removes the backslash (`\`) from characters that were escaped for shell compatibility.
 *
 * @param filePath The file path to unescape.
 * @returns The unescaped file path.
 */
export function unescapePath(filePath: string): string {
  return filePath.replace(
    new RegExp(`\\\\([${SHELL_SPECIAL_CHARS.source.slice(1, -1)}])`, 'g'),
    '$1',
  );
}

/**
 * Generates a unique SHA256 hash for a project based on its root path.
 * This is used to create unique temporary directories for each project.
 *
 * @param projectRoot The absolute path to the project's root directory.
 * @returns A SHA256 hash of the project root path.
 */
export function getProjectHash(projectRoot: string): string {
  return crypto.createHash('sha256').update(projectRoot).digest('hex');
}

/**
 * Generates a unique temporary directory path for a project, based on a hash of the project's root path.
 * @param projectRoot The absolute path to the project's root directory.
 * @returns The path to the project's temporary directory within the user's Qwen directory.
 */
export function getProjectTempDir(projectRoot: string): string {
  const hash = getProjectHash(projectRoot);
  return path.join(os.homedir(), QWEN_DIR, TMP_DIR_NAME, hash);
}

/**
 * Gets the absolute path to the user-level commands directory within the user's Qwen directory.
 * @returns The path to the user's commands directory.
 */
export function getUserCommandsDir(): string {
  return path.join(os.homedir(), QWEN_DIR, COMMANDS_DIR_NAME);
}

/**
 * Gets the absolute path to the project-level commands directory within the project's Qwen directory.
 * @param projectRoot The absolute path to the project's root directory.
 * @returns The path to the project's commands directory.
 */
export function getProjectCommandsDir(projectRoot: string): string {
  return path.join(projectRoot, QWEN_DIR, COMMANDS_DIR_NAME);
}

/**
 * Checks if a given path is a subpath of another path.
 * This function correctly handles both Windows and POSIX-style paths.
 *
 * @param parentPath The potential parent path.
 * @param childPath The potential child path.
 * @returns `true` if `childPath` is a subpath of `parentPath`, `false` otherwise.
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
