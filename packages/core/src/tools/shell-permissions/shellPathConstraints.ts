/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shell path constraints for read-only auto-allow.
 *
 * Ensures that read-only auto-allowed commands only read files within
 * the allowed working directories. Commands reading paths outside the
 * workspace will fall through to the standard permission prompt.
 *
 * Design: fail-closed. If paths cannot be reliably extracted, the command
 * is NOT auto-allowed.
 */

import { posix } from 'node:path';
import { parse, type ParseEntry } from 'shell-quote';
import {
  checkReadPermissionForPath,
  getPathsForPermissionCheck,
} from '../filesystem-permissions/filesystem.js';
import { expandTilde } from '../filesystem-permissions/pathValidation.js';
import type { PathPermissionContext } from '../tool-checkers/checker-reasons.js';
import type { ToolPermissionResult } from '../tool-checkers/rule-precedence.js';
import { getPlatform } from '../../utils/platform.js';
import { windowsPathToPosixPath } from '../../utils/windowsPaths.js';
import { ALLOWLIST_INDEX } from './shellReadOnlyCommandConfigs.js';
import type {
  CommandReadOnlySpec,
  FlagArgType,
} from './shellCommandValidation.js';

// ============================================================================
// Types
// ============================================================================

export type PathConstraintResult =
  | { allowed: true }
  | {
      allowed: false;
      reason: string;
      behavior?: 'deny' | 'ask';
      decision?: ToolPermissionResult;
    }
  | { allowed: 'skip' };

const FD_PATH_FLAGS = ['--search-path', '--base-directory', '--ignore-file'];

const PATH_VALUE_FLAGS: Record<string, string[]> = {
  grep: ['-f', '--file', '--exclude-from'],
  rg: ['-f', '--file'],
  'git grep': ['-f', '--file'],
  diff: ['-X', '--exclude-from', '--from-file', '--to-file'],
  fd: FD_PATH_FLAGS,
  fdfind: FD_PATH_FLAGS,
  sed: ['-f', '--file'],
};

// ============================================================================
// Commands that don't need path validation
// ============================================================================

/**
 * Commands that don't read arbitrary user-specified file paths.
 * Read-only semantics are validated before this path-only check runs; these
 * commands either read no files or operate within the git repo implicitly.
 */
const SKIP_PATH_CHECK_COMMANDS = new Set([
  'echo',
  'printf',
  'pwd',
  'whoami',
  'uname',
  'id',
  'groups',
  'arch',
  'locale',
  'tty',
  'df',
  'free',
  'tput',
  'man',
  'info',
  'help',
  'seq',
  'basename',
  'dirname',
  'which',
  'type',
  'node',
  'python',
  'python3',
  'ps',
  'pgrep',
  'date',
  'hostname',
  'uptime',
]);

/**
 * Git subcommands that don't read arbitrary user paths.
 * They operate within the repo directory implicitly.
 */
const SKIP_PATH_CHECK_GIT_SUBCOMMANDS = new Set([
  'status',
  'log',
  'show',
  'blame',
  'branch',
  'tag',
  'remote',
  'ls-files',
  'ls-remote',
  'rev-parse',
  'describe',
  'shortlog',
  'stash',
  'merge-base',
  'rev-list',
  'for-each-ref',
  'cat-file',
  'reflog',
  'worktree',
  'config',
]);

// ============================================================================
// Generic file-reading commands (regex-validated, not in ALLOWLIST_INDEX)
// ============================================================================

/**
 * Minimal flag specs for commands that are validated via SIMPLE_READONLY_REGEXES
 * but still need path constraint checks. Only flags that take arguments are
 * listed here (to avoid treating their values as paths).
 */
const GENERIC_FILE_READERS = new Map<string, CommandReadOnlySpec>();

// Initialize generic file reader specs
const _genericSpecs: Array<[string, Record<string, FlagArgType>]> = [
  [
    'ls',
    {
      '-l': 'none',
      '-a': 'none',
      '-h': 'none',
      '-R': 'none',
      '-r': 'none',
      '-t': 'none',
      '-S': 'none',
      '-1': 'none',
      '--color': 'string',
    },
  ],
  [
    'cat',
    {
      '-n': 'none',
      '-b': 'none',
      '-s': 'none',
      '-v': 'none',
      '-E': 'none',
      '-T': 'none',
      '-A': 'none',
    },
  ],
  ['head', { '-n': 'number', '-c': 'number', '-q': 'none' }],
  [
    'wc',
    { '-l': 'none', '-w': 'none', '-c': 'none', '-m': 'none', '-L': 'none' },
  ],
  [
    'stat',
    { '-f': 'string', '-L': 'none', '-t': 'none', '--format': 'string' },
  ],
  ['file', { '-b': 'none', '-i': 'none', '-L': 'none', '-z': 'none' }],
  [
    'du',
    {
      '-s': 'none',
      '-h': 'none',
      '-a': 'none',
      '-c': 'none',
      '-d': 'number',
      '--max-depth': 'number',
    },
  ],
  [
    'cut',
    {
      '-d': 'char',
      '-f': 'string',
      '-c': 'string',
      '-b': 'string',
      '--delimiter': 'char',
      '--fields': 'string',
    },
  ],
  [
    'diff',
    {
      '-u': 'none',
      '-r': 'none',
      '-q': 'none',
      '-s': 'none',
      '-y': 'none',
      '--color': 'string',
      '--from-file': 'string',
      '--to-file': 'string',
    },
  ],
  [
    'realpath',
    {
      '-s': 'none',
      '--no-symlinks': 'none',
      '-m': 'none',
      '--canonicalize-missing': 'none',
      '-e': 'none',
      '--canonicalize-existing': 'none',
      '-L': 'none',
      '-P': 'none',
      '--relative-to': 'string',
      '--relative-base': 'string',
      '-q': 'none',
      '--quiet': 'none',
      '-z': 'none',
      '--zero': 'none',
    },
  ],
  [
    'readlink',
    {
      '-f': 'none',
      '-e': 'none',
      '-m': 'none',
      '-n': 'none',
      '-z': 'none',
      '--canonicalize': 'none',
      '--canonicalize-existing': 'none',
      '--canonicalize-missing': 'none',
      '--no-newline': 'none',
      '--zero': 'none',
      '-v': 'none',
      '--verbose': 'none',
      '-q': 'none',
      '--quiet': 'none',
    },
  ],
];
for (const [cmd, safeFlags] of _genericSpecs) {
  GENERIC_FILE_READERS.set(cmd, { safeFlags });
}

// ============================================================================
// Path extraction helpers
// ============================================================================

/**
 * Extracts positional (non-flag) arguments from a parsed token list,
 * using the command's flag spec to skip flag arguments.
 *
 * Returns null if an unknown long flag is encountered (fail-closed):
 * unknown flags might carry path values we can't validate.
 */
function extractPositionalArgs(
  tokens: string[],
  startIndex: number,
  config: CommandReadOnlySpec,
): string[] | null {
  const positionals: string[] = [];
  const respectsDoubleDash = config.respectsDoubleDash !== false;
  let i = startIndex;
  let pastDoubleDash = false;

  while (i < tokens.length) {
    const token = tokens[i];

    if (token === '--' && respectsDoubleDash && !pastDoubleDash) {
      pastDoubleDash = true;
      i++;
      continue;
    }

    if (pastDoubleDash) {
      positionals.push(token);
      i++;
      continue;
    }

    // Long flag with = value: fail-closed if flag is unknown
    if (token.startsWith('--') && token.includes('=')) {
      const eqIndex = token.indexOf('=');
      const flag = token.slice(0, eqIndex);
      if (!config.safeFlags[flag]) {
        return null; // unknown flag may carry a path value
      }
      i++;
      continue;
    }

    // Long flag: fail-closed if unknown
    if (token.startsWith('--')) {
      const argType = config.safeFlags[token];
      if (argType === undefined) {
        return null; // unknown flag
      }
      if (argType !== 'none') {
        i += 2; // skip flag + its argument
      } else {
        i++;
      }
      continue;
    }

    // Short flag
    if (token.startsWith('-') && token.length > 1) {
      // Check if it's a single short flag that takes an arg
      if (token.length === 2) {
        const argType = config.safeFlags[token];
        if (argType === undefined) {
          return null; // unknown short flag
        }
        if (argType !== 'none') {
          i += 2; // skip flag + its argument
        } else {
          i++;
        }
        continue;
      }
      // Longer token starting with - (length > 2)
      // First check if the full token is a known flag (e.g., find's -name, -type)
      const fullTokenType = config.safeFlags[token];
      if (fullTokenType !== undefined) {
        if (fullTokenType !== 'none') {
          i += 2; // flag takes a separate argument
        } else {
          i++;
        }
        continue;
      }
      // Try to parse as short flag with attached value: -f/path, -A20, -k2,2
      // or as bundled booleans (e.g., -la = -l + -a)
      const shortFlag = token.slice(0, 2);
      const shortFlagType = config.safeFlags[shortFlag];
      if (shortFlagType !== undefined) {
        // Known flag prefix — either takes an attached arg or is bundled booleans
        i++;
        continue;
      }
      // Unknown token — fail closed
      return null;
    }

    // Positional argument
    positionals.push(token);
    i++;
  }

  return positionals;
}

/**
 * Extracts values of specific flags from a token list.
 * Used to find flag values that are file paths needing validation
 * (e.g., grep -f patterns.txt, diff --from-file=ref.txt).
 */
function extractFlagValues(
  tokens: string[],
  startIndex: number,
  flagNames: string[],
  config: CommandReadOnlySpec,
): string[] {
  const flagSet = new Set(flagNames);
  const values: string[] = [];
  let i = startIndex;

  while (i < tokens.length) {
    const token = tokens[i];

    // Long flag with = value: --file=/path
    if (token.startsWith('--') && token.includes('=')) {
      const eqIndex = token.indexOf('=');
      const flag = token.slice(0, eqIndex);
      if (flagSet.has(flag)) {
        values.push(token.slice(eqIndex + 1));
      }
      i++;
      continue;
    }

    // Long flag with space-separated value: --exclude-from /path
    if (token.startsWith('--')) {
      const argType = config.safeFlags[token];
      if (flagSet.has(token) && argType && argType !== 'none') {
        if (i + 1 < tokens.length) {
          values.push(tokens[i + 1]);
        }
        i += 2;
        continue;
      }
      if (argType && argType !== 'none') {
        i += 2;
      } else {
        i++;
      }
      continue;
    }

    // Short flag
    if (token.startsWith('-') && token.length > 1) {
      // Check for attached value (-f/path)
      if (token.length > 2) {
        const shortFlag = token.slice(0, 2);
        const argType = config.safeFlags[shortFlag];
        if (flagSet.has(shortFlag) && argType && argType !== 'none') {
          values.push(token.slice(2));
        }
        i++;
        continue;
      }
      // Separated short flag: -f /path
      const argType = config.safeFlags[token];
      if (flagSet.has(token) && argType && argType !== 'none') {
        if (i + 1 < tokens.length) {
          values.push(tokens[i + 1]);
        }
        i += 2;
        continue;
      }
      if (argType && argType !== 'none') {
        i += 2;
      } else {
        i++;
      }
      continue;
    }

    i++;
  }

  return values;
}

function hasFlagValue(
  tokens: string[],
  startIndex: number,
  flagNames: string[],
  config: CommandReadOnlySpec,
): boolean {
  return extractFlagValues(tokens, startIndex, flagNames, config).length > 0;
}

function grepPatternProvidedByFlag(
  tokens: string[],
  startIndex: number,
  config: CommandReadOnlySpec,
): boolean {
  return hasFlagValue(
    tokens,
    startIndex,
    ['-e', '--regexp', '-f', '--file'],
    config,
  );
}

function isRgFilesMode(
  firstToken: string,
  commandTokens: number,
  tokens: string[],
): boolean {
  return (
    firstToken === 'rg' &&
    commandTokens === 1 &&
    tokens.includes('--files', commandTokens)
  );
}

function resolveShellPathArg(arg: string, executionCwd: string): string {
  if (getPlatform() === 'windows') {
    arg = windowsPathToPosixPath(arg);
    executionCwd = windowsPathToPosixPath(executionCwd);
  }
  if (arg.startsWith('~') || posix.isAbsolute(arg)) {
    return arg;
  }
  return posix.resolve(executionCwd, arg);
}

function getBlockedPathForShellArg(
  resolvedPath: string,
  permissionCwd: string,
): string {
  const pathsToCheck = getPathsForPermissionCheck(resolvedPath, permissionCwd);
  const expandedPath = expandTilde(pathsToCheck[pathsToCheck.length - 1]);
  return getPlatform() === 'windows'
    ? windowsPathToPosixPath(expandedPath)
    : expandedPath;
}

/**
 * Validates a single path argument against workspace boundaries.
 * Returns a PathConstraintResult if the path is denied/outside workspace,
 * or null if the path is allowed.
 */
function validatePathArg(
  arg: string,
  context: PathPermissionContext,
  executionCwd: string,
  permissionCwd: string,
): PathConstraintResult | null {
  const resolvedPath = resolveShellPathArg(arg, executionCwd);
  // checkReadPermissionForPath handles tilde expansion, symlinks, UNC paths,
  // and workspace-boundary checks. The resolved path must be checked against
  // permissionCwd, not executionCwd, because dir_path must not expand the
  // permission boundary.
  const decision = checkReadPermissionForPath(
    resolvedPath,
    context,
    permissionCwd,
  );
  if (decision.kind !== 'allow') {
    const decisionWithBlockedPath =
      decision.kind === 'ask'
        ? {
            ...decision,
            reason: {
              ...decision.reason,
              blockedPath:
                decision.reason.blockedPath ??
                getBlockedPathForShellArg(resolvedPath, permissionCwd),
            },
          }
        : decision;
    return {
      allowed: false,
      reason: `Path "${arg}" is outside allowed working directories`,
      behavior: decision.kind,
      decision: decisionWithBlockedPath,
    };
  }
  return null;
}

/**
 * Parse command into tokens using shell-quote.
 * Returns null if parsing fails.
 */
function parseCommandTokens(command: string): string[] | null {
  let parsed: ParseEntry[];
  try {
    parsed = parse(command, (env) => `$${env}`);
  } catch {
    return null;
  }

  const tokens: string[] = [];
  for (const entry of parsed) {
    if (typeof entry === 'string') {
      tokens.push(entry);
    } else if (
      typeof entry === 'object' &&
      entry !== null &&
      'pattern' in entry
    ) {
      tokens.push((entry as { pattern: string }).pattern);
    } else if (typeof entry === 'object' && entry !== null && 'op' in entry) {
      // Operators — this shouldn't happen for a single segment
      return null;
    } else {
      return null;
    }
  }
  return tokens;
}

/**
 * Get the command config and token count for a command's tokens.
 */
function findCommandConfig(
  tokens: string[],
): { config: CommandReadOnlySpec; commandTokens: number } | null {
  if (tokens.length === 0) return null;

  const candidates = ALLOWLIST_INDEX.get(tokens[0]);
  if (!candidates) return null;

  for (const { keyTokens, config } of candidates) {
    if (tokens.length >= keyTokens.length) {
      let matches = true;
      for (let j = 0; j < keyTokens.length; j++) {
        if (tokens[j] !== keyTokens[j]) {
          matches = false;
          break;
        }
      }
      if (matches) {
        return { config, commandTokens: keyTokens.length };
      }
    }
  }
  return null;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Checks whether a read-only shell command's file paths are within
 * the allowed working directories.
 *
 * @param command Single command segment (no shell operators)
 * @param context Permission context with working directory info
 * @param cwd The working directory for the command
 * @returns Path constraint result
 */
export function checkReadOnlyShellPathConstraints(
  command: string,
  context: PathPermissionContext,
  executionCwd: string,
  permissionCwd = executionCwd,
): PathConstraintResult {
  let testCommand = command.trim();

  // Strip trailing 2>&1
  if (testCommand.endsWith(' 2>&1')) {
    testCommand = testCommand.slice(0, -5).trim();
  }

  const tokens = parseCommandTokens(testCommand);
  if (!tokens || tokens.length === 0) {
    return {
      allowed: false,
      reason: 'Failed to parse command for path extraction',
    };
  }

  const firstToken = tokens[0];

  // Check if this is a command that doesn't need path validation
  if (SKIP_PATH_CHECK_COMMANDS.has(firstToken)) {
    return { allowed: 'skip' };
  }

  // Git commands: check if the subcommand needs path validation
  if (firstToken === 'git' && tokens.length > 1) {
    const subcommand = tokens[1];
    if (SKIP_PATH_CHECK_GIT_SUBCOMMANDS.has(subcommand)) {
      return { allowed: 'skip' };
    }
    // git diff / git grep: skip path check UNLESS --no-index is present.
    // --no-index makes these commands operate on arbitrary filesystem paths.
    if (subcommand === 'diff' || subcommand === 'grep') {
      const hasNoIndex = tokens.includes('--no-index', 2);
      if (!hasNoIndex) {
        return { allowed: 'skip' };
      }
      // Fall through to path validation — findCommandConfig will find
      // the 'git diff' / 'git grep' entry in ALLOWLIST_INDEX.
    }
  }

  // For commands in the allowlist, extract positional args as paths
  const match = findCommandConfig(tokens);

  let config: CommandReadOnlySpec;
  let commandTokens: number;

  if (match) {
    config = match.config;
    commandTokens = match.commandTokens;
  } else {
    // Try generic file-reading commands (regex-validated, not in allowlist)
    const genericConfig = GENERIC_FILE_READERS.get(firstToken);
    if (genericConfig) {
      config = genericConfig;
      commandTokens = 1;
    } else {
      // Command not in allowlist or generic readers — fail closed
      return {
        allowed: false,
        reason: 'Command not in path constraint config',
      };
    }
  }
  const positionals = extractPositionalArgs(tokens, commandTokens, config);

  // Fail closed: unknown flags detected that may carry file paths
  if (positionals === null) {
    return {
      allowed: false,
      reason: 'Command contains unknown flags that may carry file paths',
    };
  }

  const commandName = tokens.slice(0, commandTokens).join(' ');
  const isGrepLike =
    (commandTokens === 1 && (firstToken === 'grep' || firstToken === 'rg')) ||
    (commandTokens === 2 && firstToken === 'git' && tokens[1] === 'grep');
  const isFdLike =
    commandTokens === 1 && (firstToken === 'fd' || firstToken === 'fdfind');
  const isSed = commandTokens === 1 && firstToken === 'sed';
  const isJq = commandTokens === 1 && firstToken === 'jq';
  const rgFilesMode = isRgFilesMode(firstToken, commandTokens, tokens);

  // Validate positional args as paths
  if (positionals.length > 0) {
    // Detect whether pattern was already provided via -e/--regexp/-f/--file.
    // If pattern is flag-provided, every positional is an input path.
    let patternAlreadyProvided = false;
    if (isGrepLike) {
      patternAlreadyProvided = grepPatternProvidedByFlag(
        tokens,
        commandTokens,
        config,
      );
    }
    // sed: if -e/--expression or -f/--file was used, all positionals are input files
    let sedScriptProvidedByFlag = false;
    if (isSed) {
      sedScriptProvidedByFlag = hasFlagValue(
        tokens,
        commandTokens,
        ['-e', '--expression', '-f', '--file'],
        config,
      );
    }

    for (let idx = 0; idx < positionals.length; idx++) {
      const arg = positionals[idx];
      // Skip first positional as pattern ONLY if no -e/--regexp was found
      if (isGrepLike && idx === 0 && !patternAlreadyProvided && !rgFilesMode) {
        continue;
      }
      // fd/fdfind: first positional is the search pattern, rest are search roots
      if (isFdLike && idx === 0) {
        continue;
      }
      // sed: first positional is the script expression (not a path) when no -e/-f
      if (isSed && idx === 0 && !sedScriptProvidedByFlag) {
        continue;
      }
      // jq: first positional is the filter expression (not a path)
      if (isJq && idx === 0) {
        continue;
      }

      const pathResult = validatePathArg(
        arg,
        context,
        executionCwd,
        permissionCwd,
      );
      if (pathResult) return pathResult;
    }
  }

  // Validate path-carrying flag values for specific commands
  const pathValueFlags = PATH_VALUE_FLAGS[commandName] ?? [];
  if (pathValueFlags.length > 0) {
    const fileFlagPaths = extractFlagValues(
      tokens,
      commandTokens,
      pathValueFlags,
      config,
    );
    for (const flagPath of fileFlagPaths) {
      const pathResult = validatePathArg(
        flagPath,
        context,
        executionCwd,
        permissionCwd,
      );
      if (pathResult) return pathResult;
    }
  }

  return { allowed: true };
}
