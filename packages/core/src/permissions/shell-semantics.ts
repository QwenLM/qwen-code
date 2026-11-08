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
import {
  decodeAnsiCEscape,
  decodeAnsiCWord,
  stripShellWrapper,
} from '../utils/shell-utils.js';
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
 * Index of the next character the shell actually lexes after `from`: a
 * `\`+newline continuation is removed outright, so `$` + continuation + `'`
 * still opens the ANSI-C word (#16075 review, R7-1).
 */
function nextSignificantIndex(command: string, from: number): number {
  let i = from;
  while (command[i] === '\\' && command[i + 1] === '\n') i += 2;
  return i;
}

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
  // A NUL ends the word bash builds inside an ANSI-C quote: `$'a\0b'c` is the
  // word `ac` — the rest of the quoted segment is dropped, but a following
  // concatenation segment still appends (#16075 review, R11-2). Once set, the
  // scan skips to the segment's closing quote without emitting anything.
  let ansiCTruncated = false;
  let escaped = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;

    if (inAnsiC) {
      if (ansiCTruncated) {
        // Skip an escaped character so `\'` does not read as the closing quote.
        if (ch === '\\') {
          i++;
          continue;
        }
        if (ch === "'") {
          inAnsiC = false;
          ansiCTruncated = false;
        }
        continue;
      }
      if (ch === '\\') {
        const escape = decodeAnsiCEscape(command, i);
        if (!escape) {
          current += '\\';
          bare += '0';
          continue;
        }
        if (escape.text === '\0') {
          ansiCTruncated = true;
          i += escape.length - 1;
          continue;
        }
        current += escape.text;
        // `bare` is one entry per UTF-16 unit of `current`; an escape such as
        // `\U0001F600` decodes to a two-unit astral char, so a single '0' here
        // desynced the positional map for the rest of the word and left
        // trailing syntax (`)`) glued to the token (#16075 review, R13-2).
        bare += '0'.repeat(escape.text.length);
        i += escape.length - 1;
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
    // A `\`+newline between the two is removed first (#16075 review, R7-1).
    // `$"…"` is bash's locale-translation quoting: the shell removes the
    // introducer and quotes just like a double-quoted word, so `git $"commit"`
    // runs the `commit` subcommand (#16075 review, R8-11).
    if (ch === '$' && !inSingle && !inDouble) {
      const next = nextSignificantIndex(command, i + 1);
      if (command[next] === "'") {
        inAnsiC = true;
        i = next;
        continue;
      }
      if (command[next] === '"') {
        inDouble = true;
        i = next;
        continue;
      }
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
      // -n/--line-number only print line numbers. They take no argument;
      // treating them as value flags consumes the pattern and drops the file.
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

interface HeredocOpener {
  /** The delimiter word of a `<<` heredoc; empty for a `<<<` here-string. */
  word: string;
  /** True for a `<<<` here-string (its word is data, not a delimiter). */
  hereString: boolean;
  /** Offset of the `<` that opens the operator. */
  index: number;
}

/**
 * Unquoted heredoc (`<<`) and here-string (`<<<`) operators on one line, in
 * order, with their offsets. Quote- and ANSI-C-aware: `echo "a << b"` and
 * `$'it\'s << EOF'` carry no operator, so a decoy cannot claim ownership of
 * a real opener's body (#16075 review, R9-1).
 */
function scanHeredocOpeners(line: string): HeredocOpener[] {
  const openers: HeredocOpener[] = [];
  let inSingle = false;
  let inDouble = false;
  let inAnsiC = false;
  let escaped = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;

    if (inAnsiC) {
      // `\'` does not close an ANSI-C word.
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === "'") inAnsiC = false;
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && !inSingle) {
      escaped = true;
      continue;
    }
    if (ch === '$' && !inSingle && !inDouble && line[i + 1] === "'") {
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
    if (inSingle || inDouble || ch !== '<' || line[i + 1] !== '<') {
      continue;
    }
    if (line[i + 2] === '<') {
      openers.push({ word: '', hereString: true, index: i });
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
      openers.push({
        word: line.slice(wordStart, wordEnd),
        hereString: false,
        index: i,
      });
    }
    i = wordEnd;
  }
  return openers;
}

function getHeredocDelimiters(line: string): string[] {
  return scanHeredocOpeners(line)
    .filter((opener) => !opener.hereString)
    .map((opener) => opener.word);
}

const AMEND_PREFIX_COMMANDS = new Set([
  ...PREFIX_COMMANDS,
  'command',
  'exec',
  // setsid execs its operand transparently (setsid(1)); a heredoc fed to
  // `setsid bash` is the program bash runs (#16075 review, R1-1).
  'setsid',
]);

const AMEND_PREFIX_FLAGS_WITH_VALUE = new Map<string, ReadonlySet<string>>([
  ...PREFIX_COMMAND_FLAGS_WITH_VALUE,
  ['doas', new Set(['-u', '-C'])],
  // exec's -a supplies argv[0]; without it the supplied name reads as the
  // program and the real command behind it is missed (#16075 review, R1-1).
  ['exec', new Set(['-a'])],
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

/**
 * Leading control-flow keywords wrapping a cd that still runs in THIS shell
 * (`if cd x; then …`, `while cd x; do …`). Stripping them lets the exemption
 * walk track the cd; the rest of the segment keeps its raw quoting. Longest
 * first so `done` is not read as `do` + noise.
 */
const AMEND_LEADING_FLOW_NOISE = new RegExp(
  '^(?:(?:' +
    [...AMEND_LEADING_NOISE].sort((a, b) => b.length - a.length).join('|') +
    ')[ \\t]+)+',
);

const AMEND_GIT_GLOBAL_FLAGS_WITH_VALUE =
  /^(?:-[cC]|--(?:attr-source|config-env|exec-path|git-dir|list-cmds|namespace|super-prefix|work-tree))$/;

/** Long `git commit` options that consume the following word as their value. */
const AMEND_COMMIT_LONG_FLAGS_WITH_VALUE =
  /^--(?:author|cleanup|date|file|fixup|message|pathspec-from-file|reedit-message|reuse-message|squash|template|trailer)$/;

/**
 * Does this `git commit` short-option cluster consume the NEXT word as a
 * value? git's parse-options reads a cluster letter by letter: the first
 * value-taking letter (`c`, `C`, `F`, `m`, `t`) takes the rest of the token
 * as its attached value when non-empty (`-mtopic`, `-mC`), and only an empty
 * rest consumes the next word (`-m --amend` is a message, not an amend).
 * `S`/`u` take an OPTIONAL attached value and never consume the next word.
 * Reading the whole cluster as one value flag swallowed the following
 * `--amend` (#16075 review, R1-6).
 */
function amendCommitShortClusterConsumesNext(token: string): boolean {
  if (!token.startsWith('-') || token.startsWith('--') || token.length < 2) {
    return false;
  }
  for (let p = 1; p < token.length; p++) {
    const letter = token[p]!;
    if (letter === 'S' || letter === 'u') {
      if (p + 1 < token.length) return false; // attached optional value
      continue;
    }
    if ('cCFmt'.includes(letter)) {
      return p + 1 === token.length; // empty rest: value is the next word
    }
  }
  return false;
}

const AMEND_UNWRAP_DEPTH_LIMIT = 8;

/** An `alias.*` git expands itself, so the subcommand word is not what runs.
 * Config section names are case-insensitive (`ALIAS.x` is `alias.x`). */
const AMEND_GIT_ALIAS_CONFIG = /^alias\.[^=]+=/i;

const AMEND_FIND_EXEC_MARKERS = new Set(['-exec', '-execdir', '-ok', '-okdir']);

/** A redirection operator as its own word; its target is the next word.
 * `<>` (read-write) and `>|` (clobber override) are redirections too: bash
 * runs `git <> /dev/null commit --amend` (#16075 review, R1-1). */
const AMEND_REDIRECT_WORD = /^\d*(?:>>?|>\||<<?|<>|<<<|>&|<&|&>|&>>)$/;

/** A redirection operator prefix, including glued targets (`>/dev/null`). */
const AMEND_REDIRECT_TOKEN = /^\d*(?:>>?|>\||<<?|<>|<<<|>&|<&|&>|&>>)/;

/**
 * Shell expansion syntax that can word-split into argv entries: variables,
 * `${…}` forms, command substitutions, brace lists, and the positional /
 * special parameters (`$1`, `$@`, `$*`, …) which expand to nothing when unset,
 * gluing the surrounding letters into the plain word (`git commit$1 --amend`
 * runs `git commit --amend`). A bare `$` at the end of a word is literal —
 * it stays in the word, so git never sees the subcommand — and does not match.
 */
const AMEND_EXPANSION_WORD = /\$[A-Za-z0-9_{(@*#?$!-]|`|\{[^{}]*,/;

/** Whether the command assigns `IFS` outside quotes — the assignment decides
 * how an unquoted expansion word-splits (#16075 review, R1-1/R12-1). */
function hasUnquotedIfsAssignment(command: string): boolean {
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote !== null) {
      if (ch === '\\' && quote === '"') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (!command.startsWith('IFS=', i)) continue;
    const before = i === 0 ? ' ' : command[i - 1]!;
    if (/[\s;|&()]/.test(before)) return true;
  }
  return false;
}

/** The text left when every expansion is read as empty, which is what bash
 * does for an unset name or an empty substitution (#16075 review, R1-1). */
function stripExpansionSyntax(text: string): string {
  return text
    .replace(/\$\([^()]*\)/g, '')
    .replace(/`[^`]*`/g, '')
    .replace(/\$\{[^}]*\}/g, '')
    .replace(/\$[A-Za-z_][A-Za-z0-9_]*/g, '')
    .replace(/\$[0-9@*#?$!-]/g, '');
}

/** A word carrying an unquoted pathname-expansion metacharacter. bash expands
 * these before it decides which program or flag the word names, so a glob in a
 * decisive word makes the invocation unprovable (#16075 review, R1-1). */
const AMEND_GLOB_WORD = /[*?[\]]/;

/** xargs short letters whose value is required: attached to the cluster, or
 * the next word when the cluster ends there. `-L` is one of them — GNU xargs
 * declares `L:`, so `xargs -L 5 rm` runs `rm`. Treating it as optional made
 * every `xargs -L N <program>` pipeline unclassifiable and the recogniser
 * answered "amend" (a false denial on plain file pipelines). */
const XARGS_VALUE_LETTERS = 'IJnLPsEadR';
/** xargs short letters with an OPTIONAL attached value: a detached value
 * cannot be told from the program word, so the position fails closed. */
const XARGS_OPTIONAL_LETTERS = 'el';
const XARGS_NO_VALUE_LETTERS = '0prtxo';
const XARGS_LONG_REQUIRED = new Set([
  '--max-args',
  '--max-procs',
  '--max-chars',
  '--delimiter',
  '--arg-file',
  '--process-slot-var',
  '--max-lines',
]);
const XARGS_LONG_OPTIONAL = new Set(['--replace', '--eof']);
const XARGS_LONG_NO_VALUE = new Set([
  '--null',
  '--no-run-if-empty',
  '--verbose',
  '--exit',
  '--open-tty',
  '--help',
  '--version',
]);

/**
 * The offset of the program xargs runs, or -1 when it runs its default
 * (`echo`, inert), or null when a flag makes the position unclassifiable.
 * The old scan skipped every `-` word, so `-I {}` left `{}` as the apparent
 * program and the real `sh -c '…'` behind it went unread (#16075 R1-1).
 */
function xargsProgramOffset(tokens: string[], start: number): number | null {
  let index = start;
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (token === '--') {
      return index + 1 < tokens.length ? index + 1 : -1;
    }
    if (!token.startsWith('-')) return index;
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      const name = eq === -1 ? token : token.slice(0, eq);
      if (XARGS_LONG_REQUIRED.has(name)) {
        index += eq === -1 ? 2 : 1;
        continue;
      }
      if (XARGS_LONG_OPTIONAL.has(name)) {
        if (eq !== -1) {
          index++;
          continue;
        }
        return null;
      }
      if (XARGS_LONG_NO_VALUE.has(name)) {
        index++;
        continue;
      }
      return null;
    }
    const letters = token.slice(1);
    let consumesNext = false;
    for (let p = 0; p < letters.length; p++) {
      const letter = letters[p]!;
      if (XARGS_VALUE_LETTERS.includes(letter)) {
        consumesNext = p + 1 === letters.length;
        break; // the rest of the cluster is the attached value
      }
      if (XARGS_OPTIONAL_LETTERS.includes(letter)) {
        if (p + 1 === letters.length) return null;
        break;
      }
      if (!XARGS_NO_VALUE_LETTERS.includes(letter)) return null;
    }
    index += consumesNext ? 2 : 1;
  }
  return -1;
}

/**
 * Offsets whose token can be the program of a wrapper that carries its command
 * in argument position: `xargs`'s first operand, the word after `find`'s
 * `-exec`/`-ok`, and the word after a leading redirection's target.
 *
 * Every other offset above the prefix is an argument, where `echo git commit
 * --amend >> CHANGELOG.md` and `echo bash -c '…'` are data rather than
 * invocations (#16075 review, R5-4). Returns null when a wrapper's operand
 * position cannot be classified — the caller fails closed.
 */
function amendWrapperProgramOffsets(tokens: string[]): Set<number> | null {
  const offsets = new Set<number>();
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (AMEND_FIND_EXEC_MARKERS.has(token)) {
      offsets.add(index + 1);
      continue;
    }
    if (amendExecutableBasename(token) === 'xargs') {
      const operand = xargsProgramOffset(tokens, index + 1);
      if (operand === null) return null;
      if (operand >= 0) offsets.add(operand);
      continue;
    }
    if (AMEND_REDIRECT_WORD.test(token)) offsets.add(index + 2);
  }
  return offsets;
}

function amendExecutableBasename(token: string): string {
  return (token.split(/[\\/]/).pop() ?? token)
    .toLowerCase()
    .replace(/\.(?:exe|cmd|bat)$/i, '');
}

/**
 * The program part of a word before any glued redirection operator. The word
 * tokenizer keeps `bash<<'EOF'` and `bash<<<'…'` as one token, so the consumer
 * of a heredoc/here-string must be read from the position before the `<`, not
 * from the whole token spelling (#16075 review, R1-1).
 */
function amendProgramBeforeRedirect(token: string): string {
  const cut = token.search(/[<>]/);
  return cut === -1 ? token : token.slice(0, cut);
}

function skipAmendPrefixes(tokens: string[]): string[] {
  let index = 0;

  // Leading redirections attach to the command, not to the program word:
  // `>log bash -c '…'` and `2>/dev/null bash -c '…'` run bash (#16075
  // review, R1-1). A bare operator consumes its target word.
  while (index < tokens.length && AMEND_REDIRECT_TOKEN.test(tokens[index]!)) {
    index += AMEND_REDIRECT_WORD.test(tokens[index]!) ? 2 : 1;
  }

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
    if (program === 'timeout' && index < tokens.length) {
      // timeout always takes a duration operand after its flags; consume it
      // without validating its spelling — `.5s`, `1m`, `0.5` all run the
      // command behind it (#16075 review, R1-1). `--help`/`--version` were
      // already consumed as flags, leaving no operand here.
      index++;
    }
  }

  return tokens.slice(index);
}

function isGitAmendInvocationAt(tokens: string[], start: number): boolean {
  if (amendExecutableBasename(tokens[start] ?? '') !== 'git') return false;
  // Pathname expansion can turn either decisive word into another one:
  // `git commi? --amend` and `git commit --?mend` become the amend only after
  // bash globs them. The model does not evaluate globs, so a glob in a word
  // that decides the invocation fails closed (#16075 review, R1-1).
  if (AMEND_GLOB_WORD.test(tokens[start]!)) return true;

  let index = start + 1;
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (token === '--') {
      index++;
      break;
    }
    // Redirections interleave with the global flags: `git >/dev/null commit
    // --amend` and `git 2>&1 commit --amend` run the same invocation
    // (#16075 review, R1-1). A standalone operator word takes the next token
    // as its target.
    if (AMEND_REDIRECT_TOKEN.test(token)) {
      index +=
        AMEND_REDIRECT_WORD.test(token) && index + 1 < tokens.length ? 2 : 1;
      continue;
    }
    if (!token.startsWith('-')) break;
    // git expands an `alias.*` it is handed here, so the subcommand word that
    // follows is not the program that runs (#16075 review, R4-1).
    if (
      AMEND_GIT_ALIAS_CONFIG.test(token.replace(/^--config-env=/, '')) ||
      (AMEND_GIT_GLOBAL_FLAGS_WITH_VALUE.test(token) &&
        index + 1 < tokens.length &&
        AMEND_GIT_ALIAS_CONFIG.test(tokens[index + 1]!))
    ) {
      return true;
    }
    index +=
      AMEND_GIT_GLOBAL_FLAGS_WITH_VALUE.test(token) && index + 1 < tokens.length
        ? 2
        : 1;
  }

  // A glob in the subcommand word expands to `commit` or to something else,
  // and neither reading is provable (#16075 review, R1-1).
  if (AMEND_GLOB_WORD.test(tokens[index] ?? '')) return true;
  if (tokens[index] !== 'commit') return false;

  for (index++; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token === '--') return false;
    // A glob in a flag word (`--?mend`) can expand to `--amend`; argument
    // words stay data (#16075 review, R1-1).
    if (token.startsWith('-') && AMEND_GLOB_WORD.test(token)) return true;
    // A word boundary ends the flag, so `--amend` stays an amend when bash
    // glues a redirect (`--amend>log`), a parameter expansion (`--amend$(…)`)
    // or a brace range (`--amend{,}`) onto it. `--amendx` / `--amend-foo` are
    // rejected by git itself and stay unrecognised. git also accepts every
    // unambiguous prefix of `--amend`, and no other commit option starts
    // with `--am` (#16075 review, R8-8).
    if (/^--am(?:e(?:n(?:d)?)?)?(?![A-Za-z-])/.test(token)) return true;

    const consumesNext = token.startsWith('--')
      ? AMEND_COMMIT_LONG_FLAGS_WITH_VALUE.test(token)
      : amendCommitShortClusterConsumesNext(token);
    if (consumesNext && index + 1 < tokens.length) index++;
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

/** Long shell options that never consume a following word. Unknown long
 * options fail closed: the payload position cannot be located. */
const SHELL_LONG_NO_VALUE = new Set([
  '--debug',
  '--debugger',
  '--dump-po-strings',
  '--dump-strings',
  '--help',
  '--interactive',
  '--login',
  '--noediting',
  '--no-execute',
  '--noprofile',
  '--norc',
  '--posix',
  '--private',
  '--protected',
  '--restricted',
  '--rpm-requires',
  '--verbose',
  '--version',
]);

/** Long shell options whose value is the next word (or the `=` tail). */
const SHELL_LONG_WITH_VALUE = new Set([
  '--rcfile',
  '--init-file',
  '--init-command',
  '--emulate',
]);

/** Single-letter shell options that take no operand (bash/dash/ksh common).
 * A cluster letter outside this set and the value-taking set makes the payload
 * position unlocatable, so the scan fails closed rather than guess (#16075
 * review, R1-1). */
const SHELL_SHORT_NO_VALUE = new Set('abefhiklmnprstuvxBCDEHPT'.split(''));

/**
 * The `-c` payload of a shell token, if it carries one.
 *
 * Returns `null` when the token list has no `-c`, and an empty string when `-c`
 * carries no locatable payload — the caller fails closed on that, because a
 * shell whose program this scan cannot read must not answer "not an amend".
 *
 * Option operands are consumed, not read as the payload: `ksh -o errexit -c
 * '…'` and `bash -o posix -c '…'` hand `-c` the word AFTER the option name
 * (#16075 review, R1-1). A `-c` cluster with letters after the `c` has no
 * provable payload (bash and dash read it differently) and fails closed.
 */
function shellDashCPayload(tokens: string[], index: number): string | null {
  const program = amendExecutableBasename(tokens[index] ?? '');
  const isFish = program === 'fish';
  const isScript = program === 'script';
  // Value-taking short letters differ per shell: fish's -C/-d, script's
  // log/format options (-I/-O/-B/-T/-m/-E/-o/-t), and every shell's -o/-O.
  const shortValueLetters = isFish
    ? /[CdoO]/
    : isScript
      ? /[IOBTmEot]/
      : /[oO]/;
  for (let inner = index + 1; inner < tokens.length; inner++) {
    const token = tokens[inner]!;
    // A redirection between the shell and its `-c` is neither an option nor
    // the payload: `bash 2>/dev/null -c '…'` still runs that payload, so skip
    // the operator and its target instead of ending the scan (#16075 review,
    // R1-1).
    if (AMEND_REDIRECT_TOKEN.test(token)) {
      inner +=
        AMEND_REDIRECT_WORD.test(token) && inner + 1 < tokens.length ? 1 : 0;
      continue;
    }
    // `+o` turns an option off and is read like `-o`; a word that is neither a
    // `-` nor a `+` option ends the option scan (#16075 review, R1-1).
    if (token === '-' || (!token.startsWith('-') && !token.startsWith('+'))) {
      break;
    }
    if (token === '--') break; // end of options: the next word is a script file
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      const name = eq === -1 ? token : token.slice(0, eq);
      if (SHELL_LONG_WITH_VALUE.has(name)) {
        if (eq === -1) inner++;
        continue;
      }
      if (SHELL_LONG_NO_VALUE.has(name)) continue;
      return '';
    }
    const plus = token.startsWith('+');
    const letters = token.slice(1);
    if (!plus) {
      const cAt = letters.indexOf('c');
      if (cAt !== -1) {
        const trailing = letters.slice(cAt + 1);
        if (trailing === '') {
          let payload = tokens[inner + 1] ?? '';
          if (payload === '--') payload = tokens[inner + 2] ?? '';
          // An ANSI-C payload decodes to readable command text; analyse that.
          const decoded = decodeBareAnsiCWord(payload);
          if (decoded !== payload) return decoded;
          // A payload that is itself an unresolved expansion (`bash -c $X
          // '…'`) can be any command text — including the FOLLOWING word when
          // $X expands to `--`. No program is provable: fail closed.
          if (/^[$`]/.test(payload)) return '';
          // An option-looking operand is read differently per shell: bash keeps
          // processing options past `-c` and takes the first non-option word
          // (`bash -c -x 'cmd'` runs `cmd`), while dash reads the operand as the
          // payload. A quoted word that could expand to `--` (`bash -c "--$X"`)
          // is the same ambiguity. Neither reading is provable: fail closed
          // (#16075 review, R1-1 / R13-1).
          if (payload.startsWith('-')) return '';
          return payload;
        }
        // Letters after `c` disagree between shells: bash reads them as more
        // options and takes the FIRST NON-OPTION argument as the payload
        // (`bash -ce 'cmd'` runs `cmd`, witnessed), while dash/zsh/getopt read
        // them as `-c`'s attached value. No single payload is provable, so the
        // position is unclassifiable rather than amend-free (#16075 R1-1).
        return '';
      }
    }
    // No `c` payload in this cluster: consume the operands of value-taking
    // letters so the scan lands on the real `-c`. A cluster of known no-value
    // letters consumes nothing; any unknown letter leaves the payload position
    // unlocatable (`script -I /dev/null -c '…'`), so fail closed rather than
    // answer "no -c" (#16075 review, R1-1).
    const valueAt = [...letters].findIndex((letter) =>
      shortValueLetters.test(letter),
    );
    if (valueAt !== -1) {
      // An attached tail IS the value and the next word is not consumed:
      // `script -t/dev/null -c '…'` still carries that `-c` payload
      // (#16075 review, R1-1).
      if (valueAt + 1 < letters.length) continue;
      inner++;
      continue;
    }
    if ([...letters].every((letter) => SHELL_SHORT_NO_VALUE.has(letter))) {
      continue;
    }
    return '';
  }
  return null;
}

/** env options that never consume a following word (FreeBSD/GNU common
 * set); anything else unknown fails closed. */
const ENV_NO_VALUE_FLAGS = new Set([
  '-i',
  '--ignore-environment',
  '-0',
  '--null',
  '-v',
  '--debug',
]);

/** util-linux su options that consume the next word (su(1)). */
const SU_VALUE_FLAGS = new Set([
  '-s',
  '--shell',
  '-g',
  '--group',
  '-G',
  '--supp-group',
  '-w',
  '--whitelist-environment',
]);

const SU_NO_VALUE_FLAGS = new Set([
  '-m',
  '-p',
  '-l',
  '-f',
  '--login',
  '--fast',
  '-P',
  '--pty',
  '-T',
  '--no-pty',
  '-h',
  '--help',
  '-V',
  '--version',
]);

/**
 * A name's statically known quote-removed value, or null when the value cannot
 * be resolved (it carries an expansion, the name is only exported from the
 * environment, an append builds on an unknown prior, or two assignments give
 * conflicting values). #16075 review, R12-1.
 */
type AmendAssignments = ReadonlyMap<string, string | null>;

/** A value with any `$`/backtick is an expansion bash resolves at run time. */
function staticAssignmentValue(raw: string): string | null {
  return /\$|`/.test(raw) ? null : raw;
}

/**
 * Values assigned anywhere in the command — leading assignments, prefix
 * assignments, `NAME+=` appends, and `export`/`declare`/`typeset` arguments.
 * Propagating the value (not just the name) lets an expanded program word whose
 * value is a provably non-amend command (`X="git status"; $X`) stay allowed,
 * while a value that can yield an amend, or that is unresolvable, still fails
 * closed (`X=$'git\x20commit\x20--amend'; $X`). Conflicting assignments and
 * appends onto an unknown prior collapse to null so a conditional assignment
 * the scan cannot order never reads as a known-safe value.
 */
function collectAssignments(
  command: string,
  inherited: AmendAssignments,
): AmendAssignments {
  let values: Map<string, string | null> | null = null;
  const current = () => values ?? inherited;
  const write = (name: string, value: string | null) => {
    (values ??= new Map(inherited)).set(name, value);
  };
  const assign = (name: string, value: string | null) => {
    const prior = current().get(name);
    // First assignment wins; a later identical one is harmless; a conflicting
    // one is unorderable here, so it fails closed.
    write(name, prior === undefined || prior === value ? value : null);
  };
  const append = (name: string, added: string | null) => {
    const prior = current().get(name);
    write(
      name,
      added === null || prior === null || prior === undefined
        ? null
        : prior + added,
    );
  };
  const readArgument = (arg: string, allowBare: boolean): boolean => {
    const appended = /^([A-Za-z_][A-Za-z0-9_]*)\+=([\s\S]*)$/.exec(arg);
    if (appended) {
      append(appended[1]!, staticAssignmentValue(appended[2]!));
      return true;
    }
    const named = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(arg);
    if (named) {
      assign(named[1]!, staticAssignmentValue(named[2]!));
      return true;
    }
    // A bare `export FOO` keeps the environment value: unknown unless a prior
    // assignment in this command already pinned it. Only an export/declare
    // argument reads a bare name; a top-level bare word is a program, not an
    // assignment.
    if (allowBare) {
      const bare = /^([A-Za-z_][A-Za-z0-9_]*)$/.exec(arg);
      if (bare) {
        if (!current().has(bare[1]!)) write(bare[1]!, null);
        return true;
      }
    }
    return false;
  };
  // Split compound segments first: the word tokenizer breaks on whitespace
  // only, so `X=git; $X …` would otherwise glue the `;` into the value.
  // Names written by constructs other than `NAME=value` are not static: a
  // `read`, `mapfile`, `printf -v` or `getopts` in the same command overwrites
  // the literal the scanner saw (#16075 review, R12-1).
  const writtenElsewhere = (tokens: string[]): void => {
    for (let i = 0; i < tokens.length; i++) {
      const base = amendExecutableBasename(tokens[i]!);
      if (base === 'read' || base === 'mapfile' || base === 'readarray') {
        for (let j = i + 1; j < tokens.length; j++) {
          const arg = tokens[j]!;
          if (arg.startsWith('-') || arg.startsWith('<')) continue;
          if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(arg)) write(arg, null);
        }
        continue;
      }
      if (base === 'printf') {
        const v = tokens.indexOf('-v', i + 1);
        const name = v === -1 ? undefined : tokens[v + 1];
        if (name !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
          write(name, null);
        }
        continue;
      }
      if (base === 'getopts') {
        const name = tokens[i + 2];
        if (name !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
          write(name, null);
        }
      }
    }
  };
  for (const { command: segment } of splitCompoundCommandSegments(command)) {
    const tokens = tokenize(segment);
    // Assignment words bind only in command position: `X=ls; $X` sets X, while
    // `echo X=ls; $X` prints text and sets nothing (#16075 review, R12-1).
    let i = 0;
    while (i < tokens.length && readArgument(tokens[i]!, false)) i++;
    for (; i < tokens.length; i++) {
      const token = tokens[i]!;
      if (/^(?:export|declare|typeset)$/.test(amendExecutableBasename(token))) {
        for (let j = i + 1; j < tokens.length; j++) {
          const arg = tokens[j]!;
          if (arg.startsWith('-')) continue;
          if (!readArgument(arg, true)) break;
        }
      }
    }
    writtenElsewhere(tokens);
  }
  return values ?? inherited;
}

/**
 * Whether a program word carrying an expansion can still be git running an
 * amend (#16075 review, R12-1). The scan fails closed only when the word can
 * actually be git, so ordinary invocations stay allowed:
 *
 *   - `IFS`, a referenced name whose assigned value is unresolvable, a command
 *     substitution, a special parameter or a brace operator expands to
 *     arbitrary text → unclassifiable;
 *   - a referenced name with a statically known value is substituted and the
 *     resulting command is read: `X="git status"; $X` is amend-free, while
 *     `X='git commit --amend'; $X` and `X=git; $X commit --amend` still amend;
 *   - a static basename after the last slash that is not `git`
 *     (`${BIN}/tool`, `$VENV/bin/pip`) can never run git → amend-free;
 *   - otherwise the program may be git, and the remaining words decide:
 *     `$GIT commit --amend` stays blocked, `$MAKE all` does not.
 *
 * The git-flag / subcommand / commit-argument expansion checks below the
 * call site are untouched: those positions decide the invocation even for
 * a statically known git.
 */
function programExpansionCouldAmend(
  word: string,
  rest: string[],
  assignments: AmendAssignments,
): boolean {
  // IFS word-splits the program into arbitrary text.
  if (/\$\{?IFS\b/.test(word)) return true;
  // Substitute the statically known values; a referenced name whose value is
  // unresolvable (null) fails closed. An unassigned name is left as residual
  // expansion text and handled by the could-be-git reading below.
  let unresolvable = false;
  const resolved = word.replace(
    /\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})/g,
    (whole, plain: string | undefined, braced: string | undefined) => {
      const name = (plain ?? braced)!;
      const value = assignments.get(name);
      if (value === undefined) return whole;
      if (value === null) {
        unresolvable = true;
        return whole;
      }
      return value;
    },
  );
  if (unresolvable) return true;
  // Any expansion syntax left over (`$(…)`, backticks, `${VAR:-…}`, `$1`, an
  // unassigned name, a brace list) is unresolvable text: the program may be
  // git, and the remaining words decide.
  if (AMEND_EXPANSION_WORD.test(resolved) || resolved.includes('`')) {
    const basename = (resolved.split(/\s+/)[0] ?? '').split('/').pop() ?? '';
    if (!/[$`]/.test(basename) && amendExecutableBasename(basename) !== 'git') {
      return false;
    }
    if (isGitAmendInvocationAt(['git', ...rest], 0)) return true;
    // An unset or empty expansion expands to NOTHING, gluing the surrounding
    // text into the decisive words: `A='git commit'; $A$UNSET_VAR --amend`
    // runs `git commit --amend`. Read that second reading too
    // (#16075 review, R1-1).
    const dropped = stripExpansionSyntax(resolved);
    const droppedTokens = [...tokenize(dropped), ...rest];
    if (isGitAmendInvocationAt(skipAmendPrefixes(droppedTokens), 0)) {
      return true;
    }
    for (let offset = 1; offset < droppedTokens.length; offset++) {
      if (amendExecutableBasename(droppedTokens[offset]!) !== 'git') continue;
      if (isGitAmendInvocationAt(droppedTokens, offset)) return true;
    }
    return false;
  }
  // The program word resolved to static text. bash word-splits an unquoted
  // expansion, so read the invocation the value forms together with the
  // remaining words rather than trusting the glued token.
  const combined = [...tokenize(resolved), ...rest];
  const stripped = skipAmendPrefixes(combined);
  if (isGitAmendInvocationAt(stripped, 0)) return true;
  for (let offset = 1; offset < combined.length; offset++) {
    if (amendExecutableBasename(combined[offset]!) !== 'git') continue;
    if (isGitAmendInvocationAt(combined, offset)) return true;
  }
  // The program word resolving to static text does not make the REST of the
  // command static: a bare expansion in a position that decides the invocation
  // can be `--amend` (`X='git commit'; Y='--amend'; $X $Y`). A flag's value is
  // data (`-m "$MSG"`), so only an expansion word that is not consumed as a
  // value fails closed (#16075 review, R12-1 second round).
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (!/^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(token)) continue;
    const previous = i > 0 ? rest[i - 1]! : undefined;
    const consumed =
      previous !== undefined &&
      (AMEND_COMMIT_LONG_FLAGS_WITH_VALUE.test(previous) ||
        amendCommitShortClusterConsumesNext(previous));
    if (!consumed) return true;
  }
  // A dashed git program word (`git-commit`) is a git invocation the invocation
  // reader does not model; keep it blocked rather than guess it is amend-free.
  const program = amendExecutableBasename(stripped[0] ?? '');
  if (program !== 'git' && /^git[-.]/.test(program)) return true;
  return false;
}

/**
 * Programs the token scan cannot turn into a command, plus the ones it can.
 *
 * `commandContainsGitAmend` is the deterministic AUTO-mode gate, so a construct
 * it cannot positively classify has to answer "amend" rather than "not an
 * amend". Since #16075 R9 (B1) that contract is enforced structurally at the
 * top level: this token scan may only ADD denials, and the fail-closed
 * backstop in `commandContainsGitAmend` re-tests the base substring pattern
 * over the raw command plus its wrapper-stripped form, denying every literal
 * occurrence the scan did not confirm unless `amendOccurrencesProvablyInert`
 * proves each one inert data. The list is grouped by construct rather than by
 * spelling: a `-c` payload and an `env -S` value are extracted and analysed,
 * while a shell fed by an executor or by data the model never reads fails
 * closed.
 */
function nestedAmendPayloads(
  tokens: string[],
  assignedNames: AmendAssignments = new Map(),
): {
  payloads: string[];
  unclassifiable: boolean;
} {
  const payloads: string[] = [];
  let unclassifiable = false;

  // git expands an `alias.*` handed to it through `GIT_CONFIG_KEY_n` or a
  // `GIT_CONFIG_PARAMETERS` entry; the value is arbitrary text, so a defined
  // alias is unclassifiable (#16075 review, R4-1 / R8-12). Config sections
  // are case-insensitive, and the PARAMETERS value keeps its inner quotes.
  for (const token of tokens) {
    if (
      /^(?:GIT_CONFIG_KEY_\d+|GIT_CONFIG_PARAMETERS)=.*alias\./i.test(token)
    ) {
      unclassifiable = true;
    }
  }

  // Only the program word and the wrapper positions that carry a command in
  // argument position can run a payload. `echo bash -c '…'` runs `echo`, and
  // `xargs -I{} sh -c '…'` runs `sh` (#16075 review, R5-4).
  const wrapperOffsets = amendWrapperProgramOffsets(tokens);
  if (wrapperOffsets === null) unclassifiable = true;
  const prefixLength = tokens.length - skipAmendPrefixes(tokens).length;

  for (let index = 0; index < tokens.length; index++) {
    if (index > prefixLength && !wrapperOffsets?.has(index)) continue;
    // A redirection glued to the program word (`bash<<'X' -c '…'`) hides the
    // shell behind `<`, so read the program before the operator
    // (#16075 review, R1-1).
    const program = amendExecutableBasename(
      amendProgramBeforeRedirect(tokens[index]!),
    );

    if (program === 'env') {
      // env's own options come first, then assignments, then the program.
      // Value-taking options consume their operand: `env -u HOME -S '…'`
      // hides the payload behind `-u`'s value (#16075 review, R1-1).
      const valueFlags = AMEND_PREFIX_FLAGS_WITH_VALUE.get('env')!;
      // env splits the -S string into argv and APPENDS the remaining command
      // line: `env -S 'git' commit --amend` runs `git commit --amend`, so the
      // payload is the split string plus the trailing argv, not the string
      // alone (#16075 review, R1-1).
      const pushSplitString = (value: string, nextIndex: number) => {
        const trailing = tokens.slice(nextIndex).join(' ');
        payloads.push(trailing ? `${value} ${trailing}` : value);
      };
      for (let inner = index + 1; inner < tokens.length; inner++) {
        const flag = tokens[inner]!;
        if (flag === '--') break;
        if (flag.startsWith('--split-string=')) {
          pushSplitString(flag.slice('--split-string='.length), inner + 1);
          continue;
        }
        if (flag === '-S' || flag === '--split-string') {
          const value = tokens[inner + 1];
          if (value === undefined) unclassifiable = true;
          else pushSplitString(value, inner + 2);
          inner++;
          continue;
        }
        if (flag.startsWith('-S') && flag.length > 2) {
          pushSplitString(flag.slice(2), inner + 1);
          continue;
        }
        if (flag.startsWith('-')) {
          if (/^(?:-u.|-C.|--unset=|--chdir=)/.test(flag)) continue;
          if (valueFlags.has(flag)) {
            inner++;
            continue;
          }
          if (ENV_NO_VALUE_FLAGS.has(flag)) continue;
          unclassifiable = true;
          break;
        }
        if (isEnvAssignmentToken(flag)) continue;
        break; // the program env runs
      }
      continue;
    }

    // `su [user] -c '…'` carries a positional user before the `-c` flag, and
    // util-linux su also spells the flag `--command` / `--session-command`
    // (su(1)), detached or `=`-glued (#16075 review, R1-1).
    if (program === 'su') {
      let sawUser = false;
      for (let inner = index + 1; inner < tokens.length; inner++) {
        const flag = tokens[inner]!;
        if (
          flag.startsWith('--command=') ||
          flag.startsWith('--session-command=')
        ) {
          payloads.push(flag.slice(flag.indexOf('=') + 1));
          continue;
        }
        if (flag === '--command' || flag === '--session-command') {
          const value = tokens[inner + 1];
          if (value === undefined) unclassifiable = true;
          else payloads.push(value);
          inner++;
          continue;
        }
        if (flag === '--') break;
        if (flag === '-') continue; // login shorthand, no operand
        if (flag.startsWith('-')) {
          const marker = /^-[A-Za-z]*c/.exec(flag);
          if (marker) {
            // su parses with getopt: an attached cluster tail IS the value.
            const attached = flag.slice(marker[0].length);
            const value = attached.length > 0 ? attached : tokens[inner + 1];
            if (value === undefined) unclassifiable = true;
            else payloads.push(value);
            if (attached.length === 0) inner++;
            continue;
          }
          if (SU_VALUE_FLAGS.has(flag)) {
            inner++;
            continue;
          }
          if (SU_NO_VALUE_FLAGS.has(flag)) continue;
          unclassifiable = true;
          break;
        }
        if (!sawUser) {
          sawUser = true;
          continue;
        }
        break; // words after the user are the invoked shell's arguments
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
    // `-c` with nothing after it: the shell has a program this scan cannot
    // read, so it is unclassifiable rather than amend-free.
    if (payload === '') unclassifiable = true;
    else if (payload !== null) payloads.push(payload);
    // A process-substitution file operand is the script a stdin-reading shell
    // runs (`bash <(printf '…')`, witnessed to amend); the generated text is
    // not statically knowable, so the position fails closed (#16075 R1-1).
    if (SHELLS_READING_STDIN.has(program)) {
      for (let k = index + 1; k < tokens.length; k++) {
        if (tokens[k]!.startsWith('<(')) {
          unclassifiable = true;
          break;
        }
      }
    }
  }

  // Unquoted expansions word-split into argv entries the tokenizer keeps
  // glued, so an expansion in a position that decides the invocation — the
  // program word, a git global flag, the subcommand, or a `git commit`
  // flag/argument — can assemble an amend this scan cannot see
  // (`git commit${IFS}--amend`, `git $(echo commit) --amend`). Quoted
  // arguments are data (`grep '${IFS}'`, `-m "… ${IFS} …"`), and another
  // subcommand's arguments cannot amend (`git push origin $BRANCH`), so only
  // the positions the invocation check reads fail closed (#16075 review,
  // R8-10).
  const afterPrefix = skipAmendPrefixes(tokens);
  const [programWord] = afterPrefix;
  if (
    programWord !== undefined &&
    AMEND_EXPANSION_WORD.test(programWord) &&
    programExpansionCouldAmend(programWord, afterPrefix.slice(1), assignedNames)
  ) {
    unclassifiable = true;
  } else if (
    programWord !== undefined &&
    amendExecutableBasename(programWord) === 'git'
  ) {
    let cursor = 1;
    while (cursor < afterPrefix.length) {
      const token = afterPrefix[cursor]!;
      if (token === '--') {
        cursor++;
        break;
      }
      if (AMEND_REDIRECT_TOKEN.test(token)) {
        cursor +=
          AMEND_REDIRECT_WORD.test(token) && cursor + 1 < afterPrefix.length
            ? 2
            : 1;
        continue;
      }
      if (!token.startsWith('-')) break;
      if (AMEND_EXPANSION_WORD.test(token)) {
        unclassifiable = true;
        break;
      }
      const takesValue =
        AMEND_GIT_GLOBAL_FLAGS_WITH_VALUE.test(token) &&
        cursor + 1 < afterPrefix.length;
      // The value decides what the flag does: `-c $X` can expand to an
      // `alias.*` definition, so an expansion there hides the invocation
      // just like one in the flag itself.
      if (takesValue && AMEND_EXPANSION_WORD.test(afterPrefix[cursor + 1]!)) {
        unclassifiable = true;
        break;
      }
      cursor += takesValue ? 2 : 1;
    }
    const subcommand = afterPrefix[cursor];
    if (subcommand !== undefined && AMEND_EXPANSION_WORD.test(subcommand)) {
      unclassifiable = true;
    } else if (subcommand === 'commit') {
      for (cursor++; cursor < afterPrefix.length; cursor++) {
        const token = afterPrefix[cursor]!;
        if (token === '--') break;
        if (AMEND_EXPANSION_WORD.test(token)) {
          unclassifiable = true;
          break;
        }
        const consumesNext = token.startsWith('--')
          ? AMEND_COMMIT_LONG_FLAGS_WITH_VALUE.test(token)
          : amendCommitShortClusterConsumesNext(token);
        if (consumesNext && cursor + 1 < afterPrefix.length) cursor++;
      }
    }
  }

  return { payloads, unclassifiable };
}

/**
 * Decode a payload that is exactly one quoted word a wrapper hands its
 * program over as: ANSI-C (`bash -c $'…'`, `eval $'…'`) or locale-translation
 * (`bash -c $"…"`) quoting. The locale form keeps its body verbatim — bash
 * translates it but performs the same expansions as a double-quoted word,
 * which the recursive pass models (#16075 review, R8-11).
 *
 * The body patterns are escape-aware and anchored to a SINGLE word: the old
 * greedy `[\s\S]*` swallowed `$'git' commit '--amend'` whole (first `$'` to
 * last `'`), decoding it into one mangled token bash never sees and missing
 * the amend bash runs (#16075 review, R1-1). A payload that merely starts
 * with `$'` but is several words is returned untouched for the tokenizer.
 */
function decodeBareAnsiCWord(text: string): string {
  const trimmed = text.trim();
  const ansiC = /^\$'((?:[^'\\]|\\[\s\S])*)'$/.exec(trimmed);
  if (ansiC) return decodeAnsiCWord(ansiC[1]!);
  const locale = /^\$"((?:[^"\\]|\\[\s\S])*)"$/.exec(trimmed);
  if (locale) return locale[1]!;
  return text;
}

/**
 * Remove the backslash escapes the OUTER shell applies to an unquoted
 * wrapper payload: `bash -c git\ commit\ --amend` hands bash the script
 * `git commit --amend`, but the recursive pass received the still-escaped
 * text and tokenized `git\` as the program (#16075 review, R1-1).
 *
 * Deny-only: this runs after ANSI-C decoding (so `$'…\x3b…'` keeps its
 * decoded semicolon) and only ever joins words the shell joins. A backslash
 * a single-quoted payload would keep literal can at worst split a token the
 * literal backstop still sees in the raw command.
 */
function removeShellBackslashEscapes(text: string): string {
  return text.replace(/\\\n/g, '').replace(/\\([\s\S])/g, '$1');
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
  let ansiC = false;
  // A `#` opens a comment only at the start of a word. Testing the raw previous
  // character read an ESCAPED space as a word boundary, so `git commit -m
  // x\ #y --amend` (one word `x #y`, then a real `--amend`) was stripped as a
  // comment (#16075 review, R1-1). Track word start instead.
  let wordStart = true;
  let out = '';
  for (let index = 0; index < segment.length; index++) {
    const char = segment[index]!;
    if (ansiC) {
      if (char === '\\' && index + 1 < segment.length) {
        out += char + segment[index + 1]!;
        index++;
        continue;
      }
      out += char;
      if (char === "'") ansiC = false;
      wordStart = false;
      continue;
    }
    if (char === '\\' && quote !== "'" && index + 1 < segment.length) {
      out += char + segment[index + 1]!;
      index++;
      wordStart = false;
      continue;
    }
    if (quote !== null) {
      out += char;
      if (char === quote) quote = null;
      wordStart = false;
      continue;
    }
    // `$'…'` keeps a `#` inside the word as data, and `\'` does not close it.
    if (char === '$' && segment[index + 1] === "'") {
      ansiC = true;
      out += "$'";
      index++;
      wordStart = false;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      out += char;
      wordStart = false;
      continue;
    }
    if (char === '#' && wordStart) {
      // Bash ends the command at the newline, not at the end of the whole
      // segment: a note on one line must not swallow the next command. The
      // newline becomes a separator because the tokenizer only splits on
      // spaces and tabs.
      const newline = segment.indexOf('\n', index);
      if (newline === -1) break;
      out += ' ';
      index = newline;
      continue;
    }
    if (char === ' ' || char === '\t' || char === '\n') {
      out += char;
      wordStart = true;
      continue;
    }
    out += char;
    wordStart = false;
  }
  return out;
}

function tokensContainGitAmend(
  segment: string,
  depth: number,
  assignedNames: AmendAssignments,
): boolean {
  if (depth >= AMEND_UNWRAP_DEPTH_LIMIT) {
    // Fail closed for pathological wrapper nesting in a permission guard.
    return true;
  }

  // Comment removal replaces `#…\n` with a space, gluing the next line's
  // command onto this one; a raw newline therefore means the segment can
  // carry a second command whose words are not the first program's arguments.
  const multiLine = segment.includes('\n');
  segment = stripUnquotedComments(segment);

  const unwrapped = stripShellWrapper(segment);
  if (unwrapped !== segment) {
    // Unwrapping `bash -c` leaves a quoted payload as written, so `$'…'` keeps
    // its introducer and escapes; decode it before scanning the program. The
    // outer shell also removed the backslashes of an UNQUOTED payload
    // (`bash -c git\ commit\ --amend`), so unescape what decoding left —
    // ANSI-C first, or a decoded `\x3b` would lose its semicolon again
    // (#16075 review, R1-1).
    // The outer shell removed the backslashes of an UNQUOTED payload
    // (`bash -c git\ commit\ --amend`), while a QUOTED payload keeps them and
    // hands `\x20` to a downstream `printf`, which decodes it. Neither reading
    // is the whole truth: analyse both and deny if either fires
    // (#16075 review, R1-1).
    const normalised = removeShellBackslashEscapes(
      decodeBareAnsiCWord(unwrapped),
    );
    if (commandContainsGitAmendAtDepth(normalised, depth + 1, assignedNames)) {
      return true;
    }
    if (
      normalised !== unwrapped &&
      commandContainsGitAmendAtDepth(unwrapped, depth + 1, assignedNames)
    ) {
      return true;
    }
    return false;
  }

  // Wrappers embedding the command behind a flag value (`env -S '…'`) are
  // consumed by skipAmendPrefixes before the scan sees them, so read the
  // payloads off the untouched token stream.
  const nested = nestedAmendPayloads(tokenize(segment), assignedNames);
  for (const payload of nested.payloads) {
    if (commandContainsGitAmendAtDepth(payload, depth + 1, assignedNames)) {
      return true;
    }
  }
  if (nested.unclassifiable) return true;

  const tokens = skipAmendPrefixes(tokenize(segment));
  if (tokens.length === 0) return false;

  if (amendExecutableBasename(tokens[0]!) === 'eval') {
    return commandContainsGitAmendAtDepth(
      tokens.slice(1).join(' '),
      depth + 1,
      assignedNames,
    );
  }

  if (isGitAmendInvocationAt(tokens, 0)) return true;

  // Wrappers that embed their command as a token subsequence rather than as a
  // prefix: `xargs git commit --amend`, `find . -exec git commit --amend …`,
  // and a leading redirection (`> log git commit --amend`), where the program
  // is not at index 0. Try every offset so those are seen without teaching this
  // function each wrapper, and so a command glued onto the previous one by
  // comment removal is still read as a command. Quoted mentions stay inert
  // because they arrive as a single token, and `-m --amend` stays inert because
  // the invocation check consumes flag values. The basename prefilter keeps
  // this linear: the scan runs for every shell tool call before the classifier,
  // and copying the token tail at each offset made a 40k-token command take
  // seconds.
  // Unquoted words after a positively inert text program are its arguments
  // (data), not a command: `echo git commit --amend >> CHANGELOG.md` prints
  // the phrase, it never runs git. The sweep exists for wrappers (`xargs`,
  // `find -exec`, a leading redirection); none of those is an inert text
  // program. Without this skip the sweep re-denied the changelog echo the
  // maintainer stopgap routes to approval (#16075 R15-4, issue #13570).
  // Substitution bodies and shell-fed carriers are analysed separately, so
  // `echo $(git commit --amend)` and `echo … | bash` stay invocations. A
  // newline ends the inert program's command: words on the next line are a
  // new command (`echo hi # note\ngit commit --amend`), not arguments, so
  // the sweep still runs for any multi-line segment.
  if (
    multiLine ||
    !INERT_TEXT_PROGRAMS.has(
      amendExecutableBasename(amendProgramBeforeRedirect(tokens[0]!)),
    )
  ) {
    for (let offset = 1; offset < tokens.length; offset++) {
      if (amendExecutableBasename(tokens[offset]!) !== 'git') continue;
      if (isGitAmendInvocationAt(tokens, offset)) return true;
    }
  }

  // A here-string is one word handed to the program on its left; when that
  // program is a shell, that word is the program it runs. The consumer is the
  // program word, not any word in the command: `echo bash <<< '…'` feeds
  // `echo`, which writes the word out (#16075 review, R5-4).
  const hereString = hereStringProgram(segment);
  if (
    hereString !== null &&
    AMEND_SHELL_PROGRAMS.has(
      amendExecutableBasename(amendProgramBeforeRedirect(tokens[0]!)),
    ) &&
    commandContainsGitAmendAtDepth(hereString, depth + 1, assignedNames)
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
  // bash feeds the LAST here-string on the line to the program; earlier ones
  // are opened but never read. Quote-aware, so `echo "a <<< b"` is not an
  // operator (#16075 review, R9-1).
  const openers = scanHeredocOpeners(segment).filter(
    (opener) => opener.hereString,
  );
  const last = openers[openers.length - 1];
  if (!last) return null;
  const [word] = tokenize(segment.slice(last.index + 3));
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
  let pending: Array<{ delimiter: string; shellFed: boolean }> = [];
  let collected: string[] = [];

  for (const line of lines) {
    if (pending.length > 0) {
      if (line.trim() === pending[0]!.delimiter) {
        if (pending[0]!.shellFed) bodies.push(collected.join('\n'));
        pending.shift();
        collected = [];
        continue;
      }
      collected.push(line);
      continue;
    }

    const delimiters = getHeredocDelimiters(line);
    if (delimiters.length === 0) continue;

    // Attribute each operator to the compound segment that carries it,
    // quote-aware — not to any shell anywhere on the line, and not to a
    // decoy `<<` inside quotes. `bash --version; cat > notes.md <<'EOF'`
    // writes the body to a file, while `echo "a << b" && bash <<'EOF'` feeds
    // it to bash. Every body on the opener line is read, in opener order:
    // bash feeds the last heredoc to the program, and analysing the earlier
    // ones too can only add denials (#16075 review, R9-1).
    const segments = splitCompoundCommandSegments(line);
    const readsStdin = (seg: string): boolean => {
      const [program] = skipAmendPrefixes(tokenize(seg));
      return (
        program !== undefined &&
        SHELLS_READING_STDIN.has(
          amendExecutableBasename(amendProgramBeforeRedirect(program)),
        )
      );
    };
    const shellFedForSegment = (index: number): boolean => {
      const owner = segments[index]!;
      return (
        readsStdin(owner.command) ||
        ((owner.terminator === '|' || owner.terminator === '|&') &&
          segments[index + 1] !== undefined &&
          readsStdin(segments[index + 1]!.command))
      );
    };
    const openerCounts = segments.map(
      ({ command: seg }) =>
        scanHeredocOpeners(seg).filter((opener) => !opener.hereString).length,
    );
    const totalOpeners = openerCounts.reduce((sum, count) => sum + count, 0);
    const shellFedFlags: boolean[] = [];
    if (totalOpeners === delimiters.length) {
      let segmentIndex = 0;
      let remaining = openerCounts[0] ?? 0;
      for (let k = 0; k < delimiters.length; k++) {
        while (remaining === 0 && segmentIndex + 1 < segments.length) {
          segmentIndex++;
          remaining = openerCounts[segmentIndex] ?? 0;
        }
        shellFedFlags.push(shellFedForSegment(segmentIndex));
        remaining--;
      }
    } else {
      // The two scans disagree on a pathological line: fail closed — any
      // stdin-reading shell on the line makes every body code.
      const anyShellFed = segments.some((_, index) =>
        shellFedForSegment(index),
      );
      for (let k = 0; k < delimiters.length; k++) {
        shellFedFlags.push(anyShellFed);
      }
    }
    pending = delimiters.map((delimiter, k) => ({
      delimiter,
      shellFed: shellFedFlags[k]!,
    }));
    collected = [];
  }

  // An unterminated heredoc still feeds the partial body bash read.
  if (pending.length > 0 && pending[0]!.shellFed && collected.length > 0) {
    bodies.push(collected.join('\n'));
  }

  return bodies;
}

function commandContainsGitAmendAtDepth(
  command: string,
  depth: number,
  assignedNames: AmendAssignments = new Map(),
): boolean {
  // Names assigned here or inherited from an enclosing payload can turn an
  // expanded program word into git (#16075 review, R12-1).
  const names = collectAssignments(command, assignedNames);
  // A heredoc handed to a shell is the program, not data.
  if (depth < AMEND_UNWRAP_DEPTH_LIMIT) {
    for (const body of extractShellFedHeredocBodies(command)) {
      if (commandContainsGitAmendAtDepth(body, depth + 1, names)) return true;
    }
  }
  // A substitution body is code the shell runs, so analyse it as its own
  // command before deciding the surrounding segment is amend-free. An
  // ANSI-C word inside the body decodes to text with real separators
  // (`printf $'git\x20commit\x20--amend'` writes an amend script), so a
  // decoded reading is analysed too — deny-only, and only for bodies, where
  // the text becomes code (#16075 review, R1-1).
  if (depth < AMEND_UNWRAP_DEPTH_LIMIT) {
    for (const body of extractCommandSubstitutionBodies(command)) {
      if (commandContainsGitAmendAtDepth(body, depth + 1, names)) return true;
      if (
        body.includes("$'") &&
        commandContainsGitAmendAtDepth(
          decodeAnsiCQuotedWords(body),
          depth + 1,
          names,
        )
      ) {
        return true;
      }
    }
  }

  const code = stripHeredocBodies(command);
  const segments = splitCompoundCommandSegments(code);
  // An `IFS` assigned in this command decides how an unquoted expansion
  // word-splits, so a program word that comes from an expansion is no longer
  // provable: `IFS=:; X='git:commit:--amend'; $X` runs `git commit --amend`
  // although the glued word reads as one token (#16075 review, R1-1/R12-1).
  const ifsSplit = hasUnquotedIfsAssignment(command);
  for (let index = 0; index < segments.length; index++) {
    const { command: segment } = segments[index]!;
    // A pipe into a stdin-reading shell hands that shell a program. The text
    // can come from ANY upstream stage in the chain — a pass-through `cat`
    // forwards it (`echo … | cat | bash`) — and echo/printf print their
    // arguments with escapes decoded. Analyse every upstream stage's candidate
    // output; deny-only, and `terminator` is quote-aware so a `|` inside a
    // commit message is not a pipe (#16075 review, R1-1).
    const prevTerminator = index > 0 ? segments[index - 1]!.terminator : '';
    if (prevTerminator === '|' || prevTerminator === '|&') {
      const [consumerProgram] = skipAmendPrefixes(tokenize(segment));
      if (
        consumerProgram !== undefined &&
        SHELLS_READING_STDIN.has(
          amendExecutableBasename(amendProgramBeforeRedirect(consumerProgram)),
        )
      ) {
        for (let up = index - 1; up >= 0; up--) {
          for (const candidate of pipedProgramCandidates(
            segments[up]!.command,
          )) {
            if (commandContainsGitAmendAtDepth(candidate, depth + 1, names)) {
              return true;
            }
          }
          const upTerminator = up > 0 ? segments[up - 1]!.terminator : '';
          if (upTerminator !== '|' && upTerminator !== '|&') break;
        }
      }
    }
    if (ifsSplit) {
      const programTokens = skipAmendPrefixes(tokenize(segment));
      const programWord = programTokens[0];
      if (programWord !== undefined && /[$`]/.test(programWord)) {
        // An assigned IFS word-splits the expanded value, so read the value
        // with that separator instead of the default whitespace. An unresolvable
        // separator or value fails closed; a value that splits into a
        // non-git program stays amend-free (#16075 review, R1-1/R12-1).
        const ifsValue = names.get('IFS');
        const name = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(programWord);
        const expanded = name === null ? undefined : names.get(name[1]!);
        if (typeof ifsValue !== 'string' || typeof expanded !== 'string') {
          return true;
        }
        const separators = ifsValue.length > 0 ? ifsValue : ' \t\n';
        const words = expanded
          .split(new RegExp(`[${separators}]+`))
          .filter(Boolean);
        const split = [...words, ...programTokens.slice(1)];
        if (isGitAmendInvocationAt(split, 0)) return true;
      }
    }
    if (tokensContainGitAmend(segment, depth, names)) return true;
  }
  return false;
}

/**
 * Replace every unquoted, unescaped ANSI-C word (`$'…'`) in a text with its
 * decoded body, leaving other quoting intact. The decoded separators become
 * word boundaries for the next tokenize pass, which is what a shell reading
 * the text as a script sees. Used only on text that becomes code
 * (substitution bodies); deny-only, since the original reading still runs.
 */
function decodeAnsiCQuotedWords(text: string): string {
  let out = '';
  let quote: '"' | "'" | null = null;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (quote !== null) {
      out += ch;
      if (ch === '\\' && quote === '"' && i + 1 < text.length) {
        out += text[i + 1];
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === '\\' && i + 1 < text.length) {
      out += ch + text[i + 1];
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === '$' && text[i + 1] === "'") {
      let j = i + 2;
      let body = '';
      while (j < text.length) {
        if (text[j] === '\\' && j + 1 < text.length) {
          body += text.slice(j, j + 2);
          j += 2;
          continue;
        }
        if (text[j] === "'") break;
        body += text[j];
        j++;
      }
      if (j < text.length) {
        out += decodeAnsiCWord(body);
        i = j + 1;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
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
    !SHELLS_READING_STDIN.has(
      amendExecutableBasename(amendProgramBeforeRedirect(program)),
    )
  ) {
    return null;
  }
  return tokenize(producer).slice(1).join(' ');
}

/**
 * Candidate program texts a producer stage can print into a pipe. The raw
 * argument words are one reading; `echo`/`printf` also interpret backslash
 * escapes in what they print, so `printf 'git\x20commit\x20--amend'` writes
 * `git commit --amend` even though the quoted argument keeps the escapes
 * (#16075 review, R1-1). Deny-only: every reading is analysed.
 */
function pipedProgramCandidates(producer: string): string[] {
  const [program, ...args] = tokenize(producer);
  const candidates: string[] = [];
  const raw = args.join(' ');
  if (raw) candidates.push(raw);
  const base = amendExecutableBasename(program ?? '');
  if (base === 'echo' || base === 'printf') {
    const decoded = args.map((arg) => decodeAnsiCWord(arg)).join(' ');
    if (decoded && decoded !== raw) candidates.push(decoded);
  }
  if (base === 'printf') {
    const spliced = printfFormatSplice(args);
    if (spliced !== null && spliced !== raw && !candidates.includes(spliced)) {
      candidates.push(spliced);
    }
  }
  return candidates;
}

/**
 * What `printf` prints for a format whose only conversions are `%%` and `%s`
 * with literal arguments — the one printf shape whose output this scan can
 * compute. Any other conversion (`%d`, `%x`, `%b`, field widths) or a backslash
 * escape makes the printed text unprovable, so the row is left to the
 * fail-closed paths instead (#16075 review, R1-1:
 * `printf 'g%s commit --amend' it | bash`).
 */
function printfFormatSplice(args: string[]): string | null {
  const [format, ...values] = args;
  if (format === undefined || format.includes('\\')) return null;
  let out = '';
  let next = 0;
  for (let i = 0; i < format.length; i++) {
    const char = format[i]!;
    if (char !== '%') {
      out += char;
      continue;
    }
    const spec = format[i + 1];
    if (spec === '%') {
      out += '%';
      i++;
      continue;
    }
    if (spec !== 's') return null;
    out += values[next++] ?? '';
    i++;
  }
  return out;
}

/**
 * Strip one layer of shell quoting from a command string so destructive
 * patterns inside `bash -c "git reset --hard"` or `sh -c 'git clean -fd'`
 * are still detected. Shared with `destructive-commands.ts`, which feeds the
 * same expansion to its other destructive patterns (#16075 R9 B1: the amend
 * backstop must see exactly the input the base substring guard saw).
 */
export function stripShellQuotes(command: string): string {
  return command.replace(
    /(?:^|\s)(?:bash|sh|zsh|fish|dash|ksh)\s+-[a-zA-Z]*c\s+(?:"([^"]*)"|'([^']*)')/g,
    (_match, dq: string | undefined, sq: string | undefined) =>
      ' ' + (dq ?? sq ?? ''),
  );
}

/**
 * The base substring guard's pattern, restored as a fail-closed backstop
 * (#16075 R9, B1). The recognizer below may only ADD denials to this set.
 */
const GIT_AMEND_BACKSTOP_PATTERN = /\bgit\s+commit\s+--amend\b/;

/**
 * Programs whose quoted arguments and quoted-delimiter heredoc bodies are
 * provably inert data: they print, search, or copy text and never execute it.
 * Deliberately tiny — a member must have no flag that turns an argument into
 * a program. Excludes every shell and executor (`env`, `node`, `xargs`,
 * `find`, `eval`, `trap`, …): for those, quoted text can still become code.
 */
const INERT_TEXT_PROGRAMS: ReadonlySet<string> = new Set([
  'echo',
  'printf',
  'grep',
  'cat',
  'head',
  'tail',
  'wc',
  'ls',
]);

/**
 * Prove that EVERY literal `git commit --amend` occurrence in the raw command
 * is inert data, so the backstop may let it through (#16075 R9, B1).
 *
 * Narrow and fail-closed by construction. An occurrence is inert only when it
 * sits inside:
 *   - a single-quoted word of a simple command whose program basename is in
 *     `INERT_TEXT_PROGRAMS`, or
 *   - an unquoted `#` comment (comment text never executes), or
 *   - the body of a SINGLE-QUOTED-delimiter heredoc (`<<'EOF'`) owned by a
 *     program in `INERT_TEXT_PROGRAMS` — bash performs no expansion on such a
 *     body, and a non-shell owner only copies it.
 *
 * Outside single-quoted spans and comments the command must be one simple
 * line: no metacharacters (`; & | $ ` < > ( ) { }`), no newline, no redirect
 * other than the heredoc opener itself, no assignment, no double quotes, no
 * backslash escapes. Double-quoted occurrences, shell-fed or unquoted-
 * delimiter heredocs, pipelines, and anything else this scanner cannot
 * positively classify answer false (deny). A backstop match with zero raw
 * occurrences (the phrase only exists in the wrapper-stripped expansion) is
 * unclassifiable, not vacuously inert.
 */
function amendOccurrencesProvablyInert(command: string): boolean {
  const occurrences: Array<{ start: number; end: number }> = [];
  const phrase = /\bgit\s+commit\s+--amend\b/g;
  for (let m = phrase.exec(command); m !== null; m = phrase.exec(command)) {
    occurrences.push({ start: m.index, end: m.index + m[0].length });
  }
  if (occurrences.length === 0) return false;

  // Per-character context: 0 code, 1 single-quoted, 2 comment, 3 heredoc body.
  const kind = new Uint8Array(command.length);
  const heredocDelimiters: string[] = [];
  // Words of code (quote spans included) for the program / assignment checks.
  const codeWords: string[] = [];
  let word = '';
  let inSingle = false;
  let inComment = false;
  let i = 0;
  const flushWord = () => {
    if (word.length > 0) {
      codeWords.push(word);
      word = '';
    }
  };
  while (i < command.length) {
    const ch = command[i]!;
    if (inComment) {
      if (ch === '\n') return false; // a second segment is not a simple command
      kind[i] = 2;
      i++;
      continue;
    }
    if (inSingle) {
      kind[i] = 1;
      word += ch;
      if (ch === "'") inSingle = false;
      i++;
      continue;
    }
    // Code context.
    if (ch === "'") {
      inSingle = true;
      kind[i] = 1;
      word += ch;
      i++;
      continue;
    }
    if (ch === '"') return false; // double quotes are not proven inert this round
    if (ch === '\\') return false; // escapes outside single quotes: unmodelled
    if (ch === '#') {
      const prev = i === 0 ? ' ' : command[i - 1]!;
      if (/\s/.test(prev)) {
        flushWord();
        inComment = true;
        kind[i] = 2;
        i++;
        continue;
      }
      // A `#` glued to a word is not a comment start.
      kind[i] = 0;
      word += ch;
      i++;
      continue;
    }
    if (ch === '<') {
      // The only redirection this prover accepts: a single-quoted-delimiter
      // heredoc opener. Everything else (`<`, `<<EOF`, `<<<`, `<<-`) denies.
      if (!command.startsWith("<<'", i)) return false;
      const close = command.indexOf("'", i + 3);
      if (close === -1 || close === i + 3) return false;
      heredocDelimiters.push(command.slice(i + 3, close));
      flushWord();
      i = close + 1;
      continue;
    }
    if (ch === '\n') {
      // The opener line's newline starts the heredoc bodies; any other
      // newline means a second segment, which this prover does not classify.
      if (heredocDelimiters.length === 0) return false;
      flushWord();
      break;
    }
    if (/[;&|$`>(){}]/.test(ch)) return false;
    if (/\s/.test(ch)) {
      flushWord();
      kind[i] = 0;
      i++;
      continue;
    }
    kind[i] = 0;
    word += ch;
    i++;
  }
  if (inSingle) return false; // unterminated quote
  flushWord();

  // Heredoc bodies follow the code line, one per opener, in order.
  if (heredocDelimiters.length > 0) {
    for (const delimiter of heredocDelimiters) {
      // i is at the newline that ends the opener line.
      if (command[i] !== '\n') return false;
      i++;
      let closed = false;
      while (i < command.length) {
        const lineEnd = command.indexOf('\n', i);
        const end = lineEnd === -1 ? command.length : lineEnd;
        const line = command.slice(i, end);
        for (let k = i; k < end; k++) kind[k] = 3;
        i = end;
        if (line === delimiter) {
          closed = true;
          if (lineEnd !== -1) i++; // consume the closing line's newline
          break;
        }
        if (lineEnd === -1) break;
        i++; // consume the body line's newline
      }
      if (!closed) return false; // unterminated heredoc
    }
    // Nothing executable may follow the last heredoc.
    if (!/^[ \t]*\n?$/.test(command.slice(i))) return false;
  }

  // The program word must be a plain allowlisted BARE name; a quoted or
  // decorated program word is not positively classifiable. A path-qualified
  // word (`./cat`, `/bin/cat`, `/tmp/grep`) may be any executable the caller
  // placed at that path, so it never earns the certificate (#16075 review,
  // R10-2).
  const program = codeWords[0];
  const programIsInert =
    program !== undefined &&
    /^[A-Za-z0-9._-]+$/.test(program) &&
    INERT_TEXT_PROGRAMS.has(program);
  // No assignment prefixes or assignment words anywhere in the code.
  if (codeWords.some((w) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w))) return false;

  for (const { start, end } of occurrences) {
    let sawQuotedOrHeredoc = false;
    for (let k = start; k < end; k++) {
      const context = kind[k];
      if (context === 0 || context === undefined) return false;
      if (context === 1 || context === 3) sawQuotedOrHeredoc = true;
    }
    // Comment-only occurrences are inert regardless of the program; quoted
    // words and heredoc bodies are data only when the owner cannot run them.
    if (sawQuotedOrHeredoc && !programIsInert) return false;
  }
  return true;
}

/**
 * Check whether a shell command actually invokes `git commit --amend`.
 *
 * Two layers, deny-only in combination (#16075 R9, B1):
 *   1. the parsed recognizer, which ignores quoted text, heredoc bodies,
 *      commit-message arguments, and commands whose program is not git, and
 *      unwraps the execution constructs it models;
 *   2. a fail-closed backstop — the base substring pattern over the raw
 *      command plus its wrapper-stripped form. A literal phrase the
 *      recognizer did not confirm is denied unless
 *      `amendOccurrencesProvablyInert` proves every occurrence inert data.
 * The recognizer can therefore only ever ADD denials, never remove one the
 * base guard made.
 */
/**
 * Which layer recognised a `git commit --amend` (#16075 maintainer stopgap,
 * round-15 assessment):
 *  - `invocation`: the parsed recognizer identified an amend invocation —
 *    positively, or fail-closed on an expansion whose inertness it cannot
 *    prove. These keep the session-commit check and hard denial.
 *  - `unprovable-text`: only the literal-phrase backstop fired. The command
 *    mentions the amend but no invocation was identified and inertness is
 *    unprovable; the guard routes these to approval, not hard denial.
 *  - `none`: no amend recognised.
 */
export type GitAmendRecognition = 'invocation' | 'unprovable-text' | 'none';

export function classifyGitAmend(command: string): GitAmendRecognition {
  if (commandContainsGitAmendAtDepth(command, 0)) return 'invocation';
  const expanded = command + ' ' + stripShellQuotes(command);
  if (
    GIT_AMEND_BACKSTOP_PATTERN.test(expanded) &&
    !amendOccurrencesProvablyInert(command)
  ) {
    return 'unprovable-text';
  }
  return 'none';
}

export function commandContainsGitAmend(command: string): boolean {
  return classifyGitAmend(command) !== 'none';
}

/** git subcommands that can move HEAD before a later `--amend` reads it, so
 * the commit the exemption certifies is no longer the one the amend rewrites
 * (#16075 review, R14-1). */
const AMEND_HEAD_MOVING_SUBCOMMANDS = new Set([
  'reset',
  'checkout',
  'switch',
  'rebase',
  'merge',
  'cherry-pick',
  'revert',
  'pull',
]);

/** One compound segment that directly invokes `git commit --amend`, with the
 * cwd it runs under. */
export interface AmendSegment {
  segment: string;
  cwd: string;
  /** Repo relocations carried in from an enclosing carrier's prefix
   * (`GIT_DIR=B/.git bash -c '…'`): the inner amend runs under them even though
   * they are not spelled in the inner segment (#16075 review, R7-2). */
  inherited?: Array<{ flag: string; value: string }>;
}

export type AmendSegmentAnalysis =
  | { kind: 'segments'; segments: AmendSegment[]; effectiveCwd: string }
  | {
      kind: 'untrackable';
      /** A preceding segment positively moves HEAD, so the amend rewrites a
       * commit the session never made even though guard-time HEAD is
       * registered. The guard hard-denies this case; every other untrackable
       * refusal routes to approval (#16075 maintainer stopgap). */
      headMayMove?: boolean;
    };

/** Does the segment carry subshell/group parentheses outside quotes? Quoted
 * parentheses (`-m 'fix (bug)'`) are message data, not shell syntax. */
function hasUnquotedParens(segment: string): boolean {
  let inSingle = false;
  let inDouble = false;
  let inAnsiC = false;
  let escaped = false;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!;
    if (inAnsiC) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === "'") inAnsiC = false;
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && !inSingle) {
      escaped = true;
      continue;
    }
    if (ch === '$' && !inSingle && !inDouble && segment[i + 1] === "'") {
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
    if (!inSingle && !inDouble && (ch === '(' || ch === ')')) return true;
  }
  return false;
}

/**
 * Locate the compound segments that DIRECTLY invoke `git commit --amend`,
 * with the cwd each runs under, for the session-commit exemption (#16075
 * review, R7-2). Heredoc bodies are data unless a shell reads them; `cd` /
 * `pushd` shift the effective cwd only when they run in THIS shell (not
 * backgrounded, not in a pipeline, not in a subshell); wrapper payloads are
 * walked recursively at the cwd they inherit, and their inner `cd` never
 * moves the outer cwd. `eval`/`source`, exported `GIT_DIR`/`GIT_WORK_TREE`,
 * subshell parentheses, `popd` and dynamic cd targets make the cwd
 * untrackable, which fails closed. An empty segment list means the amend
 * exists only in a carrier this walk does not attribute (su, env -S, xargs,
 * find -exec, …) — the caller refuses the exemption.
 */
export function amendSegmentsForExemption(
  command: string,
  cwd: string,
): AmendSegmentAnalysis {
  return walkAmendSegments(command, cwd, 0, new Map());
}

/** `builtin cd` / `command cd` run the cd builtin in this shell; the query
 * forms (`command -v cd`) run nothing and must not move the cwd. Leading
 * assignments (`FOO=1 cd B`) are part of the same simple command and do not
 * change which builtin runs (#16075 review, R7-2). */
function stripCdPrefixWords(segment: string): string {
  const assignments = /^(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]*[ \t]+)*/.exec(
    segment,
  )![0];
  if (assignments) segment = segment.slice(assignments.length);
  const prefix = /^(?:builtin|command)[ \t]+/.exec(segment);
  if (!prefix) return segment;
  let rest = segment.slice(prefix[0].length);
  // `command -- cd B`: the `--` ends command's own options, but the cd builtin
  // still runs in this shell and moves the cwd (#16075 review, R7-2).
  const terminator = /^--[ \t]+/.exec(rest);
  if (terminator) rest = rest.slice(terminator[0].length);
  const flags = /^(?:-[A-Za-z]+[ \t]+)*/.exec(rest)![0];
  const after = rest.slice(flags.length);
  if (!/[vV]/.test(flags) && /^(?:cd|pushd)(?:[ \t]|$)/.test(after)) {
    return after;
  }
  return segment;
}

function walkAmendSegments(
  command: string,
  cwd: string,
  depth: number,
  inheritedNames: AmendAssignments,
): AmendSegmentAnalysis {
  if (depth >= AMEND_UNWRAP_DEPTH_LIMIT) return { kind: 'untrackable' };
  const names = collectAssignments(command, inheritedNames);
  let effectiveCwd = cwd;
  let cwdKnown = true;
  // The splitter does not keep subshell boundaries, so once unquoted
  // parentheses appear, a cd may run in a subshell (not moving this cwd)
  // and an amend may run under a cwd this walk cannot attribute. Both fail
  // closed rather than exempt against the wrong repository.
  let sawSubshell = false;
  // An exported GIT_DIR/GIT_WORK_TREE relocates every later amend to a repo
  // this walk cannot attribute segment-by-segment; fail closed on it. Track the
  // relocated NAMES individually: `unset GIT_WORK_TREE` must not forget an
  // exported GIT_DIR (one boolean tracked both, #16075 review, R7-2).
  const relocatedEnvNames = new Set<string>();
  // Env state the walk cannot attribute at all (an unknown export flag/name,
  // `unset -f`, …): fail closed regardless of which names are relocated.
  let envRelocated = false;
  let allexport = false;
  // A cd reached only conditionally (`false && cd A`) may never run; a later
  // segment that breaks the conditional chain runs under an ambiguous cwd.
  let conditionalCdPending = false;
  let conditionalCdViaOr = false;
  // A segment before the amend that can move HEAD makes the guard-time HEAD a
  // different commit from the one the amend will rewrite (`git reset --soft
  // HEAD~1 && git commit --amend` rewrites the user's own commit while
  // certifying the session commit, #16075 review, R14-1).
  let headMayMove = false;
  const amendSegments: AmendSegment[] = [];
  const poisoned = (): boolean =>
    !cwdKnown || sawSubshell || envRelocated || relocatedEnvNames.size > 0;
  // Every refusal carries an already-proven HEAD movement: the amend after a
  // `git reset --soft HEAD~1` rewrites an unregistered commit no matter what
  // else the walk cannot attribute (#16075 review, R14-1 / R15-2).
  const untrackable = (): AmendSegmentAnalysis =>
    headMayMove
      ? { kind: 'untrackable', headMayMove: true }
      : { kind: 'untrackable' };

  // A substitution body that amends is a second amend whose cwd this walk
  // does not model (`git amend -m "$(git -C B amend)"` amends BOTH repos,
  // witnessed); refuse the exemption rather than attribute one of them.
  for (const body of extractCommandSubstitutionBodies(command)) {
    if (commandContainsGitAmendAtDepth(body, depth + 1, names)) {
      return untrackable();
    }
  }

  // Shell-fed heredoc bodies in opener order; the owning segment below
  // consumes its body at the cwd effective there.
  const fedBodies = extractShellFedHeredocBodies(command);
  let fedIndex = 0;
  const walkInner = (text: string): AmendSegmentAnalysis =>
    walkAmendSegments(text, effectiveCwd, depth + 1, names);

  // A carrier (wrapper / heredoc / pipe) inherits this walk's cwd and poison.
  // Starting a fresh walk would discard a poisoned cwd (`cd "$TARGET" && bash
  // -c '…'`), and recording only the payload would drop the carrier's prefix
  // relocation (`GIT_DIR=B/.git bash -c '…'`). Refuse a poisoned carrier whose
  // payload amends, and carry the carrier's prefix relocations into every inner
  // segment (#16075 review, R7-2).
  const walkCarrier = (
    payload: string,
    carrier: string,
  ): AmendSegmentAnalysis => {
    if (
      poisoned() &&
      commandContainsGitAmendAtDepth(payload, depth + 1, names)
    ) {
      return untrackable();
    }
    const inner = walkInner(payload);
    if (inner.kind === 'untrackable') return inner;
    const inherited = amendSegmentRelocations(carrier);
    if (inherited.length === 0) return inner;
    return {
      ...inner,
      segments: inner.segments.map((s) => ({
        ...s,
        inherited: [...inherited, ...(s.inherited ?? [])],
      })),
    };
  };

  const segments = splitCompoundCommandSegments(stripHeredocBodies(command));
  let prevTerminator = '';
  for (let i = 0; i < segments.length; i++) {
    const { command: segment, terminator } = segments[i]!;
    if (hasUnquotedParens(segment)) sawSubshell = true;
    const cleaned = segment.replace(AMEND_LEADING_FLOW_NOISE, '');
    const tokens = skipAmendPrefixes(tokenize(stripUnquotedComments(segment)));
    const program = amendExecutableBasename(tokens[0] ?? '');

    // A conditional cd (`false && cd A`) may never run. While one is pending,
    // a segment that breaks the `&&` chain runs regardless of whether the cd
    // ran, so its cwd is ambiguous: fail closed (`false && cd A; git amend`,
    // #16075 review, R7-2). A chain that stays `&&` keeps the cd and the amend
    // under the same condition, so the attribution still holds.
    if (
      conditionalCdPending &&
      (prevTerminator !== '&&' || conditionalCdViaOr)
    ) {
      // A cd reached through `||` is not guaranteed by a following `&&`:
      // `true || cd A && git amend` parses as `(true || cd A) && git amend`,
      // the cd is skipped, and the amend runs in the original cwd
      // (#16075 review, R7-2).
      cwdKnown = false;
    }

    // A wrapper payload runs at the cwd it inherits; its inner cd moves only
    // its own shell. `bash -c 'cd B && git amend'` amends B, and
    // `bash -c 'git amend' && cd A` amends the cwd BEFORE the cd (#16075
    // review, R7-2).
    const unwrapped = stripShellWrapper(cleaned);
    if (unwrapped !== cleaned) {
      const payload = removeShellBackslashEscapes(
        decodeBareAnsiCWord(unwrapped),
      );
      const inner = walkCarrier(payload, cleaned);
      if (inner.kind === 'untrackable') return inner;
      amendSegments.push(...inner.segments);
      prevTerminator = terminator;
      continue;
    }

    // A heredoc fed to a stdin-reading shell is its program. The body is
    // consumed in opener order, matching extractShellFedHeredocBodies.
    const hasHeredocOpener = scanHeredocOpeners(segment).some(
      (opener) => !opener.hereString,
    );
    if (hasHeredocOpener && fedIndex < fedBodies.length) {
      const next = segments[i + 1];
      const nextProgram = next
        ? amendExecutableBasename(
            skipAmendPrefixes(
              tokenize(stripUnquotedComments(next.command)),
            )[0] ?? '',
          )
        : '';
      const pipeFed =
        (terminator === '|' || terminator === '|&') &&
        SHELLS_READING_STDIN.has(nextProgram);
      if (SHELLS_READING_STDIN.has(program) || pipeFed) {
        const inner = walkCarrier(fedBodies[fedIndex++]!, segment);
        if (inner.kind === 'untrackable') return inner;
        amendSegments.push(...inner.segments);
        prevTerminator = terminator;
        continue;
      }
    }

    // A pipe into a stdin-reading shell hands it the producer's text as its
    // program (`echo 'cd B && git amend' | bash`, witnessed to amend B).
    if (
      (prevTerminator === '|' || prevTerminator === '|&') &&
      SHELLS_READING_STDIN.has(program) &&
      i > 0
    ) {
      const fed = pipedProgramText(segments[i - 1]!.command, segment);
      if (fed) {
        const inner = walkCarrier(fed, segment);
        if (inner.kind === 'untrackable') return inner;
        amendSegments.push(...inner.segments);
      }
      prevTerminator = terminator;
      continue;
    }

    // eval / source / . run text this walk does not read: they may amend ANY
    // repository, an amend this walk cannot record as a segment. Lowering only
    // cwdKnown left the trailing gate inert once a segment existed (`git amend
    // && eval 'git -C B amend'`), so the whole command is untrackable (#16075
    // review, R7-2).
    if (program === 'eval' || program === 'source' || program === '.') {
      return untrackable();
    }

    // Exported GIT_DIR / GIT_WORK_TREE persist across segments and relocate
    // the repository independently of the cwd; `set -a` turns plain
    // assignments into exports. Track them and fail closed on an amend
    // under an active relocation (#16075 review, R7-2).
    // `builtin export GIT_DIR=…` runs the same export: the `builtin` prefix is
    // transparent for the relocation tracker (#16075 review, R7-2).
    const rawTokens = tokenize(stripUnquotedComments(segment));
    const builtinStripped = /^(?:builtin|command)$/.test(program)
      ? rawTokens.slice(1)
      : rawTokens;
    const trackedProgram = /^(?:builtin|command)$/.test(program)
      ? amendExecutableBasename(builtinStripped[0] ?? '')
      : program;
    if (trackedProgram === 'set') {
      for (let k = 1; k < rawTokens.length; k++) {
        const t = rawTokens[k]!;
        if (t === '-o' || t === '+o') {
          if (rawTokens[k + 1] === 'allexport') allexport = t === '-o';
          k++;
          continue;
        }
        if (/^-[a-z]*a/.test(t)) allexport = true;
        else if (/^\+[a-z]*a/.test(t)) allexport = false;
      }
    } else if (
      trackedProgram === 'export' ||
      trackedProgram === 'declare' ||
      trackedProgram === 'typeset'
    ) {
      const exportTokens = builtinStripped;
      const exporting =
        trackedProgram === 'export' || exportTokens.some((t) => t === '-x');
      for (let k = 1; k < exportTokens.length; k++) {
        const t = exportTokens[k]!;
        if (t.startsWith('-')) {
          if (t !== '-p' && t !== '-x') envRelocated = true;
          continue;
        }
        const name = /^([A-Za-z_][A-Za-z0-9_]*)(?:=|$)/.exec(t)?.[1];
        if (name === undefined) {
          envRelocated = true;
          continue;
        }
        if (
          (name === 'GIT_DIR' || name === 'GIT_WORK_TREE') &&
          (exporting || allexport)
        ) {
          relocatedEnvNames.add(name);
        }
      }
    } else if (trackedProgram === 'unset') {
      // `unset GIT_DIR &` runs in a subshell and clears nothing in the shell
      // that runs the amend (#16075 review, R7-2).
      const unsetInSubshell =
        terminator === '&' || terminator === '|' || terminator === '|&';
      for (let k = 1; k < rawTokens.length; k++) {
        const t = rawTokens[k]!;
        if (t.startsWith('-')) {
          if (t !== '-v') envRelocated = true;
          continue;
        }
        // Unset clears only the named variable: `unset GIT_WORK_TREE` leaves an
        // exported GIT_DIR relocating the amend (#16075 review, R7-2).
        if ((t === 'GIT_DIR' || t === 'GIT_WORK_TREE') && !unsetInSubshell) {
          relocatedEnvNames.delete(t);
        }
      }
    } else if (allexport && rawTokens.length > 0) {
      for (const t of rawTokens) {
        const name = /^(GIT_DIR|GIT_WORK_TREE)=/.exec(t)?.[1];
        if (name !== undefined) relocatedEnvNames.add(name);
      }
    }

    // A redirection on a cd hides the builtin from the word scan; the cwd
    // move is real but unattributable here.
    if (
      rawTokens.length > 0 &&
      AMEND_REDIRECT_TOKEN.test(rawTokens[0]!) &&
      /\b(?:cd|pushd)\b/.test(segment)
    ) {
      cwdKnown = false;
    }

    const cdTarget = resolveCdTargetCwd(
      stripCdPrefixWords(cleaned),
      effectiveCwd,
      !cwdKnown,
    );
    if (cdTarget.kind !== 'not-cd') {
      // A cd moves THIS cwd only when it runs in this shell: not
      // backgrounded, not either side of a pipeline (both run in subshells),
      // not after subshell parentheses (#16075 review, R7-2).
      const inPipeline =
        terminator === '|' ||
        terminator === '|&' ||
        prevTerminator === '|' ||
        prevTerminator === '|&';
      if (terminator !== '&' && !inPipeline && !sawSubshell) {
        if (cdTarget.kind === 'static') {
          effectiveCwd = cdTarget.cwd;
          cwdKnown = !cdTarget.cwdUnknown;
        } else {
          cwdKnown = false;
        }
        // A cd behind `&&`/`||` runs only conditionally; remember it so a later
        // segment that breaks the chain fails closed (#16075 review, R7-2).
        if (prevTerminator === '&&' || prevTerminator === '||') {
          conditionalCdPending = true;
          conditionalCdViaOr = prevTerminator === '||';
        }
      }
      prevTerminator = terminator;
      continue;
    }
    if (
      tokens.length > 0 &&
      amendExecutableBasename(tokens[0]!) === 'git' &&
      tokens.slice(1).some((token) => AMEND_HEAD_MOVING_SUBCOMMANDS.has(token))
    ) {
      headMayMove = true;
    }
    if (tokens.length > 0 && isGitAmendInvocationAt(tokens, 0)) {
      if (headMayMove) {
        return { kind: 'untrackable', headMayMove: true };
      }
      if (poisoned()) {
        return untrackable();
      }
      amendSegments.push({ segment, cwd: effectiveCwd });
      prevTerminator = terminator;
      continue;
    }
    // A direct git invocation the recognizer cannot classify (an expansion
    // in an invocation-deciding position, a defined alias) is not a nested
    // payload: it may assemble an amend of ANY repository, so the cwd-only
    // answer must not exempt it.
    if (
      tokens.length > 0 &&
      amendExecutableBasename(tokens[0]!) === 'git' &&
      nestedAmendPayloads(tokenize(stripUnquotedComments(segment)), names)
        .unclassifiable
    ) {
      return untrackable();
    }
    prevTerminator = terminator;
  }
  // A shell-fed body the segment loop did not consume belongs to an opener
  // this walk could not attribute: its amend may run under any cwd.
  if (fedIndex < fedBodies.length) return untrackable();
  if ((!cwdKnown || sawSubshell) && amendSegments.length === 0) {
    return untrackable();
  }
  return { kind: 'segments', segments: amendSegments, effectiveCwd };
}

/**
 * The repo-relocating options of the direct amend invocation in ONE compound
 * segment: `-C` / `--git-dir` / `--work-tree` (separate, `=` and glued forms)
 * BEFORE the subcommand, plus leading `GIT_DIR=` / `GIT_WORK_TREE=`
 * assignments. A `-C` after `commit` is git-commit's own reuse-message
 * option, not a relocation, and a `-C` inside a quoted message is data —
 * both must stay invisible here (#16075 review, R7-2 fix-induced).
 */
export function amendSegmentRelocations(
  segment: string,
): Array<{ flag: string; value: string }> {
  const relocations: Array<{ flag: string; value: string }> = [];
  const tokens = tokenize(stripUnquotedComments(segment));
  const takeAssignment = (token: string): void => {
    const eq = token.indexOf('=');
    const name = token.slice(0, eq);
    if (name === 'GIT_DIR' || name === 'GIT_WORK_TREE') {
      relocations.push({
        flag: name === 'GIT_DIR' ? '--git-dir' : '--work-tree',
        value: token.slice(eq + 1),
      });
    }
  };
  let index = 0;
  while (index < tokens.length && isEnvAssignmentToken(tokens[index]!)) {
    takeAssignment(tokens[index]!);
    index++;
  }
  const rest = skipAmendPrefixes(tokens.slice(index));
  // `sudo GIT_DIR=… git …` and `env GIT_DIR=… git …` hand the assignment
  // through the prefix command: skipAmendPrefixes consumes it as noise, so
  // scan the region it ate for relocations too. Missing one would exempt an
  // amend of another repository against this cwd's registered HEAD.
  // The prefix's own chdir options relocate the same way: `env -C B git …`
  // and `sudo -D B git …` run git in B (witnessed), so they are read as a
  // `-C` relocation of the amend (#16075 review, R7-2). doas's `-C` is a
  // config check, NOT a chdir, and is deliberately not read here.
  const consumed = tokens.length - index - rest.length;
  let prefixProgram = '';
  for (let k = index; k < index + consumed; k++) {
    const token = tokens[k]!;
    if (isEnvAssignmentToken(token)) {
      takeAssignment(token);
      continue;
    }
    if (!token.startsWith('-')) {
      prefixProgram = amendExecutableBasename(token);
      continue;
    }
    const isEnv = prefixProgram === 'env';
    const isSudo = prefixProgram === 'sudo';
    let value: string | undefined;
    if (
      (isEnv && (token === '-C' || token === '--chdir')) ||
      (isSudo && (token === '-D' || token === '--chdir'))
    ) {
      value = tokens[k + 1];
      k++;
    } else if (isEnv && token.startsWith('-C') && token.length > 2) {
      value = token.slice(2);
    } else if (isSudo && token.startsWith('-D') && token.length > 2) {
      value = token.slice(2);
    } else if ((isEnv || isSudo) && token.startsWith('--chdir=')) {
      value = token.slice('--chdir='.length);
    }
    if (value !== undefined) {
      relocations.push({ flag: '-C', value });
      continue;
    }
    if (AMEND_PREFIX_FLAGS_WITH_VALUE.get(prefixProgram)?.has(token)) k++;
  }
  if (amendExecutableBasename(rest[0] ?? '') !== 'git') return relocations;
  let cursor = 1;
  while (cursor < rest.length) {
    const token = rest[cursor]!;
    if (token === '--') break;
    if (AMEND_REDIRECT_TOKEN.test(token)) {
      cursor +=
        AMEND_REDIRECT_WORD.test(token) && cursor + 1 < rest.length ? 2 : 1;
      continue;
    }
    if (!token.startsWith('-')) break; // the subcommand: relocations end here
    if (token === '-C' || token === '--git-dir' || token === '--work-tree') {
      relocations.push({ flag: token, value: rest[cursor + 1] ?? '' });
      cursor += 2;
    } else if (token.startsWith('-C') && token.length > 2) {
      relocations.push({ flag: '-C', value: token.slice(2) });
      cursor++;
    } else if (token.startsWith('--git-dir=')) {
      relocations.push({
        flag: '--git-dir',
        value: token.slice('--git-dir='.length),
      });
      cursor++;
    } else if (token.startsWith('--work-tree=')) {
      relocations.push({
        flag: '--work-tree',
        value: token.slice('--work-tree='.length),
      });
      cursor++;
    } else {
      cursor +=
        AMEND_GIT_GLOBAL_FLAGS_WITH_VALUE.test(token) &&
        cursor + 1 < rest.length
          ? 2
          : 1;
    }
  }
  return relocations;
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
