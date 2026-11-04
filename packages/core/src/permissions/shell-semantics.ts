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

/**
 * Tokenize a shell command string, respecting single/double quotes and
 * backslash escapes, splitting on unquoted whitespace.
 *
 * The input should be a single simple command (already split from compound
 * commands via `splitCompoundCommand`).
 *
 * Quote removal hides whether a `&` was typed bare: `>&1` duplicates a file
 * descriptor, but `>"&1"` and `>\&1` write a file named `&1`. When
 * `fdRedirects` is given, it receives the index of each token that starts
 * with `>&`, `1>&`, `2>&` or `<&` whose `>`/`<` and `&` were both unquoted.
 * Bash reads an unquoted `-` right after such an operator as "close" and the
 * rest of the word as an argument: `rm >&-notes.txt` closes stdout and
 * removes `notes.txt`. That rest becomes its own token after the redirect
 * token, and `fdCloses` receives the redirect token's index.
 */
function tokenize(
  command: string,
  fdRedirects?: Set<number>,
  fdCloses?: Set<number>,
): string[] {
  const tokens: string[] = [];
  let current = '';
  // One char per char of `current`: '1' if typed unquoted and unescaped.
  let bare = '';
  let inSingle = false;
  let inDouble = false;
  // `$'…'` keeps its own quote state: `\'` does not close it and `\n` is a
  // newline rather than layout, so decoding escapes here is what keeps
  // `bash -c $'git commit --amend\ntrue'` from reading as one inert word.
  let inAnsiC = false;
  let escaped = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;

    if (inAnsiC) {
      if (ch === '\\') {
        const next = command[i + 1];
        if (next === undefined) {
          current += '\\';
          bare += '0';
          continue;
        }
        current +=
          next === 'n'
            ? '\n'
            : next === 't'
              ? '\t'
              : next === 'r'
                ? '\r'
                : next === '\\'
                  ? '\\'
                  : next;
        bare += '0';
        i++;
        continue;
      }
      if (ch === "'") {
        inAnsiC = false;
        continue;
      }
      current += ch;
      bare += '0';
      continue;
    }

    if (escaped) {
      current += ch;
      bare += '0';
      escaped = false;
      continue;
    }
    if (ch === '\\' && !inSingle) {
      // Bash removes a backslash-newline continuation outright, joining the
      // word it interrupts — so `git commit \<newline>--amend` is the plain
      // two-word invocation, not a token containing a newline.
      if (command[i + 1] === '\n') {
        i++;
        continue;
      }
      escaped = true;
      continue;
    }
    // `$'…'`: skip only the `$`; the quote that follows opens the ANSI-C
    // word, so the payload stays one token instead of splitting on spaces.
    if (ch === '$' && command[i + 1] === "'" && !inSingle && !inDouble) {
      inAnsiC = true;
      i++;
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
    if (!inSingle && !inDouble && (ch === ' ' || ch === '\t')) {
      if (current) {
        pushToken(tokens, current, bare, fdRedirects, fdCloses);
        current = '';
        bare = '';
      }
      continue;
    }
    current += ch;
    bare += inSingle || inDouble ? '0' : '1';
  }
  if (current) pushToken(tokens, current, bare, fdRedirects, fdCloses);
  return tokens;
}

function pushToken(
  tokens: string[],
  token: string,
  bare: string,
  fdRedirects: Set<number> | undefined,
  fdCloses?: Set<number>,
): void {
  // Right after an unquoted `>&`, `N>&` or `<&`, bash reads an unquoted `-`
  // as "close the descriptor" and starts a new word after it:
  // `rm >&-notes.txt` closes stdout and removes `notes.txt`. The redirect
  // token keeps the whole word (see extractRedirects) and the rest of the
  // word follows it as an argument. The new word can close again
  // (`rm >&->&-notes.txt`); a loop handles that, so a long chain can't
  // overflow the stack, and only the first redirect keeps the whole word,
  // as on `main`: the closes after it open no file.
  let chained = false;
  for (;;) {
    if (token === '{' || token === '}') return;
    const normalized = trimShellSyntax(token, bare);
    if (!normalized) return;
    if (!fdRedirects) {
      tokens.push(normalized);
      return;
    }
    // trimShellSyntax only drops leading `(` and trailing `)`/`&`.
    const start = /^\(*/.exec(token)![0].length;
    const normBare = bare.slice(start, start + normalized.length);
    const op = /^[12]?>&|^<&/.exec(normalized)?.[0];
    if (!op || normBare.slice(op.length - 2, op.length) !== '11') {
      tokens.push(normalized);
      return;
    }
    const close = op.length;
    const closes = normalized[close] === '-' && normBare[close] === '1';
    if (!closes || normalized.length === close + 1) {
      fdRedirects.add(tokens.length);
      tokens.push(normalized);
      return;
    }
    if (!chained) {
      fdRedirects.add(tokens.length);
      fdCloses?.add(tokens.length);
      tokens.push(normalized);
      chained = true;
    }
    token = normalized.slice(close + 1);
    bare = normBare.slice(close + 1);
  }
}

function trimShellSyntax(token: string, bare: string): string {
  let start = 0;
  let end = token.length;

  while (start < end && token[start] === '(') {
    start++;
  }
  while (end > start) {
    const ch = token[end - 1];
    // A quoted or escaped `)` or `&` is part of the word: `>"x&"` writes
    // `x&`, `>"notes)"` writes `notes)`.
    if ((ch !== ')' && ch !== '&') || bare[end - 1] !== '1') break;
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
 * The file that `>&word`, `N>&word` or `<&word` opens, or undefined when it
 * only duplicates or closes a descriptor (`2>&1`, `>&2`, `<&0`, `2>&-`).
 *
 * `>&file` and `1>&file` write `file` (stdout and stderr). `2>&file` and
 * `<&file` are errors in bash; treating them as file operations keeps the
 * check strict. A `$`/backtick word may expand to a descriptor or a file, so
 * it keeps the literal `&word` write.
 */
function fdRedirectFile(word: string): string | undefined {
  if (/^(\d+|-)$/.test(word)) return undefined;
  if (isDynamicShellPath(word)) return `&${word}`;
  if (word === '/dev/null' || isNetworkPseudoDevice(word)) return undefined;
  // An unquoted leading `-` never gets here (see `fdCloses`), so a `-` still
  // here was quoted or escaped: `>&"-x"` writes the file `-x`, it isn't a flag.
  if (word.startsWith('-') || looksLikePath(word)) return word;
  return undefined;
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
 *
 * `fdRedirects` holds the indices that `tokenize` found to start with an
 * unquoted `>&`, `N>&` or `<&`, and `fdCloses` those of them that close the
 * descriptor with an unquoted `-` and pass the rest of the word on.
 */
function extractRedirects(
  tokens: string[],
  cwd: string,
  fdRedirects: ReadonlySet<number>,
  fdCloses: ReadonlySet<number> = new Set(),
): RedirectResult {
  const readFiles: string[] = [];
  const writeFiles: string[] = [];
  const toRemove = new Set<number>();

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;

    // ── `>&word`, `N>&word`, `<&word` with an unquoted `>&`/`<&` ─────────
    const fdOp = fdRedirects.has(i)
      ? /^(?:[12]?>&|<&)/.exec(tok)?.[0]
      : undefined;
    if (fdOp) {
      toRemove.add(i);
      // `>&-word`: bash passes `word` to the command, and only the command
      // knows what it does with it. The parser doesn't know every command
      // and drops numbers and `$` words as arguments (`tee >&-2` writes
      // `2`), so the whole word also stays a file operation, as it was
      // before `-` was split off.
      const file = fdCloses.has(i)
        ? `&${tok.slice(fdOp.length)}`
        : fdRedirectFile(tok.slice(fdOp.length));
      if (file !== undefined) {
        (fdOp === '<&' ? readFiles : writeFiles).push(resolvePath(file, cwd));
      }
      continue;
    }

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

type CommandHandler = (args: string[], cwd: string) => ShellOperation[];

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

  find: (args, cwd) => {
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
        ...extractFindExecOps(args, cwd),
      ];
    }
    return [
      ...startingPoints.map((p) => ({
        virtualTool: 'list_directory' as const,
        filePath: p,
      })),
      ...extractFindExecOps(args, cwd),
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
 */
export function extractShellOperations(
  simpleCommand: string,
  cwd: string,
): ShellOperation[] {
  if (!simpleCommand.trim()) return [];

  const fdRedirects = new Set<number>();
  const fdCloses = new Set<number>();
  const tokens = tokenize(simpleCommand, fdRedirects, fdCloses);
  if (tokens.length === 0) return [];

  // Extract I/O redirections before dispatching to the command handler.
  // This mutates `tokens` in-place by removing redirect tokens.
  const { readFiles: redirectReads, writeFiles: redirectWrites } =
    extractRedirects(tokens, cwd, fdRedirects, fdCloses);

  while (tokens[0] && isEnvAssignmentToken(tokens[0])) {
    tokens.shift();
  }

  const cmdName = tokens[0];
  if (!cmdName) {
    // Only assignments and/or redirections were present.
    return toRedirectOperations({
      readFiles: redirectReads,
      writeFiles: redirectWrites,
    });
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
      // Reconstruct the inner command and recurse
      const innerCommand = tokens.slice(startIdx).join(' ');
      ops.push(...extractShellOperations(innerCommand, cwd));
    }
  } else {
    // ── Dispatch to the known-command handler ─────────────────────────────
    const handler = COMMANDS[cmdName];
    if (handler) {
      const args = tokens.slice(1);
      ops.push(...handler(args, cwd));
    }
    // Unknown commands: return no ops (safe — we don't guess what we don't know)
  }

  // Append redirect-derived operations
  ops.push(
    ...toRedirectOperations({
      readFiles: redirectReads,
      writeFiles: redirectWrites,
    }),
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
  | { kind: 'dynamic'; redirects: RedirectResult }
  | {
      kind: 'static';
      cwd: string;
      cwdUnknown: boolean;
      redirects: RedirectResult;
    };

function isDynamicShellPath(word: string): boolean {
  return word.includes('$') || word.includes('`');
}

function resolveCdTargetCwd(
  command: string,
  cwd: string,
  cwdUnknown: boolean,
): CdResolution {
  const fdRedirects = new Set<number>();
  const fdCloses = new Set<number>();
  const words = tokenize(command, fdRedirects, fdCloses);
  const redirects = extractRedirects(words, cwd, fdRedirects, fdCloses);

  if (words[0] === 'popd') return { kind: 'dynamic', redirects };
  if (words[0] !== 'cd' && words[0] !== 'pushd') return { kind: 'not-cd' };

  if (words[0] === 'pushd') {
    if (words.length === 1) return { kind: 'dynamic', redirects };
    if (/^[+-]\d+$/.test(words[1]!)) return { kind: 'dynamic', redirects };
    if (words[1] === '-n') return { kind: 'dynamic', redirects };
  }

  // Skip POSIX `cd` flags (-L, -P, --, -e, -@) without consuming the special
  // `cd -` (previous directory) which is non-static and should bail out.
  let targetIndex = 1;
  while (
    targetIndex < words.length &&
    words[targetIndex]!.startsWith('-') &&
    words[targetIndex] !== '-' &&
    words[targetIndex] !== '--'
  ) {
    targetIndex++;
  }
  if (words[targetIndex] === '--') {
    targetIndex++;
  }

  const target = words[targetIndex] ?? process.env['HOME'];
  if (!target || target === '-' || isDynamicShellPath(target)) {
    return { kind: 'dynamic', redirects };
  }

  return {
    kind: 'static',
    cwd: resolvePath(target, cwd),
    cwdUnknown: cwdUnknown && !isShellAbsolutePath(target),
    redirects,
  };
}

function toRedirectOperations({
  readFiles,
  writeFiles,
}: RedirectResult): ShellOperation[] {
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
 *     segments; redirects on a `cd` segment are reported from the cwd where
 *     that segment starts.
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
): ShellOperation[] {
  return walkCompoundCommand(command, cwd, 0, false);
}

function extractFindExecOps(args: string[], cwd: string): ShellOperation[] {
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
      .map((arg) => arg.replaceAll('{}', '__find_exec_path__'))
      .join(' ');
    const innerOps = extractShellOperationsAcrossCommand(innerCommand, cwd);
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

const AMEND_PREFIX_COMMANDS = new Set([...PREFIX_COMMANDS, 'command', 'exec']);

const AMEND_PREFIX_FLAGS_WITH_VALUE = new Map<string, ReadonlySet<string>>([
  ...PREFIX_COMMAND_FLAGS_WITH_VALUE,
  ['doas', new Set(['-u', '-C'])],
  ['env', new Set(['-u', '--unset', '-S', '--split-string', '-C', '--chdir'])],
  [
    'ionice',
    new Set([
      '-c',
      '--class',
      '-n',
      '--classdata',
      '-p',
      '--pid',
      '-P',
      '--pgid',
      '-u',
      '--uid',
    ]),
  ],
  ['nice', new Set(['-n', '--adjustment'])],
  ['stdbuf', new Set(['-i', '-o', '-e', '--input', '--output', '--error'])],
  ['time', new Set(['-f', '--format', '-o', '--output'])],
]);

const AMEND_LEADING_NOISE = new Set(
  '! do done elif else esac fi for if in select then time until while'.split(
    ' ',
  ),
);

const AMEND_GIT_GLOBAL_FLAGS_WITH_VALUE =
  /^(?:-[cC]|--(?:config-env|exec-path|git-dir|list-cmds|namespace|super-prefix|work-tree))$/;

const AMEND_COMMIT_FLAGS_WITH_VALUE =
  /^(?:-[A-Za-z]*[cCFm]|--(?:author|cleanup|date|file|fixup|message|pathspec-from-file|reedit-message|reuse-message|squash|template|trailer))$/;

const AMEND_UNWRAP_DEPTH_LIMIT = 8;

function amendExecutableBasename(token: string): string {
  return (token.split(/[\\/]/).pop() ?? token)
    .toLowerCase()
    .replace(/\.(?:exe|cmd|bat)$/i, '');
}

function skipAmendPrefixes(tokens: string[]): string[] {
  let index = 0;

  while (index < tokens.length) {
    const token = tokens[index]!;
    const program = amendExecutableBasename(token);
    // A word can be both shell noise and a wrapper that takes flags — `time` is
    // the only such word here. Letting the noise branch swallow it would skip its
    // `-f`/`--format`/`-o`/`--output` value, leaving that value as the apparent
    // program and the amend behind it unrecognised.
    if (
      !AMEND_PREFIX_COMMANDS.has(program) &&
      (AMEND_LEADING_NOISE.has(token) || isEnvAssignmentToken(token))
    ) {
      index++;
      continue;
    }

    if (!AMEND_PREFIX_COMMANDS.has(program)) break;

    index++;
    const flagsWithValue = AMEND_PREFIX_FLAGS_WITH_VALUE.get(program);
    while (index < tokens.length && tokens[index]!.startsWith('-')) {
      const flag = tokens[index]!;
      index++;
      if (
        flagsWithValue?.has(flag) &&
        index < tokens.length &&
        !tokens[index]!.startsWith('-')
      ) {
        index++;
      }
    }
    if (program === 'env') {
      while (index < tokens.length && isEnvAssignmentToken(tokens[index]!)) {
        index++;
      }
    }
    if (
      program === 'timeout' &&
      index < tokens.length &&
      /^\d/.test(tokens[index]!)
    ) {
      index++;
    }
  }

  return tokens.slice(index);
}

function isGitAmendInvocationAt(tokens: string[], start: number): boolean {
  if (amendExecutableBasename(tokens[start] ?? '') !== 'git') return false;

  let index = start + 1;
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (token === '--') {
      index++;
      break;
    }
    if (!token.startsWith('-')) break;
    index +=
      AMEND_GIT_GLOBAL_FLAGS_WITH_VALUE.test(token) && index + 1 < tokens.length
        ? 2
        : 1;
  }

  if (tokens[index] !== 'commit') return false;

  for (index++; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token === '--') return false;
    // A word boundary ends the flag, so `--amend` stays an amend when bash
    // glues a redirect (`--amend>log`), a parameter expansion (`--amend$(…)`)
    // or a brace range (`--amend{,}`) onto it. `--amendx` / `--amend-foo` are
    // rejected by git itself and stay unrecognised.
    if (/^--amend(?![A-Za-z-])/.test(token)) return true;

    const consumesNext =
      AMEND_COMMIT_FLAGS_WITH_VALUE.test(token) && index + 1 < tokens.length;
    if (consumesNext) index++;
  }
  return false;
}

// Declared literally rather than spread from SHELLS_READING_STDIN, which is
// defined further down the module and would be in its temporal dead zone here.
const AMEND_SHELL_PROGRAMS = new Set([
  'bash',
  'sh',
  'zsh',
  'dash',
  'ksh',
  'ash',
  'fish',
  'su',
  'script',
]);

/**
 * The `-c` payload of a shell token, if it carries one (`-c`, `-lc`, `-c'…'`).
 *
 * Returns `null` when the token list has no `-c`, and an empty string when `-c`
 * carries no locatable payload — the caller fails closed on that, because a
 * shell whose program this scan cannot read must not answer "not an amend".
 */
function shellDashCPayload(tokens: string[], index: number): string | null {
  for (let inner = index + 1; inner < tokens.length; inner++) {
    const token = tokens[inner]!;
    if (token === '-' || !token.startsWith('-')) break;
    const flag = /^-[A-Za-z]*c/.exec(token);
    if (!flag) continue;
    // Tokenization drops the quote but keeps the word, so `-c'…'` arrives as
    // one token and its payload is the flag's own tail.
    const attached = token.slice(flag[0].length);
    return attached.length > 0 ? attached : (tokens[inner + 1] ?? '');
  }
  return null;
}

/**
 * Programs the token scan cannot turn into a command, plus the ones it can.
 *
 * `commandContainsGitAmend` is the deterministic AUTO-mode gate, so a construct
 * it cannot positively classify has to answer "amend" rather than "not an
 * amend". The list is grouped by construct rather than by spelling: a `-c`
 * payload and an `env -S` value are extracted and analysed, while a shell fed
 * by an executor or by data the model never reads fails closed.
 */
function nestedAmendPayloads(tokens: string[]): {
  payloads: string[];
  unclassifiable: boolean;
} {
  const payloads: string[] = [];
  let unclassifiable = false;

  for (let index = 0; index < tokens.length; index++) {
    const program = amendExecutableBasename(tokens[index]!);

    if (program === 'env') {
      for (let inner = index + 1; inner < tokens.length; inner++) {
        const flag = tokens[inner]!;
        if (!flag.startsWith('-')) break;
        if (flag === '-S' || flag === '--split-string') {
          const value = tokens[inner + 1];
          if (value === undefined) unclassifiable = true;
          else payloads.push(value);
          break;
        }
        if (flag.startsWith('--split-string=')) {
          payloads.push(flag.slice('--split-string='.length));
          break;
        }
      }
      continue;
    }

    // `su [user] -c '…'` carries a positional user before the `-c` flag, so the
    // leading-flag scan below would stop at the user and miss the payload. Scan
    // past positionals for the `-c` flag and read the program it runs.
    if (program === 'su') {
      for (let inner = index + 1; inner < tokens.length; inner++) {
        const flag = tokens[inner]!;
        const marker = /^-[A-Za-z]*c/.exec(flag);
        if (!marker) continue;
        const attached = flag.slice(marker[0].length);
        const value = attached.length > 0 ? attached : tokens[inner + 1];
        if (value === undefined) unclassifiable = true;
        else payloads.push(value);
        break;
      }
      continue;
    }

    // `xargs`/`find` hand their operand a list of *data* (file names, lines),
    // not a program, so a bare shell there cannot hide a command: `ls | xargs
    // sh` and `find . -name bash` are inert. A `-c` operand is a program and is
    // read by the shell branch below.
    if (program === 'xargs' || program === 'find') continue;

    if (!AMEND_SHELL_PROGRAMS.has(program)) continue;
    const payload = shellDashCPayload(tokens, index);
    if (payload === null) continue;
    // `-c` with nothing after it: the shell has a program this scan cannot
    // read, so it is unclassifiable rather than amend-free.
    if (payload === '') unclassifiable = true;
    else payloads.push(payload);
  }

  // `${IFS}` splits a word into argv entries the tokenizer keeps glued
  // together, so `git${IFS}commit${IFS}--amend` only executes an amend when the
  // expansion lands in the program word. Inside quoted arguments the same text
  // is literal (`grep '${IFS}'`), so only the program position fails closed.
  const [programWord] = skipAmendPrefixes(tokens);
  if (programWord !== undefined && /\$\{?IFS\b/.test(programWord)) {
    unclassifiable = true;
  }

  return { payloads, unclassifiable };
}

/**
 * Decode the escapes an ANSI-C word (`$'…'`) applies, so a payload hidden
 * behind `\n` is analysed as the two commands bash runs.
 */
function decodeAnsiCWord(body: string): string {
  return body.replace(/\\(.)/g, (_match, char: string) =>
    char === 'n' ? '\n' : char === 't' ? '\t' : char === 'r' ? '\r' : char,
  );
}

/**
 * Drop an unquoted `#…`-to-EOL comment, keeping quoted `#` text.
 *
 * `git commit -m 'fix: tidy' # --amend is blocked` never runs the comment, but
 * bash still ends the command there; tokenizing the words as arguments made the
 * scan read a bare `--amend` inside the note.
 */
function stripUnquotedComments(segment: string): string {
  let quote: '"' | "'" | null = null;
  let out = '';
  for (let index = 0; index < segment.length; index++) {
    const char = segment[index]!;
    if (char === '\\' && quote !== "'" && index + 1 < segment.length) {
      out += char + segment[index + 1]!;
      index++;
      continue;
    }
    if (quote !== null) {
      out += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      out += char;
      continue;
    }
    if (char === '#' && (index === 0 || /\s/.test(segment[index - 1]!))) break;
    out += char;
  }
  return out;
}

function tokensContainGitAmend(segment: string, depth: number): boolean {
  if (depth >= AMEND_UNWRAP_DEPTH_LIMIT) {
    // Fail closed for pathological wrapper nesting in a permission guard.
    return true;
  }

  segment = stripUnquotedComments(segment);

  const unwrapped = stripShellWrapper(segment);
  if (unwrapped !== segment) {
    // Unwrapping `bash -c` leaves a quoted payload as written, so `$'…'` keeps
    // its introducer and escapes; decode it before scanning the program.
    const ansiC = /^\$'([\s\S]*)'$/.exec(unwrapped.trim());
    return commandContainsGitAmendAtDepth(
      ansiC ? decodeAnsiCWord(ansiC[1]!) : unwrapped,
      depth + 1,
    );
  }

  // Wrappers embedding the command behind a flag value (`env -S '…'`) are
  // consumed by skipAmendPrefixes before the scan sees them, so read the
  // payloads off the untouched token stream.
  const nested = nestedAmendPayloads(tokenize(segment));
  for (const payload of nested.payloads) {
    if (commandContainsGitAmendAtDepth(payload, depth + 1)) return true;
  }
  if (nested.unclassifiable) return true;

  const tokens = skipAmendPrefixes(tokenize(segment));
  if (tokens.length === 0) return false;

  if (amendExecutableBasename(tokens[0]!) === 'eval') {
    return commandContainsGitAmendAtDepth(tokens.slice(1).join(' '), depth + 1);
  }

  if (isGitAmendInvocationAt(tokens, 0)) return true;

  // Wrappers that embed their command as a token subsequence rather than as a
  // prefix: `xargs git commit --amend`, `find . -exec git commit --amend …`,
  // and a leading redirection (`> log git commit --amend`), where the program
  // is not at index 0. Try every offset so those are seen without teaching this
  // function each wrapper. Quoted mentions stay inert because they arrive as a
  // single token, and `-m --amend` stays inert because the invocation check
  // consumes flag values. The basename prefilter keeps this linear: the scan
  // runs for every shell tool call before the classifier, and copying the token
  // tail at each offset made a 40k-token command take seconds.
  for (let offset = 1; offset < tokens.length; offset++) {
    if (amendExecutableBasename(tokens[offset]!) !== 'git') continue;
    if (isGitAmendInvocationAt(tokens, offset)) return true;
  }

  // A here-string is one word handed to the program on its left; when that
  // program is a shell, that word is the program it runs.
  const hereString = hereStringProgram(segment);
  if (
    hereString !== null &&
    tokens.some((token) =>
      AMEND_SHELL_PROGRAMS.has(amendExecutableBasename(token)),
    ) &&
    commandContainsGitAmendAtDepth(hereString, depth + 1)
  ) {
    return true;
  }

  return false;
}

/**
 * The word a `<<<` here-string feeds to a shell, quote-removed.
 *
 * Returns null when the segment has no here-string.
 */
function hereStringProgram(segment: string): string | null {
  const operator = segment.indexOf('<<<');
  if (operator === -1) return null;
  const [word] = tokenize(segment.slice(operator + 3));
  return word ?? null;
}

/**
 * Bodies of `$(…)`, `<(…)`, `>(…)` and backtick substitutions, which are code
 * rather than data.
 *
 * Quoted and escaped occurrences are skipped so `echo '$(date)'` does not read
 * as a substitution, and a process substitution inside double quotes stays
 * literal text, which is why `<(`/`>(` are only taken unquoted; nesting inside
 * `$( … $( … ) … )` is preserved by counting depth, and the body is returned
 * verbatim so the caller can analyse it.
 */
function extractCommandSubstitutionBodies(command: string): string[] {
  const bodies: string[] = [];
  let index = 0;
  let quote: "'" | '"' | null = null;
  // `$'…'` is not a substitution host: `$( … )` inside it is literal text, and
  // its own `\'` must not be read as closing a plain single-quoted span.
  let ansiC = false;
  while (index < command.length) {
    const char = command[index]!;
    if (ansiC) {
      if (char === '\\') {
        index += 2;
        continue;
      }
      if (char === "'") ansiC = false;
      index++;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      index += 2;
      continue;
    }
    if (!quote && char === '$' && command[index + 1] === "'") {
      ansiC = true;
      index += 2;
      continue;
    }
    if (quote === '"') {
      // Inside double quotes bash still runs substitutions, so `$( … )` and
      // backticks must be extracted; only a single-quoted string suppresses
      // them. Reparsing here rather than skipping keeps
      // `echo "$(git commit --amend)"` blocked while `echo '$(…)'` stays inert.
      if (char === '"') {
        quote = null;
        index++;
        continue;
      }
    } else if (quote === "'") {
      if (char === "'") quote = null;
      index++;
      continue;
    }
    // Only an unquoted quote opens a new state. Inside `"…"` an apostrophe is
    // literal text: letting it open a single-quoted span would swallow the
    // rest of the command and hide any `$( … )` in it (#13570 review).
    if (!quote && (char === "'" || char === '"')) {
      quote = char;
      index++;
      continue;
    }
    if (
      command[index + 1] === '(' &&
      (char === '$' || (!quote && (char === '<' || char === '>')))
    ) {
      let depth = 1;
      let cursor = index + 2;
      let inner: "'" | '"' | null = null;
      while (cursor < command.length && depth > 0) {
        const c = command[cursor]!;
        if (c === '\\' && inner !== "'") {
          cursor += 2;
          continue;
        }
        if (inner) {
          if (c === inner) inner = null;
        } else if (c === "'" || c === '"') {
          inner = c;
        } else if (c === '(') {
          depth++;
        } else if (c === ')') {
          depth--;
          if (depth === 0) break;
        }
        cursor++;
      }
      bodies.push(command.slice(index + 2, cursor));
      index = cursor + 1;
      continue;
    }
    if (char === '`') {
      const close = command.indexOf('`', index + 1);
      if (close === -1) break;
      bodies.push(command.slice(index + 1, close));
      index = close + 1;
      continue;
    }
    index++;
  }
  return bodies;
}

const SHELLS_READING_STDIN = new Set([
  'bash',
  'sh',
  'zsh',
  'dash',
  'ksh',
  'ash',
  'fish',
]);

/**
 * Heredoc bodies whose consumer runs them as code.
 *
 * `cat > notes.txt <<'EOF'` carries inert data, but `bash <<'EOF'` carries the
 * program itself — stripping every body unconditionally hides the second case.
 * The body is shell-fed when any command on the opener line is a stdin-reading
 * shell: the one that owns the redirection, or a pipe consumer after it.
 */
function extractShellFedHeredocBodies(command: string): string[] {
  const lines = command.split('\n');
  const bodies: string[] = [];
  let active: { delimiter: string; shellFed: boolean } | null = null;
  let collected: string[] = [];

  for (const line of lines) {
    if (active) {
      if (line.trim() === active.delimiter) {
        if (active.shellFed) bodies.push(collected.join('\n'));
        active = null;
        collected = [];
        continue;
      }
      collected.push(line);
      continue;
    }

    const delimiters = getHeredocDelimiters(line);
    if (delimiters.length === 0) continue;

    // Attributed to the segment that owns the redirection, plus a pipe consumer
    // after it — not to any shell anywhere on the line. `bash --version; cat >
    // notes.md <<'EOF'` writes the body to a file, so the `bash` before the `;`
    // must not turn it into a program.
    const segments = splitCompoundCommandSegments(line);
    const readsStdin = (seg: string): boolean => {
      const [program] = skipAmendPrefixes(tokenize(seg));
      return (
        program !== undefined &&
        SHELLS_READING_STDIN.has(amendExecutableBasename(program))
      );
    };
    const ownerIndex = Math.max(
      segments.findIndex(({ command: seg }) => /<<-?\s*['"]?/.test(seg)),
      0,
    );
    const owner = segments[ownerIndex]!;
    const shellFed =
      readsStdin(owner.command) ||
      ((owner.terminator === '|' || owner.terminator === '|&') &&
        segments[ownerIndex + 1] !== undefined &&
        readsStdin(segments[ownerIndex + 1]!.command));
    active = {
      delimiter: delimiters[0]!,
      shellFed,
    };
    collected = [];
  }

  return bodies;
}

function commandContainsGitAmendAtDepth(
  command: string,
  depth: number,
): boolean {
  // A heredoc handed to a shell is the program, not data.
  if (depth < AMEND_UNWRAP_DEPTH_LIMIT) {
    for (const body of extractShellFedHeredocBodies(command)) {
      if (commandContainsGitAmendAtDepth(body, depth + 1)) return true;
    }
  }
  // A substitution body is code the shell runs, so analyse it as its own
  // command before deciding the surrounding segment is amend-free.
  if (depth < AMEND_UNWRAP_DEPTH_LIMIT) {
    for (const body of extractCommandSubstitutionBodies(command)) {
      if (commandContainsGitAmendAtDepth(body, depth + 1)) return true;
    }
  }

  const code = stripHeredocBodies(command);
  const segments = splitCompoundCommandSegments(code);
  for (let index = 0; index < segments.length; index++) {
    const { command: segment, terminator } = segments[index]!;
    // A pipe into a shell hands that shell a program through stdin, and the
    // segment split keeps only the bare shell on the consumer side. The
    // producer's words are what that shell runs, so analyse them as a command;
    // `terminator` is quote-aware, so a `|` inside a commit message is not a
    // pipe and `||` is a different operator.
    const consumer = segments[index + 1];
    if ((terminator === '|' || terminator === '|&') && consumer !== undefined) {
      const fed = pipedProgramText(segment, consumer.command);
      if (fed !== null && commandContainsGitAmendAtDepth(fed, depth + 1)) {
        return true;
      }
    }
    if (tokensContainGitAmend(segment, depth)) return true;
  }
  return false;
}

/**
 * The program a shell consumer runs from its producer's output.
 *
 * `echo`/`printf` write their arguments, so the producer's words are the
 * candidate program text. Returns null when the consumer is not a shell that
 * reads stdin, and an empty string when nothing the scan can read reaches it
 * (a file, a download) — there is nothing to classify in that case.
 */
function pipedProgramText(producer: string, consumer: string): string | null {
  const [program] = skipAmendPrefixes(tokenize(consumer));
  if (
    program === undefined ||
    !SHELLS_READING_STDIN.has(amendExecutableBasename(program))
  ) {
    return null;
  }
  return tokenize(producer).slice(1).join(' ');
}

/**
 * Check whether a shell command actually invokes `git commit --amend`.
 *
 * Unlike the old raw-substring guard, this ignores quoted text, heredoc
 * bodies, commit-message arguments, and commands whose program is not git.
 */
export function commandContainsGitAmend(command: string): boolean {
  return commandContainsGitAmendAtDepth(command, 0);
}

function walkCompoundCommand(
  command: string,
  cwd: string,
  depth: number,
  initialCwdUnknown: boolean,
): ShellOperation[] {
  const subCommands = splitCompoundCommandSegments(stripHeredocBodies(command));

  const ops: ShellOperation[] = [];
  let effectiveCwd = cwd;
  let cwdUnknown = initialCwdUnknown;

  for (const { command: sub, terminator } of subCommands) {
    // `cd x & …` runs the `cd` in a background subshell, so it does not move
    // the cwd the following segments run in. Treating it as a foreground `cd`
    // would attribute their relative writes to the wrong directory — for
    // `cd /tmp & echo {} > settings.json` the write lands in the *original*
    // cwd, which is exactly where a protected settings file would be.
    const backgrounded = terminator === '&';

    const cdTarget = resolveCdTargetCwd(sub, effectiveCwd, cwdUnknown);
    if (cdTarget.kind !== 'not-cd') {
      const redirectOps = toRedirectOperations(cdTarget.redirects);
      ops.push(
        ...(cwdUnknown
          ? markCwdUnknownOps(redirectOps, sub, effectiveCwd)
          : redirectOps),
      );
      if (!backgrounded) {
        if (cdTarget.kind === 'static') {
          effectiveCwd = cdTarget.cwd;
          cwdUnknown = cdTarget.cwdUnknown;
        } else {
          cwdUnknown = true;
        }
      }
      continue;
    }

    // Unwrap per segment, after the outer split, so wrapper suffixes like
    // `bash -lc 'safe' && echo > file` are not discarded.
    if (depth < MAX_SHELL_UNWRAP_DEPTH) {
      const subUnwrapped = stripShellWrapper(sub);
      if (subUnwrapped !== sub) {
        ops.push(
          ...walkCompoundCommand(
            subUnwrapped,
            effectiveCwd,
            depth + 1,
            cwdUnknown,
          ),
        );
        continue;
      }
    } else if (stripShellWrapper(sub) !== sub) {
      shellSemanticsDebugLogger.warn(
        `Shell wrapper unwrap depth limit reached (${MAX_SHELL_UNWRAP_DEPTH}); analysing remaining command as-is.`,
      );
    }

    const subOps = extractShellOperations(sub, effectiveCwd);
    if (cwdUnknown) {
      ops.push(...markCwdUnknownOps(subOps, sub, effectiveCwd));
    } else {
      ops.push(...subOps);
    }
  }

  return ops;
}

function hasAbsolutePathTokenForOperation(
  command: string,
  cwd: string,
  filePath: string,
): boolean {
  for (const token of tokenize(command)) {
    // `[12]?>&` and `<&` come before `1>`, `>` and `<`, or those would match
    // first and leave `&/abs/path`. A quoted `&` (`>"&"/tmp/x` writes the
    // relative `&/tmp/x`) can't match by mistake: the resolved path must
    // equal the operation's path.
    const redirectTarget = token.match(
      /^(?:1>>|[12]?>&|<&|1>|>>|>|2>>|2>|&>>|&>|<)([\s\S]+)$/,
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
