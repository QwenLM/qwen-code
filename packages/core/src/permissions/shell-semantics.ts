/**
 * @license
 * Copyright 2025 Qwen team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shell command semantic analysis for permission matching.
 *
 * Analyzes simple shell commands to extract "virtual tool operations" so that
 * Read / Edit / Write / WebFetch / ListFiles permission rules can match their
 * shell equivalents and prevent bypass via the shell tool.
 *
 * @example
 *   extractShellOperations('cat /etc/passwd', '/home/user')
 *   // → [{ virtualTool: 'read_file', filePath: '/etc/passwd' }]
 *
 * @example
 *   extractShellOperations('curl https://example.com/api', '/home/user')
 *   // → [{ virtualTool: 'web_fetch', domain: 'example.com' }]
 *
 * @example
 *   extractShellOperations('echo hi > /etc/motd', '/home/user')
 *   // → [{ virtualTool: 'write_file', filePath: '/etc/motd' }]
 *
 * Known limitations (cannot be statically analysed):
 *   - Shell variable expansion: `cat $FILE`
 *   - Command substitution: `cat $(find .)`
 *   - Interpreter scripts: `python script.py`, `node x.js`
 *   - Pipe targets: `find . | xargs cat`
 *   - Complex dynamic expressions: `eval "cat $f"`
 */

import nodePath from 'node:path';
import os from 'node:os';
import { stripShellWrapper } from '../utils/shell-utils.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { splitCompoundCommandSegments } from './rule-parser.js';

const shellSemanticsDebugLogger = createDebugLogger('SHELL_SEMANTICS');

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A virtual file or network operation extracted from a shell command.
 * Used to match Read / Edit / Write / WebFetch / ListFiles permission rules
 * against shell commands that perform equivalent operations.
 */
export interface ShellOperation {
  /**
   * The virtual tool this operation maps to.
   * Matches the canonical tool names used in the permission system.
   */
  virtualTool:
    | 'read_file'
    | 'list_directory'
    | 'edit'
    | 'write_file'
    | 'web_fetch'
    | 'grep_search';
  /** Absolute file or directory path (for file operations). */
  filePath?: string;
  /** Domain name without port (for web_fetch operations). */
  domain?: string;
  /**
   * True when this operation was extracted after a dynamic `cd` whose target
   * cannot be statically resolved. Consumers that enforce protected relative
   * paths should treat this as conservative signal, not as a concrete path.
   */
  cwdUnknown?: boolean;
  /**
   * True when `cwdUnknown` may affect the extracted file path. Absolute paths
   * do not depend on cwd; relative redirect/path arguments do.
   */
  pathMayDependOnCwd?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tokenizer
// ─────────────────────────────────────────────────────────────────────────────

interface ShellWord {
  /** Word value after quote removal, as the command sees it. */
  value: string;
  /** Source text of the word, quotes and escapes intact. */
  raw: string;
}

/**
 * Split a shell command into words, respecting single/double quotes and
 * backslash escapes, splitting on unquoted whitespace. Each word keeps both
 * its de-quoted value and its raw source text: bash decides whether a word is
 * an assignment before quote removal, so that decision has to look at `raw`.
 *
 * The input should be a single simple command (already split from compound
 * commands via `splitCompoundCommand`).
 */
function splitShellWords(command: string): ShellWord[] {
  const words: ShellWord[] = [];
  let current = '';
  let raw = '';
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  // Whether a word has begun, tracked apart from `current`: `''#x` starts a
  // word whose de-quoted value is still empty, and bash reads its `#` as data.
  let started = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;

    if (escaped) {
      current += ch;
      raw += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' && !inSingle) {
      escaped = true;
      raw += ch;
      started = true;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      raw += ch;
      started = true;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      raw += ch;
      started = true;
      continue;
    }
    // `#` starts a comment only at the start of a word, so `cd # note` must
    // not read `#` as the target, while `cd dir#part` keeps it.
    if (ch === '#' && !inSingle && !inDouble && !started) break;
    if (!inSingle && !inDouble && (ch === ' ' || ch === '\t')) {
      if (started) pushWord(words, current, raw);
      current = '';
      raw = '';
      started = false;
      continue;
    }
    current += ch;
    raw += ch;
    started = true;
  }
  if (started) pushWord(words, current, raw);
  return words;
}

function tokenize(command: string): string[] {
  return splitShellWords(command).map((word) => word.value);
}

/**
 * Quote a de-quoted word again so it survives being joined into a command
 * string. Words that need no quoting keep their spelling, which leaves flags
 * and simple operands readable.
 */
function quoteShellWord(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function pushWord(words: ShellWord[], value: string, raw: string): void {
  if (value === '{' || value === '}') return;
  const normalized = trimShellSyntax(value);
  if (normalized) words.push({ value: normalized, raw });
}

function trimShellSyntax(token: string): string {
  let start = 0;
  let end = token.length;

  while (start < end && token[start] === '(') {
    start++;
  }
  while (end > start) {
    const ch = token[end - 1];
    if (ch !== ')' && ch !== '&') break;
    end--;
  }

  return token.slice(start, end);
}

// ─────────────────────────────────────────────────────────────────────────────
// Path helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve a path argument to an absolute POSIX-style path.
 * Handles `~` home-directory expansion and relative paths.
 *
 * Always returns paths with forward-slash separators so that the resolved
 * paths are consistent across platforms and compatible with picomatch / the
 * permission rule matching system.
 */
function resolvePath(p: string, cwd: string): string {
  // Normalize inputs to forward slashes for consistent cross-platform handling
  const normP = p.replace(/\\/g, '/');
  const normCwd = cwd.replace(/\\/g, '/');

  if (normP === '~' || normP.startsWith('~/')) {
    const homeDir = os.homedir().replace(/\\/g, '/');
    const rest = normP.slice(1); // '' or '/some/path'
    // nodePath.posix.join handles the rest correctly:
    // join('C:/Users/foo', '/.ssh/id_rsa') → 'C:/Users/foo/.ssh/id_rsa'
    return rest ? nodePath.posix.join(homeDir, rest) : homeDir;
  }
  if (isShellAbsolutePath(normP)) {
    return normP;
  }
  return nodePath.posix.join(normCwd, normP);
}

function isShellAbsolutePath(p: string): boolean {
  return p.startsWith('/') || /^[A-Za-z]:\//.test(p.replace(/\\/g, '/'));
}

function isEnvAssignmentToken(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

/**
 * Return true if a token looks like a file/directory path argument, as
 * opposed to a flag, shell variable, number, or script expression.
 */
function looksLikePath(s: string): boolean {
  if (!s) return false;
  // Shell variable references
  if (s.startsWith('$')) return false;
  // Flags
  if (s.startsWith('-')) return false;
  // Pure integers — likely a count/size/mode argument (e.g. -n 10, chmod 755)
  if (/^\d+$/.test(s)) return false;
  // Script-like expressions (awk/sed programs, brace expansions)
  if (s.includes('{') || s.includes('}')) return false;
  // URLs are handled separately by the web-fetch handlers
  if (s.includes('://')) return false;
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Redirect extraction
// ─────────────────────────────────────────────────────────────────────────────

interface RedirectResult {
  readFiles: string[];
  writeFiles: string[];
}

/**
 * A bash /dev/tcp/<host>/<port> or /dev/udp/... redirect target opens a
 * network socket, not a file. Such targets must not be reported as file
 * reads/writes.
 */
function isNetworkPseudoDevice(target: string): boolean {
  return /^\/dev\/(tcp|udp)\//.test(target);
}

/**
 * Extract I/O redirections from a token array.
 *
 * Modifies `tokens` in-place to remove redirect operators and their targets.
 * Returns the absolute paths of redirect targets as read / write operations.
 *
 * Handles:
 *   `> file`   `>> file`  `< file`   (with or without space)
 *   `2> file`  `2>> file` `&> file`  `&>> file`
 *   Combined forms: `>file`, `>>file`, `1>file`, `2>/dev/null`
 */
function extractRedirects(tokens: string[], cwd: string): RedirectResult {
  const readFiles: string[] = [];
  const writeFiles: string[] = [];
  const toRemove = new Set<number>();

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;

    // ── Separate-token redirect operators ─────────────────────────────────
    if (tok === '>' || tok === '1>') {
      const target = tokens[i + 1];
      if (target && looksLikePath(target)) {
        if (!isNetworkPseudoDevice(target)) {
          writeFiles.push(resolvePath(target, cwd));
        }
        toRemove.add(i);
        toRemove.add(i + 1);
        i++;
      }
    } else if (tok === '>>' || tok === '1>>') {
      const target = tokens[i + 1];
      if (target && looksLikePath(target)) {
        if (!isNetworkPseudoDevice(target)) {
          writeFiles.push(resolvePath(target, cwd));
        }
        toRemove.add(i);
        toRemove.add(i + 1);
        i++;
      }
    } else if (tok === '<<' || tok === '<<-') {
      toRemove.add(i);
      if (tokens[i + 1]) {
        toRemove.add(i + 1);
        i++;
      }
    } else if (tok === '<') {
      const target = tokens[i + 1];
      if (target && looksLikePath(target)) {
        if (!isNetworkPseudoDevice(target)) {
          readFiles.push(resolvePath(target, cwd));
        }
        toRemove.add(i);
        toRemove.add(i + 1);
        i++;
      }
    } else if (tok === '2>' || tok === '2>>' || tok === '&>' || tok === '&>>') {
      // stderr / combined redirect — consume target
      const target = tokens[i + 1];
      if (target) {
        if (
          target !== '/dev/null' &&
          looksLikePath(target) &&
          !isNetworkPseudoDevice(target)
        ) {
          writeFiles.push(resolvePath(target, cwd));
        }
        toRemove.add(i);
        toRemove.add(i + 1);
        i++;
      }
    }
    // ── Combined redirect tokens without space: `>file`, `>>file`, etc. ───
    else {
      const m = tok.match(/^(<<-?|1>>|1>|>>|>|2>>|2>|&>>|&>|<)([\s\S]+)$/);
      if (m) {
        const op = m[1]!;
        const target = m[2]!;
        if (op.startsWith('<<')) {
          toRemove.add(i);
          continue;
        }
        if (
          target !== '/dev/null' &&
          looksLikePath(target) &&
          !isNetworkPseudoDevice(target)
        ) {
          if (op === '<') {
            readFiles.push(resolvePath(target, cwd));
          } else {
            writeFiles.push(resolvePath(target, cwd));
          }
        }
        toRemove.add(i);
      }
    }
  }

  // Remove redirect tokens from the array in-place
  const filtered = tokens.filter((_, idx) => !toRemove.has(idx));
  tokens.length = 0;
  tokens.push(...filtered);

  return { readFiles, writeFiles };
}

// ─────────────────────────────────────────────────────────────────────────────
// Argument parsing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract positional (non-flag) arguments from a token list.
 *
 * Flags starting with `-` are skipped. Flags listed in `flagsWithValue`
 * also consume the immediately following token (their value).
 */
function getPositionalArgs(
  args: string[],
  flagsWithValue: ReadonlySet<string> = new Set(),
): string[] {
  const positional: string[] = [];
  let skipNext = false;

  for (const arg of args) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (!arg.startsWith('-')) {
      positional.push(arg);
      continue;
    }
    const equalsIndex = arg.indexOf('=');
    if (equalsIndex > 0 && flagsWithValue.has(arg.slice(0, equalsIndex))) {
      continue;
    }
    // Flag: check if it consumes the next token
    if (flagsWithValue.has(arg)) {
      skipNext = true;
      continue;
    }
    for (const flag of flagsWithValue) {
      if (isAttachedShortFlagValue(arg, flag)) {
        break;
      }
      if (
        flag.startsWith('-') &&
        !flag.startsWith('--') &&
        flag.length === 2 &&
        hasCombinedShortFlag(arg, flag.slice(1))
      ) {
        skipNext = true;
        break;
      }
    }
    // Flags combined with their value in the same token (`-n10`) are ignored
    // because looksLikePath will filter out anything starting with `-`.
  }

  return positional;
}

function getFlagValue(
  args: string[],
  shortName: string,
  longName: string,
): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === shortName || arg === longName) {
      return args[i + 1];
    }
    if (arg.startsWith(`${longName}=`)) {
      return arg.slice(longName.length + 1);
    }
    if (isAttachedShortFlagValue(arg, shortName)) {
      return arg.slice(shortName.length).replace(/^=/, '');
    }
    if (hasCombinedShortFlag(arg, shortName.slice(1))) {
      return args[i + 1];
    }
  }
  return undefined;
}

function targetDirectoryPath(args: string[], cwd: string): string | undefined {
  const target = getFlagValue(args, '-t', '--target-directory');
  if (!target || !looksLikePath(target)) return undefined;
  return resolvePath(target, cwd);
}

function targetDirectoryWrites(
  targetDir: string,
  sources: string[],
): ShellOperation[] {
  return sources.map((source) => ({
    virtualTool: 'write_file',
    filePath: nodePath.posix.join(
      targetDir,
      nodePath.posix.basename(source.replace(/\\/g, '/')),
    ),
  }));
}

function writeOpForFlag(
  args: string[],
  cwd: string,
  shortName: string,
  longName: string,
): ShellOperation | undefined {
  const target = getFlagValue(args, shortName, longName);
  if (!target || !looksLikePath(target)) return undefined;
  return { virtualTool: 'write_file', filePath: resolvePath(target, cwd) };
}

function hasCombinedShortFlag(arg: string, flag: string): boolean {
  return (
    arg.startsWith('-') && !arg.startsWith('--') && arg.slice(1).includes(flag)
  );
}

function isAttachedShortFlagValue(arg: string, flag: string): boolean {
  return (
    flag.startsWith('-') &&
    !flag.startsWith('--') &&
    flag.length === 2 &&
    arg.startsWith(flag) &&
    arg.length > flag.length
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Command handler helpers
// ─────────────────────────────────────────────────────────────────────────────

type CommandHandler = (
  args: string[],
  cwd: string,
  homeUnknown?: boolean,
) => ShellOperation[];

/** Build read_file operations from positional path arguments. */
function readOps(
  args: string[],
  cwd: string,
  flagsWithValue?: ReadonlySet<string>,
): ShellOperation[] {
  return getPositionalArgs(args, flagsWithValue)
    .filter(looksLikePath)
    .map((p) => ({
      virtualTool: 'read_file' as const,
      filePath: resolvePath(p, cwd),
    }));
}

/** Build list_directory operations from positional path arguments.
 *  Defaults to cwd when no path args are given. */
function listOps(
  args: string[],
  cwd: string,
  flagsWithValue?: ReadonlySet<string>,
): ShellOperation[] {
  const dirs = getPositionalArgs(args, flagsWithValue).filter(looksLikePath);
  if (dirs.length === 0)
    return [{ virtualTool: 'list_directory', filePath: cwd }];
  return dirs.map((p) => ({
    virtualTool: 'list_directory' as const,
    filePath: resolvePath(p, cwd),
  }));
}

/** Extract URL domain and return a web_fetch operation, or null on failure. */
function webOp(url: string): ShellOperation | null {
  try {
    const normalized = url.includes('://') ? url : `https://${url}`;
    const domain = new URL(normalized).hostname;
    return domain ? { virtualTool: 'web_fetch', domain } : null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Command dispatch table
// ─────────────────────────────────────────────────────────────────────────────

const COMMANDS: Readonly<Record<string, CommandHandler>> = {
  // ── File-read commands ────────────────────────────────────────────────────

  cat: (a, d) => readOps(a, d),
  tac: (a, d) => readOps(a, d),
  nl: (a, d) => readOps(a, d),
  zcat: (a, d) => readOps(a, d),
  bzcat: (a, d) => readOps(a, d),
  xzcat: (a, d) => readOps(a, d),
  gzcat: (a, d) => readOps(a, d),
  lzcat: (a, d) => readOps(a, d),
  head: (a, d) => readOps(a, d, new Set(['-n', '-c', '--lines', '--bytes'])),
  tail: (a, d) =>
    readOps(
      a,
      d,
      new Set(['-n', '-c', '-s', '--lines', '--bytes', '--sleep-interval']),
    ),
  less: (a, d) =>
    readOps(
      a,
      d,
      new Set(['-b', '-h', '-j', '-p', '-x', '-y', '-z', '--shift', '--tabs']),
    ),
  more: (a, d) => readOps(a, d),
  most: (a, d) => readOps(a, d),
  wc: (a, d) => readOps(a, d),
  file: (a, d) =>
    readOps(
      a,
      d,
      new Set([
        '-m',
        '-e',
        '-F',
        '-P',
        '--magic-file',
        '--exclude',
        '--extension',
        '--separator',
      ]),
    ),
  stat: (a, d) =>
    readOps(
      a,
      d,
      new Set(['-c', '-f', '--format', '--printf', '--file-system']),
    ),
  readlink: (a, d) =>
    readOps(
      a,
      d,
      new Set([
        '-e',
        '-f',
        '-m',
        '-q',
        '-s',
        '-v',
        '-z',
        '--canonicalize',
        '--canonicalize-existing',
        '--canonicalize-missing',
        '--no-newline',
        '--quiet',
        '--silent',
        '--verbose',
        '--zero',
      ]),
    ),
  realpath: (a, d) =>
    readOps(
      a,
      d,
      new Set([
        '--relative-to',
        '--relative-base',
        '-e',
        '-m',
        '-s',
        '-z',
        '--canonicalize-existing',
        '--canonicalize-missing',
        '--logical',
        '--physical',
        '--no-symlinks',
        '--quiet',
        '--strip',
        '--zero',
      ]),
    ),
  diff: (a, d) =>
    readOps(
      a,
      d,
      new Set([
        '-u',
        '-U',
        '-c',
        '-C',
        '-I',
        '-x',
        '-X',
        '-W',
        '--label',
        '--to-file',
        '--from-file',
        '--width',
        '--horizon-lines',
        '--strip-trailing-cr',
        '--ignore-matching-lines',
        '--exclude',
        '--exclude-from',
      ]),
    ),
  diff3: (a, d) =>
    readOps(
      a,
      d,
      new Set([
        '-m',
        '-T',
        '-A',
        '-E',
        '-e',
        '-x',
        '-X',
        '-3',
        '-i',
        '--label',
      ]),
    ),
  sdiff: (a, d) =>
    readOps(
      a,
      d,
      new Set(['-o', '-w', '-W', '-s', '-i', '-b', '-B', '-E', '-H']),
    ),
  cmp: (a, d) =>
    readOps(
      a,
      d,
      new Set([
        '-i',
        '-l',
        '-n',
        '-s',
        '--ignore-initial',
        '--bytes',
        '--print-bytes',
        '--quiet',
        '--silent',
        '--verbose',
        '--zero',
      ]),
    ),
  md5sum: (a, d) => readOps(a, d),
  sha1sum: (a, d) => readOps(a, d),
  sha256sum: (a, d) => readOps(a, d),
  sha512sum: (a, d) => readOps(a, d),
  sha224sum: (a, d) => readOps(a, d),
  sha384sum: (a, d) => readOps(a, d),
  cksum: (a, d) => readOps(a, d),
  b2sum: (a, d) => readOps(a, d),
  sum: (a, d) => readOps(a, d),
  strings: (a, d) =>
    readOps(
      a,
      d,
      new Set([
        '-n',
        '-t',
        '-e',
        '-o',
        '-a',
        '--min-len',
        '--radix',
        '--encoding',
        '--file',
        '--print-file-name',
        '--data',
        '--all',
      ]),
    ),
  hexdump: (a, d) =>
    readOps(
      a,
      d,
      new Set([
        '-n',
        '-s',
        '-l',
        '-C',
        '-b',
        '-c',
        '-d',
        '-o',
        '-x',
        '-e',
        '-f',
        '-v',
      ]),
    ),
  xxd: (a, d) =>
    readOps(
      a,
      d,
      new Set([
        '-l',
        '-s',
        '-c',
        '-g',
        '-o',
        '-n',
        '-b',
        '-e',
        '-i',
        '-p',
        '-r',
        '-u',
        '-E',
      ]),
    ),
  od: (a, d) =>
    readOps(
      a,
      d,
      new Set([
        '-N',
        '-j',
        '-w',
        '-s',
        '-t',
        '-A',
        '-v',
        '--address-radix',
        '--endian',
        '--format',
        '--read-bytes',
        '--skip-bytes',
        '--strings',
        '--output-duplicates',
        '--width',
      ]),
    ),
  sort: (a, d) => {
    const output = writeOpForFlag(a, d, '-o', '--output');
    return [
      ...readOps(
        a,
        d,
        new Set([
          '-k',
          '-t',
          '-T',
          '--output',
          '-o',
          '--field-separator',
          '--key',
          '--temporary-directory',
          '--compress-program',
          '--batch-size',
          '--parallel',
          '--random-source',
          '--sort',
        ]),
      ),
      ...(output ? [output] : []),
    ];
  },
  uniq: (a, d) =>
    readOps(
      a,
      d,
      new Set([
        '-f',
        '-s',
        '-w',
        '-n',
        '--skip-fields',
        '--skip-chars',
        '--check-chars',
      ]),
    ),
  cut: (a, d) =>
    readOps(
      a,
      d,
      new Set([
        '-b',
        '-c',
        '-d',
        '-f',
        '--delimiter',
        '--fields',
        '--bytes',
        '--characters',
        '--output-delimiter',
      ]),
    ),
  paste: (a, d) =>
    readOps(a, d, new Set(['-d', '-s', '--delimiters', '--serial'])),
  join: (a, d) =>
    readOps(
      a,
      d,
      new Set([
        '-t',
        '-1',
        '-2',
        '-j',
        '-o',
        '-a',
        '-e',
        '--field',
        '--header',
        '--check-order',
        '--nocheck-order',
        '--zero-terminated',
      ]),
    ),
  column: (a, d) =>
    readOps(
      a,
      d,
      new Set([
        '-t',
        '-s',
        '-n',
        '-c',
        '-o',
        '-x',
        '--table',
        '--separator',
        '--output-separator',
        '--fillrows',
      ]),
    ),
  fold: (a, d) =>
    readOps(
      a,
      d,
      new Set(['-w', '-b', '-s', '--width', '--bytes', '--spaces']),
    ),
  expand: (a, d) => readOps(a, d, new Set(['-t', '--tabs', '--initial'])),
  unexpand: (a, d) =>
    readOps(a, d, new Set(['-t', '-a', '--tabs', '--all', '--first-only'])),
  base64: (a, d) =>
    readOps(
      a,
      d,
      new Set(['-d', '-i', '-w', '--decode', '--ignore-garbage', '--wrap']),
    ),
  base32: (a, d) =>
    readOps(
      a,
      d,
      new Set(['-d', '-i', '-w', '--decode', '--ignore-garbage', '--wrap']),
    ),
  tr: (a, d) => readOps(a, d),

  // ── Grep / search commands ────────────────────────────────────────────────

  grep: (args, cwd) => {
    const hasPatternFlag = args.some(
      (a) =>
        a === '-e' || a === '-f' || a.startsWith('-e') || a.startsWith('-f'),
    );
    const isRecursive = args.some((a) =>
      ['-r', '-R', '--recursive', '--dereference-recursive'].includes(a),
    );
    const flagsWithValue = new Set([
      '-e',
      '-f',
      '-m',
      '-A',
      '-B',
      '-C',
      '--context',
      '--include',
      '--exclude',
      '--exclude-dir',
      '--max-count',
      '--after-context',
      '--before-context',
      '-n',
      '--line-number',
      '--label',
      '-D',
      '--devices',
      '--max-depth',
      '-X',
      '--exclude-from',
    ]);
    const positional = getPositionalArgs(args, flagsWithValue).filter(
      looksLikePath,
    );
    // If -e/-f was used, there is no positional pattern; all positionals are paths.
    // Otherwise, the first positional is the pattern and the rest are paths.
    const filePaths = hasPatternFlag ? positional : positional.slice(1);
    const tool: 'read_file' | 'list_directory' = isRecursive
      ? 'list_directory'
      : 'read_file';
    return filePaths.map((p) => ({
      virtualTool: tool,
      filePath: resolvePath(p, cwd),
    }));
  },
  egrep: (a, d) => (COMMANDS['grep'] as CommandHandler)(a, d),
  fgrep: (a, d) => (COMMANDS['grep'] as CommandHandler)(a, d),
  zgrep: (a, d) => (COMMANDS['grep'] as CommandHandler)(a, d),
  bzgrep: (a, d) => (COMMANDS['grep'] as CommandHandler)(a, d),

  rg: (args, cwd) => {
    // ripgrep: recursive by default; first non-flag positional = pattern
    const hasPatternFlag = args.some((a) => a === '-e' || a === '-f');
    const flagsWithValue = new Set([
      '-e',
      '-f',
      '-m',
      '-A',
      '-B',
      '-C',
      '-t',
      '-T',
      '-g',
      '--iglob',
      '--glob',
      '--type',
      '--type-not',
      '--max-count',
      '--max-depth',
      '--context',
      '--after-context',
      '--before-context',
      '-M',
      '--max-columns',
      '--field-match-separator',
    ]);
    const positional = getPositionalArgs(args, flagsWithValue).filter(
      looksLikePath,
    );
    const filePaths = hasPatternFlag ? positional : positional.slice(1);
    return filePaths.map((p) => ({
      virtualTool: 'list_directory' as const,
      filePath: resolvePath(p, cwd),
    }));
  },

  ag: (args, cwd) => {
    const hasPatternFlag = args.some((a) => a === '-e');
    const flagsWithValue = new Set([
      '-e',
      '-m',
      '-A',
      '-B',
      '-C',
      '--depth',
      '--file-search-regex',
      '--file-search-regex-i',
      '--ignore',
      '--ignore-dir',
      '-n',
    ]);
    const positional = getPositionalArgs(args, flagsWithValue).filter(
      looksLikePath,
    );
    const filePaths = hasPatternFlag ? positional : positional.slice(1);
    return filePaths.map((p) => ({
      virtualTool: 'list_directory' as const,
      filePath: resolvePath(p, cwd),
    }));
  },

  ack: (args, cwd) => {
    const flagsWithValue = new Set([
      '-m',
      '-A',
      '-B',
      '-C',
      '--type',
      '--ignore-dir',
      '--ignore-file',
      '--ignore-directory',
      '-n',
    ]);
    // ack: first positional = pattern, rest = paths
    const positional = getPositionalArgs(args, flagsWithValue).filter(
      looksLikePath,
    );
    return positional.slice(1).map((p) => ({
      virtualTool: 'list_directory' as const,
      filePath: resolvePath(p, cwd),
    }));
  },

  // ── Directory-listing commands ────────────────────────────────────────────

  ls: (a, d) => listOps(a, d),
  dir: (a, d) => listOps(a, d),
  vdir: (a, d) => listOps(a, d),
  exa: (a, d) =>
    listOps(
      a,
      d,
      new Set([
        '-L',
        '--level',
        '--sort',
        '--color',
        '--colour',
        '--group',
        '-I',
        '--ignore-glob',
      ]),
    ),
  eza: (a, d) =>
    listOps(
      a,
      d,
      new Set([
        '-L',
        '--level',
        '--sort',
        '--color',
        '--colour',
        '--group',
        '-I',
        '--ignore-glob',
      ]),
    ),
  lsd: (a, d) =>
    listOps(
      a,
      d,
      new Set([
        '--depth',
        '--color',
        '--icon',
        '--icon-theme',
        '--date',
        '--size',
        '--blocks',
        '--header',
        '--classic',
        '--no-symlink',
        '--ignore-glob',
        '-I',
      ]),
    ),

  find: (args, cwd, homeUnknown) => {
    // `find [starting-point...] [expression]`
    // Starting points come before any expression keyword beginning with `-` or `(`.
    const expressionKeywords = new Set([
      '-name',
      '-iname',
      '-path',
      '-ipath',
      '-regex',
      '-iregex',
      '-type',
      '-maxdepth',
      '-mindepth',
      '-newer',
      '-mtime',
      '-atime',
      '-ctime',
      '-size',
      '-user',
      '-group',
      '-perm',
      '-links',
      '-inum',
      '-exec',
      '-execdir',
      '-ok',
      '-okdir',
      '-print',
      '-print0',
      '-ls',
      '-delete',
      '-prune',
      '-depth',
      '-empty',
      '-readable',
      '-writable',
      '-executable',
      '-follow',
      '-xdev',
      '-mount',
      '-true',
      '-false',
      '-not',
      '!',
      '-a',
      '-and',
      '-o',
      '-or',
    ]);
    const startingPoints: string[] = [];
    for (const arg of args) {
      if (
        arg.startsWith('-') ||
        arg === '(' ||
        arg === ')' ||
        expressionKeywords.has(arg)
      )
        break;
      if (looksLikePath(arg)) startingPoints.push(resolvePath(arg, cwd));
    }
    if (startingPoints.length === 0) {
      return [
        { virtualTool: 'list_directory', filePath: cwd },
        ...extractFindExecOps(args, cwd, homeUnknown),
      ];
    }
    return [
      ...startingPoints.map((p) => ({
        virtualTool: 'list_directory' as const,
        filePath: p,
      })),
      ...extractFindExecOps(args, cwd, homeUnknown),
    ];
  },

  tree: (args, cwd) =>
    listOps(
      args,
      cwd,
      new Set([
        '-L',
        '-P',
        '-I',
        '-o',
        '-n',
        '-H',
        '-T',
        '--charset',
        '--filelimit',
        '--matchdirs',
        '--dirsfirst',
        '-J',
        '-X',
        '--du',
        '--si',
      ]),
    ),

  du: (args, cwd) =>
    listOps(
      args,
      cwd,
      new Set([
        '-d',
        '--max-depth',
        '--threshold',
        '-t',
        '--block-size',
        '-B',
        '--time-style',
        '--exclude',
        '-X',
        '--time',
        '--output',
      ]),
    ),

  // ── File-write commands (create or overwrite) ─────────────────────────────

  touch: (args, cwd) =>
    getPositionalArgs(
      args,
      new Set(['-t', '-r', '--reference', '--date', '-d', '--time']),
    )
      .filter(looksLikePath)
      .map((p) => ({
        virtualTool: 'write_file' as const,
        filePath: resolvePath(p, cwd),
      })),

  mkdir: (args, cwd) =>
    getPositionalArgs(args, new Set(['-m', '--mode', '-Z', '--context']))
      .filter(looksLikePath)
      .map((p) => ({
        virtualTool: 'write_file' as const,
        filePath: resolvePath(p, cwd),
      })),

  mkfifo: (args, cwd) =>
    getPositionalArgs(args, new Set(['-m', '--mode', '-Z']))
      .filter(looksLikePath)
      .map((p) => ({
        virtualTool: 'write_file' as const,
        filePath: resolvePath(p, cwd),
      })),

  tee: (args, cwd) =>
    getPositionalArgs(args)
      .filter(looksLikePath)
      .map((p) => ({
        virtualTool: 'write_file' as const,
        filePath: resolvePath(p, cwd),
      })),

  cp: (args, cwd) => {
    const targetDir = targetDirectoryPath(args, cwd);
    const flagsWithValue = new Set([
      '-S',
      '--suffix',
      '-t',
      '--target-directory',
      '--backup',
      '--no-target-directory',
      '--sparse',
      '--reflink',
      '-Z',
      '--context',
      '--copy-contents',
    ]);
    const positional = getPositionalArgs(args, flagsWithValue).filter(
      looksLikePath,
    );
    if (positional.length === 0) return [];
    if (targetDir) {
      return [
        ...positional.map((p) => ({
          virtualTool: 'read_file' as const,
          filePath: resolvePath(p, cwd),
        })),
        ...targetDirectoryWrites(targetDir, positional),
      ];
    }
    if (positional.length === 1) {
      return [
        {
          virtualTool: 'read_file',
          filePath: resolvePath(positional[0]!, cwd),
        },
      ];
    }
    const srcs = positional.slice(0, -1);
    const dst = positional[positional.length - 1]!;
    return [
      ...srcs.map((p) => ({
        virtualTool: 'read_file' as const,
        filePath: resolvePath(p, cwd),
      })),
      { virtualTool: 'write_file' as const, filePath: resolvePath(dst, cwd) },
    ];
  },

  mv: (args, cwd) => {
    const targetDir = targetDirectoryPath(args, cwd);
    const flagsWithValue = new Set([
      '-S',
      '--suffix',
      '-t',
      '--target-directory',
      '--backup',
      '-Z',
      '--context',
    ]);
    const positional = getPositionalArgs(args, flagsWithValue).filter(
      looksLikePath,
    );
    if (targetDir && positional.length > 0) {
      return [
        ...positional.map((p) => ({
          virtualTool: 'edit' as const,
          filePath: resolvePath(p, cwd),
        })),
        ...targetDirectoryWrites(targetDir, positional),
      ];
    }
    if (positional.length < 2) return [];
    const srcs = positional.slice(0, -1);
    const dst = positional[positional.length - 1]!;
    return [
      // The source files are edited (moved away — their original location changes)
      ...srcs.map((p) => ({
        virtualTool: 'edit' as const,
        filePath: resolvePath(p, cwd),
      })),
      { virtualTool: 'write_file' as const, filePath: resolvePath(dst, cwd) },
    ];
  },

  install: (args, cwd) => {
    const targetDir = targetDirectoryPath(args, cwd);
    const flagsWithValue = new Set([
      '-m',
      '--mode',
      '-o',
      '--owner',
      '-g',
      '--group',
      '-S',
      '--suffix',
      '-t',
      '--target-directory',
      '-T',
      '--no-target-directory',
      '-Z',
      '--context',
      '-C',
      '--compare',
    ]);
    const positional = getPositionalArgs(args, flagsWithValue).filter(
      looksLikePath,
    );
    if (targetDir && positional.length > 0) {
      return [
        ...positional.map((p) => ({
          virtualTool: 'read_file' as const,
          filePath: resolvePath(p, cwd),
        })),
        ...targetDirectoryWrites(targetDir, positional),
      ];
    }
    if (positional.length < 2) return [];
    const srcs = positional.slice(0, -1);
    const dst = positional[positional.length - 1]!;
    return [
      ...srcs.map((p) => ({
        virtualTool: 'read_file' as const,
        filePath: resolvePath(p, cwd),
      })),
      { virtualTool: 'write_file', filePath: resolvePath(dst, cwd) },
    ];
  },

  dd: (args, cwd) => {
    // dd if=input of=output — arguments are key=value pairs, not flags
    const ops: ShellOperation[] = [];
    for (const arg of args) {
      if (arg.startsWith('if=')) {
        const p = arg.slice(3);
        if (looksLikePath(p)) {
          ops.push({ virtualTool: 'read_file', filePath: resolvePath(p, cwd) });
        }
      } else if (arg.startsWith('of=')) {
        const p = arg.slice(3);
        if (looksLikePath(p)) {
          ops.push({
            virtualTool: 'write_file',
            filePath: resolvePath(p, cwd),
          });
        }
      }
    }
    return ops;
  },

  rsync: (args, cwd) => {
    const positional = getPositionalArgs(
      args,
      new Set([
        '-e',
        '--rsh',
        '--rsync-path',
        '--backup-dir',
        '--suffix',
        '--files-from',
        '--include-from',
        '--exclude-from',
        '--filter',
      ]),
    ).filter(looksLikePath);
    if (positional.length === 0) return [];
    if (positional.length === 1) {
      return [
        {
          virtualTool: 'read_file',
          filePath: resolvePath(positional[0]!, cwd),
        },
      ];
    }
    const srcs = positional.slice(0, -1);
    const dst = positional[positional.length - 1]!;
    return [
      ...srcs.map((p) => ({
        virtualTool: 'read_file' as const,
        filePath: resolvePath(p, cwd),
      })),
      { virtualTool: 'write_file' as const, filePath: resolvePath(dst, cwd) },
    ];
  },

  ln: (args, cwd) => {
    // ln [-s] TARGET LINKNAME — the link being created is a write operation
    const targetDir = targetDirectoryPath(args, cwd);
    const positional = getPositionalArgs(
      args,
      new Set(['-S', '--suffix', '-t', '--target-directory', '-b', '--backup']),
    ).filter(looksLikePath);
    if (targetDir && positional.length > 0) {
      return [
        ...positional.map((p) => ({
          virtualTool: 'read_file' as const,
          filePath: resolvePath(p, cwd),
        })),
        ...targetDirectoryWrites(targetDir, positional),
      ];
    }
    if (positional.length < 2) return [];
    const targets = positional.slice(0, -1);
    const linkname = positional[positional.length - 1]!;
    return [
      ...targets.map((p) => ({
        virtualTool: 'read_file' as const,
        filePath: resolvePath(p, cwd),
      })),
      { virtualTool: 'write_file', filePath: resolvePath(linkname, cwd) },
    ];
  },

  // ── File-edit commands (modify or delete existing content) ────────────────

  rm: (args, cwd) =>
    getPositionalArgs(args, new Set(['--interactive']))
      .filter(looksLikePath)
      .map((p) => ({
        virtualTool: 'edit' as const,
        filePath: resolvePath(p, cwd),
      })),

  rmdir: (args, cwd) =>
    getPositionalArgs(
      args,
      new Set(['--ignore-fail-on-non-empty', '-p', '--parents']),
    )
      .filter(looksLikePath)
      .map((p) => ({
        virtualTool: 'edit' as const,
        filePath: resolvePath(p, cwd),
      })),

  unlink: (args, cwd) =>
    getPositionalArgs(args)
      .filter(looksLikePath)
      .map((p) => ({
        virtualTool: 'edit' as const,
        filePath: resolvePath(p, cwd),
      })),

  shred: (args, cwd) =>
    getPositionalArgs(
      args,
      new Set(['-n', '--iterations', '-s', '--size', '--random-source']),
    )
      .filter(looksLikePath)
      .map((p) => ({
        virtualTool: 'edit' as const,
        filePath: resolvePath(p, cwd),
      })),

  truncate: (args, cwd) =>
    getPositionalArgs(
      args,
      new Set([
        '-s',
        '--size',
        '-r',
        '--reference',
        '-o',
        '-I',
        '-c',
        '--io-blocks',
        '--no-create',
      ]),
    )
      .filter(looksLikePath)
      .map((p) => ({
        virtualTool: 'edit' as const,
        filePath: resolvePath(p, cwd),
      })),

  chmod: (args, cwd) => {
    // chmod [opts] MODE file... — the mode is the first positional arg.
    // Apply slice(1) BEFORE filter so that numeric modes like '755' (which are
    // filtered by looksLikePath) don't cause the file path to be dropped.
    const positional = getPositionalArgs(
      args,
      new Set(['-f', '--reference', '--from']),
    );
    return positional
      .slice(1)
      .filter(looksLikePath)
      .map((p) => ({
        virtualTool: 'edit' as const,
        filePath: resolvePath(p, cwd),
      }));
  },

  chown: (args, cwd) => {
    // chown [opts] OWNER[:GROUP] file... — the owner spec is the first positional.
    const positional = getPositionalArgs(
      args,
      new Set(['--from', '--reference']),
    );
    return positional
      .slice(1)
      .filter(looksLikePath)
      .map((p) => ({
        virtualTool: 'edit' as const,
        filePath: resolvePath(p, cwd),
      }));
  },

  chgrp: (args, cwd) => {
    const positional = getPositionalArgs(args, new Set(['--reference']));
    return positional
      .slice(1)
      .filter(looksLikePath)
      .map((p) => ({
        virtualTool: 'edit' as const,
        filePath: resolvePath(p, cwd),
      }));
  },

  rename: (args, cwd) => {
    // rename FROM TO file... — skip first two positionals (the from/to patterns)
    const positional = getPositionalArgs(args).filter(looksLikePath);
    return positional.slice(2).map((p) => ({
      virtualTool: 'edit' as const,
      filePath: resolvePath(p, cwd),
    }));
  },

  patch: (args, cwd) => {
    const output = getFlagValue(args, '-o', '--output');
    const outputOps =
      output && looksLikePath(output)
        ? [
            {
              virtualTool: 'edit' as const,
              filePath: resolvePath(output, cwd),
            },
          ]
        : [];

    return [
      ...outputOps,
      ...getPositionalArgs(
        args,
        new Set(['-i', '--input', '-d', '--directory', '-o', '--output']),
      )
        .filter(looksLikePath)
        .map((p) => ({
          virtualTool: 'edit' as const,
          filePath: resolvePath(p, cwd),
        })),
    ];
  },

  perl: (args, cwd) => {
    const hasInPlace = args.some(
      (a) =>
        a === '-i' ||
        a.startsWith('-i') ||
        a === '--in-place' ||
        a.startsWith('--in-place=') ||
        hasCombinedShortFlag(a, 'i'),
    );
    const hasExplicitScript = args.some(
      (a) =>
        a === '-e' ||
        a === '-f' ||
        a.startsWith('-e') ||
        hasCombinedShortFlag(a, 'e'),
    );
    const positional = getPositionalArgs(
      args,
      new Set(['-e', '-f', '-I', '-M', '-m', '-0']),
    ).filter(looksLikePath);
    const files = hasExplicitScript ? positional : positional.slice(1);
    const tool: 'edit' | 'read_file' = hasInPlace ? 'edit' : 'read_file';
    return files.map((p) => ({
      virtualTool: tool,
      filePath: resolvePath(p, cwd),
    }));
  },

  sed: (args, cwd) => {
    // sed [-i] SCRIPT file... or sed -e SCRIPT file...
    // With -i: in-place edit (virtualTool = 'edit'); otherwise read (virtualTool = 'read_file')
    const hasInPlace = args.some(
      (a) =>
        a === '-i' ||
        a.startsWith('-i') ||
        a === '--in-place' ||
        a.startsWith('--in-place=') ||
        hasCombinedShortFlag(a, 'i'),
    );
    const hasExplicitScript = args.some(
      (a) =>
        a === '-e' ||
        a === '-f' ||
        a.startsWith('-e') ||
        hasCombinedShortFlag(a, 'e'),
    );
    const flagsWithValue = new Set([
      '-e',
      '-f',
      '--expression',
      '--file',
      // NOTE: -i is intentionally absent — it is an optional-suffix flag
      // (e.g. `-i`, `-i.bak`) and does NOT consume the next token as a value.
      '-l',
      '--line-length',
      '--sandbox',
      '-s',
      '--separate',
    ]);
    const positional = getPositionalArgs(args, flagsWithValue).filter(
      looksLikePath,
    );
    // If -e/-f was used, all positionals are file paths.
    // Otherwise, the first positional is the script expression.
    const filePaths = hasExplicitScript ? positional : positional.slice(1);
    const tool: 'edit' | 'read_file' = hasInPlace ? 'edit' : 'read_file';
    return filePaths.map((p) => ({
      virtualTool: tool,
      filePath: resolvePath(p, cwd),
    }));
  },

  awk: (args, cwd) => {
    // awk [-F sep] [-v var=val] PROGRAM file...
    // The PROGRAM is the first positional — it will contain `{...}` which is
    // filtered out by looksLikePath, so we don't need special handling.
    const hasInPlace = getFlagValue(args, '-i', '--include') === 'inplace';
    const flagsWithValue = new Set([
      '-F',
      '-f',
      '-v',
      '-m',
      '-W',
      '-M',
      '--source',
      '--include',
      '--load',
      '-b',
      '--characters-as-bytes',
      '-c',
      '--traditional',
      '-d',
      '-D',
      '--debug',
      '-e',
      '--exec',
      '-h',
      '--help',
      '-i',
      '--lint',
      '-o',
      '-p',
      '-r',
      '-s',
      '-S',
      '-t',
      '-V',
    ]);
    const tool: 'edit' | 'read_file' = hasInPlace ? 'edit' : 'read_file';
    return getPositionalArgs(args, flagsWithValue)
      .filter(looksLikePath)
      .map((p) => ({
        virtualTool: tool,
        filePath: resolvePath(p, cwd),
      }));
  },
  gawk: (a, d) => (COMMANDS['awk'] as CommandHandler)(a, d),

  // ── WebFetch commands ─────────────────────────────────────────────────────

  curl: (args, cwd) => {
    const flagsWithValue = new Set([
      '-o',
      '-O',
      '--output',
      '-u',
      '--user',
      '-A',
      '--user-agent',
      '-H',
      '--header',
      '-d',
      '--data',
      '--data-binary',
      '--data-raw',
      '--data-urlencode',
      '-X',
      '--request',
      '-F',
      '--form',
      '-e',
      '--referer',
      '-T',
      '--upload-file',
      '--cacert',
      '--capath',
      '--cert',
      '--key',
      '--pass',
      '-m',
      '--max-time',
      '--connect-timeout',
      '-r',
      '--range',
      '--limit-rate',
      '-b',
      '--cookie',
      '-c',
      '--cookie-jar',
      '--proxy',
      '-U',
      '--proxy-user',
      '-K',
      '--config',
      '--netrc-file',
      '--resolve',
      '--connect-to',
      '-w',
      '--write-out',
      '-x',
      '-Y',
      '--speed-limit',
      '--speed-time',
      '-y',
      '--max-filesize',
      '--proto',
      '--proto-redir',
      '-E',
      '--cert-type',
      '--key-type',
    ]);
    const output = writeOpForFlag(args, cwd, '-o', '--output');
    return [
      ...(output ? [output] : []),
      ...getPositionalArgs(args, flagsWithValue)
        .filter(
          (p) =>
            p.includes('://') || /^https?:\/\//.test(p) || /^ftp:\/\//.test(p),
        )
        .flatMap((url) => {
          const op = webOp(url);
          return op ? [op] : [];
        }),
    ];
  },

  wget: (args, cwd) => {
    const flagsWithValue = new Set([
      '-O',
      '--output-document',
      '-P',
      '--directory-prefix',
      '-o',
      '--output-file',
      '-a',
      '--append-output',
      '-U',
      '--user-agent',
      '--header',
      '-e',
      '--execute',
      '--tries',
      '-t',
      '-T',
      '--timeout',
      '--wait',
      '-w',
      '--quota',
      '-Q',
      '--bind-address',
      '--limit-rate',
      '--user',
      '--password',
      '--proxy-user',
      '--proxy-password',
      '-i',
      '--input-file',
      '--base',
      '--config',
      '--referer',
      '-D',
      '--domains',
      '--exclude-domains',
      '-I',
      '--include-directories',
      '-X',
      '--exclude-directories',
      '--regex-type',
      '-A',
      '-R',
      '--accept',
      '--reject',
      '--no-check-certificate',
      '--ca-certificate',
      '--ca-directory',
      '--certificate',
      '--private-key',
    ]);
    const output = writeOpForFlag(args, cwd, '-O', '--output-document');
    return [
      ...(output ? [output] : []),
      ...getPositionalArgs(args, flagsWithValue)
        .filter((p) => p.includes('://') || /^https?:\/\//.test(p))
        .flatMap((url) => {
          const op = webOp(url);
          return op ? [op] : [];
        }),
    ];
  },

  fetch: (args) => {
    // BSD `fetch` utility
    const flagsWithValue = new Set([
      '-o',
      '-q',
      '-v',
      '-a',
      '-T',
      '-S',
      '--no-verify-peer',
      '--no-verify-hostname',
      '--ca-cert',
    ]);
    return getPositionalArgs(args, flagsWithValue)
      .filter((p) => p.includes('://'))
      .flatMap((url) => {
        const op = webOp(url);
        return op ? [op] : [];
      });
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Transparent prefix commands
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Flags that consume the next argument as their value, for specific prefix
 * commands.  Used by the prefix-stripping logic to correctly skip flag values
 * (e.g. `-u root` in `sudo -u root cat /etc/shadow`).
 */
const PREFIX_COMMAND_FLAGS_WITH_VALUE = new Map<string, ReadonlySet<string>>([
  [
    'sudo',
    new Set([
      '-u',
      '--user',
      '-g',
      '--group',
      '-C',
      '--close-from',
      '-c',
      '--login-class',
      '-D',
      '--chdir',
      '-p',
      '--prompt',
      '-r',
      '--role',
      '-t',
      '--type',
      '-T',
      '--command-timeout',
      '-U',
      '--other-user',
    ]),
  ],
  ['timeout', new Set(['-s', '--signal', '-k', '--kill-after'])],
]);

/**
 * Commands that act as transparent wrappers around the actual command.
 * When encountered, the prefix is stripped and the analysis recurses on
 * the remaining command string.
 *
 * Examples:
 *   `sudo cat /etc/shadow`     → analyse `cat /etc/shadow`
 *   `timeout 10 wget http://…` → analyse `wget http://…`
 */
const PREFIX_COMMANDS = new Set([
  'sudo',
  'doas', // OpenBSD sudo alternative
  'env',
  'time',
  'nice',
  'ionice',
  'nohup',
  'timeout',
  'unbuffer',
  'stdbuf',
]);

// ─────────────────────────────────────────────────────────────────────────────
// Main entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract virtual file/network operations from a single simple shell command.
 *
 * This function expects a **single simple command** (no `&&`, `||`, `;`, `|`
 * operators).  Use `splitCompoundCommand()` before calling this for compound
 * commands.
 *
 * Returns an empty array for:
 *   - Commands not in the known command table (safe default)
 *   - Empty or whitespace-only input
 *   - Pure environment variable assignments (`FOO=bar`)
 *
 * @param simpleCommand - A single shell command without compound operators.
 * @param cwd           - Working directory for resolving relative paths.
 * @param homeUnknown    - True when the enclosing compound command already
 *                         changed `HOME`, so any path this command resolves
 *                         through `~` is not one the analyzer can certify.
 */
export function extractShellOperations(
  simpleCommand: string,
  cwd: string,
  homeUnknown = false,
): ShellOperation[] {
  const ops = extractShellOperationsUnmarked(simpleCommand, cwd, homeUnknown);
  // A single place to mark the results, so nested entries (prefix commands,
  // `find -exec`) do not each have to thread a second return value.
  return homeUnknown ? markHomeUnknownOps(ops, simpleCommand, cwd) : ops;
}

function extractShellOperationsUnmarked(
  simpleCommand: string,
  cwd: string,
  homeUnknown: boolean,
): ShellOperation[] {
  if (!simpleCommand.trim()) return [];

  const tokens = tokenize(simpleCommand);
  if (tokens.length === 0) return [];

  // Extract I/O redirections before dispatching to the command handler.
  // This mutates `tokens` in-place by removing redirect tokens.
  const { readFiles: redirectReads, writeFiles: redirectWrites } =
    extractRedirects(tokens, cwd);

  while (tokens[0] && isEnvAssignmentToken(tokens[0])) {
    tokens.shift();
  }

  const cmdName = tokens[0];
  if (!cmdName) {
    // Only assignments and/or redirections were present.
    return [
      ...redirectReads.map((p) => ({
        virtualTool: 'read_file' as const,
        filePath: p,
      })),
      ...redirectWrites.map((p) => ({
        virtualTool: 'write_file' as const,
        filePath: p,
      })),
    ];
  }

  const ops: ShellOperation[] = [];

  // ── Transparent prefix commands ───────────────────────────────────────────
  if (PREFIX_COMMANDS.has(cmdName)) {
    const flagsWithVal = PREFIX_COMMAND_FLAGS_WITH_VALUE.get(cmdName);
    // Find where the actual command starts (after flags, flag-values, and env
    // variable assignments).  For example:
    //   sudo -u root cat /file  →  startIdx skips '-u' AND 'root'
    let startIdx = 1;
    while (startIdx < tokens.length) {
      const t = tokens[startIdx]!;
      if (t.startsWith('-')) {
        // Skip the flag itself
        startIdx++;
        // If this flag takes a separate value argument, skip that too
        if (
          flagsWithVal?.has(t) &&
          startIdx < tokens.length &&
          !tokens[startIdx]!.startsWith('-')
        ) {
          startIdx++;
        }
      } else if (isEnvAssignmentToken(t)) {
        // Environment variable assignment: skip
        startIdx++;
      } else {
        break;
      }
    }
    // `timeout DURATION command` — the duration is a numeric positional that
    // precedes the actual command.  Skip it.
    if (
      cmdName === 'timeout' &&
      startIdx < tokens.length &&
      /^\d/.test(tokens[startIdx]!)
    ) {
      startIdx++;
    }
    if (startIdx < tokens.length) {
      // Reconstruct the inner command and recurse. `timeout`, `nohup`, `env`
      // and friends pass the environment through, so a `HOME` assignment among
      // the words skipped above reaches the child, and a `HOME` the enclosing
      // command already changed still applies inside it.
      //
      // The reconstruction quotes each word again: the tokens lost their
      // quotes when they were split, and a wrapper's script argument must stay
      // a single word — `timeout 5 bash -c "cd && echo {} > f"` unwrapped as
      // `bash -c cd && echo {} > f` would analyse a different command.
      const innerCommand = tokens.slice(startIdx).map(quoteShellWord).join(' ');
      const scopedHome =
        homeUnknown ||
        tokens.slice(1, startIdx).some((token) => {
          const assignment = parseAssignmentWord(
            { value: token, raw: token },
            true,
          );
          return (
            assignment !== null && homeAssignmentChangesValue(assignment, true)
          );
        });
      // The inner command may itself be a wrapper (`timeout 5 bash -c '…'`) or
      // a compound one (`sudo sh -c 'cd && …'`), so it goes through the walker
      // rather than the single-simple-command entry point.
      ops.push(...walkCompoundCommand(innerCommand, cwd, 1, false, scopedHome));
    }
  } else {
    // ── Dispatch to the known-command handler ─────────────────────────────
    const handler = COMMANDS[cmdName];
    if (handler) {
      const args = tokens.slice(1);
      ops.push(...handler(args, cwd, homeUnknown));
    }
    // Unknown commands: return no ops (safe — we don't guess what we don't know)
  }

  // Append redirect-derived operations
  ops.push(
    ...redirectReads.map((p) => ({
      virtualTool: 'read_file' as const,
      filePath: p,
    })),
    ...redirectWrites.map((p) => ({
      virtualTool: 'write_file' as const,
      filePath: p,
    })),
  );

  return ops;
}

// ─────────────────────────────────────────────────────────────────────────────
// Compound-aware extractor
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cap on recursive shell-wrapper unwrapping. A pathological command can wrap
 * itself many levels deep (`bash -lc "bash -lc \"...\""`) to obscure intent;
 * after this many unwraps we stop and analyse whatever remains as-is. Four is
 * enough for every legitimate wrapper combination observed in the wild
 * (login shells, sandbox shells, tmux send-keys).
 */
const MAX_SHELL_UNWRAP_DEPTH = 4;

/**
 * Classify a literal `cd` command and resolve its target cwd when static.
 * Dynamic targets (command substitutions, variable expansions, `cd -`) are
 * reported separately so callers can mark subsequent relative paths as
 * uncertain instead of trusting a guessed cwd.
 *
 * Used by {@link extractShellOperationsAcrossCommand} to track the effective
 * cwd left-to-right across compound segments, so a segment like
 * `cd .qwen && echo > settings.json` correctly attributes the write to
 * `<cwd>/.qwen/settings.json`.
 */
type CdResolution =
  | { kind: 'not-cd' }
  | { kind: 'dynamic' }
  | { kind: 'static'; cwd: string; cwdUnknown: boolean };

function isDynamicShellPath(word: string): boolean {
  return word.includes('$') || word.includes('`');
}

// Local to the HOME tracking: `HOME+=…` appends to the value, so it changes
// `HOME` just like `HOME=…` does, but the shared `isEnvAssignmentToken` (used
// elsewhere to strip command prefixes) deliberately does not match the `+`.
// A subscript is evaluated arithmetically by bash, so the name accepts any
// `[…]`; whether the assignment reaches `$HOME` is decided separately.
const ASSIGNMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?$/;

interface AssignmentName {
  base: string;
  /** Raw subscript text without the brackets, `null` when there is none. */
  subscript: string | null;
}

function parseAssignmentName(rawName: string): AssignmentName | null {
  if (!ASSIGNMENT_NAME.test(rawName)) return null;
  const match = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[([^\]]*)\])?$/.exec(rawName);
  if (!match) return null;
  return { base: match[1]!, subscript: match[2] ?? null };
}

/**
 * Subscript spellings that name element 0, i.e. the scalar `$HOME` itself:
 * bash evaluates the subscript as arithmetic, so `0`, `00`, `+0` and `0x0` all
 * assign the scalar.
 */
const SUBSCRIPT_ZERO = /^(?:[+]?0+|0[xX]0+)$/;
/** Non-zero integer literals — decimal, `+`-prefixed, hex or octal — name an element only. */
const SUBSCRIPT_ELEMENT =
  /^(?:[+]?[1-9][0-9]*|0[xX][0-9a-fA-F]*[1-9a-fA-F][0-9a-fA-F]*|0[0-7]*[1-7][0-7]*)$/;

/**
 * Whether an assignment target of this name changes the value `$HOME` reads.
 * `export` and `readonly` reject a subscript outright (`not a valid
 * identifier`), so a subscripted name never reaches the scalar through them.
 */
function assignmentTargetsHome(
  name: AssignmentName,
  allowSubscript: boolean,
): boolean {
  if (name.base !== 'HOME') return false;
  if (name.subscript === null) return true;
  if (!allowSubscript) return false;
  const subscript = name.subscript.trim();
  if (SUBSCRIPT_ZERO.test(subscript)) return true;
  if (SUBSCRIPT_ELEMENT.test(subscript)) return false;
  // Anything that is not a plain integer literal is evaluated at runtime; fail
  // closed and treat it as reaching `$HOME`.
  return true;
}

const REDIRECT_OPERATORS = new Set([
  '>',
  '>>',
  '<',
  '<<',
  '<<-',
  '1>',
  '1>>',
  '2>',
  '2>>',
  '&>',
  '&>>',
  '>&',
  '<&',
]);
const REDIRECT_WITH_TARGET =
  /^(?:<<-?|1>>|1>|>>|>|2>>|2>|&>>|&>|>&|<&|<)([\s\S]+)$/;

// Words that can precede the statement's command word inside one segment, e.g.
// `then export HOME=/x` or `do export HOME=/x`. Without skipping them the
// export is read as an argument and the reassignment is missed.
const RESERVED_PREFIX_WORDS = new Set([
  '!',
  'time',
  'if',
  'then',
  'elif',
  'else',
  'while',
  'until',
  'do',
  'done',
  'fi',
  'esac',
]);

interface AssignmentWord {
  name: AssignmentName;
  append: boolean;
  /** Value after quote removal, i.e. what bash would assign. */
  value: string;
  /** True when part of the value cannot expand (single quotes or escapes). */
  literal: boolean;
}

/**
 * Drop redirect operators and their targets. A bare assignment may carry a
 * redirect (`HOME=/x > /dev/null`, `> /dev/null HOME=/x`), which bash still
 * persists, so the redirect must not be mistaken for the command word.
 */
function withoutRedirects(words: ShellWord[]): ShellWord[] {
  const kept: ShellWord[] = [];
  for (let i = 0; i < words.length; i++) {
    const value = words[i]!.value;
    if (REDIRECT_OPERATORS.has(value)) {
      i++;
      continue;
    }
    if (REDIRECT_WITH_TARGET.test(value)) continue;
    kept.push(words[i]!);
  }
  return kept;
}

/**
 * Remove the quotes and escapes from a value, reporting whether any of them
 * suppressed expansion — `HOME='$HOME'` assigns the four characters `$HOME`,
 * while `HOME="$HOME"` assigns whatever `$HOME` holds.
 */
function splitAssignmentValue(rawValue: string): {
  value: string;
  literal: boolean;
} {
  let value = '';
  let literal = false;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < rawValue.length; i++) {
    const ch = rawValue[i]!;
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      literal = true;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (ch === '\\' && !inSingle) {
      const next = rawValue[i + 1];
      if (next === undefined) continue;
      value += next;
      i++;
      literal = true;
      continue;
    }
    value += ch;
  }
  return { value, literal };
}

/**
 * Parse `name=value` (or `name+=value`) from a word. Bash recognises the
 * assignment before quote removal, so a quote or escape inside the name turns
 * the word into a command name (`"HOME=/x"`, `\HOME=/x`) and must not count.
 * Builtin operands are different: `declare "HOME=/x"` quotes the operand, so
 * there the de-quoted value is the name bash parses, and there a whole-word
 * single quote still suppresses expansion in the value.
 */
function parseAssignmentWord(
  word: ShellWord,
  fromValue = false,
): AssignmentWord | null {
  // `''` is an empty argument, not an assignment.
  if (word.value === '') return null;
  const text = fromValue ? word.value : word.raw;
  const equals = text.indexOf('=');
  if (equals <= 0) return null;
  const namePart = text.slice(0, equals);
  if (!fromValue && /['"\\]/.test(namePart)) return null;
  const append = namePart.endsWith('+');
  const name = parseAssignmentName(append ? namePart.slice(0, -1) : namePart);
  if (!name) return null;
  if (fromValue) {
    // The name may be quoted; the raw word tells whether the value expands.
    const rawValue = word.raw.replace(/^[^=]*=/, '');
    const parsed = splitAssignmentValue(rawValue);
    return {
      name,
      append,
      value: parsed.value,
      literal: parsed.literal,
    };
  }
  const parsed = splitAssignmentValue(text.slice(equals + 1));
  return { name, append, value: parsed.value, literal: parsed.literal };
}

/**
 * A value that assigns the very directory `$HOME` already names: `$HOME`,
 * `${HOME}` and `~`, each optionally with trailing slashes. `~` expands to
 * `$HOME`, and the slashes name the same directory. A literal value such as
 * `HOME='$HOME'` or `HOME='~'` really does change what `$HOME` reads.
 */
const SELF_REFERENTIAL_HOME = /^(?:~|\$HOME|\$\{HOME\})\/*$/;

function homeAssignmentChangesValue(
  assignment: AssignmentWord,
  allowSubscript: boolean,
): boolean {
  if (!assignmentTargetsHome(assignment.name, allowSubscript)) return false;
  // `HOME+=` and `HOME+=''` append nothing, which leaves the value alone;
  // every other append grows it, including `HOME+=$HOME`.
  if (assignment.append) return assignment.value !== '';
  if (assignment.literal) return true;
  return !SELF_REFERENTIAL_HOME.test(assignment.value);
}

/**
 * Whether a builtin's operands assign `HOME`. `export` and `readonly` reject an
 * array subscript (`export HOME[0]=…` fails with "not a valid identifier" and
 * leaves `HOME` alone), while `declare`, `typeset` and `local` accept it —
 * assigning element 0 of the scalar, which `$HOME` then reads.
 */
function hasHomeAssignmentOperand(
  words: ShellWord[],
  start: number,
  allowSubscript: boolean,
): boolean {
  for (let index = start; index < words.length; index++) {
    const value = words[index]!.value;
    if (value === '--') continue;
    if (value.startsWith('-') && value.length > 1) continue;
    const assignment = parseAssignmentWord(words[index]!, true);
    if (!assignment) continue;
    if (homeAssignmentChangesValue(assignment, allowSubscript)) return true;
  }
  return false;
}

function unsetsHome(words: ShellWord[], start: number): boolean {
  let functionsOnly = false;
  for (let index = start; index < words.length; index++) {
    const value = words[index]!.value;
    if (value === '--') continue;
    if (value.startsWith('-') && value.length > 1) {
      // `-f` targets functions and `-n` a nameref's target; neither unsets the
      // variable itself.
      if (value.includes('f') || value.includes('n')) functionsOnly = true;
      continue;
    }
    if (value === 'HOME' && !functionsOnly) return true;
  }
  return false;
}

/**
 * How a segment changes the shell's `HOME`:
 *   - `persistent`: the change outlives the running command and applies to
 *     later segments (`HOME=/x`, `export HOME=/x`, `unset HOME`,
 *     `for HOME in …`, top-level `declare HOME=/x`, `declare -g`).
 *   - `scoped`: the change applies inside the enclosing function only
 *     (`local HOME=/x`, `declare`/`typeset` without `-g` in a function body).
 *   - `none`: bash keeps the parent shell's value, so a later bare `cd` still
 *     goes to the analyzer's own `HOME`.
 *
 * A command-scoped prefix (`HOME=/x npm test`, `HOME=/x cd`) and a
 * command-position word that only looks like an assignment
 * (`"HOME=/x"`, `echo HOME=/x`) are not changes: treating them as
 * reassignments mis-attributes a later bare `cd` and can downgrade a user's
 * hard `deny` to a confirmation prompt.
 */
type HomeMutation = 'none' | 'persistent' | 'scoped';

function segmentHomeMutation(
  command: string,
  inFunction: boolean,
): HomeMutation {
  const words = withoutRedirects(splitShellWords(command));
  if (words.length === 0) return 'none';

  // `for HOME in …; do` assigns the loop variable in the current shell.
  if (words[0]!.value === 'for' || words[0]!.value === 'select') {
    return words[1]?.value === 'HOME' ? 'persistent' : 'none';
  }

  let index = 0;
  while (
    index < words.length &&
    RESERVED_PREFIX_WORDS.has(words[index]!.value)
  ) {
    index++;
  }

  let prefixedHome = false;
  while (index < words.length) {
    const assignment = parseAssignmentWord(words[index]!);
    if (!assignment) break;
    if (homeAssignmentChangesValue(assignment, true)) prefixedHome = true;
    index++;
  }
  if (index === words.length) {
    // A bare assignment statement persists; there is no command to scope it.
    return prefixedHome ? 'persistent' : 'none';
  }

  // `command` and `builtin` run the builtin in this shell, so they are
  // transparent; their flags are skipped.
  while (
    words[index]!.value === 'command' ||
    words[index]!.value === 'builtin'
  ) {
    index++;
    while (index < words.length && words[index]!.value.startsWith('-')) index++;
    if (index === words.length) return 'none';
  }

  const builtin = words[index]!.value;
  const operandStart = index + 1;
  switch (builtin) {
    case 'export':
    case 'readonly':
      return hasHomeAssignmentOperand(words, operandStart, false)
        ? 'persistent'
        : 'none';
    case 'local':
      // `local` is only legal in a function body, where it is function-scoped.
      return inFunction && hasHomeAssignmentOperand(words, operandStart, true)
        ? 'scoped'
        : 'none';
    case 'declare':
    case 'typeset': {
      if (!hasHomeAssignmentOperand(words, operandStart, true)) return 'none';
      if (!inFunction) return 'persistent';
      // Inside a function both are function-scoped unless `-g` asks for the
      // global variable.
      return words
        .slice(operandStart)
        .some((word) => word.value.startsWith('-') && word.value.includes('g'))
        ? 'persistent'
        : 'scoped';
    }
    case 'unset':
      return unsetsHome(words, operandStart) ? 'persistent' : 'none';
    default:
      return 'none';
  }
}

/**
 * Whether the segment scopes a `HOME` assignment to the command it prefixes,
 * e.g. `HOME=/repo/.qwen cd`. Bash applies that value to the command — so a
 * bare `cd` there does not go to the analyzer's `HOME` — but leaves the parent
 * shell's `HOME` unchanged, so it must not latch for later segments. `env`
 * prefixes are handled by the walker, which re-enters on the command `env`
 * runs, so they are not looked at here.
 */
function segmentPrefixesHome(command: string): boolean {
  const words = withoutRedirects(splitShellWords(command));
  let index = 0;
  while (
    index < words.length &&
    RESERVED_PREFIX_WORDS.has(words[index]!.value)
  ) {
    index++;
  }
  let homeAssigned = false;
  while (index < words.length) {
    const assignment = parseAssignmentWord(words[index]!);
    if (!assignment) break;
    if (homeAssignmentChangesValue(assignment, true)) homeAssigned = true;
    index++;
  }
  return homeAssigned && index < words.length;
}

function resolveCdTargetCwd(
  command: string,
  cwd: string,
  cwdUnknown: boolean,
  homeReassigned: boolean,
  homePrefixed: boolean,
): CdResolution {
  const words = withoutRedirects(splitShellWords(command));

  // Control-structure words put the command in a later position (`do cd`,
  // `then cd`). A command-scoped prefix such as `HOME=/x cd` applies to the
  // `cd` builtin itself, so those words are stripped the same way
  // `extractShellOperations` does before its cd dispatch; otherwise the cd is
  // never resolved at all.
  let verbIndex = 0;
  while (
    verbIndex < words.length &&
    RESERVED_PREFIX_WORDS.has(words[verbIndex]!.value)
  ) {
    verbIndex++;
  }
  while (verbIndex < words.length && parseAssignmentWord(words[verbIndex]!)) {
    verbIndex++;
  }

  const verb = words[verbIndex]?.value;
  if (verb === 'popd') return { kind: 'dynamic' };
  if (verb !== 'cd' && verb !== 'pushd') return { kind: 'not-cd' };

  if (verb === 'pushd') {
    if (words.length - verbIndex === 1) return { kind: 'dynamic' };
    if (/^[+-]\d+$/.test(words[verbIndex + 1]!.value)) {
      return { kind: 'dynamic' };
    }
    if (words[verbIndex + 1]!.value === '-n') return { kind: 'dynamic' };
  }

  // Skip POSIX `cd` flags (-L, -P, --, -e, -@) without consuming the special
  // `cd -` (previous directory) which is non-static and should bail out.
  let targetIndex = verbIndex + 1;
  while (
    targetIndex < words.length &&
    words[targetIndex]!.value.startsWith('-') &&
    words[targetIndex]!.value !== '-' &&
    words[targetIndex]!.value !== '--'
  ) {
    targetIndex++;
  }
  if (words[targetIndex]?.value === '--') {
    targetIndex++;
  }

  // A bare `cd` goes to bash's `$HOME`, and `~` / `~/…` expands it, so once
  // this compound command reassigned `HOME` the analyzer process's own value is
  // not what bash expands and the target is unknown. A command-scoped prefix
  // (`HOME=/repo/.qwen cd`) only applies to that command, so it makes a *bare*
  // `cd` unknown while an explicit `~` target — expanded from the parent
  // shell's `HOME` before the command runs — stays the analyzer's home.
  const explicitTarget = words[targetIndex]?.value;
  const expandsHome =
    explicitTarget === undefined ||
    explicitTarget === '~' ||
    explicitTarget.startsWith('~/');
  if (expandsHome && (homeReassigned || (homePrefixed && !explicitTarget))) {
    return { kind: 'dynamic' };
  }

  const target = explicitTarget ?? process.env['HOME'];
  if (!target || target === '-' || isDynamicShellPath(target)) {
    return { kind: 'dynamic' };
  }

  return {
    kind: 'static',
    cwd: resolvePath(target, cwd),
    cwdUnknown: cwdUnknown && !isShellAbsolutePath(target),
  };
}

/**
 * Compound-aware shell-operation extractor.
 *
 * Unlike {@link extractShellOperations} (which only handles ONE simple
 * command), this walks an arbitrary compound shell string and returns every
 * virtual file / network operation it can statically resolve, while
 * tracking effective cwd through literal `cd` segments and recursively
 * unwrapping shell wrappers (`bash -lc '...'`, `sh -c "..."`).
 *
 * Behaviour:
 *   - `splitCompoundCommand` produces the segment boundaries.
 *   - Literal `cd <dir>` segments shift the effective cwd for subsequent
 *     segments and themselves emit no ops.
 *   - Dynamic `cd` targets (variables, substitutions, `cd -`) keep the last
 *     known cwd for best-effort path extraction and mark subsequent relative
 *     file operations with `cwdUnknown`.
 *   - Shell wrappers are unwrapped after the outer command is split, so
 *     wrapper suffixes remain visible while inner compound operators
 *     (`&&`, `;`, `|`) are still recursively discovered.
 *   - Operation order is preserved across segments.
 *
 * Single source of truth for compound shell analysis: both the
 * PermissionManager (matching `Edit/Write` rules against shell writes) and
 * AUTO mode (force-reviewing protected shell writes) call into this
 * function so a deny / ask / force-review verdict is consistent regardless
 * of how the shell call was wrapped.
 *
 * @example
 *   extractShellOperationsAcrossCommand(
 *     "cd .qwen && bash -lc 'echo {} > settings.json'",
 *     '/repo',
 *   )
 *   // → [{ virtualTool: 'write_file', filePath: '/repo/.qwen/settings.json' }]
 */
export function extractShellOperationsAcrossCommand(
  command: string,
  cwd: string,
  homeUnknown = false,
): ShellOperation[] {
  return walkCompoundCommand(command, cwd, 0, false, homeUnknown);
}

function extractFindExecOps(
  args: string[],
  cwd: string,
  homeUnknown = false,
): ShellOperation[] {
  const ops: ShellOperation[] = [];
  for (let i = 0; i < args.length; i++) {
    const marker = args[i]!;
    if (
      marker !== '-exec' &&
      marker !== '-execdir' &&
      marker !== '-ok' &&
      marker !== '-okdir'
    ) {
      continue;
    }

    const inner: string[] = [];
    i++;
    while (i < args.length && args[i] !== ';' && args[i] !== '+') {
      inner.push(args[i]!);
      i++;
    }
    if (inner.length === 0) continue;

    const innerCommand = inner
      .map((arg) => quoteShellWord(arg.replaceAll('{}', '__find_exec_path__')))
      .join(' ');
    // The command runs with the calling shell's `HOME`, so a reassignment the
    // enclosing compound command already made applies inside it too.
    const innerOps = extractShellOperationsAcrossCommand(
      innerCommand,
      cwd,
      homeUnknown,
    );
    ops.push(
      ...(marker.endsWith('dir')
        ? markCwdUnknownOps(innerOps, innerCommand, cwd)
        : innerOps),
    );
  }
  return ops;
}

function stripHeredocBodies(command: string): string {
  const lines = command.split('\n');
  const kept: string[] = [];
  const pendingDelimiters: string[] = [];

  for (const line of lines) {
    if (pendingDelimiters.length > 0) {
      if (line.trim() === pendingDelimiters[0]) {
        pendingDelimiters.shift();
      }
      continue;
    }

    kept.push(line);
    pendingDelimiters.push(...getHeredocDelimiters(line));
  }

  return kept.join('\n');
}

function getHeredocDelimiters(line: string): string[] {
  const delimiters: string[] = [];
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;

    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && !inSingle) {
      escaped = true;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (inSingle || inDouble || ch !== '<' || line[i + 1] !== '<') {
      continue;
    }
    if (line[i + 2] === '<') {
      i += 2;
      continue;
    }

    let wordStart = i + 2;
    if (line[wordStart] === '-') wordStart++;
    while (line[wordStart] === ' ' || line[wordStart] === '\t') {
      wordStart++;
    }

    const quote = line[wordStart];
    const quoted = quote === "'" || quote === '"';
    if (quoted) wordStart++;

    let wordEnd = wordStart;
    while (wordEnd < line.length) {
      const wordCh = line[wordEnd]!;
      if (quoted ? wordCh === quote : !/[A-Za-z0-9_./-]/.test(wordCh)) {
        break;
      }
      wordEnd++;
    }

    if (wordEnd > wordStart) {
      delimiters.push(line.slice(wordStart, wordEnd));
    }
    i = wordEnd;
  }
  return delimiters;
}

// A function definition segment, e.g. `setup() {` or `function setup {`.
const FUNCTION_HEADER =
  /^\s*(?:function\s+[A-Za-z_][A-Za-z0-9_:-]*\s*(?:\(\s*\))?|[A-Za-z_][A-Za-z0-9_:-]*\s*\(\s*\))\s*\{/;
// A header whose `{` is still to come, e.g. the first line of
// `f()\n{` or `function f`.
const FUNCTION_HEADER_OPEN =
  /^\s*(?:function\s+[A-Za-z_][A-Za-z0-9_:-]*\s*(?:\(\s*\))?|[A-Za-z_][A-Za-z0-9_:-]*\s*\(\s*\))\s*$/;

/** One `{ … }` body, `{ … }` group or `( … )` subshell that spans segments. */
interface ShellFrame {
  kind: 'function' | 'group' | 'subshell';
  /** True once this body scoped a `HOME` assignment for its remaining part. */
  homeScoped: boolean;
}

interface SegmentStructure {
  /** Frames this segment opens, outermost first. */
  opens: ShellFrame[];
  /** How many enclosing frames it closes. */
  closes: number;
  /** Whether any `( … )` opens here, so the segment runs in a subshell. */
  subshell: boolean;
}

/**
 * Read the `{`, `}`, `(` and `)` that change shell scope out of one segment.
 * Quotes, `${…}` parameter expansions and `$((…))` arithmetic are skipped, and
 * the empty `()` of a function header is not a subshell. `pendingFunction`
 * is true when a previous segment ended with a function header and this one
 * starts the body, so its `{` opens a function frame rather than a group.
 */
function scanSegmentStructure(
  segment: string,
  pendingFunction: boolean,
): SegmentStructure {
  const opens: ShellFrame[] = [];
  let closes = 0;
  let subshell = false;
  let pending = pendingFunction;
  // `${` and `$(` open constructs whose `}` / `)` are not shell scope.
  const expansions: Array<'param' | 'paren'> = [];
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && !inSingle) {
      escaped = true;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (inSingle) continue;

    if (ch === '$' && (segment[i + 1] === '{' || segment[i + 1] === '(')) {
      expansions.push(segment[i + 1] === '{' ? 'param' : 'paren');
      i++;
      continue;
    }
    if (ch === '{') {
      if (expansions[expansions.length - 1] === 'param') {
        expansions.push('param');
      } else if (pending) {
        opens.push({ kind: 'function', homeScoped: false });
        pending = false;
      } else {
        opens.push({ kind: 'group', homeScoped: false });
      }
      continue;
    }
    if (ch === '}') {
      if (expansions[expansions.length - 1] === 'param') expansions.pop();
      else closes++;
      continue;
    }
    if (ch === '(') {
      // `name()` — the empty parameter list of a function definition.
      if (
        segment[i + 1] === ')' &&
        i > 0 &&
        /[A-Za-z0-9_]/.test(segment[i - 1]!)
      ) {
        i++;
        continue;
      }
      if (expansions[expansions.length - 1] === 'paren') {
        expansions.push('paren');
        continue;
      }
      subshell = true;
      opens.push({ kind: 'subshell', homeScoped: false });
      continue;
    }
    if (ch === ')') {
      if (expansions[expansions.length - 1] === 'paren') expansions.pop();
      else closes++;
    }
  }

  return { opens, closes, subshell };
}

/**
 * Indices of the segments inside a brace group that bash runs in a subshell,
 * e.g. `{ export HOME=/x; } &` or `{ export HOME=/x; } | cat`. The group's own
 * terminator is not the terminator of the segment that carries the
 * assignment, so `backgrounded` cannot see it: the closing `} &` does.
 */
function subshellBraceGroupSegments(
  segments: ReadonlyArray<{ command: string; terminator: string }>,
): Set<number> {
  const inGroup = new Set<number>();
  const open: number[] = [];
  segments.forEach((segment, index) => {
    const trimmed = segment.command.trim();
    if (trimmed === '}' || trimmed.startsWith('} ')) {
      const start = open.pop();
      if (
        start !== undefined &&
        (segment.terminator === '&' ||
          segment.terminator === '|' ||
          segment.terminator === '|&')
      ) {
        for (let i = start; i <= index; i++) inGroup.add(i);
      }
      return;
    }
    if (trimmed.startsWith('{')) open.push(index);
  });
  return inGroup;
}

/**
 * The file operations of a segment's redirections. Bash performs them before
 * running the segment's command, so they belong to the cwd the segment starts
 * in — also when the command is a `cd`.
 */
function redirectOpsForSegment(command: string, cwd: string): ShellOperation[] {
  const { readFiles, writeFiles } = extractRedirects(tokenize(command), cwd);
  return [
    ...readFiles.map((filePath) => ({
      virtualTool: 'read_file' as const,
      filePath,
    })),
    ...writeFiles.map((filePath) => ({
      virtualTool: 'write_file' as const,
      filePath,
    })),
  ];
}

/**
 * Split an `env` prefix off a segment: `env -i -u FOO HOME=/x cmd` runs `cmd`
 * with the given environment. Returns the command `env` runs with its original
 * quoting, plus whether one of those assignments changed `HOME`.
 */
function splitEnvPrefix(
  command: string,
): { rest: string; homeAssigned: boolean } | null {
  const words = splitShellWords(command);
  if (words[0]?.value !== 'env') return null;

  let index = 1;
  let homeAssigned = false;
  while (index < words.length) {
    const assignment = parseAssignmentWord(words[index]!);
    if (assignment) {
      if (homeAssignmentChangesValue(assignment, true)) homeAssigned = true;
      index++;
      continue;
    }
    const value = words[index]!.value;
    if (value === '--') {
      index++;
      continue;
    }
    if (!value.startsWith('-')) break;
    // `-u NAME`, `-C DIR` and their long forms take the next word as a value.
    index += /^(?:-u|--unset|-C|--chdir)$/.test(value) ? 2 : 1;
  }

  if (index >= words.length) return null;
  // `raw` keeps the child command's quotes, so a `bash -c 'cd && …'` script
  // stays one word.
  return {
    rest: words
      .slice(index)
      .map((word) => word.raw)
      .join(' '),
    homeAssigned,
  };
}

function walkCompoundCommand(
  command: string,
  cwd: string,
  depth: number,
  initialCwdUnknown: boolean,
  initialHomeReassigned: boolean,
): ShellOperation[] {
  const subCommands = splitCompoundCommandSegments(stripHeredocBodies(command));
  const inSubshellGroup = subshellBraceGroupSegments(subCommands);

  const ops: ShellOperation[] = [];
  let effectiveCwd = cwd;
  let cwdUnknown = initialCwdUnknown;
  let homeReassigned = initialHomeReassigned;
  // One entry per open shell frame: a `name() { … }` body, a `{ … }` group or
  // a `( … )` subshell. A function frame is dropped when its body closes, so a
  // nested body's `local` does not outlive it while an enclosing body's `local`
  // still applies afterwards; a subshell frame means its assignments never
  // reach the parent shell. Groups do not isolate anything.
  const frames: ShellFrame[] = [];
  let pendingFunction = false;
  // Terminator of the previous segment: a `|` there makes this segment a
  // pipeline element even though its own terminator is empty.
  let previousTerminator = '';

  for (const [index, { command: sub, terminator }] of subCommands.entries()) {
    // `cd x & …` runs the `cd` in a background subshell, so it does not move
    // the cwd the following segments run in. Treating it as a foreground `cd`
    // would attribute their relative writes to the wrong directory — for
    // `cd /tmp & echo {} > settings.json` the write lands in the *original*
    // cwd, which is exactly where a protected settings file would be.
    // A `{ … } &` group is backgrounded by its closing segment, so membership
    // is what counts for the assignments inside it.
    const backgrounded = terminator === '&' || inSubshellGroup.has(index);
    // `( export HOME=/x )` is a subshell too: bash applies the assignment in a
    // child shell, so the parent's HOME is unchanged.
    const inSubshell = /^\s*\(/.test(sub);
    // Every element of a pipeline runs in its own subshell, so `export
    // HOME=/x | cat` leaves the parent's HOME alone — latching it would make a
    // later bare `cd` dynamic and downgrade a hard `deny` to a prompt.
    const inPipeline =
      terminator === '|' ||
      terminator === '|&' ||
      previousTerminator === '|' ||
      previousTerminator === '|&';
    previousTerminator = terminator;

    // A function body (`f() {` / `…` / `}`), a bare `{ … }` group and a
    // `( … )` subshell all carry their own scope, and only the closing segment
    // says where the body ends: `{ echo hi; }` must not read as an unclosed
    // function body, and `(\n export HOME=/x \n)` must not latch.
    const structure = scanSegmentStructure(
      sub,
      pendingFunction || FUNCTION_HEADER.test(sub),
    );
    frames.push(...structure.opens);
    pendingFunction =
      !structure.opens.some((frame) => frame.kind === 'function') &&
      FUNCTION_HEADER_OPEN.test(sub);
    const inFunctionBody = frames.some((frame) => frame.kind === 'function');
    const insideSubshellFrame =
      structure.subshell || frames.some((frame) => frame.kind === 'subshell');
    // `HOME=/x & …` runs the assignment in a background subshell and
    // `HOME=/x cmd` scopes it to one command; neither leaves the parent
    // shell's HOME changed, so only a foreground persistent form latches.
    if (!backgrounded && !inSubshell && !inPipeline && !insideSubshellFrame) {
      const mutation = segmentHomeMutation(sub, inFunctionBody);
      if (mutation === 'persistent') {
        homeReassigned = true;
      } else if (mutation === 'scoped') {
        for (let frame = frames.length - 1; frame >= 0; frame--) {
          if (frames[frame]!.kind === 'function') {
            frames[frame]!.homeScoped = true;
            break;
          }
        }
      }
    }
    for (let closed = 0; closed < structure.closes; closed++) frames.pop();
    const homeUnknown =
      homeReassigned || frames.some((frame) => frame.homeScoped);
    const prefixesHome = segmentPrefixesHome(sub);

    const cdTarget = resolveCdTargetCwd(
      sub,
      effectiveCwd,
      cwdUnknown,
      homeUnknown,
      prefixesHome,
    );
    if (cdTarget.kind === 'static' || cdTarget.kind === 'dynamic') {
      // Bash performs the segment's redirections before running the builtin, so
      // `cd build > build.log` still creates `build.log` in the cwd this
      // segment started in. The `continue` below skips op extraction, so those
      // redirect ops have to be emitted here or they are silently lost.
      let redirectOps = redirectOpsForSegment(sub, effectiveCwd);
      if (cwdUnknown) {
        redirectOps = markCwdUnknownOps(redirectOps, sub, effectiveCwd);
      }
      // `cd > ~/settings.json` expands `~` with the `HOME` this command
      // reassigned, exactly like the redirected writes of other commands, so
      // the redirect ops get the same marking here.
      if (homeUnknown) {
        redirectOps = markHomeUnknownOps(redirectOps, sub, effectiveCwd);
      }
      ops.push(...redirectOps);
      if (cdTarget.kind === 'static') {
        if (!backgrounded) {
          effectiveCwd = cdTarget.cwd;
          cwdUnknown = cdTarget.cwdUnknown;
        }
      } else if (!backgrounded) {
        cwdUnknown = true;
      }
      continue;
    }

    // `env HOME=/x cmd` hands its environment to the command it runs: the
    // child resolves `~` and a bare `cd` against the new value while the parent
    // shell's `HOME` stays unchanged, so re-enter on that command rather than
    // trusting the analyzer's own home.
    const envPrefix = splitEnvPrefix(sub);
    if (envPrefix) {
      ops.push(
        ...walkCompoundCommand(
          envPrefix.rest,
          effectiveCwd,
          depth,
          cwdUnknown,
          homeUnknown || prefixesHome || envPrefix.homeAssigned,
        ),
      );
      continue;
    }

    // Unwrap per segment, after the outer split, so wrapper suffixes like
    // `bash -lc 'safe' && echo > file` are not discarded.
    if (depth < MAX_SHELL_UNWRAP_DEPTH) {
      const subUnwrapped = stripShellWrapper(sub);
      if (subUnwrapped !== sub) {
        // `HOME=/x bash -lc '…'` exports the command-scoped value into the
        // wrapper's environment, so the child resolves `~` and a bare `cd`
        // against it even though the parent shell keeps its own `HOME`.
        ops.push(
          ...walkCompoundCommand(
            subUnwrapped,
            effectiveCwd,
            depth + 1,
            cwdUnknown,
            homeUnknown || prefixesHome,
          ),
        );
        continue;
      }
    } else if (stripShellWrapper(sub) !== sub) {
      shellSemanticsDebugLogger.warn(
        `Shell wrapper unwrap depth limit reached (${MAX_SHELL_UNWRAP_DEPTH}); analysing remaining command as-is.`,
      );
    }

    // `~` expands bash's HOME, which this command reassigned, so an operation
    // resolved through it points at a directory the analyzer cannot know. The
    // facade marks those, including ones rebuilt from a prefix command such as
    // `timeout` or from a `find -exec`.
    const subOps = extractShellOperations(sub, effectiveCwd, homeUnknown);
    ops.push(
      ...(cwdUnknown ? markCwdUnknownOps(subOps, sub, effectiveCwd) : subOps),
    );
  }

  return ops;
}

function hasAbsolutePathTokenForOperation(
  command: string,
  cwd: string,
  filePath: string,
): boolean {
  for (const token of tokenize(command)) {
    const redirectTarget = token.match(
      /^(?:1>>|1>|>>|>|2>>|2>|&>>|&>|<)([\s\S]+)$/,
    )?.[1];
    const candidate = redirectTarget ?? token;
    if (
      looksLikePath(candidate) &&
      isShellAbsolutePath(candidate) &&
      resolvePath(candidate, cwd) === filePath
    ) {
      return true;
    }
  }
  return false;
}

function markCwdUnknownOps(
  ops: ShellOperation[],
  command: string,
  cwd: string,
): ShellOperation[] {
  return ops.map((op) => {
    if (!op.filePath) return op;
    return {
      ...op,
      cwdUnknown: true,
      pathMayDependOnCwd: !hasAbsolutePathTokenForOperation(
        command,
        cwd,
        op.filePath,
      ),
    };
  });
}

/**
 * Absolute paths that `~` / `~/…` in the segment resolve to against the
 * analyzer's own `HOME`. Used once the compound command has reassigned
 * `HOME`: bash expands those tokens against the new value, so a path resolved
 * through them is not the one the analyzer computed.
 *
 * The scan runs on words, not on the raw text, because the `~` is usually part
 * of a longer word (`>>~/log`, `--target-directory=~/bak`, `~/settings.json`)
 * and can be followed by a quote (`~/"settings.json"`) or contain a space
 * (`~/.qwen\ bak`). A word-level regex stopped at the quote or the space and
 * missed both. `~user` and URLs such as `http://host/~user/x` are still out:
 * the `~` must be the whole first path segment.
 */
function homeTildeTargets(command: string, cwd: string): Set<string> {
  const targets = new Set<string>();
  const add = (candidate: string) => {
    const trimmed = candidate.replace(/\/+$/, '');
    targets.add(resolvePath(trimmed || '~', cwd));
  };
  for (const word of splitShellWords(command)) {
    const value = word.value;
    // `--out=~/log`, `>>~/log`: the value may follow `=` or a redirect.
    const prefix = /^[^=<>~]*[=<>](?=~(?:\/|$))/.exec(value)?.[0] ?? '';
    const candidate = value.slice(prefix.length);
    if (candidate === '~' || candidate.startsWith('~/')) add(candidate);
  }
  return targets;
}

function markHomeUnknownOps(
  ops: ShellOperation[],
  command: string,
  cwd: string,
): ShellOperation[] {
  const targets = homeTildeTargets(command, cwd);
  if (targets.size === 0) return ops;
  return ops.map((op) => {
    if (!op.filePath) return op;
    const filePath = op.filePath.replace(/\/+$/, '');
    // `~` names a directory, so an operation on anything below it also
    // depends on the reassigned value (`> ~/settings.json`, `cp x ~/.qwen/`,
    // `mkdir -p ~/a/b`), not just on the path itself.
    for (const target of targets) {
      if (filePath === target || filePath.startsWith(`${target}/`)) {
        return { ...op, cwdUnknown: true, pathMayDependOnCwd: true };
      }
    }
    return op;
  });
}
