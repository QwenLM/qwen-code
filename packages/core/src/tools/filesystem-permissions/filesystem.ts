/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import ignore from 'ignore';
import { lstatSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, posix } from 'node:path';
import {
  classifyPathShape,
  isFsTouchUnsafePath,
  isLocallySuspiciousPath,
  isNetworkPathEnforced,
  isNetworkShapedPath,
} from '../../utils/pathShape.js';
import {
  PermissionModes,
  permissionRuleValueFromString,
  toolNameMatchesRule,
  type PermissionBehavior,
  type PermissionRule,
  type PermissionRuleSource,
} from '../../permissions/manager/decision/index.js';
import {
  createReadRuleSuggestion,
  type PathPermissionContext,
  type PermissionUpdate,
} from '../tool-checkers/checker-reasons.js';
import {
  applyManagedRuleResult,
  checkManagedContentRules,
  checkManagedToolRules,
  type ToolPermissionResult,
} from '../tool-checkers/rule-precedence.js';
import { expandTilde } from './pathValidation.js';
import {
  EDIT_TOOL_NAME,
  NOTEBOOK_EDIT_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
} from '../tool-names.js';
import { expandPath, resolveToRealPath } from '../../utils/paths.js';
import { getPlatform } from '../../utils/platform.js';
import { toPosixPath } from './pathRules.js';
import {
  checkEditableInternalPath,
  checkReadableInternalPath,
  isProjectInternalPath,
  isSessionPlanFile,
} from './internalPaths.js';
import { isAutoMemoryPath } from './filesystem-helpers.js';
import { qwenInternalPathDeps } from './internal-path-deps.js';

// ============================================================================
// Constants
// ============================================================================

/**
 * Files that should be protected from auto-editing because they can
 * enable code execution or data exfiltration when modified.
 *
 * Security rationale:
 * - Shell configs (.bashrc, .zshrc, etc.) execute on shell start
 * - Git configs (.gitconfig, .gitmodules) can execute hooks and redirect
 * - Ripgrep config can influence tool behavior
 * - MCP/project configs can redirect tool execution
 */
export const DANGEROUS_FILES = [
  '.gitconfig',
  '.gitmodules',
  '.bashrc',
  '.bash_profile',
  '.zshrc',
  '.zprofile',
  '.profile',
  '.ripgreprc',
  '.mcp.json',
] as const;

/**
 * Directories that should be protected from auto-editing.
 * Editing files within these directories could compromise security.
 *
 * - .git: hooks, config, objects manipulation
 * - .vscode/.idea: launch configs, tasks, debugger settings
 * - .husky: git hooks
 * - The configured project directory: project configuration and settings
 */
export const DANGEROUS_DIRECTORIES = [
  '.git',
  '.vscode',
  '.idea',
  '.husky',
  '.qwen',
] as const;

/**
 * The project configuration directory name.
 * Shared Core default; checks use the injected project configuration path.
 * Used for permission checks involving project-level settings.
 */
export const PROJECT_CONFIG_DIR_NAME = '.qwen';

/**
 * Subdirectories under the configured project directory that are
 * user/project-extensible and safe to edit without treating the whole config
 * directory as protected.
 */
export const SAFE_CONFIG_SUBDIRS = [
  'commands',
  'agents',
  'skills',
  'worktrees',
] as const;

/**
 * Config subdirectories whose definitions can carry hooks, allowed-tools,
 * inline MCP servers or a permission mode. Exempt from the protected-path
 * prompt, but auto mode still sends their writes to the classifier.
 */
const AUTO_REVIEWED_CONFIG_SUBDIRS: ReadonlySet<string> = new Set([
  'commands',
  'agents',
  'skills',
]);

export function isAutoReviewedConfigPath(
  expandedPath: string,
  internalPaths = qwenInternalPathDeps.resolve({ cwd: process.cwd() }),
): boolean {
  const segments = toPosixPath(expandedPath).split('/').filter(Boolean);
  const configDir = internalPaths.projectConfigDir
    ? posix.basename(toPosixPath(internalPaths.projectConfigDir)).toLowerCase()
    : undefined;
  for (let i = 0; i < segments.length - 2; i++) {
    if (
      segments[i].toLowerCase() === configDir &&
      AUTO_REVIEWED_CONFIG_SUBDIRS.has(segments[i + 1].toLowerCase())
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Internal project directory name.
 * The project-local internal files live under the same .qwen directory name
 * as project configuration files. The actual allow-list and matching logic
 * lives in internalPaths.ts (isProjectInternalPath).
 */
export const INTERNAL_DIR_NAME = '.qwen';

/**
 * Always use POSIX separator for gitignore-style pattern matching.
 */
const DIR_SEP = posix.sep;

/** Matches POSIX-style Windows drive paths like `/c/` or `/D/`. */
const POSIX_DRIVE_PATH_RE = /^\/[a-z]\//i;

/**
 * Normalized global plans directory prefix for plan-file detection.
 * Lazy-initialized: getConfigHomeDir() reads env vars at call time.
 */
// ============================================================================
// Path Normalization
// ============================================================================

/**
 * Normalizes a path to lowercase for case-insensitive comparison.
 * Always lowercases regardless of platform to prevent mixed-case bypasses.
 */
export function normalizeCaseForComparison(path: string): string {
  return path.toLowerCase();
}

export { toPosixPath } from './pathRules.js';

function resolvePermissionPath(inputPath: string, cwd?: string): string {
  const expandedPath = toPosixPath(expandTilde(inputPath));

  // SECURITY: posix.resolve collapses `//srv/share` to `/srv/share` and mangles
  // device-namespace prefixes, either of which would hide the real shape from
  // every check downstream. Leave such paths unanchored.
  if (
    !cwd ||
    isFsTouchUnsafePath(expandedPath) ||
    posix.isAbsolute(expandedPath)
  ) {
    return expandedPath;
  }

  return posix.resolve(toPosixPath(expandTilde(cwd)), expandedPath);
}

const _cwdExistsCache = new Map<string, boolean>();

function cwdExistsOnDisk(cwd?: string): boolean {
  if (!cwd) {
    return true;
  }

  const key = resolvePermissionPath(cwd);
  const cached = _cwdExistsCache.get(key);
  if (cached !== undefined) {
    return cached;
  }

  let result: boolean;
  try {
    lstatSync(key);
    result = true;
  } catch {
    result = false;
  }
  _cwdExistsCache.set(key, result);
  return result;
}

/**
 * Computes a relative path from `from` to `to` using POSIX conventions.
 * Always returns forward-slash paths regardless of platform.
 */
export function relativePath(from: string, to: string): string {
  return posix.relative(toPosixPath(from), toPosixPath(to));
}

// ============================================================================
// Dangerous File/Directory Detection
// ============================================================================

/** Pre-computed lowercase sets for O(1) dangerous-name lookups. */
const DANGEROUS_FILES_LOWER = new Set(
  DANGEROUS_FILES.map((f) => f.toLowerCase()),
);
const DANGEROUS_DIRS_LOWER = new Set(
  DANGEROUS_DIRECTORIES.map((d) => d.toLowerCase()),
);

/**
 * Checks if a filename matches a known dangerous file.
 * Case-insensitive comparison to prevent bypasses like ".BaShRc".
 */
export function isDangerousFileName(filename: string): boolean {
  return DANGEROUS_FILES_LOWER.has(filename.toLowerCase());
}

/**
 * Checks if a directory segment matches a known dangerous directory.
 * Case-insensitive. Has a special carve-out for worktree subdirectories.
 */
export function isDangerousDirectorySegment(
  segment: string,
  internalPaths = qwenInternalPathDeps.resolve({ cwd: process.cwd() }),
): boolean {
  const configDir = internalPaths.projectConfigDir
    ? posix.basename(toPosixPath(internalPaths.projectConfigDir)).toLowerCase()
    : undefined;
  return (
    (DANGEROUS_DIRS_LOWER.has(segment.toLowerCase()) &&
      segment.toLowerCase() !== '.qwen') ||
    segment.toLowerCase() === configDir
  );
}

/**
 * Checks if a file path points to a dangerous location for auto-editing.
 * Walks the path segments looking for:
 * 1. Dangerous directory names (with a project config worktrees carve-out)
 * 2. Dangerous filenames at the leaf position
 *
 * @param expandedPath The fully-expanded, absolute path to check
 */
export function isDangerousFilePathToAutoEdit(
  expandedPath: string,
  internalPaths = qwenInternalPathDeps.resolve({ cwd: process.cwd() }),
): boolean {
  const posixPath = toPosixPath(expandedPath);
  if (isAutoMemoryPath(posixPath, internalPaths)) {
    return false;
  }

  const segments = posixPath.split('/').filter(Boolean);

  // Check each segment for dangerous directories
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];

    if (isDangerousDirectorySegment(segment, internalPaths)) {
      if (
        segment.toLowerCase() ===
        (internalPaths.projectConfigDir
          ? posix
              .basename(toPosixPath(internalPaths.projectConfigDir))
              .toLowerCase()
          : undefined)
      ) {
        // Carve-outs: user/project-extensible content under the configured
        // project directory is safe to edit without treating the whole config
        // directory as protected.
        if (
          (SAFE_CONFIG_SUBDIRS as readonly string[]).includes(
            segments[i + 1]?.toLowerCase() ?? '',
          )
        ) {
          continue;
        }
      }

      // If this dangerous directory is not the last segment, the path
      // is within a dangerous directory
      if (i < segments.length - 1) {
        return true;
      }
    }
  }

  // Check the filename (last segment) against dangerous files
  const filename = segments[segments.length - 1];
  if (filename && isDangerousFileName(filename)) {
    return true;
  }

  return false;
}

// ============================================================================
// Windows Path Safety
// ============================================================================

/**
 * Checks for Windows path spellings that defeat path comparison, so a
 * name-based allow or deny list can be walked around.
 *
 * @deprecated Use `isLocallySuspiciousPath` from utils/pathShape.js. This
 * wrapper exists because the symbol is part of the package's public surface.
 *
 * Coverage differs from the original implementation in both directions:
 * `\\?\C:\x` and `//?/C:/x` are now recognized as local extended-length paths
 * rather than suspicious, while trailing dots and spaces, three or more
 * consecutive dots, reserved device names and the `\??\` prefix are newly
 * covered.
 */
export function hasSuspiciousWindowsPathPattern(path: string): boolean {
  return isLocallySuspiciousPath(path);
}

// ============================================================================
// Symlink Resolution and Path Security
// ============================================================================

/**
 * Resolves a file path to its real (symlink-resolved) path.
 * Returns both the original expanded path and the resolved path.
 *
 * This prevents symlink-based path traversal attacks where an attacker
 * creates a symlink inside the working directory that points to a
 * sensitive location outside of it.
 *
 * For non-existent files (common for write operations), resolves the nearest
 * existing ancestor and appends the unresolved tail. This handles writes under
 * symlinked directories even when deeper child directories do not exist yet.
 *
 * @param inputPath The file path to resolve
 * @param cwd The working directory used to resolve relative paths
 * @returns Array of paths to check: [expandedOriginal, resolvedReal?]
 *          Returns a single-element array if no symlink is involved
 */
export function getPathsForPermissionCheck(
  inputPath: string,
  cwd?: string,
): string[] {
  const expandedPath = resolvePermissionPath(inputPath, cwd);
  const paths = [expandedPath];

  // SECURITY: the realpath call below is itself the attack for these shapes —
  // resolving a network path performs the NTLM handshake. Skip it.
  if (isFsTouchUnsafePath(expandedPath)) {
    return paths;
  }

  // Unit tests and some pure permission callers use virtual cwd strings.
  // Preserve string-only behavior in that case instead of canonicalizing
  // nonexistent roots against the host filesystem.
  if (!cwdExistsOnDisk(cwd)) {
    return paths;
  }

  try {
    const realPath = toPosixPath(resolveToRealPath(expandedPath));
    if (
      normalizeCaseForComparison(realPath) !==
      normalizeCaseForComparison(expandedPath)
    ) {
      paths.push(realPath);
    }
  } catch {
    // Nothing to resolve. Permission checks still evaluate the expanded path.
  }

  return paths;
}

/**
 * Checks if a path is a symlink (does not follow the link).
 * Returns false for non-existent paths or on any error.
 */
export function isSymlink(filePath: string): boolean {
  try {
    const stat = lstatSync(filePath);
    return stat.isSymbolicLink();
  } catch {
    return false;
  }
}

// ============================================================================
// Public utility · attachment-channel deny-rule guard
// ============================================================================

/**
 * Returns true when the given file path is denied by the user's read-deny
 * rules in the current permission context.
 *
 * Designed for the Attachment预读 channel (file-generators):
 * generators short-circuit normally bypass the permission pipeline; calling
 * this guard lets them honor the user's `Read(...)` deny rules without
 * routing through the full pipeline.
 */
export function isFileReadDenied(
  inputPath: string,
  context: PathPermissionContext,
  cwd: string,
): boolean {
  // SECURITY: the attachment channel pre-reads files without going through
  // checkPermissions, so there is no prompt to fall back on. On Windows
  // (where enforcement applies) a network path must be refused outright here
  // — the ask that covers the read tool cannot reach this path.
  if (isNetworkPathEnforced() && isNetworkShapedPath(inputPath)) {
    return true;
  }
  // Pre-reads cannot ask. Leave a managed ask for an explicit Read call.
  if (checkManagedReadPaths([inputPath], context, cwd)) return true;
  const resolved = resolvePermissionPath(inputPath, cwd);
  return matchingRuleForInput(resolved, context, 'read', 'deny', cwd) !== null;
}

// ============================================================================
// Public utility · search-result deny filter
// ============================================================================

/**
 * Builds a per-file predicate for directory-level search tools (Glob/Grep)
 * that returns true when a file is hit by the user's Read deny rules.
 *
 * This is a result filter, not a permission decision: the directory-level
 * search itself stays allowed (checkPermissions is untouched); only entries
 * that a direct Read would deny are dropped from the results. Matching is
 * delegated to matchingRuleForInput so hidden entries track the direct-Read
 * deny verdict exactly. Only deny rules feed this filter — ask rules are
 * interactive decisions and must not silently shrink search results.
 *
 * Returns undefined when no Read deny rule exists so callers skip per-file
 * matching entirely on the common no-deny hot path.
 *
 * @param context The permission context (may be undefined before setup)
 * @param cwd The working directory used to resolve relative rule patterns
 */
export function createReadDenyResultFilter(
  context: PathPermissionContext | undefined,
  cwd: string,
): ((filePath: string) => boolean) | undefined {
  if (!context) return undefined;

  // Short-circuit: materialize the rule set once just to detect presence,
  // avoiding per-file matching cost when no read-deny rule is configured.
  let hasDenyRules = false;
  for (const patternMap of getPatternsByRoot(
    context,
    'read',
    'deny',
    cwd,
  ).values()) {
    if (patternMap.size > 0) {
      hasDenyRules = true;
      break;
    }
  }
  const managedContext = {
    ...context,
    globalRules: {
      deny: (context.globalRules?.deny ?? []).filter((rule) =>
        toolNameMatchesRule(
          READ_FILE_TOOL_NAME,
          permissionRuleValueFromString(rule).toolName,
        ),
      ),
      ask: [],
    },
  };
  if (!hasDenyRules && !managedContext.globalRules.deny.length)
    return undefined;

  return (filePath: string) =>
    matchingRuleForInput(filePath, context, 'read', 'deny', cwd) !== null ||
    checkManagedReadPaths([filePath], managedContext, cwd)?.kind === 'deny';
}


// ============================================================================
// Internal Path Exemptions
// ============================================================================

/**
 * Checks if a file path is within the internal project directory (.qwen/).
 * Files in this directory get special permission exemptions because they are
 * internal tool state files (todo, memory).
 *
 * Implementation delegates to the modular internalPaths sub-domain for the
 * project-internal allowance. Future runtime self-managed paths will be
 * registered as additional sub-domains in internalPaths.ts.
 *
 * @param filePath The expanded, absolute file path to check
 * @param cwd The current working directory (project root)
 * @returns true if the path is an allowed internal path
 */
export function isInternalPath(
  filePath: string,
  cwd: string,
  internalPaths = qwenInternalPathDeps.resolve({ cwd }),
): boolean {
  return isProjectInternalPath(filePath, cwd, internalPaths);
}

/**
 * Returns true if filePath is a .md file inside the global plans directory.
 *
 * MUST be checked before isDangerousFilePathToAutoEdit: the plans path may sit
 * inside a user config root that is also a DANGEROUS_DIRECTORY.
 */
export function isPlanFile(
  filePath: string,
  internalPaths = qwenInternalPathDeps.resolve({ cwd: process.cwd() }),
): boolean {
  return isSessionPlanFile(filePath, internalPaths);
}

// ============================================================================
// Path Safety for Auto-Edit
// ============================================================================

/**
 * Result of a path safety check for auto-editing.
 */
export type PathSafetyResult =
  | { safe: true }
  | {
      safe: false;
      message: string;
      safetyCheckKind?: 'protectedPath';
      /** Whether the AI classifier can approve this instead of hard-blocking */
      classifierApprovable: boolean;
    };

/**
 * Comprehensive safety check for auto-editing a file path.
 *
 * Checks (in order):
 * 1. Suspicious Windows path patterns (hard block)
 * 2. Dangerous file/directory paths (classifier-approvable)
 *
 * NOTE: Full implementation would also check symlink resolution and
 * project config paths. Those checks require runtime I/O.
 *
 * @param inputPath The path to check
 * @param pathsToCheck Optional pre-resolved paths (original + symlink-resolved).
 *                     If not provided, only the input path is checked.
 */
export function checkPathSafetyForAutoEdit(
  inputPath: string,
  pathsToCheck?: readonly string[],
  internalPaths = qwenInternalPathDeps.resolve({ cwd: process.cwd() }),
): PathSafetyResult {
  const paths = pathsToCheck ?? [inputPath];

  for (const pathToCheck of paths) {
    // 1. Suspicious Windows path patterns
    if (hasSuspiciousWindowsPathPattern(pathToCheck)) {
      return {
        safe: false,
        message: `This path uses suspicious Windows path syntax that could bypass security checks: ${pathToCheck}. Please use a standard path format.`,
        classifierApprovable: false,
      };
    }

    // 2. Dangerous file/directory check
    if (isDangerousFilePathToAutoEdit(pathToCheck, internalPaths)) {
      return {
        safe: false,
        message: `This file path is sensitive and requires explicit approval: ${pathToCheck}`,
        safetyCheckKind: 'protectedPath',
        classifierApprovable: true,
      };
    }
  }

  return { safe: true };
}

// ============================================================================
// Working Directory Checks
// ============================================================================

/**
 * Returns the set of all working directories from the permission context.
 * Includes the provided CWD and all additional working directories.
 *
 * @param context The permission context
 * @param cwd The current working directory
 */
export function allWorkingDirectories(
  context: PathPermissionContext,
  cwd: string,
): Set<string> {
  const dirs = new Set<string>();
  dirs.add(cwd);
  for (const dir of context.additionalDirectories) {
    dirs.add(dir);
  }
  return dirs;
}

/**
 * Core containment check: is `path` inside `workingPath`?
 *
 * Handles:
 * - macOS symlink normalization (/private/var, /private/tmp)
 * - Case-insensitive comparison
 * - Path traversal detection via relative path computation
 *
 * @param inputPath The path to check
 * @param workingPath The working directory to check against
 */
export function pathInWorkingPath(
  inputPath: string,
  workingPath: string,
): boolean {
  let expandedInput = toPosixPath(expandTilde(inputPath));
  let expandedWork = toPosixPath(expandTilde(workingPath));

  // Resolve relative paths against the working directory before comparison.
  // Without this, posix.relative() resolves relative inputs against
  // process.cwd() which on macOS returns /private/tmp/... while
  // normalizeMacOSPath converts workingPath to /tmp/..., causing mismatch.
  if (!posix.isAbsolute(expandedInput)) {
    expandedInput = posix.resolve(expandedWork, expandedInput);
  }

  // Normalize macOS /private/var and /private/tmp symlinks
  expandedInput = normalizeMacOSPath(expandedInput);
  expandedWork = normalizeMacOSPath(expandedWork);

  // Case-insensitive comparison
  const normalizedInput = normalizeCaseForComparison(expandedInput);
  const normalizedWork = normalizeCaseForComparison(expandedWork);

  // Same path
  if (normalizedInput === normalizedWork) {
    return true;
  }

  // Compute relative path and check for traversal
  const rel = posix.relative(normalizedWork, normalizedInput);
  if (!rel) {
    return true; // empty relative = same path
  }

  // If relative path traverses to a true parent directory or is absolute,
  // path escapes working dir. Only '..' or '../...' indicates traversal;
  // a segment like '..cache' is a legitimate directory name, not traversal.
  return rel !== '..' && !rel.startsWith('../') && !posix.isAbsolute(rel);
}

/**
 * Checks if a path is within any of the allowed working directories.
 *
 * @param inputPath The path to check
 * @param context The permission context
 * @param cwd The current working directory
 */
export function pathInAllowedWorkingPath(
  inputPath: string,
  context: PathPermissionContext,
  cwd: string,
): boolean {
  const workDirs = allWorkingDirectories(context, cwd);
  for (const workDir of workDirs) {
    if (pathInWorkingPath(inputPath, workDir)) {
      return true;
    }
  }
  return false;
}

/**
 * Normalizes macOS-specific symlinked paths.
 * /private/var → /var, /private/tmp → /tmp
 */
function normalizeMacOSPath(path: string): string {
  if (path.startsWith('/private/var/')) {
    return path.slice('/private'.length);
  }
  if (path.startsWith('/private/tmp/')) {
    return path.slice('/private'.length);
  }
  if (path === '/private/var') {
    return '/var';
  }
  if (path === '/private/tmp') {
    return '/tmp';
  }
  return path;
}

// ============================================================================
// gitignore-Style Rule Matching
// ============================================================================

/**
 * Prepends the directory separator to a path for gitignore matching.
 */
function prependDirSep(path: string): string {
  return DIR_SEP + path;
}

/**
 * Determines the root path for a permission rule source.
 *
 * - userSettings: home directory
 * - projectSettings/localSettings: CWD (project root)
 * - Others: CWD as fallback
 *
 * @param source The rule source
 * @param cwd The current working directory
 */
export function rootPathForSource(
  source: PermissionRuleSource,
  cwd: string,
): string {
  switch (source) {
    case 'userSettings':
      return homedir();
    case 'projectSettings':
    case 'localSettings':
      return cwd;
    default:
      return cwd;
  }
}

/**
 * Resolves a pattern's root and relative form based on its prefix.
 *
 * Pattern conventions:
 * - "//path" → absolute path (root = "/")
 * - "~/path" → relative to home directory
 * - "/path"  → relative to the source's root directory
 * - "path"   → rootless pattern (matches anywhere)
 *
 * @returns { relativePattern, root } where root is null for rootless patterns
 */
export function patternWithRoot(
  pattern: string,
  source: PermissionRuleSource,
  cwd: string,
): { relativePattern: string; root: string | null } {
  return patternWithBaseRoot(pattern, rootPathForSource(source, cwd));
}

/** The same path syntax with an explicit root, including policies without a local source. */
function patternWithBaseRoot(
  pattern: string,
  baseRoot: string,
): { relativePattern: string; root: string | null } {
  // Double-slash: absolute path
  if (pattern.startsWith('//')) {
    const patternWithoutDoubleSlash = pattern.slice(1);

    // On Windows, detect POSIX-style drive paths (//c/Users/...) vs UNC paths (//server/share)
    if (
      getPlatform() === 'windows' &&
      POSIX_DRIVE_PATH_RE.test(patternWithoutDoubleSlash)
    ) {
      const driveLetter = patternWithoutDoubleSlash[1].toUpperCase();
      const driveRoot = `${driveLetter}:\\`;
      // Pattern is /c/path/..., slice(2) gives /path/..., slice(3) gives path/...
      const relativeFromDrive = patternWithoutDoubleSlash.slice(3);

      return {
        relativePattern: relativeFromDrive,
        root: driveRoot,
      };
    }

    return {
      relativePattern: patternWithoutDoubleSlash,
      root: '/',
    };
  }

  // Home directory prefix
  if (pattern.startsWith('~/')) {
    return {
      relativePattern: prependDirSep(pattern.slice(2)),
      root: homedir(),
    };
  }

  // Rooted pattern (single leading slash)
  if (pattern.startsWith('/')) {
    return {
      relativePattern: pattern,
      root: baseRoot,
    };
  }

  // Rootless pattern (matches from any root)
  return {
    relativePattern: prependDirSep(pattern),
    root: null,
  };
}

/**
 * Normalizes a pattern relative to a target root path.
 * Used when checking against a specific root.
 *
 * @returns The normalized pattern string, or null if the pattern's root
 *          doesn't match the target root path.
 */
export function normalizePatternToPath(opts: {
  patternRoot: string | null;
  pattern: string;
  rootPath: string;
}): string | null {
  const { patternRoot, pattern, rootPath } = opts;

  // Rootless patterns always match
  if (patternRoot === null) {
    return pattern;
  }

  const patternRootPosix = toPosixPath(patternRoot);
  const rootPathPosix = toPosixPath(rootPath);

  // If pattern root matches target root, use pattern as-is
  if (
    normalizeCaseForComparison(patternRootPosix) ===
    normalizeCaseForComparison(rootPathPosix)
  ) {
    return pattern;
  }

  // If pattern root is within target root, adjust
  const rel = posix.relative(rootPathPosix, patternRootPosix);
  if (!rel.startsWith('..') && !posix.isAbsolute(rel)) {
    return prependDirSep(posix.join(rel, pattern.replace(/^\//, '')));
  }

  // If target root is within pattern root, adjust
  const rel2 = posix.relative(patternRootPosix, rootPathPosix);
  if (!rel2.startsWith('..') && !posix.isAbsolute(rel2)) {
    const adjustedPattern = posix.relative(prependDirSep(rel2), pattern);
    if (!adjustedPattern.startsWith('..')) {
      return prependDirSep(adjustedPattern);
    }
  }

  return null;
}

/**
 * Normalizes a set of patterns to match against a specific root path.
 */
export function normalizePatternsToPath(
  patternsByRoot: Map<string | null, string[]>,
  root: string,
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();

  for (const [patternRoot, patterns] of patternsByRoot) {
    for (const pattern of patterns) {
      const normalized = normalizePatternToPath({
        patternRoot,
        pattern,
        rootPath: root,
      });
      if (normalized !== null && !seen.has(normalized)) {
        seen.add(normalized);
        result.push(normalized);
      }
    }
  }

  return result;
}

/**
 * Extracts permission rules from context and organizes them by root path.
 *
 * @param context The permission context
 * @param toolType 'edit' for write tools, 'read' for read tools
 * @param behavior Which rule behavior to extract
 * @param cwd The current working directory
 * @returns Map from root path (or null) to Map of pattern → PermissionRule
 */
export function getPatternsByRoot(
  context: PathPermissionContext,
  toolType: 'edit' | 'read',
  behavior: PermissionBehavior,
  cwd: string,
): Map<string | null, Map<string, PermissionRule>> {
  const toolName = toolType === 'edit' ? EDIT_TOOL_NAME : READ_FILE_TOOL_NAME;

  const result = new Map<string | null, Map<string, PermissionRule>>();

  const rulesBySource = context.rules[behavior];
  for (const [source, ruleStrings] of Object.entries(rulesBySource)) {
    if (!ruleStrings) continue;
    const ruleSource = source as PermissionRuleSource;

    for (const ruleString of ruleStrings) {
      const parsed = permissionRuleValueFromString(ruleString);

      // Only include rules that match the target tool
      // Also include tool-wide rules (no content) that match the tool
      if (parsed.toolName !== toolName) continue;

      // Tool-wide rules (no content) don't participate in pattern matching
      if (!parsed.ruleContent) continue;

      const { relativePattern, root } = patternWithRoot(
        parsed.ruleContent,
        ruleSource,
        cwd,
      );

      if (!result.has(root)) {
        result.set(root, new Map());
      }

      const rule: PermissionRule = {
        source: ruleSource,
        ruleBehavior: behavior,
        ruleValue: parsed,
      };

      result.get(root)!.set(relativePattern, rule);
    }
  }

  return result;
}

/**
 * Finds a matching permission rule for a file path using gitignore-style matching.
 *
 * Uses the `ignore` library (gitignore spec) for pattern matching.
 * The `ignore` library requires patterns without trailing `/**` for directory matching.
 *
 * @param inputPath The file path to check
 * @param context The permission context
 * @param toolType 'edit' or 'read'
 * @param behavior The rule behavior to check
 * @param cwd The current working directory
 * @returns The matching PermissionRule, or null if no match
 */
export function matchingRuleForInput(
  inputPath: string,
  context: PathPermissionContext,
  toolType: 'edit' | 'read',
  behavior: PermissionBehavior,
  cwd: string,
): PermissionRule | null {
  const expandedPath = resolvePermissionPath(inputPath, cwd);
  const patternsByRoot = getPatternsByRoot(context, toolType, behavior, cwd);
  return matchingPathPattern(expandedPath, patternsByRoot);
}

function matchingPathPattern<T>(
  expandedPath: string,
  patternsByRoot: ReadonlyMap<string | null, ReadonlyMap<string, T>>,
): T | null {
  for (const [root, patternMap] of patternsByRoot) {
    if (patternMap.size === 0) continue;

    // Compute the relative path from the root
    let targetPath: string;
    if (root === null) {
      const lastSlash = expandedPath.lastIndexOf('/');
      targetPath =
        lastSlash >= 0 ? expandedPath.slice(lastSlash + 1) : expandedPath;
    } else {
      const rel = relativePath(root, expandedPath);
      if (rel.startsWith('..') || posix.isAbsolute(rel)) {
        continue; // Path is not under this root
      }
      targetPath = rel;
    }

    // Normalize target path for ignore matching
    const normalizedTarget = prependDirSep(targetPath);
    const matchTarget = normalizedTarget.slice(1);

    // The input IS the rule root itself: the ignore library throws on an
    // empty path. Only a pattern covering the root itself (e.g. `Read(/**)`)
    // can match here — anything else points below the root.
    if (matchTarget === '') {
      for (const [pattern, rule] of patternMap) {
        const stripped = pattern.endsWith('/**') ? pattern.slice(0, -3) : pattern;
        if (stripped === '' || stripped === '/' || stripped === '.') {
          return rule;
        }
      }
      continue;
    }

    // Build the ignore instance and test
    const ig = ignore();
    const patterns: string[] = [];
    const patternToRule = new Map<string, T>();

    for (const [pattern, rule] of patternMap) {
      // The ignore library handles /** automatically for directory matching
      // Strip trailing /** for the ignore library, then add back for lookup
      let ignorePattern = pattern;
      if (ignorePattern.endsWith('/**')) {
        ignorePattern = ignorePattern.slice(0, -3);
      }
      patterns.push(ignorePattern);
      patternToRule.set(ignorePattern, rule);
    }

    ig.add(patterns);

    if (ig.ignores(normalizedTarget.slice(1))) {
      // Find which pattern matched — return the first match
      for (const [pattern, rule] of patternToRule) {
        const singleIg = ignore().add(pattern);
        if (singleIg.ignores(normalizedTarget.slice(1))) {
          return rule;
        }
      }
    }
  }

  return null;
}

// ============================================================================
// Permission Check Pipelines
// ============================================================================

/** Managed single-slash patterns use the session cwd, without inventing a local source. */
function checkManagedPathRules(
  paths: readonly string[],
  context: PathPermissionContext,
  toolType: 'read' | 'edit',
  cwd: string,
): ToolPermissionResult | undefined {
  const toolName = toolType === 'read' ? READ_FILE_TOOL_NAME : EDIT_TOOL_NAME;
  return checkManagedContentRules(toolName, context.globalRules, (content) => {
    const { root, relativePattern } = patternWithBaseRoot(content, cwd);
    // The ignore matcher strips trailing /**. Preserve an entire managed root
    // here, including the root itself, without changing local pattern behavior.
    if (root !== null && relativePattern === '/**') {
      return paths.some((path) => {
        const relative = relativePath(root, path);
        return (
          relative !== '..' &&
          !relative.startsWith('../') &&
          !posix.isAbsolute(relative)
        );
      });
    }
    if (root === null && relativePattern.indexOf('/', 1) !== -1) {
      // Rootless directory rules match at any depth, using the full path.
      // Keep the existing basename matcher for local rules and file patterns.
      const pattern = relativePattern.slice(1).replace(/\/\*\*$/, '');
      const matcher = ignore().add(
        pattern.startsWith('**/') ? pattern : `**/${pattern}`,
      );
      return paths.some((p) => {
        const target = toPosixPath(p).replace(/^\/+/, '');
        return target !== '' && matcher.ignores(target);
      });
    }
    const patterns = new Map([[root, new Map([[relativePattern, true]])]]);
    return paths.some((p) => matchingPathPattern(p, patterns) !== null);
  });
}

/** Managed read constraints for channels that do not use the Read tool. */
export function checkManagedReadPaths(
  inputPaths: readonly string[],
  context: PathPermissionContext,
  cwd: string,
): ToolPermissionResult | undefined {
  if (
    !context.globalRules ||
    (!context.globalRules.deny.length && !context.globalRules.ask.length)
  )
    return undefined;
  const tool = checkManagedToolRules(READ_FILE_TOOL_NAME, context.globalRules);
  if (tool?.kind === 'deny') return tool;
  const content = checkManagedPathRules(
    inputPaths.flatMap((path) => getPathsForPermissionCheck(path, cwd)),
    context,
    'read',
    cwd,
  );
  return content
    ? applyManagedRuleResult(content, tool, PermissionModes.Default)
    : tool;
}

// ============================================================================
// SDK memory root boundary
// ============================================================================

/** A memory root an SDK host registered for this session. */
export interface SdkMemoryRoot {
  path: string;
  access: 'read-only' | 'read-write';
}

/**
 * Keeps access through an SDK-registered memory root inside that root, and
 * enforces the root's access mode on writes. Returns null when no registered
 * root claims the input path.
 */
export function checkSdkMemoryRootBoundary(
  pathsToCheck: readonly string[],
  sdkMemoryRoots: readonly SdkMemoryRoot[] | undefined,
  operation: 'read' | 'edit',
): ToolPermissionResult | null {
  if (!sdkMemoryRoots || sdkMemoryRoots.length === 0) return null;

  const escapesRoot = (relative: string) =>
    relative === '..' || relative.startsWith('../') || posix.isAbsolute(relative);
  const isWithinRoot = (rootPath: string, candidate: string) =>
    !escapesRoot(relativePath(rootPath, candidate));
  const inputPath = pathsToCheck[0];
  const root = sdkMemoryRoots.find(({ path: rootPath }) => {
    const rootPaths = getPathsForPermissionCheck(rootPath);
    return rootPaths.some((candidateRoot) =>
      isWithinRoot(candidateRoot, inputPath),
    );
  });
  if (!root) return null;

  const denyBoundary = (
    decisionPoint: string,
    message: string,
    reason: string,
  ): ToolPermissionResult => ({
    kind: 'deny',
    extra: {
      decisionPoint,
      denialReason: {
        message,
        attribution: { type: 'other', reason },
        denialKind: 'permission-rule',
        decisionPoint,
      },
    },
  });

  if (operation === 'edit' && root.access !== 'read-write') {
    return denyBoundary(
      'fs_write.sdk_memory_readonly.deny',
      `Writing to this SDK memory root is not allowed: ${inputPath}`,
      'SDK memory root is read-only',
    );
  }

  // Compare both the caller-visible root and its real path. On macOS `/tmp`
  // resolves to `/private/tmp`; treating those aliases as different roots
  // blocks legitimate memory access. Requiring every candidate path to stay
  // under one of the equivalent root paths still rejects symlinks that escape
  // the registered root.
  const rootPaths = getPathsForPermissionCheck(root.path);
  const escaped = pathsToCheck.some(
    (candidate) =>
      !rootPaths.some((candidateRoot) =>
        isWithinRoot(candidateRoot, candidate),
      ),
  );
  if (!escaped) return null;

  return denyBoundary(
    `fs_${operation === 'edit' ? 'write' : 'read'}.sdk_memory_root_escape.deny`,
    `Access through an SDK memory root cannot escape that root: ${inputPath}`,
    'Path resolves outside SDK memory root',
  );
}

/**
 * Checks read permission for a file path.
 *
 * Pipeline order:
 * 1. Network-shaped paths and device namespaces → ask (Windows only)
 * 2. Comparison-defeating Windows spellings → ask (defense in depth)
 * 3. Check deny rules
 * 4. Check ask rules
 * 5. Edit-implies-read (full write pipeline → allow)
 * 6. Allow reads in working directories (symlink traversal → ask)
 * 7. InternalPaths read-domain fast-path (after working-dir)
 * 8. Check allow rules
 * 9. Default to ask
 *
 * @param inputPath The file path to read
 * @param context The permission context
 * @param cwd The current working directory
 * @returns Permission decision
 */
export function checkReadPermissionForPath(
  inputPath: string,
  context: PathPermissionContext,
  cwd: string,
  sdkMemoryRoots?: readonly SdkMemoryRoot[],
): ToolPermissionResult {
  // Resolve symlinks: check both original and real paths
  const pathsToCheck = getPathsForPermissionCheck(inputPath, cwd);
  const managed = checkManagedPathRules(pathsToCheck, context, 'read', cwd);
  if (managed?.kind === 'deny') return managed;
  return applyManagedRuleResult(
    checkReadPermissionForPaths(
      inputPath,
      context,
      cwd,
      pathsToCheck,
      sdkMemoryRoots,
    ),
    managed,
    PermissionModes.Default,
  );
}

function checkReadPermissionForPaths(
  inputPath: string,
  context: PathPermissionContext,
  cwd: string,
  pathsToCheck: readonly string[],
  sdkMemoryRoots?: readonly SdkMemoryRoot[],
): ToolPermissionResult {
  const internalPaths = context.internalPaths ?? qwenInternalPathDeps.resolve({ cwd });
  // 1. Network-shaped paths and device namespaces (check all resolved paths).
  // Windows-only enforcement: ask for confirmation rather than refuse, so the
  // user can allow a legitimate network location per prompt. Touching such a
  // path performs an SMB/WebDAV handshake or reaches a raw device, so this
  // runs before rule matching and offers no suggestions — a persisted rule
  // would permanently authorize the credential-disclosure vector. Local
  // mounts (WSL, extended-length drives, volume GUIDs) classify as local and
  // pass.
  if (isNetworkPathEnforced()) {
    for (const p of pathsToCheck) {
      const shape = classifyPathShape(p);
      const isNetwork = shape.network.kind === 'network';
      const isDeviceNamespace =
        shape.local.kind === 'suspicious' &&
        shape.local.reasons.some(
          (r) => r === 'devicePath' || r === 'ntObjectPath',
        );
      if (isNetwork || isDeviceNamespace) {
        const viaAutomount = isNetwork && shape.network.via === 'automount';
        return {
          kind: 'ask',
          reason: {
            message: isDeviceNamespace
              ? `This path names a device or object namespace and requires confirmation: ${inputPath}`
              : viaAutomount
                ? `This path is under an automount map and would trigger a network mount: ${inputPath}`
                : `This path is a network location and requires confirmation: ${inputPath}`,
            attribution: {
              type: 'other',
              reason: isDeviceNamespace
                ? 'Device path requires confirmation'
                : viaAutomount
                  ? 'Automount path requires confirmation'
                  : 'Network path requires confirmation',
            },
            decisionPoint: viaAutomount
              ? 'fs_read.automount_path.ask'
              : 'fs_read.network_path.ask',
          },
        };
      }
    }
  }

  const sdkMemoryBoundary = checkSdkMemoryRootBoundary(
    pathsToCheck,
    sdkMemoryRoots,
    'read',
  );
  if (sdkMemoryBoundary) return sdkMemoryBoundary;

  // 2. Comparison-defeating Windows spellings (check all resolved paths)
  for (const p of pathsToCheck) {
    if (isLocallySuspiciousPath(p)) {
      return {
        kind: 'ask',
        reason: {
          message: `This path uses suspicious Windows syntax that could bypass security checks: ${inputPath}`,
          attribution: {
            type: 'other',
            reason: 'Suspicious Windows path pattern',
          },
          decisionPoint: 'fs_read.suspicious_pattern.ask',
        },
      };
    }
  }

  // 3. Check deny rules (match against all resolved paths)
  for (const p of pathsToCheck) {
    const denyRule = matchingRuleForInput(p, context, 'read', 'deny', cwd);
    if (denyRule) {
      return {
        kind: 'deny',
        extra: {
          decisionPoint: 'fs_read.rule.deny',
          denialReason: {
            message: `Reading this path is denied by a ${denyRule.source} rule: ${inputPath}`,
            attribution: { type: 'rule', rule: denyRule },
            denialKind: 'permission-rule',
            decisionPoint: 'fs_read.rule.deny',
          },
        },
      };
    }
  }

  // 4. Check ask rules (match against all resolved paths)
  for (const p of pathsToCheck) {
    const askRule = matchingRuleForInput(p, context, 'read', 'ask', cwd);
    if (askRule) {
      return {
        kind: 'ask',
        reason: {
          message: `Reading this path requires confirmation per ${askRule.source} rule: ${inputPath}`,
          attribution: { type: 'rule', rule: askRule },
          decisionPoint: 'fs_read.rule.ask',
        },
        suggestions: generateReadSuggestions(inputPath, cwd),
      };
    }
  }

  // 5. Edit-implies-read: if the write pipeline would ALLOW editing this path,
  // reading is implied. Runs the full write permission check so edit-allow
  // rules / internal editable paths grant read access before the working-dir
  // and internal-read checks below.
  const editResult = checkWritePermissionForPath(
    inputPath,
    { ...context, internalPaths },
    cwd,
  );
  if (editResult.kind === 'allow') {
    return {
      kind: 'allow',
      extra: { decisionPoint: 'fs_read.edit_implies_read.allow' },
    };
  }

  // 6. Allow reads in working directories (ALL resolved paths must be inside)
  const allPathsInWorkDir = pathsToCheck.every((p) =>
    pathInAllowedWorkingPath(p, context, cwd),
  );
  if (allPathsInWorkDir) {
    return {
      kind: 'allow',
      extra: { decisionPoint: 'fs_read.working_dir.allow' },
    };
  }

  // If the original path is in working dir but the resolved path is NOT,
  // this is a symlink traversal attempt — require explicit approval
  if (
    pathsToCheck.length > 1 &&
    pathInAllowedWorkingPath(pathsToCheck[0], context, cwd) &&
    !pathInAllowedWorkingPath(pathsToCheck[1], context, cwd)
  ) {
    return {
      kind: 'ask',
      reason: {
        message: `This path is a symlink that resolves outside the working directory: ${inputPath} → ${pathsToCheck[1]}`,
        attribution: {
          type: 'other',
          reason: 'Symlink resolves outside working directory',
        },
        decisionPoint: 'fs_read.symlink_escape.ask',
      },
      suggestions: generateReadSuggestions(inputPath, cwd),
    };
  }

  // 7. InternalPaths read-domain fast-path: project-dir / project-temp /
  // user-config / session-plan / auto-memory / etc. Placed AFTER working-dir.
  // Session-scoped
  // sub-domains require ctx; absent ctx they no-op.
  if (
    pathsToCheck.every((p) => checkReadableInternalPath(p, cwd, internalPaths))
  ) {
    return {
      kind: 'allow',
      extra: { decisionPoint: 'fs_read.internal_path.allow' },
    };
  }

  // 8. Check allow rules
  for (const p of pathsToCheck) {
    const allowRule = matchingRuleForInput(p, context, 'read', 'allow', cwd);
    if (allowRule) {
      return {
        kind: 'allow',
        extra: { decisionPoint: 'fs_read.rule.allow' },
      };
    }
  }

  // 9. Default to ask
  return {
    kind: 'ask',
    reason: {
      message: `Allow reading ${inputPath}?`,
      attribution: {
        type: 'workingDir',
        reason: 'Path is outside allowed working directories',
      },
      decisionPoint: 'fs_read.outside_workspace.ask',
    },
    suggestions: generateReadSuggestions(inputPath, cwd),
  };
}

/**
 * Checks write permission for a file path.
 *
 * Pipeline order:
 * 0. Network-shaped paths and device namespaces → ask (Windows only)
 * 1. Check deny rules
 * 2. InternalPaths edit-domain fast-path (after deny, BEFORE safety+ask)
 * 3. Safety checks (Windows patterns, dangerous files)
 * 4. Check ask rules
 * 5. Check allow rules
 * 6. Path boundary check LAST (mode-agnostic, returns ask with blockedPath if outside)
 * 7. Default to ask
 *
 * @param inputPath The file path to write
 * @param context The permission context
 * @param cwd The current working directory
 * @returns Permission decision
 */
export function checkWritePermissionForPath(
  inputPath: string,
  context: PathPermissionContext,
  cwd: string,
  sdkMemoryRoots?: readonly SdkMemoryRoot[],
): ToolPermissionResult {
  // Resolve symlinks: check both original and real paths
  const pathsToCheck = getPathsForPermissionCheck(inputPath, cwd);
  const managed = checkManagedPathRules(pathsToCheck, context, 'edit', cwd);
  if (managed?.kind === 'deny') return managed;
  return applyManagedRuleResult(
    checkWritePermissionForPaths(
      inputPath,
      context,
      cwd,
      pathsToCheck,
      sdkMemoryRoots,
    ),
    managed,
    PermissionModes.Default,
  );
}

function checkWritePermissionForPaths(
  inputPath: string,
  context: PathPermissionContext,
  cwd: string,
  pathsToCheck: readonly string[],
  sdkMemoryRoots?: readonly SdkMemoryRoot[],
): ToolPermissionResult {
  const internalPaths = context.internalPaths ?? qwenInternalPathDeps.resolve({ cwd });
  // 0. Network-shaped paths and device namespaces require confirmation.
  // Windows-only enforcement: ask rather than refuse so the user can allow a
  // legitimate network location per prompt. Runs before rule matching and
  // offers no suggestions. Local mounts (WSL, extended-length drives, volume
  // GUIDs) classify as local and pass.
  if (isNetworkPathEnforced()) {
    for (const p of pathsToCheck) {
      const shape = classifyPathShape(p);
      const isNetwork = shape.network.kind === 'network';
      const isDeviceNamespace =
        shape.local.kind === 'suspicious' &&
        shape.local.reasons.some(
          (r) => r === 'devicePath' || r === 'ntObjectPath',
        );
      if (isNetwork || isDeviceNamespace) {
        return {
          kind: 'ask',
          reason: {
            message: isDeviceNamespace
              ? `Writing to a device or object namespace requires confirmation: ${inputPath}`
              : `Writing to a network location requires confirmation: ${inputPath}`,
            attribution: {
              type: 'other',
              reason: isDeviceNamespace
                ? 'Device path requires confirmation'
                : 'Network path requires confirmation',
            },
            decisionPoint: 'fs_write.network_path.ask',
          },
        };
      }
    }
  }

  // 1. Check deny rules (match against all resolved paths)
  for (const p of pathsToCheck) {
    const denyRule = matchingRuleForInput(p, context, 'edit', 'deny', cwd);
    if (denyRule) {
      return {
        kind: 'deny',
        extra: {
          decisionPoint: 'fs_write.rule.deny',
          denialReason: {
            message: `Writing to this path is denied by a ${denyRule.source} rule: ${inputPath}`,
            attribution: { type: 'rule', rule: denyRule },
            denialKind: 'permission-rule',
            decisionPoint: 'fs_write.rule.deny',
          },
        },
      };
    }
  }

  const sdkMemoryBoundary = checkSdkMemoryRootBoundary(
    pathsToCheck,
    sdkMemoryRoots,
    'edit',
  );
  if (sdkMemoryBoundary) return sdkMemoryBoundary;

  // 2. InternalPaths edit-domain fast-path: project-dir / project-temp /
  // session-plan / auto-memory / etc. Placed AFTER deny rules (so user deny
  // rules still win) but BEFORE safety+ask — internal paths under .qwen/ would
  // otherwise trip the dangerous-directory safety check. Session-scoped
  // sub-domains require ctx;
  // absent ctx they no-op.
  if (
    pathsToCheck.every((p) => checkEditableInternalPath(p, cwd, internalPaths))
  ) {
    return {
      kind: 'allow',
      extra: { decisionPoint: 'fs_write.internal_path.allow' },
    };
  }

  // 3. Safety checks for dangerous paths (check all resolved paths)
  const safetyResult = checkPathSafetyForAutoEdit(
    pathsToCheck[0],
    pathsToCheck,
    internalPaths,
  );
  if (!safetyResult.safe) {
    // Return ask with safety check info for ALL modes.
    // auto mode routes safety objections to the classifier rather than
    // denying them here.
    return {
      kind: 'ask',
      reason: {
        message: safetyResult.message,
        attribution: {
          type: 'safetyCheck',
          reason: safetyResult.message,
          safetyCheckKind: safetyResult.safetyCheckKind,
          classifierApprovable: safetyResult.classifierApprovable,
        },
        decisionPoint: 'fs_write.safety_check.ask',
      },
    };
  }

  const reviewExtra = pathsToCheck.some((p) =>
    isAutoReviewedConfigPath(p, internalPaths),
  )
    ? { extra: { autoModeReview: true } }
    : {};

  // 4. Check ask rules (match against all resolved paths)
  for (const p of pathsToCheck) {
    const askRule = matchingRuleForInput(p, context, 'edit', 'ask', cwd);
    if (askRule) {
      return {
        kind: 'ask',
        reason: {
          message: `Writing to this path requires confirmation per ${askRule.source} rule: ${inputPath}`,
          attribution: { type: 'rule', rule: askRule },
          decisionPoint: 'fs_write.rule.ask',
        },
        suggestions: generateWriteSuggestions(inputPath, context, cwd),
        ...reviewExtra,
      };
    }
  }

  // 5. Check allow rules (before the boundary check: an explicit edit-allow
  // rule grants the write even for paths outside the workspace).
  for (const p of pathsToCheck) {
    const allowRule = matchingRuleForInput(p, context, 'edit', 'allow', cwd);
    if (allowRule) {
      return {
        kind: 'allow',
        extra: { decisionPoint: 'fs_write.rule.allow' },
      };
    }
  }

  // 6. Path boundary check (mode-agnostic). Intrinsic path danger is already
  // handled at step 3 (checkPathSafetyForAutoEdit); this step decides ONLY the
  // workspace-scope question. Placed LAST so deny/ask/allow rules take
  // precedence. The check does NOT decide by mode —
  // it reports the blocked path and the mode decides.
  const allPathsInWorkDir = pathsToCheck.every((p) =>
    pathInAllowedWorkingPath(p, context, cwd),
  );
  if (!allPathsInWorkDir) {
    // Symlink traversal: original in working dir, resolved outside → ask.
    if (
      pathsToCheck.length > 1 &&
      pathInAllowedWorkingPath(pathsToCheck[0], context, cwd) &&
      !pathInAllowedWorkingPath(pathsToCheck[1], context, cwd)
    ) {
      return {
        kind: 'ask',
        reason: {
          message: `This path is a symlink that resolves outside the working directory: ${inputPath} → ${pathsToCheck[1]}`,
          attribution: {
            type: 'other',
            reason: 'Symlink resolves outside working directory',
          },
          decisionPoint: 'fs_write.symlink_escape.ask',
        },
        suggestions: generateWriteSuggestions(inputPath, context, cwd),
        ...reviewExtra,
      };
    }

    // Outside the workspace boundary — ask with blockedPath for ALL modes.
    return {
      kind: 'ask',
      reason: {
        message: `Writing to paths outside the workspace requires confirmation: ${inputPath}`,
        attribution: {
          type: 'other',
          reason: 'Path is outside workspace boundary',
        },
        decisionPoint: 'fs_write.outside_workspace.ask',
        blockedPath: inputPath,
      },
      suggestions: generateWriteSuggestions(inputPath, context, cwd),
    };
  }

  // 7. Default to ask. This ask only says nobody vouched for the write, so a
  //    tool-level allow for the writing tool itself (--allowed-tools Write /
  //    permissions.allow Write) fills it. A shell command that redirects is
  //    judged under Bash: its allow must not stand in for the file-write grant.
  //    Safety, workspace-boundary and explicit ask-rule findings above keep
  //    their own attribution and stay unfillable.
  const writeToolVouched =
    context.toolName === WRITE_FILE_TOOL_NAME ||
    context.toolName === EDIT_TOOL_NAME ||
    context.toolName === NOTEBOOK_EDIT_TOOL_NAME;
  return {
    kind: 'ask',
    reason: {
      message: `Allow writing to ${inputPath}?`,
      attribution: { type: 'other', reason: 'No rule covers this write' },
      decisionPoint: 'fs_write.default.ask',
    },
    suggestions: generateWriteSuggestions(inputPath, context, cwd),
    extra: {
      ...(writeToolVouched ? { fillableByAllow: true } : {}),
      ...(pathsToCheck.some((path) => isAutoReviewedConfigPath(path))
        ? { autoModeReview: true }
        : {}),
    },
  };
}

// ============================================================================
// Suggestion Generation
// ============================================================================

/**
 * Generates permission suggestions for a read permission dialog.
 */
function generateReadSuggestions(
  filePath: string,
  cwd: string,
): PermissionUpdate[] {
  const suggestions: PermissionUpdate[] = [];

  const pathsToCheck = getPathsForPermissionCheck(filePath, cwd);
  const expandedPath = toPosixPath(pathsToCheck[pathsToCheck.length - 1]);
  let suggestionPath = posix.dirname(expandedPath);
  try {
    const stat = lstatSync(expandedPath);
    if (stat.isDirectory()) {
      suggestionPath = expandedPath;
    } else if (stat.isSymbolicLink()) {
      const realPath = toPosixPath(resolveToRealPath(expandedPath));
      suggestionPath = lstatSync(realPath).isDirectory()
        ? realPath
        : posix.dirname(realPath);
    }
  } catch {
    if (expandedPath.endsWith('/')) {
      suggestionPath = expandedPath.replace(/\/+$/, '');
    }
  }

  // Suggest allowing reads of the target directory, or the containing
  // directory when the target is a file or does not exist.
  const dirPath = suggestionPath;
  const suggestion = createReadRuleSuggestion(dirPath);
  if (suggestion) {
    suggestions.push(suggestion);
  }

  return suggestions;
}

/**
 * Generates permission suggestions for a write permission dialog.
 */
function generateWriteSuggestions(
  filePath: string,
  context: PathPermissionContext,
  cwd: string,
): PermissionUpdate[] {
  const suggestions: PermissionUpdate[] = [];

  const expandedPath = expandPath(filePath, cwd);
  const inWorkingDir = pathInAllowedWorkingPath(expandedPath, context, cwd);

  // If outside working dir, also suggest adding the directory so that
  // acceptEdits mode covers this path (it only auto-allows within working dirs).
  if (!inWorkingDir) {
    // 授权目录会交给宿主做文件操作，必须先转回原生路径，再判断目录或取父目录。
    let dirPath = dirname(expandedPath);
    try {
      if (statSync(expandedPath).isDirectory()) dirPath = expandedPath;
    } catch {
      // 文件尚未创建或无法读取时，建议授权其父目录。
    }
    if (dirPath !== '/') {
      const directories = [dirPath];
      try {
        const realPath = resolveToRealPath(dirPath);
        if (realPath !== dirPath) directories.push(realPath);
      } catch {
        // 无法解析符号链接时，仍保留用户输入对应的原生目录。
      }
      suggestions.push({
        type: 'addDirectories',
        destination: 'session',
        directories,
      });
    }
  }

  return suggestions;
}

// ============================================================================
// File Read Ignore Patterns (for UI filtering)
// ============================================================================

/**
 * Collects all deny patterns for file read operations.
 * Used to filter out denied files from directory listings and search results.
 *
 * @returns Map from root path (or null) to pattern strings
 */
export function getFileReadIgnorePatterns(
  context: PathPermissionContext,
  cwd: string,
): Map<string | null, string[]> {
  const patternsByRoot = getPatternsByRoot(context, 'read', 'deny', cwd);
  const result = new Map<string | null, string[]>();

  for (const [root, patternMap] of patternsByRoot) {
    const patterns: string[] = [];
    for (const pattern of patternMap.keys()) {
      patterns.push(pattern);
    }
    if (patterns.length > 0) {
      result.set(root, patterns);
    }
  }

  return result;
}
