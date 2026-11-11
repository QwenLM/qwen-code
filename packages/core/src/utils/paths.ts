/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import os from 'node:os';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isFsTouchUnsafePath, isNetworkShapedPath } from './pathShape.js';
import { rewritePosixDrivePath } from './windowsPathConvert.js';
import {
  readBrandEnv,
  ENV_CONFIG_DIR,
  ENV_CONFIG_DIR_NAME,
  ENV_CLI_HOME,
  BRAND_USER_CONFIG_DIR_NAME,
  BRAND_PROJECT_CONFIG_DIR_NAME,
} from '../config/brand.js';
import { resolveConfigDirectoryNames } from '../config/configDirectory.js';

export { rewritePosixDrivePath };

const configDirectoryNames = resolveConfigDirectoryNames({
  rawValue: readBrandEnv(ENV_CONFIG_DIR_NAME),
  envName: ENV_CONFIG_DIR_NAME,
  userDefault: BRAND_USER_CONFIG_DIR_NAME,
  projectDefault: BRAND_PROJECT_CONFIG_DIR_NAME,
});

/**
 * Effective config directory name used under a project root.
 *
 * Defaults to the compiled brand's project directory and follows its
 * `*_CONFIG_DIR_NAME` variable when configured.
 */
export const CONFIG_DIR = configDirectoryNames.projectConfigDirName;

/**
 * Effective user-level config directory name. Defaults to the compiled brand's
 * user directory and follows its `*_CONFIG_DIR_NAME` variable when configured.
 */
export const GLOBAL_CONFIG_DIR = configDirectoryNames.userConfigDirName;

// Keep this key in sync with packages/cli/src/config/configDirFlag.ts.
// The CLI early parser must set it without importing core before --config-dir
// has been applied.
const CONFIG_HOME_DIR_OVERRIDE_KEY = Symbol.for('cli.configHomeDirOverride');

export function getConfigHomeDirOverride(): string | undefined {
  const global = globalThis as Record<symbol, string | undefined>;
  return global[CONFIG_HOME_DIR_OVERRIDE_KEY];
}

export function setConfigHomeDirOverride(dir: string | undefined): void {
  const global = globalThis as Record<symbol, string | undefined>;
  if (dir === undefined) {
    delete global[CONFIG_HOME_DIR_OVERRIDE_KEY];
  } else {
    const value = path.resolve(dir).normalize('NFC');
    global[CONFIG_HOME_DIR_OVERRIDE_KEY] = value;
  }
  _resetConfigHomeDirCache();
}

/**
 * Returns the home directory.
 * If the brand's CLI_HOME environment variable is set, returns its value
 * (QWEN_CLI_HOME by default).
 * Otherwise, it returns the user's home directory.
 */
export function homedir(): string {
  const envHome = readBrandEnv(ENV_CLI_HOME);
  if (envHome) {
    return envHome;
  }
  return os.homedir();
}

/**
 * Returns the user-level config root.
 *
 * The in-process override used by --config-dir and the brand's CONFIG_DIR are
 * complete root paths. When neither is set, the root is
 * `${homedir()}/${GLOBAL_CONFIG_DIR}`. The brand's CLI_HOME only overrides
 * homedir(), so QWEN_CLI_HOME=/tmp/qwen-home resolves under that directory
 * using this build's GLOBAL_CONFIG_DIR.
 * The directory name is fixed at module load. Reset the cache explicitly
 * after changing root/home environment variables.
 */
let _configHomeDirCached: string | undefined;
// The lightweight --config-dir parser can update the Symbol before calling us.
let _configHomeDirCachedOverride: string | undefined;

export function getConfigHomeDir(): string {
  const overrideConfigDir = getConfigHomeDirOverride();
  if (
    _configHomeDirCached !== undefined &&
    _configHomeDirCachedOverride === overrideConfigDir
  ) {
    return _configHomeDirCached;
  }

  let result: string;
  const envConfigDir = readBrandEnv(ENV_CONFIG_DIR);
  if (overrideConfigDir) {
    result = overrideConfigDir;
  } else if (envConfigDir) {
    result = path.resolve(envConfigDir).normalize('NFC');
  } else {
    const homeDir = homedir();
    if (!homeDir) {
      result = path.join(tmpdir(), GLOBAL_CONFIG_DIR).normalize('NFC');
    } else {
      result = path.join(homeDir, GLOBAL_CONFIG_DIR).normalize('NFC');
    }
  }

  _configHomeDirCached = result;
  _configHomeDirCachedOverride = overrideConfigDir;
  return result;
}

/**
 * Returns a user-facing path for a resource under the resolved user config root.
 * Uses `~/...` only for the default OS-home-based root. Explicit root and CLI
 * home overrides are displayed using their effective paths. This helper is
 * display-only; use getConfigHomeDir() for filesystem access.
 */
export function getUserConfigDisplayPath(...segments: string[]): string {
  const root = getConfigHomeDir();
  const defaultRoot = path
    .join(os.homedir(), GLOBAL_CONFIG_DIR)
    .normalize('NFC');
  const hasExplicitRoot =
    getConfigHomeDirOverride() !== undefined ||
    Boolean(readBrandEnv(ENV_CONFIG_DIR)) ||
    Boolean(readBrandEnv(ENV_CLI_HOME));
  if (!hasExplicitRoot && root === defaultRoot) {
    return ['~', GLOBAL_CONFIG_DIR, ...segments].join('/');
  }
  return path.join(root, ...segments);
}

/** @internal Test-only: reset the memoized getConfigHomeDir() cache. */
export function _resetConfigHomeDirCache(): void {
  _configHomeDirCached = undefined;
}

/**
 * Returns the operating system's default directory for temporary files.
 */
export function tmpdir(): string {
  return os.tmpdir();
}

/**
 * Replaces the home directory with a tilde.
 * @param path - The path to tildeify.
 * @returns The tildeified path.
 */
export function tildeifyPath(inputPath: string): string {
  const homeDir = homedir();
  if (inputPath === homeDir) {
    return '~';
  }
  if (inputPath.startsWith(homeDir + path.sep)) {
    return '~' + inputPath.slice(homeDir.length);
  }
  return inputPath;
}

/**
 * Shortens a path string if it exceeds maxLen, prioritizing the start and end segments.
 * Example: /path/to/a/very/long/file.txt -> /path/.../long/file.txt
 */
export function shortenPath(filePath: string, maxLen: number = 35): string {
  if (filePath.length <= maxLen) {
    return filePath;
  }

  const simpleTruncate = () => {
    const keepLen = Math.floor((maxLen - 3) / 2);
    if (keepLen <= 0) {
      return filePath.substring(0, maxLen - 3) + '...';
    }
    const start = filePath.substring(0, keepLen);
    const end = filePath.substring(filePath.length - keepLen);
    return `${start}...${end}`;
  };

  type TruncateMode = 'start' | 'end' | 'center';

  const truncateComponent = (
    component: string,
    targetLength: number,
    mode: TruncateMode,
  ): string => {
    if (component.length <= targetLength) {
      return component;
    }

    if (targetLength <= 0) {
      return '';
    }

    if (targetLength <= 3) {
      if (mode === 'end') {
        return component.slice(-targetLength);
      }
      return component.slice(0, targetLength);
    }

    if (mode === 'start') {
      return `${component.slice(0, targetLength - 3)}...`;
    }

    if (mode === 'end') {
      return `...${component.slice(component.length - (targetLength - 3))}`;
    }

    const front = Math.ceil((targetLength - 3) / 2);
    const back = targetLength - 3 - front;
    return `${component.slice(0, front)}...${component.slice(
      component.length - back,
    )}`;
  };

  const parsedPath = path.parse(filePath);
  const root = parsedPath.root;
  const separator = path.sep;

  // Get segments of the path *after* the root
  const relativePath = filePath.substring(root.length);
  const segments = relativePath.split(separator).filter((s) => s !== ''); // Filter out empty segments

  // Handle cases with no segments after root (e.g., "/", "C:\") or only one segment
  if (segments.length <= 1) {
    // Fall back to simple start/end truncation for very short paths or single segments
    return simpleTruncate();
  }

  const firstDir = segments[0];
  const lastSegment = segments[segments.length - 1];
  const startComponent = root + firstDir;

  const endPartSegments = [lastSegment];
  let endPartLength = lastSegment.length;

  // Iterate backwards through the middle segments
  for (let i = segments.length - 2; i > 0; i--) {
    const segment = segments[i];
    const newLength =
      startComponent.length +
      separator.length +
      3 + // for "..."
      separator.length +
      endPartLength +
      separator.length +
      segment.length;

    if (newLength <= maxLen) {
      endPartSegments.unshift(segment);
      endPartLength += separator.length + segment.length;
    } else {
      break;
    }
  }

  const components = [firstDir, ...endPartSegments];
  const componentModes: TruncateMode[] = components.map((_, index) => {
    if (index === 0) {
      return 'start';
    }
    if (index === components.length - 1) {
      return 'end';
    }
    return 'center';
  });

  const separatorsCount = endPartSegments.length + 1;
  const fixedLen = root.length + separatorsCount * separator.length + 3; // ellipsis length
  const availableForComponents = maxLen - fixedLen;

  const trailingFallback = () => {
    const ellipsisTail = `...${separator}${lastSegment}`;
    if (ellipsisTail.length <= maxLen) {
      return ellipsisTail;
    }

    if (root) {
      const rootEllipsisTail = `${root}...${separator}${lastSegment}`;
      if (rootEllipsisTail.length <= maxLen) {
        return rootEllipsisTail;
      }
    }

    if (root && `${root}${lastSegment}`.length <= maxLen) {
      return `${root}${lastSegment}`;
    }

    if (lastSegment.length <= maxLen) {
      return lastSegment;
    }

    // As a final resort (e.g., last segment itself exceeds maxLen), fall back to simple truncation.
    return simpleTruncate();
  };

  if (availableForComponents <= 0) {
    return trailingFallback();
  }

  const minLengths = components.map((component, index) => {
    if (index === 0) {
      return Math.min(component.length, 1);
    }
    if (index === components.length - 1) {
      return component.length; // Never truncate the last segment when possible.
    }
    return Math.min(component.length, 1);
  });

  const minTotal = minLengths.reduce((sum, len) => sum + len, 0);
  if (availableForComponents < minTotal) {
    return trailingFallback();
  }

  const budgets = components.map((component) => component.length);
  let currentTotal = budgets.reduce((sum, len) => sum + len, 0);

  const pickIndexToReduce = () => {
    let bestIndex = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < budgets.length; i++) {
      if (budgets[i] <= minLengths[i]) {
        continue;
      }
      const isLast = i === budgets.length - 1;
      const score = (isLast ? 0 : 1_000_000) + budgets[i];
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    return bestIndex;
  };

  while (currentTotal > availableForComponents) {
    const index = pickIndexToReduce();
    if (index === -1) {
      return trailingFallback();
    }
    budgets[index]--;
    currentTotal--;
  }

  const truncatedComponents = components.map((component, index) =>
    truncateComponent(component, budgets[index], componentModes[index]),
  );

  const truncatedFirst = truncatedComponents[0];
  const truncatedEnd = truncatedComponents.slice(1).join(separator);
  const result = `${root}${truncatedFirst}${separator}...${separator}${truncatedEnd}`;

  if (result.length > maxLen) {
    return trailingFallback();
  }

  return result;
}

/**
 * Calculates the relative path from a root directory to a target path.
 * If targetPath is relative, it is returned as-is.
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
  if (!path.isAbsolute(targetPath)) {
    return targetPath;
  }
  const resolvedRootDirectory = path.resolve(rootDirectory);
  const relativePath = path.relative(resolvedRootDirectory, targetPath);

  // If the paths are the same, path.relative returns '', return '.' instead
  return relativePath || '.';
}

/**
 * Format a file path for user-facing display relative to a workspace root.
 *
 * Policy:
 * 1. Resolve relative input against workspaceRoot.
 * 2. If resolved path is inside workspaceRoot → display relative path.
 * 3. If outside workspaceRoot but under $HOME → display ~/... path.
 * 4. Otherwise → display absolute path.
 * 5. Never display workspace-external paths as ../..
 */
export function displayPathForWorkspace(
  filePath: string,
  workspaceRoot: string,
): string {
  const resolved = path.isAbsolute(filePath)
    ? path.normalize(filePath)
    : path.resolve(workspaceRoot, filePath);
  const relativePath = path.relative(workspaceRoot, resolved);

  const isOutsideWorkspace =
    relativePath === '..' || relativePath.startsWith(`..${path.sep}`);
  if (!isOutsideWorkspace && !path.isAbsolute(relativePath)) {
    return relativePath || '.';
  }

  const tildePath = tildeifyPath(resolved);
  if (tildePath !== resolved) {
    return tildePath;
  }

  return resolved;
}

/**
 * Escape paths for at-commands.
 *
 *  - Windows: double quoted if they contain special chars, otherwise bare
 *  - POSIX: backslash-escaped
 */
export function escapePath(filePath: string): string {
  if (process.platform === 'win32') {
    // Windows: Double quote if it contains special chars
    if (/[\s&()[\]{}^=;!'+,`~%$@#]/.test(filePath)) {
      return `"${filePath}"`;
    }
    return filePath;
  } else {
    // POSIX: Backslash escape
    return filePath.replace(/([ \t()[\]{};|*?$`'"#&<>!~\\])/g, '\\$1');
  }
}

/**
 * Unescapes paths for at-commands.
 *
 *  - Windows: double quoted if they contain special chars, otherwise bare
 *  - POSIX: backslash-escaped
 */
export function unescapePath(filePath: string): string {
  if (process.platform === 'win32') {
    if (
      filePath.length >= 2 &&
      filePath.startsWith('"') &&
      filePath.endsWith('"')
    ) {
      return filePath.slice(1, -1);
    }
    return filePath;
  } else {
    return filePath.replace(/\\(.)/g, '$1');
  }
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
 * Maximum length for a sanitized path component. Most filesystems (ext4,
 * APFS, NTFS) limit individual components to 255 bytes; leave room for the
 * hash suffix and separator appended when a path exceeds this length.
 */
export { MAX_SANITIZED_LENGTH, sanitizePath } from './sanitizePath.js';

/**
 * Returns a SHA-1 hex digest of the given text.
 * Used for content change detection (delta hashing) where
 * cryptographic strength is not required.
 */
export function sha1(text: string): string {
  return crypto.createHash('sha1').update(text).digest('hex');
}

/**
 * Normalizes a path for reliable comparison across platforms.
 * - Resolves to an absolute path.
 * - Converts all path separators to forward slashes.
 * - On Windows, converts to lowercase for case-insensitivity.
 */
export function normalizePath(p: string): string {
  const platform = process.platform;
  const isWindows = platform === 'win32';
  const pathModule = isWindows ? path.win32 : path;

  const resolved = pathModule.resolve(p);
  const normalized = resolved.replace(/\\/g, '/');
  const isCaseInsensitive = isWindows || platform === 'darwin';
  return isCaseInsensitive ? normalized.toLowerCase() : normalized;
}

/**
 * Checks if a path is a subpath of another path.
 * @param parentPath The parent path.
 * @param childPath The child path.
 * @returns True if childPath is a subpath of parentPath, false otherwise.
 */
export function isSubpath(parentPath: string, childPath: string): boolean {
  const platform = process.platform;
  const isWindows = platform === 'win32';
  const isDarwin = platform === 'darwin';
  const pathModule = isWindows ? path.win32 : path;

  // Resolve both paths to absolute to ensure consistent comparison,
  // especially when mixing relative and absolute paths or when casing differs.
  let p = pathModule.resolve(parentPath);
  let c = pathModule.resolve(childPath);

  // On Windows, path.relative is case-insensitive.
  // On POSIX (including Darwin), path.relative is case-sensitive.
  // We want it to be case-insensitive on Darwin to match user expectation.
  if (isDarwin) {
    p = p.toLowerCase();
    c = c.toLowerCase();
  }

  const relative = pathModule.relative(p, c);

  return (
    !relative.startsWith(`..${pathModule.sep}`) &&
    relative !== '..' &&
    !pathModule.isAbsolute(relative)
  );
}

/**
 * Type guard to verify a value is a string and does not contain null bytes.
 */
export function isValidPathString(p: unknown): p is string {
  return typeof p === 'string' && !p.includes('\0');
}

/**
 * Sanitise a uid so it is safe to use as a file-system path segment.
 * Strips path separators (via basename) and leading dots; falls back to
 * 'anon' if the result is empty.
 */
export function safeUidSegment(uid: string): string {
  return path.basename(uid).replace(/^\.+/, '') || 'anon';
}

/**
 * Asserts that a value is a valid path string, throwing an Error otherwise.
 */
export function assertValidPathString(p: unknown): asserts p is string {
  if (!isValidPathString(p)) {
    throw new Error(`Invalid path: ${String(p)}`);
  }
}

/**
 * Expands a path that may contain tilde notation (~) to an absolute path.
 *
 * Processing steps:
 *   1. Security check for null bytes
 *   2. Trim whitespace
 *   3. Tilde expansion: `~` → homedir, `~/path` → path within homedir
 *   4. Absolute paths → returned normalized
 *   5. Relative paths → resolved relative to baseDir
 *   6. NFC Unicode normalization (macOS compatibility)
 *
 * @param filePath - The path to expand
 * @param baseDir - The base directory for resolving relative paths (defaults to process.cwd())
 * @returns The expanded absolute path in NFC-normalized form
 *
 * @throws {Error} If path or baseDir contains null bytes
 */
export function expandPath(filePath: string, baseDir?: string): string {
  const actualBaseDir = baseDir ?? process.cwd();

  // Security: Check for null bytes
  if (filePath.includes('\0') || actualBaseDir.includes('\0')) {
    throw new Error('Path contains null bytes');
  }

  // Handle empty or whitespace-only paths
  const trimmedPath = filePath.trim();
  if (!trimmedPath) {
    return path.normalize(actualBaseDir).normalize('NFC');
  }

  // Handle home directory notation
  if (trimmedPath === '~') {
    return homedir().normalize('NFC');
  }

  if (trimmedPath.startsWith('~/') || trimmedPath.startsWith('~\\')) {
    return path.join(homedir(), trimmedPath.slice(2)).normalize('NFC');
  }

  // Windows: `/d/...` names drive D. Without the rewrite path.isAbsolute
  // keeps it root-relative and every later step pins it to the current drive
  // (`D:\d\...`), landing reads/writes in a mirror tree.
  const effectivePath = rewritePosixDrivePath(trimmedPath);

  // Handle absolute paths
  if (path.isAbsolute(effectivePath)) {
    return path.normalize(effectivePath).normalize('NFC');
  }

  // Handle relative paths
  return path.resolve(actualBaseDir, effectivePath).normalize('NFC');
}

/**
 * Resolves a path to its real path, sanitizing it first.
 * - Removes 'file://' protocol if present.
 * - Decodes URI components (e.g. %20 -> space).
 * - Resolves symbolic links using fs.realpathSync.
 *
 * SECURITY: returns fs-touch-unsafe shapes untouched — see the guards below.
 *
 * @param pathStr The path string to resolve.
 * @returns The resolved real path.
 */
export function resolveToRealPath(pathStr: string): string {
  assertValidPathString(pathStr);
  let resolvedPath = pathStr;

  try {
    if (resolvedPath.startsWith('file://')) {
      resolvedPath = fileURLToPath(resolvedPath);
    }

    // SECURITY: decoding must not manufacture a network path that the caller's
    // shape check never saw — `%5C%5Cserver%5Cshare` decodes to `\\server\share`.
    const decoded = decodeURIComponent(resolvedPath);
    if (!isNetworkShapedPath(decoded) || isNetworkShapedPath(resolvedPath)) {
      resolvedPath = decoded;
    }
  } catch {
    // Ignore error (e.g. malformed URI), keep path from previous step
  }

  // SECURITY: realpathSync on a network path performs the SMB/NTLM handshake,
  // and path.resolve collapses `//srv/share` to `/srv/share` on POSIX, which
  // would launder a network path into a local-looking one. Neither is safe for
  // these shapes, so return the path as-is and let the caller decide.
  if (isFsTouchUnsafePath(resolvedPath)) {
    return resolvedPath;
  }

  // Windows: `/d/...` names drive D. path.resolve would pin it to the
  // current drive (`D:\d\...`) and realpath would then fabricate a mirror
  // path — the permission layer compares that against the posix comparison
  // form `/d/...` and misreads the difference as a symlink escape. Rewrite
  // to `D:\...` so resolution targets the named drive.
  return robustRealpath(path.resolve(rewritePosixDrivePath(resolvedPath)));
}

function robustRealpath(p: string, visited = new Set<string>()): string {
  const key = process.platform === 'win32' ? p.toLowerCase() : p;
  if (visited.has(key)) {
    throw new Error(`Infinite recursion detected in robustRealpath: ${p}`);
  }
  visited.add(key);
  try {
    // NOTE: plain realpathSync, deliberately. `realpathSync.native` emits
    // `\\?\`-prefixed results on Windows, which would start feeding
    // extended-length paths into every caller's shape classification.
    return fs.realpathSync(p);
  } catch (e: unknown) {
    if (
      e &&
      typeof e === 'object' &&
      'code' in e &&
      (e.code === 'ENOENT' || e.code === 'EISDIR')
    ) {
      try {
        const stat = fs.lstatSync(p);
        if (stat.isSymbolicLink()) {
          const target = fs.readlinkSync(p);
          const resolvedTarget = path.resolve(path.dirname(p), target);
          return robustRealpath(resolvedTarget, visited);
        }
      } catch (lstatError: unknown) {
        // Not a symlink, or lstat failed. Re-throw if it's not an expected
        // ENOENT (e.g., a permissions error), otherwise resolve parent.
        if (
          !(
            lstatError &&
            typeof lstatError === 'object' &&
            'code' in lstatError &&
            (lstatError.code === 'ENOENT' || lstatError.code === 'EISDIR')
          )
        ) {
          throw lstatError;
        }
      }
      const parent = path.dirname(p);
      if (parent === p) return p;
      return path.join(robustRealpath(parent, visited), path.basename(p));
    }
    throw e;
  }
}
