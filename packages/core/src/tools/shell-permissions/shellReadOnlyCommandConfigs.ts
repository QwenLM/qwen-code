/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shell read-only command configurations and lookup index.
 *
 * This file stores all command read-only specifications (configs) and
 * the pre-built lookup index for O(1) matching. Extracted from the
 * monolithic shellReadOnlyValidation.ts for maintainability.
 */

import type {
  CommandReadOnlySpec,
  FlagArgType,
} from './shellCommandValidation.js';

// ============================================================================
// Git safe flag groups (shared across git subcommands)
// ============================================================================

const GIT_REF_SELECTION_FLAGS: Record<string, FlagArgType> = {
  '--all': 'none',
  '--branches': 'none',
  '--tags': 'none',
  '--remotes': 'none',
};

const GIT_DATE_FILTER_FLAGS: Record<string, FlagArgType> = {
  '--since': 'string',
  '--after': 'string',
  '--until': 'string',
  '--before': 'string',
};

const GIT_LOG_DISPLAY_FLAGS: Record<string, FlagArgType> = {
  '--oneline': 'none',
  '--graph': 'none',
  '--decorate': 'none',
  '--no-decorate': 'none',
  '--date': 'string',
  '--relative-date': 'none',
};

const GIT_COUNT_FLAGS: Record<string, FlagArgType> = {
  '--max-count': 'number',
  '-n': 'number',
};

const GIT_STAT_FLAGS: Record<string, FlagArgType> = {
  '--stat': 'none',
  '--numstat': 'none',
  '--shortstat': 'none',
  '--name-only': 'none',
  '--name-status': 'none',
};

const GIT_COLOR_FLAGS: Record<string, FlagArgType> = {
  '--color': 'none',
  '--no-color': 'none',
};

const GIT_PATCH_FLAGS: Record<string, FlagArgType> = {
  '--patch': 'none',
  '-p': 'none',
  '--no-patch': 'none',
  '--no-ext-diff': 'none',
  '-s': 'none',
};

const GIT_AUTHOR_FILTER_FLAGS: Record<string, FlagArgType> = {
  '--author': 'string',
  '--committer': 'string',
  '--grep': 'string',
};

const CHECKSUM_SAFE_FLAGS: Record<string, FlagArgType> = {
  '-b': 'none',
  '--binary': 'none',
  '-t': 'none',
  '--text': 'none',
  '--tag': 'none',
  '--quiet': 'none',
  '--status': 'none',
  '--strict': 'none',
  '-w': 'none',
};

const FD_SPEC: CommandReadOnlySpec = {
  safeFlags: {
    '-H': 'none',
    '--hidden': 'none',
    '-I': 'none',
    '--no-ignore': 'none',
    '--no-ignore-vcs': 'none',
    '--no-ignore-parent': 'none',
    '-s': 'none',
    '--case-sensitive': 'none',
    '-i': 'none',
    '--ignore-case': 'none',
    '-g': 'none',
    '--glob': 'none',
    '--regex': 'none',
    '-F': 'none',
    '--fixed-strings': 'none',
    '-a': 'none',
    '--absolute-path': 'none',
    '-L': 'none',
    '--follow': 'none',
    '-p': 'none',
    '--full-path': 'none',
    '-0': 'none',
    '--print0': 'none',
    '-1': 'none',
    '--strip-cwd-prefix': 'none',
    '--one-file-system': 'none',
    '--show-errors': 'none',
    '--no-hidden': 'none',
    '-d': 'number',
    '--max-depth': 'number',
    '--min-depth': 'number',
    '--exact-depth': 'number',
    '-t': 'string',
    '--type': 'string',
    '-e': 'string',
    '--extension': 'string',
    '-E': 'string',
    '--exclude': 'string',
    '--ignore-file': 'string',
    '-S': 'string',
    '--size': 'string',
    '--changed-within': 'string',
    '--changed-before': 'string',
    '--newer': 'string',
    '--older': 'string',
    '-o': 'string',
    '--owner': 'string',
    '--search-path': 'string',
    '--base-directory': 'string',
    '--path-separator': 'string',
    '--color': 'string',
    '-j': 'number',
    '--threads': 'number',
    '--max-results': 'number',
    '--max-buffer-time': 'number',
  },
  // SECURITY: -x/--exec, -X/--exec-batch execute arbitrary commands
  additionalIsDangerousCallback: (_rawCommand: string, args: string[]) =>
    args.some(
      (a) => a === '-x' || a === '--exec' || a === '-X' || a === '--exec-batch',
    ),
};

/** Flags in jq that consume the next argument (hoisted to avoid per-call alloc). */
const JQ_FLAGS_WITH_VALUE = new Set(['--indent', '--arg', '--argjson']);

/**
 * Detects dangerous 'w' (write to file) or 'e' (execute) flags in a sed
 * s/// substitution command. Input must already have the address stripped,
 * so it starts with 's<delim>...'.
 */
function hasUnsafeSedSubstitutionFlag(noAddr: string): boolean {
  if (noAddr.length < 2 || noAddr[0] !== 's') return false;

  const delimiter = noAddr[1];
  if (/\s/.test(delimiter)) return false;

  let pos = 2;
  for (let part = 0; part < 2; part++) {
    let foundDelimiter = false;
    while (pos < noAddr.length) {
      if (noAddr[pos] === '\\') {
        pos += 2;
        continue;
      }
      if (noAddr[pos] === delimiter) {
        foundDelimiter = true;
        pos++;
        break;
      }
      pos++;
    }
    if (!foundDelimiter) return false;
  }

  // Check flags directly without allocating a substring
  while (pos < noAddr.length && /[a-zA-Z0-9]/.test(noAddr[pos])) {
    if (noAddr[pos] === 'w' || noAddr[pos] === 'e') return true;
    pos++;
  }
  return false;
}

/**
 * Checks if a sed script contains dangerous commands:
 * w/W (write to file), e (execute), r/R (read external file),
 * or 'w'/'e' flags on s/// substitutions.
 */
function hasDangerousSedCommand(script: string): boolean {
  // Split on semicolons and newlines to get individual commands
  // (simplified — doesn't handle escaped semicolons in s///)
  const commands = script.split(/[;\n]/);
  for (const cmd of commands) {
    const trimmed = cmd.trim();
    // Strip leading address (line numbers, /regex/, $, etc.)
    // Addresses: N, N,N, /re/, /re/,/re/, $, 0~N, etc.
    const noAddr = trimmed
      .replace(/^[0-9~,$]*/, '')
      .replace(/^\/(?:[^/\\]|\\.)*\/,?/, '')
      .replace(/^\/(?:[^/\\]|\\.)*\//, '')
      .trim();

    // Check s/// substitution flags (w/e)
    if (hasUnsafeSedSubstitutionFlag(noAddr)) {
      return true;
    }

    // Single-letter commands that are dangerous. GNU/BSD sed accept the file
    // argument immediately after w/W/r/R, e.g. `1w/tmp/out`.
    if (/^[wWrR](?:\s|$|[^a-zA-Z0-9_])/.test(noAddr)) {
      return true;
    }
    if (/^e(?:\s|$|[^a-zA-Z0-9_])/.test(noAddr)) {
      return true;
    }
  }
  return false;
}

// ============================================================================
// Shared callback helpers
// ============================================================================

/**
 * Validates that a git command has at most one positional arg and that it
 * is a safe remote name. Used by `git remote show` and `git ls-remote`.
 *
 * @param strict - When true, additionally blocks URLs (`://`), SSH syntax (`@`),
 *   absolute paths, and path traversal (`..`). Needed for ls-remote which can
 *   contact arbitrary remotes.
 * @param allowSlash - Whether to allow `/` in remote names (e.g. fork-style
 *   refs like `origin/main`).
 */
function hasUnsafeRemotePositional(
  args: string[],
  opts: { strict?: boolean; allowSlash?: boolean } = {},
): boolean {
  const positionals = args.filter((a) => !a.startsWith('-'));
  if (positionals.length > 1) return true;
  if (positionals.length === 1) {
    const remote = positionals[0];
    if (opts.strict) {
      if (
        remote.includes('://') ||
        remote.includes('@') ||
        remote.startsWith('/') ||
        remote.includes('..')
      ) {
        return true;
      }
    }
    const pattern = opts.allowSlash
      ? /^[a-zA-Z0-9._/-]+$/
      : /^[a-zA-Z0-9._-]+$/;
    if (!pattern.test(remote)) return true;
  }
  return false;
}

function hasUnsafeLsRemotePositional(args: string[]): boolean {
  const positionals = extractNonFlagArgs(args, LS_REMOTE_FLAGS_WITH_VALUES);
  return hasUnsafeRemotePositional(positionals, {
    strict: true,
    allowSlash: true,
  });
}

function extractNonFlagArgs(
  args: string[],
  flagsWithValues = new Set<string>(),
): string[] {
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const flag = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
      if (flagsWithValues.has(flag) && !arg.includes('=')) {
        i++;
      }
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1) {
      const flag = arg.slice(0, 2);
      if (flagsWithValues.has(flag) && arg.length === 2) {
        i++;
      }
      continue;
    }
    positionals.push(arg);
  }
  return positionals;
}

const SAFE_HELP_TOPIC_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._+:-]*$/;
const SAFE_ACCOUNT_NAME_PATTERN = /^[a-zA-Z0-9._-]+$/;
const SAFE_LOCALE_CATEGORY_PATTERN = /^(?:LANG|LC_ALL|LC_[A-Z0-9_]+)$/;
const SAFE_LOCALE_POSITIONALS = new Set(['charmap']);
const SAFE_MAN_SECTION_PATTERN = /^[0-9][a-zA-Z]?$/;
const TPUT_SAFE_CAPABILITIES = new Set([
  'cols',
  'lines',
  'colors',
  'longname',
  'clear',
  'bold',
  'sgr0',
]);
const LS_REMOTE_FLAGS_WITH_VALUES = new Set(['--sort']);
const WHERE_BOOLEAN_FLAGS = new Set(['--where']);
const WHERE_FLAGS = new Set(['-w', '--where']);
const VERSION_FLAGS = new Set(['--version']);
const DF_FLAGS_WITH_VALUES = new Set([
  '-B',
  '--block-size',
  '-t',
  '--type',
  '-x',
  '--exclude-type',
]);

function hasSafeTopic(topic: string): boolean {
  return SAFE_HELP_TOPIC_PATTERN.test(topic);
}

function hasFlag(args: string[], flags: Set<string>): boolean {
  return args.some((arg) => {
    if (flags.has(arg)) return true;
    if (arg.startsWith('--') && arg.includes('=')) {
      return flags.has(arg.slice(0, arg.indexOf('=')));
    }
    return false;
  });
}

function hasBooleanFlagWithInlineValue(args: string[], flags: Set<string>) {
  return args.some(
    (arg) =>
      arg.startsWith('--') &&
      arg.includes('=') &&
      flags.has(arg.slice(0, arg.indexOf('='))),
  );
}

/**
 * Determines if a git subcommand has write-intent positional args.
 * Used by `git branch` and `git tag` callbacks which share the pattern:
 * - Reject if any short flag contains a "write" character
 * - Skip values consumed by flags that take arguments
 * - If a "list-like" flag is present, positional args are patterns (safe)
 * - Otherwise, positional args indicate write operations (dangerous)
 */
function hasWritePositionals(
  args: string[],
  opts: {
    writeFlagChars: Set<string>;
    flagsWithArg: Set<string>;
    listFlags: Set<string>;
    /** Whether to detect list flags inside bundled short flags (e.g., -ln → has 'l') */
    detectBundledListFlag?: boolean;
  },
): boolean {
  let pastDoubleDash = false;
  const positionals: string[] = [];
  let hasListFlag = false;
  let skipNext = false;

  for (const arg of args) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (arg === '--') {
      pastDoubleDash = true;
      continue;
    }
    if (pastDoubleDash) {
      positionals.push(arg);
      continue;
    }
    // Check for write flags in short flag tokens (single or bundled)
    if (arg.startsWith('-') && !arg.startsWith('--') && arg.length >= 2) {
      for (let i = 1; i < arg.length; i++) {
        if (opts.writeFlagChars.has(arg[i])) return true;
      }
      // Detect list flags in bundled short flags
      if (opts.detectBundledListFlag) {
        for (let i = 1; i < arg.length; i++) {
          if (opts.listFlags.has(`-${arg[i]}`)) {
            hasListFlag = true;
            break;
          }
        }
      }
    }
    if (opts.listFlags.has(arg)) hasListFlag = true;
    // Long flags with = inline value
    if (arg.startsWith('--') && arg.includes('=')) continue;
    // Flags that consume next arg
    if (opts.flagsWithArg.has(arg)) {
      skipNext = true;
      continue;
    }
    if (!arg.startsWith('-')) positionals.push(arg);
  }
  if (hasListFlag) return false;
  return positionals.length > 0;
}

// ============================================================================
// Git read-only subcommands with their allowed flags
// ============================================================================

const GIT_READ_ONLY_COMMANDS: Record<string, CommandReadOnlySpec> = {
  'git diff': {
    safeFlags: {
      ...GIT_STAT_FLAGS,
      ...GIT_COLOR_FLAGS,
      '--dirstat': 'none',
      '--summary': 'none',
      '--patch-with-stat': 'none',
      '--word-diff': 'none',
      '--word-diff-regex': 'string',
      '--color-words': 'none',
      '--no-renames': 'none',
      '--no-ext-diff': 'none',
      '--check': 'none',
      '--full-index': 'none',
      '--binary': 'none',
      '--abbrev': 'number',
      '--find-renames': 'none',
      '--find-copies': 'none',
      '--find-copies-harder': 'none',
      '--diff-algorithm': 'string',
      '--histogram': 'none',
      '--patience': 'none',
      '--minimal': 'none',
      '--ignore-space-at-eol': 'none',
      '--ignore-space-change': 'none',
      '--ignore-all-space': 'none',
      '--ignore-blank-lines': 'none',
      '--inter-hunk-context': 'number',
      '--function-context': 'none',
      '--exit-code': 'none',
      '--quiet': 'none',
      '--cached': 'none',
      '--staged': 'none',
      '--no-index': 'none',
      '--relative': 'string',
      '--diff-filter': 'string',
      '-p': 'none',
      '-u': 'none',
      '-M': 'none',
      '-C': 'none',
      '-B': 'none',
      '-D': 'none',
      '-R': 'none',
      // SECURITY: -S/-G/-O take REQUIRED string arguments
      '-S': 'string',
      '-G': 'string',
      '-O': 'string',
    },
  },
  'git log': {
    safeFlags: {
      ...GIT_LOG_DISPLAY_FLAGS,
      ...GIT_REF_SELECTION_FLAGS,
      ...GIT_DATE_FILTER_FLAGS,
      ...GIT_COUNT_FLAGS,
      ...GIT_STAT_FLAGS,
      ...GIT_COLOR_FLAGS,
      ...GIT_PATCH_FLAGS,
      ...GIT_AUTHOR_FILTER_FLAGS,
      '--abbrev-commit': 'none',
      '--full-history': 'none',
      '--dense': 'none',
      '--sparse': 'none',
      '--simplify-merges': 'none',
      '--ancestry-path': 'none',
      '--source': 'none',
      '--first-parent': 'none',
      '--merges': 'none',
      '--no-merges': 'none',
      '--reverse': 'none',
      '--walk-reflogs': 'none',
      '--skip': 'number',
      '--follow': 'none',
      '--no-walk': 'none',
      '--left-right': 'none',
      '--cherry-mark': 'none',
      '--cherry-pick': 'none',
      '--boundary': 'none',
      '--topo-order': 'none',
      '--date-order': 'none',
      '--author-date-order': 'none',
      '--pretty': 'string',
      '--format': 'string',
      '--diff-filter': 'string',
      '-S': 'string',
      '-G': 'string',
    },
  },
  'git show': {
    safeFlags: {
      ...GIT_LOG_DISPLAY_FLAGS,
      ...GIT_STAT_FLAGS,
      ...GIT_COLOR_FLAGS,
      ...GIT_PATCH_FLAGS,
      '--abbrev-commit': 'none',
      '--word-diff': 'none',
      '--word-diff-regex': 'string',
      '--color-words': 'none',
      '--pretty': 'string',
      '--format': 'string',
      '--first-parent': 'none',
      '--raw': 'none',
      '--diff-filter': 'string',
      '-m': 'none',
      '--quiet': 'none',
    },
  },
  'git status': {
    safeFlags: {
      '--short': 'none',
      '-s': 'none',
      '--branch': 'none',
      '-b': 'none',
      '--porcelain': 'none',
      '--long': 'none',
      '--verbose': 'none',
      '-v': 'none',
      '--untracked-files': 'string',
      '-u': 'string',
      '--ignored': 'none',
      '--ignore-submodules': 'string',
      '--column': 'none',
      '--no-column': 'none',
      '--ahead-behind': 'none',
      '--no-ahead-behind': 'none',
      '--renames': 'none',
      '--no-renames': 'none',
    },
  },
  'git blame': {
    safeFlags: {
      ...GIT_COLOR_FLAGS,
      '-L': 'string',
      '--porcelain': 'none',
      '-p': 'none',
      '--line-porcelain': 'none',
      '--incremental': 'none',
      '--root': 'none',
      '--show-stats': 'none',
      '--show-name': 'none',
      '--show-number': 'none',
      '-n': 'none',
      '--show-email': 'none',
      '-e': 'none',
      '-f': 'none',
      '--date': 'string',
      '-w': 'none',
      '--ignore-rev': 'string',
      '--ignore-revs-file': 'string',
      '-M': 'none',
      '-C': 'none',
      '--abbrev': 'number',
      '-s': 'none',
      '-l': 'none',
      '-t': 'none',
    },
  },
  'git ls-files': {
    safeFlags: {
      '--cached': 'none',
      '-c': 'none',
      '--deleted': 'none',
      '-d': 'none',
      '--modified': 'none',
      '-m': 'none',
      '--others': 'none',
      '-o': 'none',
      '--ignored': 'none',
      '-i': 'none',
      '--stage': 'none',
      '-s': 'none',
      '--killed': 'none',
      '-k': 'none',
      '--unmerged': 'none',
      '-u': 'none',
      '--directory': 'none',
      '--no-empty-directory': 'none',
      '--eol': 'none',
      '--full-name': 'none',
      '--abbrev': 'number',
      '--debug': 'none',
      '-z': 'none',
      '-t': 'none',
      '-v': 'none',
      '--exclude': 'string',
      '-x': 'string',
      '--exclude-from': 'string',
      '-X': 'string',
      '--exclude-standard': 'none',
      '--error-unmatch': 'none',
      '--recurse-submodules': 'none',
    },
  },
  'git rev-parse': {
    safeFlags: {
      '--show-toplevel': 'none',
      '--show-cdup': 'none',
      '--show-prefix': 'none',
      '--git-dir': 'none',
      '--git-common-dir': 'none',
      '--is-inside-git-dir': 'none',
      '--is-inside-work-tree': 'none',
      '--is-bare-repository': 'none',
      '--is-shallow-repository': 'none',
      '--resolve-git-dir': 'string',
      '--abbrev-ref': 'none',
      '--short': 'none',
      '--verify': 'none',
      '--symbolic': 'none',
      '--symbolic-full-ref': 'none',
      '--absolute-git-dir': 'none',
    },
  },
  'git describe': {
    safeFlags: {
      '--tags': 'none',
      '--all': 'none',
      '--long': 'none',
      '--abbrev': 'number',
      '--always': 'none',
      '--exact-match': 'none',
      '--contains': 'none',
      '--first-parent': 'none',
      '--match': 'string',
      '--exclude': 'string',
      '--dirty': 'none',
      '--broken': 'none',
    },
  },
  'git remote': {
    safeFlags: {
      '-v': 'none',
      '--verbose': 'none',
    },
    // Only allow bare 'git remote' or 'git remote -v/--verbose'
    additionalIsDangerousCallback: (_rawCommand: string, args: string[]) =>
      // Any positional arg (add, remove, set-url, etc.) is a write operation
      args.some((a) => !a.startsWith('-')),
  },
  'git branch': {
    safeFlags: {
      '--list': 'none',
      '-l': 'none',
      '-a': 'none',
      '--all': 'none',
      '-r': 'none',
      '--remotes': 'none',
      '--sort': 'string',
      '--color': 'none',
      '--no-color': 'none',
      '-v': 'none',
      '--verbose': 'none',
      '-vv': 'none',
      '--show-current': 'none',
      '--contains': 'string',
      '--no-contains': 'string',
      '--merged': 'string',
      '--no-merged': 'string',
      '--format': 'string',
      '--abbrev': 'number',
    },
    additionalIsDangerousCallback: (_rawCommand: string, args: string[]) =>
      hasWritePositionals(args, {
        writeFlagChars: new Set(['d', 'D', 'm', 'M', 'c', 'C']),
        flagsWithArg: new Set([
          '--sort',
          '--contains',
          '--no-contains',
          '--merged',
          '--no-merged',
          '--format',
          '--abbrev',
        ]),
        listFlags: new Set([
          '--list',
          '-l',
          '-a',
          '--all',
          '-r',
          '--remotes',
          '--show-current',
        ]),
      }),
  },
  'git tag': {
    safeFlags: {
      '--list': 'none',
      '-l': 'none',
      '-n': 'number',
      '--sort': 'string',
      '--color': 'none',
      '--no-color': 'none',
      '--contains': 'string',
      '--no-contains': 'string',
      '--merged': 'string',
      '--no-merged': 'string',
      '--format': 'string',
      '--points-at': 'string',
    },
    additionalIsDangerousCallback: (_rawCommand: string, args: string[]) =>
      hasWritePositionals(args, {
        writeFlagChars: new Set(['d', 'a', 's', 'u', 'f']),
        flagsWithArg: new Set([
          '-n',
          '--sort',
          '--contains',
          '--no-contains',
          '--merged',
          '--no-merged',
          '--format',
          '--points-at',
        ]),
        listFlags: new Set(['--list', '-l']),
        detectBundledListFlag: true,
      }),
  },
  'git shortlog': {
    safeFlags: {
      ...GIT_REF_SELECTION_FLAGS,
      ...GIT_DATE_FILTER_FLAGS,
      '-s': 'none',
      '--summary': 'none',
      '-n': 'none',
      '--numbered': 'none',
      '-e': 'none',
      '--email': 'none',
      '--group': 'string',
      '--format': 'string',
      '--no-merges': 'none',
      '--author': 'string',
    },
  },
  'git stash list': {
    safeFlags: {
      ...GIT_LOG_DISPLAY_FLAGS,
      ...GIT_COUNT_FLAGS,
    },
  },
  'git stash show': {
    safeFlags: {
      ...GIT_STAT_FLAGS,
      ...GIT_COLOR_FLAGS,
      ...GIT_PATCH_FLAGS,
      '--include-untracked': 'none',
      '-u': 'none',
    },
  },
  'git merge-base': {
    safeFlags: {
      '--all': 'none',
      '--octopus': 'none',
      '--is-ancestor': 'none',
      '--independent': 'none',
      '--fork-point': 'none',
    },
  },
  'git rev-list': {
    safeFlags: {
      ...GIT_REF_SELECTION_FLAGS,
      ...GIT_DATE_FILTER_FLAGS,
      ...GIT_COUNT_FLAGS,
      '--first-parent': 'none',
      '--merges': 'none',
      '--no-merges': 'none',
      '--reverse': 'none',
      '--ancestry-path': 'none',
      '--topo-order': 'none',
      '--date-order': 'none',
      '--author-date-order': 'none',
      '--count': 'none',
      '--left-right': 'none',
      '--cherry-mark': 'none',
      '--cherry-pick': 'none',
      '--objects': 'none',
      '--objects-edge': 'none',
      '--unpacked': 'none',
    },
  },
  'git for-each-ref': {
    safeFlags: {
      '--format': 'string',
      '--sort': 'string',
      '--count': 'number',
      '--color': 'none',
      '--no-color': 'none',
      '--shell': 'none',
      '--perl': 'none',
      '--python': 'none',
      '--tcl': 'none',
      '--contains': 'string',
      '--no-contains': 'string',
      '--merged': 'string',
      '--no-merged': 'string',
      '--points-at': 'string',
    },
  },
  'git cat-file': {
    safeFlags: {
      '-t': 'none',
      '-s': 'none',
      '-p': 'none',
      '-e': 'none',
      '--batch-check': 'none',
    },
  },
  'git reflog': {
    safeFlags: {
      ...GIT_LOG_DISPLAY_FLAGS,
      ...GIT_REF_SELECTION_FLAGS,
      ...GIT_DATE_FILTER_FLAGS,
      ...GIT_COUNT_FLAGS,
      ...GIT_AUTHOR_FILTER_FLAGS,
    },
    // Block write subcommands: expire, delete, exists
    additionalIsDangerousCallback: (_rawCommand: string, args: string[]) => {
      const DANGEROUS_SUBCOMMANDS = new Set(['expire', 'delete', 'exists']);
      for (const token of args) {
        if (!token || token.startsWith('-')) continue;
        if (DANGEROUS_SUBCOMMANDS.has(token)) return true;
        break; // First non-flag positional is safe (show/HEAD/ref)
      }
      return false;
    },
  },
  'git worktree list': {
    safeFlags: {
      '--porcelain': 'none',
    },
  },
  'git config': {
    safeFlags: {
      '--get': 'none',
      '--get-all': 'none',
      '--get-regexp': 'none',
      '--list': 'none',
      '-l': 'none',
      '--show-origin': 'none',
      '--show-scope': 'none',
      '--global': 'none',
      '--local': 'none',
      '--system': 'none',
      '--worktree': 'none',
      '--name-only': 'none',
      '--includes': 'none',
      '--default': 'string',
      '-z': 'none',
      '--null': 'none',
      '--type': 'string',
      '--bool': 'none',
      '--int': 'none',
      '--path': 'none',
    },
    // Only allow read operations: --get, --get-all, --get-regexp, --list, or bare key lookup
    additionalIsDangerousCallback: (_rawCommand: string, args: string[]) => {
      // If any write flag is present, reject
      const writeFlagPrefixes = [
        '--add',
        '--replace-all',
        '--unset',
        '--unset-all',
        '--rename-section',
        '--remove-section',
        '--edit',
        '-e',
      ];
      for (const arg of args) {
        if (
          writeFlagPrefixes.some((f) => arg === f || arg.startsWith(f + '='))
        ) {
          return true;
        }
      }
      // Must have a read flag or just a key name (single positional)
      const readFlags = ['--get', '--get-all', '--get-regexp', '--list', '-l'];
      const hasReadFlag = args.some((a) => readFlags.includes(a));
      if (hasReadFlag) return false;
      // Without a read flag, allow bare key lookup (at most 1 positional) but
      // reject if there are 2+ positionals (key + value = set operation)
      const positionals = args.filter((a) => !a.startsWith('-'));
      return positionals.length > 1;
    },
  },
  'git grep': {
    safeFlags: {
      ...GIT_COLOR_FLAGS,
      '-e': 'string',
      '-i': 'none',
      '--ignore-case': 'none',
      '-v': 'none',
      '--invert-match': 'none',
      '-w': 'none',
      '--word-regexp': 'none',
      '-F': 'none',
      '--fixed-strings': 'none',
      '-E': 'none',
      '--extended-regexp': 'none',
      '-P': 'none',
      '--perl-regexp': 'none',
      '-G': 'none',
      '--basic-regexp': 'none',
      '-n': 'none',
      '--line-number': 'none',
      '-l': 'none',
      '--files-with-matches': 'none',
      '--name-only': 'none',
      '-L': 'none',
      '--files-without-match': 'none',
      '-c': 'none',
      '--count': 'none',
      '-h': 'none',
      '-H': 'none',
      '--heading': 'none',
      '--break': 'none',
      '-p': 'none',
      '--show-function': 'none',
      '-W': 'none',
      '--function-context': 'none',
      '-A': 'number',
      '--after-context': 'number',
      '-B': 'number',
      '--before-context': 'number',
      '-C': 'number',
      '--context': 'number',
      '-o': 'none',
      '--only-matching': 'none',
      '--all-match': 'none',
      '--and': 'none',
      '--or': 'none',
      '--not': 'none',
      '--threads': 'number',
      '-q': 'none',
      '--quiet': 'none',
      '-z': 'none',
      '--null': 'none',
      '--recurse-submodules': 'none',
      '--untracked': 'none',
      '--no-index': 'none',
      '--max-depth': 'number',
      '-f': 'string',
    },
    // git grep is inherently read-only within the repo, no callback needed
  },
  'git remote show': {
    safeFlags: {
      '-n': 'none',
      '--no-query-remote': 'none',
    },
    additionalIsDangerousCallback: (_rawCommand: string, args: string[]) =>
      hasUnsafeRemotePositional(args),
  },
  'git ls-remote': {
    safeFlags: {
      '--heads': 'none',
      '--branches': 'none',
      '-h': 'none',
      '--tags': 'none',
      '-t': 'none',
      '--refs': 'none',
      '--symref': 'none',
      '-q': 'none',
      '--quiet': 'none',
      '--exit-code': 'none',
      '--get-url': 'none',
      '--sort': 'string',
    },
    // SECURITY: --upload-pack NOT in safeFlags (executes arbitrary command)
    additionalIsDangerousCallback: (_rawCommand: string, args: string[]) =>
      hasUnsafeLsRemotePositional(args),
  },
};

// ============================================================================
// Non-git read-only commands with their allowed flags
// ============================================================================

const SIMPLE_READ_ONLY_COMMANDS: Record<string, CommandReadOnlySpec> = {
  grep: {
    safeFlags: {
      '-e': 'string',
      '--regexp': 'string',
      '-f': 'string',
      '--file': 'string',
      '-F': 'none',
      '--fixed-strings': 'none',
      '-E': 'none',
      '--extended-regexp': 'none',
      '-P': 'none',
      '--perl-regexp': 'none',
      '-G': 'none',
      '--basic-regexp': 'none',
      '-i': 'none',
      '--ignore-case': 'none',
      '-v': 'none',
      '--invert-match': 'none',
      '-w': 'none',
      '--word-regexp': 'none',
      '-x': 'none',
      '--line-regexp': 'none',
      '-c': 'none',
      '--count': 'none',
      '--color': 'string',
      '--colour': 'string',
      '-L': 'none',
      '--files-without-match': 'none',
      '-l': 'none',
      '--files-with-matches': 'none',
      '-m': 'number',
      '--max-count': 'number',
      '-o': 'none',
      '--only-matching': 'none',
      '-q': 'none',
      '--quiet': 'none',
      '--silent': 'none',
      '-s': 'none',
      '--no-messages': 'none',
      '-b': 'none',
      '--byte-offset': 'none',
      '-H': 'none',
      '--with-filename': 'none',
      '-h': 'none',
      '--no-filename': 'none',
      '--label': 'string',
      '-n': 'none',
      '--line-number': 'none',
      '-T': 'none',
      '--initial-tab': 'none',
      '-Z': 'none',
      '--null': 'none',
      '-z': 'none',
      '--null-data': 'none',
      '-A': 'number',
      '--after-context': 'number',
      '-B': 'number',
      '--before-context': 'number',
      '-C': 'number',
      '--context': 'number',
      '-a': 'none',
      '--text': 'none',
      '--include': 'string',
      '--exclude': 'string',
      '--exclude-from': 'string',
      '--exclude-dir': 'string',
      '-r': 'none',
      '--recursive': 'none',
      '-R': 'none',
      '--dereference-recursive': 'none',
      '--line-buffered': 'none',
      '--help': 'none',
      '-V': 'none',
      '--version': 'none',
    },
  },
  rg: {
    safeFlags: {
      '-e': 'string',
      '--regexp': 'string',
      '-f': 'string',
      '--file': 'string',
      '-F': 'none',
      '--fixed-strings': 'none',
      '-i': 'none',
      '--ignore-case': 'none',
      '-S': 'none',
      '--smart-case': 'none',
      '-v': 'none',
      '--invert-match': 'none',
      '-w': 'none',
      '--word-regexp': 'none',
      '-x': 'none',
      '--line-regexp': 'none',
      '-c': 'none',
      '--count': 'none',
      '--count-matches': 'none',
      '-l': 'none',
      '--files-with-matches': 'none',
      '--files-without-match': 'none',
      '--files': 'none',
      '-m': 'number',
      '--max-count': 'number',
      '-o': 'none',
      '--only-matching': 'none',
      '-q': 'none',
      '--quiet': 'none',
      '-n': 'none',
      '--line-number': 'none',
      '-N': 'none',
      '--no-line-number': 'none',
      '-H': 'none',
      '--with-filename': 'none',
      '--no-filename': 'none',
      '-0': 'none',
      '--null': 'none',
      '--null-data': 'none',
      '-A': 'number',
      '--after-context': 'number',
      '-B': 'number',
      '--before-context': 'number',
      '-C': 'number',
      '--context': 'number',
      '--color': 'string',
      '--colors': 'string',
      '-p': 'none',
      '--pretty': 'none',
      '-g': 'string',
      '--glob': 'string',
      '--iglob': 'string',
      '-t': 'string',
      '--type': 'string',
      '-T': 'string',
      '--type-not': 'string',
      '--type-add': 'string',
      '--type-clear': 'string',
      '--type-list': 'none',
      '-u': 'none',
      '--unrestricted': 'none',
      '--hidden': 'none',
      '--no-ignore': 'none',
      '--no-ignore-vcs': 'none',
      '--no-ignore-parent': 'none',
      '-L': 'none',
      '--follow': 'none',
      '-j': 'number',
      '--threads': 'number',
      '--max-depth': 'number',
      '--maxdepth': 'number',
      '-d': 'number',
      '--max-filesize': 'string',
      '--sort': 'string',
      '--sortr': 'string',
      '--heading': 'none',
      '--no-heading': 'none',
      '--stats': 'none',
      '--trim': 'none',
      '--vimgrep': 'none',
      '--json': 'none',
      '--multiline': 'none',
      '-U': 'none',
      '--multiline-dotall': 'none',
      '--pcre2': 'none',
      '--no-pcre2-unicode': 'none',
      '--crlf': 'none',
      '--mmap': 'none',
      '--no-mmap': 'none',
      '--binary': 'none',
      '--no-binary': 'none',
      '--one-file-system': 'none',
      '--help': 'none',
      '--version': 'none',
      // SECURITY: --pre EXCLUDED (executes arbitrary preprocessor)
    },
  },
  find: {
    safeFlags: {
      '-name': 'string',
      '-iname': 'string',
      '-path': 'string',
      '-ipath': 'string',
      '-type': 'string',
      '-maxdepth': 'number',
      '-mindepth': 'number',
      '-newer': 'string',
      '-size': 'string',
      '-mtime': 'string',
      '-atime': 'string',
      '-ctime': 'string',
      '-mmin': 'string',
      '-amin': 'string',
      '-cmin': 'string',
      '-user': 'string',
      '-group': 'string',
      '-perm': 'string',
      '-empty': 'none',
      '-not': 'none',
      '-and': 'none',
      '-or': 'none',
      '-print': 'none',
      '-print0': 'none',
      '-prune': 'none',
      '-follow': 'none',
      '-L': 'none',
      '-H': 'none',
      '-P': 'none',
      '-depth': 'none',
      '-mount': 'none',
      '-xdev': 'none',
      '-daystart': 'none',
      '-regex': 'string',
      '-iregex': 'string',
      '-regextype': 'string',
      '-wholename': 'string',
      '-iwholename': 'string',
      '-samefile': 'string',
      '-links': 'string',
      '-inum': 'string',
      '-readable': 'none',
      '-writable': 'none',
      '-executable': 'none',
    },
    // Block -exec, -execdir, -ok, -delete, -fprint, etc.
    additionalIsDangerousCallback: (_rawCommand: string, args: string[]) => {
      const DANGEROUS_FIND_ARGS = new Set([
        '-exec',
        '-execdir',
        '-ok',
        '-okdir',
        '-delete',
        '-fprint',
        '-fprint0',
        '-fls',
        '-fprintf',
      ]);
      return args.some((a) => DANGEROUS_FIND_ARGS.has(a));
    },
  },
  sort: {
    safeFlags: {
      '-r': 'none',
      '--reverse': 'none',
      '-n': 'none',
      '--numeric-sort': 'none',
      '-f': 'none',
      '--ignore-case': 'none',
      '-u': 'none',
      '--unique': 'none',
      '-t': 'char',
      '--field-separator': 'char',
      '-k': 'string',
      '--key': 'string',
      '-s': 'none',
      '--stable': 'none',
      '-h': 'none',
      '--human-numeric-sort': 'none',
      '-M': 'none',
      '--month-sort': 'none',
      '-g': 'none',
      '--general-numeric-sort': 'none',
      '-V': 'none',
      '--version-sort': 'none',
      '-b': 'none',
      '--ignore-leading-blanks': 'none',
      '-d': 'none',
      '--dictionary-order': 'none',
      '-i': 'none',
      '--ignore-nonprinting': 'none',
      '-c': 'none',
      '--check': 'none',
      '-C': 'none',
      '--check=quiet': 'none',
      '-z': 'none',
      '--zero-terminated': 'none',
      '--parallel': 'number',
      '-S': 'string',
      '--buffer-size': 'string',
      '-T': 'string',
      '--temporary-directory': 'string',
    },
    // SECURITY: -o/--output writes to file — NOT in safeFlags
    // Additional callback not needed since -o not in safeFlags
  },
  tail: {
    safeFlags: {
      '-n': 'number',
      '--lines': 'number',
      '-c': 'number',
      '--bytes': 'number',
      '-q': 'none',
      '--quiet': 'none',
      '--silent': 'none',
      '-v': 'none',
      '--verbose': 'none',
      '--pid': 'number',
      '-z': 'none',
      '--zero-terminated': 'none',
    },
    // SECURITY: -f/-F/--follow NOT in safeFlags — they cause streaming/blocking
  },
  uniq: {
    safeFlags: {
      '-c': 'none',
      '--count': 'none',
      '-d': 'none',
      '--repeated': 'none',
      '-D': 'none',
      '--all-repeated': 'none',
      '-f': 'number',
      '--skip-fields': 'number',
      '-i': 'none',
      '--ignore-case': 'none',
      '-s': 'number',
      '--skip-chars': 'number',
      '-u': 'none',
      '--unique': 'none',
      '-w': 'number',
      '--check-chars': 'number',
      '-z': 'none',
      '--zero-terminated': 'none',
    },
    // SECURITY: uniq with 2 positional args writes to the second file
    additionalIsDangerousCallback: (_rawCommand: string, args: string[]) => {
      // Count non-flag positional arguments
      const positionals = args.filter((a) => !a.startsWith('-'));
      // uniq accepts at most 1 positional (input). 2nd positional is output file.
      return positionals.length > 1;
    },
  },
  // ---- Migrated from regex fallback to structured configs ----
  ls: {
    safeFlags: {
      '-l': 'none',
      '-a': 'none',
      '-A': 'none',
      '-h': 'none',
      '-R': 'none',
      '-r': 'none',
      '-t': 'none',
      '-S': 'none',
      '-1': 'none',
      '-d': 'none',
      '-i': 'none',
      '-s': 'none',
      '-F': 'none',
      '-p': 'none',
      '-G': 'none',
      '-g': 'none',
      '-o': 'none',
      '-n': 'none',
      '-Z': 'none',
      '--color': 'string',
      '--sort': 'string',
      '--time': 'string',
      '--group-directories-first': 'none',
      '--classify': 'none',
      '--no-group': 'none',
      '--human-readable': 'none',
      '--si': 'none',
      '--reverse': 'none',
      '--recursive': 'none',
      '--all': 'none',
      '--almost-all': 'none',
      '--directory': 'none',
      '--inode': 'none',
      '--size': 'none',
    },
  },
  cat: {
    safeFlags: {
      '-n': 'none',
      '--number': 'none',
      '-b': 'none',
      '--number-nonblank': 'none',
      '-s': 'none',
      '--squeeze-blank': 'none',
      '-v': 'none',
      '--show-nonprinting': 'none',
      '-E': 'none',
      '--show-ends': 'none',
      '-T': 'none',
      '--show-tabs': 'none',
      '-A': 'none',
      '--show-all': 'none',
      '-e': 'none',
      '-t': 'none',
    },
  },
  head: {
    safeFlags: {
      '-n': 'number',
      '--lines': 'number',
      '-c': 'number',
      '--bytes': 'number',
      '-q': 'none',
      '--quiet': 'none',
      '--silent': 'none',
      '-v': 'none',
      '--verbose': 'none',
      '-z': 'none',
      '--zero-terminated': 'none',
    },
  },
  wc: {
    safeFlags: {
      '-l': 'none',
      '--lines': 'none',
      '-w': 'none',
      '--words': 'none',
      '-c': 'none',
      '--bytes': 'none',
      '-m': 'none',
      '--chars': 'none',
      '-L': 'none',
      '--max-line-length': 'none',
    },
    // SECURITY: --files0-from is intentionally excluded. Its value is a list
    // file whose contents name additional files for wc to read, so validating
    // only the list file path cannot prove the resulting reads stay in-bounds.
  },
  stat: {
    safeFlags: {
      '-f': 'string',
      '--file-system': 'none',
      '-L': 'none',
      '--dereference': 'none',
      '-t': 'none',
      '--terse': 'none',
      '--format': 'string',
      '-c': 'string',
      '--printf': 'string',
    },
  },
  file: {
    safeFlags: {
      '-b': 'none',
      '--brief': 'none',
      '-i': 'none',
      '--mime': 'none',
      '--mime-type': 'none',
      '--mime-encoding': 'none',
      '-L': 'none',
      '--dereference': 'none',
      '-z': 'none',
      '--uncompress': 'none',
      '-h': 'none',
      '--no-dereference': 'none',
      '-p': 'none',
      '--preserve-date': 'none',
      '-s': 'none',
      '--special-files': 'none',
      '-r': 'none',
      '--raw': 'none',
      '-0': 'none',
      '--print0': 'none',
      '--separator': 'string',
    },
  },
  du: {
    safeFlags: {
      '-s': 'none',
      '--summarize': 'none',
      '-h': 'none',
      '--human-readable': 'none',
      '-a': 'none',
      '--all': 'none',
      '-c': 'none',
      '--total': 'none',
      '-d': 'number',
      '--max-depth': 'number',
      '-k': 'none',
      '-m': 'none',
      '-b': 'none',
      '--bytes': 'none',
      '--si': 'none',
      '-L': 'none',
      '--dereference': 'none',
      '-l': 'none',
      '--count-links': 'none',
      '-x': 'none',
      '--one-file-system': 'none',
      '--apparent-size': 'none',
      '--time': 'none',
      '-0': 'none',
      '--null': 'none',
      '--exclude': 'string',
      '--block-size': 'string',
      '-t': 'string',
      '--threshold': 'string',
    },
  },
  cut: {
    safeFlags: {
      '-d': 'char',
      '--delimiter': 'char',
      '-f': 'string',
      '--fields': 'string',
      '-c': 'string',
      '--characters': 'string',
      '-b': 'string',
      '--bytes': 'string',
      '-s': 'none',
      '--only-delimited': 'none',
      '--complement': 'none',
      '-z': 'none',
      '--zero-terminated': 'none',
      '--output-delimiter': 'string',
    },
  },
  diff: {
    safeFlags: {
      '-u': 'none',
      '--unified': 'none',
      '-c': 'none',
      '--context': 'none',
      '-r': 'none',
      '--recursive': 'none',
      '-q': 'none',
      '--brief': 'none',
      '-s': 'none',
      '--report-identical-files': 'none',
      '-y': 'none',
      '--side-by-side': 'none',
      '-i': 'none',
      '--ignore-case': 'none',
      '-w': 'none',
      '--ignore-all-space': 'none',
      '-b': 'none',
      '--ignore-space-change': 'none',
      '-B': 'none',
      '--ignore-blank-lines': 'none',
      '-N': 'none',
      '--new-file': 'none',
      '-a': 'none',
      '--text': 'none',
      '--color': 'string',
      '-U': 'number',
      '--from-file': 'string',
      '--to-file': 'string',
      '-X': 'string',
      '--exclude-from': 'string',
      '--exclude': 'string',
      '-x': 'string',
      '--tabsize': 'number',
      '-W': 'number',
      '--width': 'number',
      '--label': 'string',
      '-p': 'none',
      '--show-c-function': 'none',
      '-t': 'none',
      '--expand-tabs': 'none',
      '--suppress-common-lines': 'none',
      '-E': 'none',
      '--ignore-tab-expansion': 'none',
      '-Z': 'none',
      '--ignore-trailing-space': 'none',
    },
  },
  realpath: {
    safeFlags: {
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
  },
  readlink: {
    safeFlags: {
      '-f': 'none',
      '--canonicalize': 'none',
      '-e': 'none',
      '--canonicalize-existing': 'none',
      '-m': 'none',
      '--canonicalize-missing': 'none',
      '-n': 'none',
      '--no-newline': 'none',
      '-z': 'none',
      '--zero': 'none',
      '-v': 'none',
      '--verbose': 'none',
      '-q': 'none',
      '--quiet': 'none',
    },
  },
  sha256sum: {
    safeFlags: { ...CHECKSUM_SAFE_FLAGS },
  },
  sha1sum: {
    safeFlags: { ...CHECKSUM_SAFE_FLAGS },
  },
  md5sum: {
    safeFlags: { ...CHECKSUM_SAFE_FLAGS },
  },
  tree: {
    safeFlags: {
      '-a': 'none',
      '-d': 'none',
      '-f': 'none',
      '-i': 'none',
      '-l': 'none',
      '-q': 'none',
      '-N': 'none',
      '-p': 'none',
      '-u': 'none',
      '-g': 'none',
      '-s': 'none',
      '-h': 'none',
      '-D': 'none',
      '--inodes': 'none',
      '--device': 'none',
      '-F': 'none',
      '--dirsfirst': 'none',
      '--noreport': 'none',
      '-C': 'none',
      '--charset': 'string',
      '-L': 'number',
      '--filelimit': 'number',
      '-P': 'string',
      '-I': 'string',
      '--matchdirs': 'none',
      '--prune': 'none',
      '-n': 'none',
      '-J': 'none',
      '-X': 'none',
      '-H': 'string',
      '--timefmt': 'string',
      '-r': 'none',
      '-t': 'none',
      '-v': 'none',
      '-U': 'none',
      '--du': 'none',
      '--si': 'none',
      '--sort': 'string',
      '-x': 'none',
    },
    // SECURITY: -o/--output writes to file, --fromfile reads arbitrary listing
    additionalIsDangerousCallback: (_rawCommand: string, args: string[]) =>
      args.some(
        (a) =>
          a === '-o' ||
          a === '--output' ||
          a === '--fromfile' ||
          a.startsWith('--output='),
      ),
  },
  // ---- Phase 4B: process/system viewing commands ----
  groups: {
    safeFlags: {
      '--help': 'none',
      '--version': 'none',
    },
    additionalIsDangerousCallback: (_rawCommand: string, args: string[]) => {
      const positionals = extractNonFlagArgs(args);
      return positionals.some((arg) => !SAFE_ACCOUNT_NAME_PATTERN.test(arg));
    },
  },
  arch: {
    safeFlags: {
      '--help': 'none',
      '--version': 'none',
    },
    // On macOS, `arch -x86_64 command` executes a command under another
    // architecture. Keep this to metadata-only forms.
    additionalIsDangerousCallback: (_rawCommand: string, args: string[]) =>
      extractNonFlagArgs(args).length > 0,
  },
  locale: {
    safeFlags: {
      '-a': 'none',
      '--all-locales': 'none',
      '-m': 'none',
      '--charmaps': 'none',
      '-c': 'none',
      '--category-name': 'none',
      '-k': 'none',
      '--keyword-name': 'none',
      '--help': 'none',
      '--version': 'none',
    },
    additionalIsDangerousCallback: (_rawCommand: string, args: string[]) => {
      const positionals = extractNonFlagArgs(args);
      return positionals.some(
        (arg) =>
          !SAFE_LOCALE_CATEGORY_PATTERN.test(arg) &&
          !SAFE_LOCALE_POSITIONALS.has(arg),
      );
    },
  },
  tty: {
    safeFlags: {
      '-s': 'none',
      '--silent': 'none',
      '--quiet': 'none',
      '--help': 'none',
      '--version': 'none',
    },
    additionalIsDangerousCallback: (_rawCommand: string, args: string[]) =>
      extractNonFlagArgs(args).length > 0,
  },
  df: {
    safeFlags: {
      '-a': 'none',
      '--all': 'none',
      '-h': 'none',
      '--human-readable': 'none',
      '-H': 'none',
      '--si': 'none',
      '-k': 'none',
      '-m': 'none',
      '-P': 'none',
      '--portability': 'none',
      '-T': 'none',
      '--print-type': 'none',
      '-i': 'none',
      '--inodes': 'none',
      '-l': 'none',
      '--local': 'none',
      '--total': 'none',
      '-B': 'string',
      '--block-size': 'string',
      '-t': 'string',
      '--type': 'string',
      '-x': 'string',
      '--exclude-type': 'string',
    },
    // Keep df path-free for now: positional paths may disclose mounts for
    // arbitrary filesystem locations and should go through explicit approval.
    additionalIsDangerousCallback: (_rawCommand: string, args: string[]) =>
      extractNonFlagArgs(args, DF_FLAGS_WITH_VALUES).length > 0,
  },
  free: {
    safeFlags: {
      '-b': 'none',
      '--bytes': 'none',
      '-k': 'none',
      '--kibi': 'none',
      '--kilo': 'none',
      '-m': 'none',
      '--mebi': 'none',
      '--mega': 'none',
      '-g': 'none',
      '--gibi': 'none',
      '--giga': 'none',
      '-h': 'none',
      '--human': 'none',
      '--si': 'none',
      '-t': 'none',
      '--total': 'none',
      '-w': 'none',
      '--wide': 'none',
    },
    // SECURITY: -s/--seconds and -c/--count are intentionally excluded because
    // they can turn a simple query into repeated output.
  },
  ps: {
    safeFlags: {
      '-e': 'none',
      '-f': 'none',
      '-l': 'none',
      '-u': 'string',
      '-p': 'string',
      '-o': 'string',
      '--format': 'string',
      '--sort': 'string',
      '--no-headers': 'none',
      '--headers': 'none',
      '-w': 'none',
      '--wide': 'none',
      '-H': 'none',
      '--forest': 'none',
      '-L': 'none',
      '-T': 'none',
      '--pid': 'string',
      '--ppid': 'string',
    },
    // SECURITY: 'e' in BSD-style positional args exposes environment variables
    additionalIsDangerousCallback: (_rawCommand: string, args: string[]) => {
      for (const a of args) {
        if (a.startsWith('-')) continue;
        // BSD-style positional containing 'e' → leaks env vars
        if (a.includes('e')) return true;
      }
      return false;
    },
  },
  pgrep: {
    safeFlags: {
      '-f': 'none',
      '--full': 'none',
      '-l': 'none',
      '--list-name': 'none',
      '-a': 'none',
      '--list-full': 'none',
      '-i': 'none',
      '--ignore-case': 'none',
      '-x': 'none',
      '--exact': 'none',
      '-c': 'none',
      '--count': 'none',
      '-d': 'string',
      '--delimiter': 'string',
      '-n': 'none',
      '--newest': 'none',
      '-o': 'none',
      '--oldest': 'none',
      '-u': 'string',
      '--euid': 'string',
      '-U': 'string',
      '--uid': 'string',
      '-t': 'string',
      '--terminal': 'string',
      '-P': 'string',
      '--parent': 'string',
      '-v': 'none',
      '--inverse': 'none',
    },
  },
  date: {
    safeFlags: {
      '-u': 'none',
      '--utc': 'none',
      '--universal': 'none',
      '-I': 'string',
      '--iso-8601': 'string',
      '-R': 'none',
      '--rfc-email': 'none',
      '--rfc-2822': 'none',
      '-r': 'string',
      '--reference': 'string',
      '-d': 'string',
      '--date': 'string',
      '+%': 'none',
    },
    // date with no write flags is inherently safe — just reject --set
    additionalIsDangerousCallback: (_rawCommand: string, args: string[]) =>
      args.some((a) => a === '-s' || a === '--set' || a.startsWith('--set=')),
  },
  hostname: {
    safeFlags: {
      '-s': 'none',
      '--short': 'none',
      '-f': 'none',
      '--fqdn': 'none',
      '--long': 'none',
      '-d': 'none',
      '--domain': 'none',
      '-i': 'none',
      '--ip-address': 'none',
      '-I': 'none',
      '--all-ip-addresses': 'none',
      '-A': 'none',
      '--all-fqdns': 'none',
    },
    // Reject bare positional (sets hostname)
    additionalIsDangerousCallback: (_rawCommand: string, args: string[]) => {
      const positionals = args.filter((a) => !a.startsWith('-'));
      return positionals.length > 0;
    },
  },
  uptime: {
    safeFlags: {
      '-p': 'none',
      '--pretty': 'none',
      '-s': 'none',
      '--since': 'none',
    },
  },
  tput: {
    safeFlags: {},
    additionalIsDangerousCallback: (_rawCommand: string, args: string[]) => {
      const positionals = extractNonFlagArgs(args);
      return (
        positionals.length !== 1 || !TPUT_SAFE_CAPABILITIES.has(positionals[0])
      );
    },
  },
  man: {
    safeFlags: {
      '-w': 'none',
      '--where': 'none',
    },
    // Only allow path lookup forms. Rendering a page can invoke a pager from
    // PAGER/MANPAGER, so plain `man ls` is left to normal approval.
    additionalIsDangerousCallback: (_rawCommand: string, args: string[]) => {
      if (hasBooleanFlagWithInlineValue(args, WHERE_BOOLEAN_FLAGS)) {
        return true;
      }
      if (!hasFlag(args, WHERE_FLAGS)) return true;
      const positionals = extractNonFlagArgs(args);
      if (positionals.length === 1) return !hasSafeTopic(positionals[0]);
      if (positionals.length === 2) {
        return (
          !SAFE_MAN_SECTION_PATTERN.test(positionals[0]) ||
          !hasSafeTopic(positionals[1])
        );
      }
      return true;
    },
  },
  info: {
    safeFlags: {
      '--where': 'none',
      '-w': 'none',
      '--version': 'none',
    },
    // Keep to metadata-only forms. `info TOPIC` can open the interactive info
    // reader; --where/--version are simple local queries.
    additionalIsDangerousCallback: (_rawCommand: string, args: string[]) => {
      if (hasBooleanFlagWithInlineValue(args, WHERE_BOOLEAN_FLAGS)) {
        return true;
      }
      const positionals = extractNonFlagArgs(args);
      if (hasFlag(args, VERSION_FLAGS)) {
        return positionals.length > 0;
      }
      if (!hasFlag(args, WHERE_FLAGS)) return true;
      return positionals.length !== 1 || !hasSafeTopic(positionals[0]);
    },
  },
  help: {
    safeFlags: {
      '-d': 'none',
      '-m': 'none',
      '-s': 'none',
    },
    additionalIsDangerousCallback: (_rawCommand: string, args: string[]) => {
      const positionals = extractNonFlagArgs(args);
      return (
        positionals.length > 1 ||
        (positionals.length === 1 && !/^[a-zA-Z0-9_:-]+$/.test(positionals[0]))
      );
    },
  },
  // ---- Phase 4C: fd / fdfind ----
  fd: FD_SPEC,
  fdfind: FD_SPEC,
  // ---- Phase 4D: sed read-only subset ----
  sed: {
    safeFlags: {
      '-n': 'none',
      '--quiet': 'none',
      '--silent': 'none',
      '-e': 'string',
      '--expression': 'string',
      '-f': 'string',
      '--file': 'string',
      '-E': 'none',
      '-r': 'none',
      '--regexp-extended': 'none',
      '--posix': 'none',
      '-l': 'number',
      '--line-length': 'number',
      '-u': 'none',
      '--unbuffered': 'none',
      '-z': 'none',
      '--null-data': 'none',
      '--debug': 'none',
      '--follow-symlinks': 'none',
      '-s': 'none',
      '--separate': 'none',
    },
    // SECURITY: -i/--in-place writes files; sed script commands w/e/r/R/W can
    // write files, execute commands, or read arbitrary files.
    additionalIsDangerousCallback: (_rawCommand: string, args: string[]) => {
      // Block -i/--in-place (in-place editing)
      for (const a of args) {
        if (
          a === '-i' ||
          a === '--in-place' ||
          a.startsWith('-i') ||
          a.startsWith('--in-place=')
        ) {
          return true;
        }
      }
      // Collect sed script expressions from args.
      // Scripts can come from: -e 'script', --expression='script', or bare positional.
      const scripts: string[] = [];
      let skipNext = false;
      let foundScript = false;
      for (let i = 0; i < args.length; i++) {
        if (skipNext) {
          skipNext = false;
          continue;
        }
        const a = args[i];
        if (a === '-e' || a === '--expression') {
          if (i + 1 < args.length) {
            scripts.push(args[i + 1]);
            foundScript = true;
          }
          skipNext = true;
          continue;
        }
        if (a.startsWith('--expression=')) {
          scripts.push(a.slice('--expression='.length));
          foundScript = true;
          continue;
        }
        // -f/--file takes a script file path — skip it
        if (a === '-f' || a === '--file') {
          foundScript = true;
          skipNext = true;
          continue;
        }
        if (a.startsWith('--file=')) {
          foundScript = true;
          continue;
        }
        // Skip known flags that take values
        if (a === '-l' || a === '--line-length') {
          skipNext = true;
          continue;
        }
        if (a.startsWith('-') && a !== '--') continue;
        // First non-flag, non-consumed positional is the script if no -e/-f was found
        if (!foundScript) {
          scripts.push(a);
          foundScript = true;
          continue;
        }
        // Remaining positionals are input files — don't check here
      }
      // Check scripts for dangerous sed commands
      return scripts.some(hasDangerousSedCommand);
    },
  },
  // ---- Phase 4E: jq read-only subset ----
  jq: {
    safeFlags: {
      '-c': 'none',
      '--compact-output': 'none',
      '-r': 'none',
      '--raw-output': 'none',
      '--raw-output0': 'none',
      '-R': 'none',
      '--raw-input': 'none',
      '-S': 'none',
      '--sort-keys': 'none',
      '-e': 'none',
      '--exit-status': 'none',
      '-s': 'none',
      '--slurp': 'none',
      '-n': 'none',
      '--null-input': 'none',
      '-j': 'none',
      '--join-output': 'none',
      '-a': 'none',
      '--ascii-output': 'none',
      '--tab': 'none',
      '--indent': 'number',
      '--arg': 'string',
      '--argjson': 'string',
      '--args': 'none',
      '--jsonargs': 'none',
      '--color-output': 'none',
      '-C': 'none',
      '--monochrome-output': 'none',
      '-M': 'none',
    },
    // SECURITY: Block flags that read arbitrary files or execute code
    // -f/--from-file, --rawfile, --slurpfile, -L, --run-tests
    // Also block filter expressions that access environment variables
    additionalIsDangerousCallback: (_rawCommand: string, args: string[]) => {
      for (const a of args) {
        if (
          a === '-f' ||
          a === '--from-file' ||
          a.startsWith('--from-file=') ||
          a === '--rawfile' ||
          a === '--slurpfile' ||
          a === '-L' ||
          a.startsWith('-L') ||
          a === '--library-path' ||
          a.startsWith('--library-path=') ||
          a === '--run-tests' ||
          a.startsWith('--run-tests=')
        ) {
          return true;
        }
      }
      // Collect the jq filter expression to check for env access.
      // Filter is the first positional (non-flag) arg.
      let filter: string | null = null;
      let skipNext = false;
      for (let i = 0; i < args.length; i++) {
        if (skipNext) {
          skipNext = false;
          continue;
        }
        const a = args[i];
        if (a === '--') break;
        if (a.startsWith('--') && a.includes('=')) continue;
        if (a.startsWith('-') && a.length > 1) {
          if (JQ_FLAGS_WITH_VALUE.has(a)) {
            // --arg and --argjson take TWO arguments (name, value)
            if (a === '--arg' || a === '--argjson') {
              i += 2;
            } else {
              skipNext = true;
            }
            continue;
          }
          continue;
        }
        // First non-flag is the filter
        filter = a;
        break;
      }
      // Block filter expressions that access environment variables
      if (filter && (/\benv\b/.test(filter) || /\$ENV\b/.test(filter))) {
        return true;
      }
      return false;
    },
  },
};

// ============================================================================
// Combined command allowlist with pre-built lookup index
// ============================================================================

export const COMMAND_ALLOWLIST: Record<string, CommandReadOnlySpec> = {
  ...GIT_READ_ONLY_COMMANDS,
  ...SIMPLE_READ_ONLY_COMMANDS,
};

/**
 * Pre-built index for O(1) lookup by first token.
 * Maps first word → list of {keyTokens, config} sorted longest-first.
 */
export const ALLOWLIST_INDEX: Map<
  string,
  Array<{ keyTokens: string[]; config: CommandReadOnlySpec }>
> = (() => {
  const index = new Map<
    string,
    Array<{ keyTokens: string[]; config: CommandReadOnlySpec }>
  >();
  for (const [key, config] of Object.entries(COMMAND_ALLOWLIST)) {
    const keyTokens = key.split(' ');
    const firstWord = keyTokens[0];
    if (!index.has(firstWord)) {
      index.set(firstWord, []);
    }
    index.get(firstWord)!.push({ keyTokens, config });
  }
  // Sort each group by key length descending so longer matches are tried first
  for (const group of index.values()) {
    group.sort((a, b) => b.keyTokens.length - a.keyTokens.length);
  }
  return index;
})();

// ============================================================================
// Simple read-only regex patterns
// ============================================================================

/**
 * Commands validated via simple regex patterns.
 *
 * Only used for commands that either:
 * 1. Take no arguments (exact match): pwd, whoami
 * 2. Are pure string manipulation (no file I/O): basename, dirname
 * 3. Are simple system info: uname, id
 * 4. Are exact version checks: node -v, python --version
 * 5. Don't have complex flag semantics worth structured validation: which, type, tr, column, seq
 *
 * All commands that read files from user-specified paths have been migrated
 * to SIMPLE_READ_ONLY_COMMANDS for proper flag validation and path constraints.
 */
export const SIMPLE_READONLY_REGEXES: Array<{
  pattern: RegExp;
  description: string;
}> = [
  // Exact-match commands (no args)
  { pattern: /^pwd$/, description: 'pwd' },
  { pattern: /^whoami$/, description: 'whoami' },
  // Waiting has no filesystem effects; reject flags and non-duration arguments.
  {
    pattern: /^sleep(?:\s+(?:\d+(?:\.\d*)?|\.\d+)[smhd]?)+$/,
    description: 'sleep',
  },

  // Commands that don't read user-specified file paths
  {
    pattern: /^which(?:\s+[^<>()$`|{}&;\n\r]*)?$/,
    description: 'which (read-only)',
  },
  {
    pattern: /^type(?:\s+[^<>()$`|{}&;\n\r]*)?$/,
    description: 'type (read-only)',
  },

  // System info commands (no file path args)
  {
    pattern: /^uname(?:\s+[^<>()$`|{}&;\n\r]*)?$/,
    description: 'uname (read-only)',
  },
  {
    pattern: /^id(?:\s+[^<>()$`|{}&;\n\r]*)?$/,
    description: 'id (read-only)',
  },
  // Pure string manipulation (no file I/O, arg is a string not a path)
  {
    pattern: /^basename(?:\s+[^<>()$`|{}&;\n\r]*)?$/,
    description: 'basename',
  },
  {
    pattern: /^dirname(?:\s+[^<>()$`|{}&;\n\r]*)?$/,
    description: 'dirname',
  },

  // Simple text processing (output to stdout only, low-risk flag sets)
  {
    pattern: /^tr(?:\s+[^<>()$`|{}&;\n\r]*)?$/,
    description: 'tr (read-only)',
  },
  {
    pattern: /^column(?:\s+[^<>()$`|{}&;\n\r]*)?$/,
    description: 'column (read-only)',
  },
  {
    pattern: /^seq(?:\s+[^<>()$`|{}&;\n\r]*)?$/,
    description: 'seq (read-only)',
  },

  // Version checking - exact match only for security
  { pattern: /^node -v$/, description: 'node -v' },
  { pattern: /^node --version$/, description: 'node --version' },
  { pattern: /^python --version$/, description: 'python --version' },
  { pattern: /^python3 --version$/, description: 'python3 --version' },
];
