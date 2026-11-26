/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { homedir } from 'node:os';
import { dirname } from 'node:path';

import { getPlatform } from '../../utils/platform.js';
import { isNetworkShapedPath } from '../../utils/pathShape.js';
import { expandTilde } from '../../utils/expandTilde.js';
export { expandTilde };
import type { PermissionAttribution } from '../tool-checkers/checker-reasons.js';

// ============================================================================
// Constants
// ============================================================================

/** Maximum directories to show in formatted lists before truncating */
const MAX_DIRS_TO_LIST = 5;

/** Regex for detecting glob special characters */
const GLOB_PATTERN_REGEX = /[*?[\]{}]/;

/** Windows drive root pattern: C:\ or C:/ */
const WINDOWS_DRIVE_ROOT_REGEX = /^[A-Za-z]:\/?$/;

/** Windows drive direct child: C:\Windows, D:\Users */
const WINDOWS_DRIVE_CHILD_REGEX = /^[A-Za-z]:\/[^/]+$/;

// ============================================================================
// Types
// ============================================================================

/**
 * The type of file operation being validated.
 * Determines which permission rules apply (read is more permissive than write/create).
 */
export type FileOperationType = 'read' | 'write' | 'create';

/**
 * Result of a path permission check.
 */
export type PathCheckResult = {
  allowed: boolean;
  decisionReason?: PermissionAttribution;
};

/**
 * Path check result with the resolved (canonicalized) path included.
 */
export type ResolvedPathCheckResult = PathCheckResult & {
  resolvedPath: string;
};

// ============================================================================
// Directory Formatting
// ============================================================================

/**
 * Format a list of directories for display, truncating if too many.
 * Caps at MAX_DIRS_TO_LIST (5) directories before showing "and N more".
 *
 * @example
 * formatDirectoryList(['/a', '/b']) // => "'/a', '/b'"
 * formatDirectoryList(['/a','/b','/c','/d','/e','/f']) // => "'/a', '/b', '/c', '/d', '/e', and 1 more"
 */
export function formatDirectoryList(directories: string[]): string {
  const dirCount = directories.length;

  if (dirCount <= MAX_DIRS_TO_LIST) {
    return directories.map((dir) => `'${dir}'`).join(', ');
  }

  const firstDirs = directories
    .slice(0, MAX_DIRS_TO_LIST)
    .map((dir) => `'${dir}'`)
    .join(', ');

  return `${firstDirs}, and ${dirCount - MAX_DIRS_TO_LIST} more`;
}

// ============================================================================
// Glob Utilities
// ============================================================================

/**
 * Extracts the base directory from a glob pattern for validation.
 * Everything before the first glob character is treated as the base path.
 *
 * @example
 * getGlobBaseDirectory('/path/to/*.txt')   // => '/path/to'
 * getGlobBaseDirectory('src/**\/*.ts')      // => 'src'
 * getGlobBaseDirectory('*.js')             // => '.'
 * getGlobBaseDirectory('/no/globs/here')   // => '/no/globs/here'
 */
export function getGlobBaseDirectory(path: string): string {
  const globMatch = path.match(GLOB_PATTERN_REGEX);
  if (!globMatch || globMatch.index === undefined) {
    return path;
  }

  // Get everything before the first glob character
  const beforeGlob = path.substring(0, globMatch.index);

  // Find the last directory separator
  const lastSepIndex =
    getPlatform() === 'windows'
      ? Math.max(beforeGlob.lastIndexOf('/'), beforeGlob.lastIndexOf('\\'))
      : beforeGlob.lastIndexOf('/');
  if (lastSepIndex === -1) return '.';

  return beforeGlob.substring(0, lastSepIndex) || '/';
}

/**
 * Test whether a path string contains glob special characters.
 */
export function isGlobPattern(path: string): boolean {
  return GLOB_PATTERN_REGEX.test(path);
}

// ============================================================================
// Tilde Expansion
// ============================================================================


// ============================================================================
// UNC Path Detection
// ============================================================================

/**
 * Detects paths that could reach a remote host, which on Windows discloses the
 * user's NTLM hash during the SMB/WebDAV handshake.
 *
 * @deprecated Use `isNetworkShapedPath` from utils/pathShape.js. This wrapper
 * exists because the symbol is part of the package's public surface.
 *
 * Coverage is wider than the original implementation, which required a
 * non-separator character after the sigil and so missed `\\\\share`, `///x`,
 * mixed sigils, extended UNC (`\\?\UNC\...`) and `/net` automount paths.
 */
export function containsVulnerableUncPath(path: string): boolean {
  return isNetworkShapedPath(path);
}

// ============================================================================
// Path Traversal Detection
// ============================================================================

/**
 * Checks whether a path contains directory traversal sequences (../).
 * Used to detect attempts to escape allowed directories.
 */
export function containsPathTraversal(path: string): boolean {
  // Normalize separators for cross-platform check
  const normalized = path.replace(/\\/g, '/');
  return (
    normalized.includes('../') ||
    normalized.includes('/..') ||
    normalized === '..'
  );
}

// ============================================================================
// Shell Expansion Syntax Detection
// ============================================================================

/**
 * Checks whether a path contains shell expansion syntax that creates TOCTOU
 * vulnerabilities. These are preserved as literal strings during validation
 * but expanded by the shell during execution.
 *
 * Detects:
 * - $VAR, ${VAR}, $(cmd) — Unix environment/command substitution
 * - %VAR% — Windows environment variables
 * - =cmd — Zsh equals expansion (=rg → /usr/bin/rg)
 */
export function containsShellExpansionSyntax(path: string): boolean {
  return path.includes('$') || path.includes('%') || path.startsWith('=');
}

/**
 * Checks whether a path starts with an unsupported tilde variant.
 * expandTilde handles ~ and ~/, but ~user, ~+, ~- etc. create TOCTOU gaps.
 *
 * Should be called AFTER expandTilde — if the path still starts with ~,
 * it's an unexpanded variant that we cannot safely resolve.
 */
export function isUnsupportedTildeVariant(path: string): boolean {
  return path.startsWith('~');
}

// ============================================================================
// Dangerous Removal Path Detection
// ============================================================================

/**
 * Checks if a resolved path is dangerous for removal operations (rm/rmdir).
 *
 * Dangerous paths include:
 * - Wildcard '*' (removes all files in directory)
 * - Any path ending with '/*' or '\*'
 * - Root directory (/)
 * - Home directory (~)
 * - Direct children of root (/usr, /tmp, /etc, etc.)
 * - Windows drive root (C:\, D:\) and direct children (C:\Windows, C:\Users)
 *
 * @example
 * isDangerousRemovalPath('/')           // => true
 * isDangerousRemovalPath('/usr')        // => true
 * isDangerousRemovalPath('C:/')         // => true
 * isDangerousRemovalPath('/usr/local')  // => false
 */
export function isDangerousRemovalPath(resolvedPath: string): boolean {
  // Callers pass both slash forms; collapse runs so C:\\Windows (valid in
  // PowerShell) doesn't bypass the drive-child check.
  const forwardSlashed = resolvedPath.replace(/[\\/]+/g, '/');

  if (forwardSlashed === '*' || forwardSlashed.endsWith('/*')) {
    return true;
  }

  const normalizedPath =
    forwardSlashed === '/' ? forwardSlashed : forwardSlashed.replace(/\/$/, '');

  if (normalizedPath === '/') {
    return true;
  }

  if (WINDOWS_DRIVE_ROOT_REGEX.test(normalizedPath)) {
    return true;
  }

  const normalizedHome = homedir().replace(/[\\/]+/g, '/');
  if (normalizedPath === normalizedHome) {
    return true;
  }

  // Direct children of root: /usr, /tmp, /etc (but not /usr/local)
  const parentDir = dirname(normalizedPath);
  if (parentDir === '/') {
    return true;
  }

  if (WINDOWS_DRIVE_CHILD_REGEX.test(normalizedPath)) {
    return true;
  }

  return false;
}
