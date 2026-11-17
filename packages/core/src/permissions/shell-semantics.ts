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
  stripShellCommandNegation,
  stripShellCommandPrefixes,
  stripShellWrapper,
} from '../utils/shell-utils.js';
import {
  envSplitStringCommand,
  getShellPrefixCommand,
  MAX_SHELL_UNWRAP_DEPTH,
} from '../utils/shell-command-prefixes.js';
import { tokenizeShellWords as tokenize } from '../utils/shell-word-tokenizer.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { splitCompoundCommandSegments } from './rule-parser.js';
import {
  removeShellLineContinuations,
  shellCommandMayChangeCwd,
} from './shell-command-syntax.js';

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
 * The words of one simple shell command after quote removal, ANSI-C `$'…'`
 * decoding and `\`-newline joining. The amend guard matches on these so a
 * quote-split spelling (`git com''mit --amend`) is read as the word bash runs.
 */
export function shellWords(command: string): string[] {
  return tokenize(command);
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
function resolvePath(p: string, cwd: string, bare?: string): string {
  // Normalize inputs to forward slashes for consistent cross-platform handling
  const normP = p.replace(/\\/g, '/');
  const normCwd = cwd.replace(/\\/g, '/');

  // Only a tilde the user typed unquoted expands: `"~/x"` and `$'\x7e/x'`
  // both decode to `~/x`, and bash opens the literal directory `~` — expanding
  // it invented a path under $HOME that no rule can match.
  const tildeIsBare = bare === undefined || bare.startsWith('1');
  if (tildeIsBare && (normP === '~' || normP.startsWith('~/'))) {
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
 * Index where bash ends the word and starts an unquoted redirection operator.
 *
 * A quoted or escaped `<`, `>`, `&` or `|` stays inside the word, so `'>'>file`
 * is the word `>` followed by the redirect `>file`, and `'&'>file` is the
 * word `&` followed by the same redirect. The tokenizer keeps both in one
 * token, and the masked spelling alone would hide the real operator.
 *
 * The character set is the mask's, and has to stay in step with it: `|` joined
 * that set when a quoted `|` stopped being read as the clobber operator, and
 * leaving it out here kept the opposite hole open. `"|" >file` (spaced) was
 * seen while `"|">file` was not, so bash wrote the file and no rule saw a
 * write at all — `echo '{}' "|">.qwen/settings.json` overwrites the settings
 * file under a `Write(.qwen/settings.json)` deny, measured on base as well as
 * here. `&`, `>` and `<` never had the gap.
 */
function operatorAfterMaskedOperator(
  token: string,
  bare: string | undefined,
): number {
  if (bare === undefined || bare.length !== token.length) return -1;
  for (let index = 1; index < token.length; index++) {
    if (bare[index] !== '1') continue;
    const previous = token[index - 1]!;
    if (bare[index - 1] === '1' || !'<>&|'.includes(previous)) continue;
    if (!/^(?:&>>|&>|>>|>|<<|<)/.test(token.slice(index))) continue;
    return index;
  }
  return -1;
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
 *   `>| file`  `N>| file`            (the clobber override: same write as `>`)
 *   `2> file`  `2>> file` `&> file`  `&>> file`
 *   Combined forms: `>file`, `>>file`, `1>file`, `2>/dev/null`, `>|file`
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
  bares?: string[],
): RedirectResult {
  const readFiles: string[] = [];
  const writeFiles: string[] = [];
  const toRemove = new Set<number>();

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    const tokBare = bares?.[i];
    const syntax =
      tokBare === undefined
        ? tok
        : tok
            .split('')
            .map((character, index) =>
              // `|` belongs here: `>"|"file` and `>\|file` are plain writes to
              // a file whose name starts with `|`, not shell pipes. Leaving it
              // un-masked made the quoted form read as the `>|` clobber, and the
              // reported target lost its leading `|` — `>"|/../".qwen/settings.json`
              // normalised to `.qwen/settings.json`, which bypassed the deny.
              // Masking keeps the pipe visible to bash but out of the syntax
              // match, so the quoted forms fall back to the existing `>` branch
              // and the target is sliced from the original token, as on base.
              '<>&|'.includes(character) && tokBare[index] !== '1'
                ? '\0'
                : character,
            )
            .join('');
    const targetBare = (index: number): string | undefined => bares?.[index];

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
        (fdOp === '<&' ? readFiles : writeFiles).push(
          resolvePath(file, cwd, tokBare?.slice(fdOp.length)),
        );
      }
      continue;
    }

    // ── Separate-token redirect operators ─────────────────────────────────
    // `>|` and `N>|` are bash's clobber override: the same write as `>` / `N>`,
    // spelled to defeat `noclobber`. Reading them as anything else loses a
    // write to a protected path.
    if (
      syntax === '>' ||
      syntax === '1>' ||
      syntax === '>|' ||
      syntax === '1>|'
    ) {
      const target = tokens[i + 1];
      if (target && looksLikePath(target)) {
        if (!isNetworkPseudoDevice(target)) {
          writeFiles.push(resolvePath(target, cwd, targetBare(i + 1)));
        }
        toRemove.add(i);
        toRemove.add(i + 1);
        i++;
      }
    } else if (syntax === '>>' || syntax === '1>>') {
      const target = tokens[i + 1];
      if (target && looksLikePath(target)) {
        if (!isNetworkPseudoDevice(target)) {
          writeFiles.push(resolvePath(target, cwd, targetBare(i + 1)));
        }
        toRemove.add(i);
        toRemove.add(i + 1);
        i++;
      }
    } else if (syntax === '<<' || syntax === '<<-') {
      toRemove.add(i);
      if (tokens[i + 1]) {
        toRemove.add(i + 1);
        i++;
      }
    } else if (syntax === '<') {
      const target = tokens[i + 1];
      if (target && looksLikePath(target)) {
        if (!isNetworkPseudoDevice(target)) {
          readFiles.push(resolvePath(target, cwd, targetBare(i + 1)));
        }
        toRemove.add(i);
        toRemove.add(i + 1);
        i++;
      }
    } else if (
      syntax === '2>' ||
      syntax === '2>>' ||
      syntax === '&>' ||
      syntax === '&>>' ||
      syntax === '2>|'
    ) {
      // stderr / combined redirect — consume target
      const target = tokens[i + 1];
      if (target) {
        if (
          target !== '/dev/null' &&
          looksLikePath(target) &&
          !isNetworkPseudoDevice(target)
        ) {
          writeFiles.push(resolvePath(target, cwd, targetBare(i + 1)));
        }
        toRemove.add(i);
        toRemove.add(i + 1);
        i++;
      }
    }
    // ── Combined redirect tokens without space: `>file`, `>>file`, etc. ───
    else {
      const split = operatorAfterMaskedOperator(tok, tokBare);
      const redirectText = split > 0 ? tok.slice(split) : tok;
      const redirectBare = split > 0 ? tokBare?.slice(split) : tokBare;
      const fdOp = split > 0 ? /^(?:[12]?>&|<&)/.exec(redirectText)?.[0] : null;
      if (fdOp) {
        const file = fdRedirectFile(redirectText.slice(fdOp.length));
        if (file !== undefined) {
          (fdOp === '<&' ? readFiles : writeFiles).push(
            resolvePath(file, cwd, redirectBare?.slice(fdOp.length)),
          );
        }
        tokens[i] = tok.slice(0, split);
        if (bares !== undefined) bares[i] = tokBare!.slice(0, split);
        continue;
      }
      // Match the operator on the masked spelling after the quoted word too:
      // in `'>'>"|"file` the redirect is a plain `>` and the quoted `|` starts
      // the file name, so `>|` must not claim the target's first character.
      // The length is unchanged, so the target is still sliced from `tok`.
      const matchText = split > 0 ? syntax.slice(split) : syntax;
      const m = matchText.match(
        /^(<<-?|1>\||2>\||>\||1>>|1>|>>|>|2>>|2>|&>>|&>|<)([\s\S]+)$/,
      );
      if (m) {
        const op = m[1]!;
        const targetStart = Math.max(split, 0) + op.length;
        const target = tok.slice(targetStart);
        if (op.startsWith('<<')) {
          if (split > 0) {
            tokens[i] = tok.slice(0, split);
            if (bares !== undefined) bares[i] = tokBare!.slice(0, split);
          } else {
            toRemove.add(i);
          }
          continue;
        }
        if (
          target !== '/dev/null' &&
          looksLikePath(target) &&
          !isNetworkPseudoDevice(target)
        ) {
          const file = resolvePath(target, cwd, tokBare?.slice(targetStart));
          if (op === '<') {
            readFiles.push(file);
          } else {
            writeFiles.push(file);
          }
        }
        if (split > 0) {
          tokens[i] = tok.slice(0, split);
          if (bares !== undefined) bares[i] = tokBare!.slice(0, split);
        } else {
          toRemove.add(i);
        }
      } else if (split > 0) {
        // A quoted operator before a descriptor duplication or control
        // syntax (`'>'>&1`): the quoted word stays, the rest opens no file.
        tokens[i] = tok.slice(0, split);
        if (bares !== undefined) bares[i] = tokBare!.slice(0, split);
      }
    }
  }

  // Remove redirect tokens in-place, compacting the index-parallel marking
  // with the SAME index set: a caller reads a token's marking by position, so
  // filtering one array without the other desyncs every later index.
  const filtered = tokens.filter((_, idx) => !toRemove.has(idx));
  tokens.length = 0;
  tokens.push(...filtered);
  if (bares !== undefined) {
    const filteredBares = bares.filter((_, idx) => !toRemove.has(idx));
    bares.length = 0;
    bares.push(...filteredBares);
  }

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
  depth = 0,
): ShellOperation[] {
  if (!simpleCommand.trim()) return [];

  const fdRedirects = new Set<number>();
  const fdCloses = new Set<number>();
  const bares: string[] = [];
  const tokens = tokenize(simpleCommand, fdRedirects, fdCloses, bares);
  if (tokens.length === 0) return [];

  // Extract I/O redirections before dispatching to the command handler.
  // This mutates `tokens` in-place by removing redirect tokens.
  const { readFiles: redirectReads, writeFiles: redirectWrites } =
    extractRedirects(tokens, cwd, fdRedirects, fdCloses, bares);

  while (tokens[0] && isEnvAssignmentToken(tokens[0])) {
    tokens.shift();
    bares.shift();
  }

  const ops: ShellOperation[] = [];
  let commandIndex = 0;
  for (;;) {
    if (tokens[commandIndex] === '!' && bares[commandIndex] === '1') {
      commandIndex++;
      continue;
    }
    const prefix = getShellPrefixCommand(tokens, commandIndex);
    if (prefix === undefined) break;
    if (prefix.splitString !== undefined) {
      if (depth < MAX_SHELL_UNWRAP_DEPTH) {
        const payload = envSplitStringCommand(
          prefix.splitString,
          tokens.slice(prefix.commandIndex),
        );
        if (payload !== undefined) {
          ops.push(...walkCompoundCommand(payload, cwd, depth + 1, true));
        }
      }
      commandIndex = tokens.length;
      break;
    }
    commandIndex = prefix.commandIndex;
  }

  const cmdName = tokens[commandIndex];
  if (!cmdName) {
    // Only assignments and/or redirections were present.
    return [
      ...ops,
      ...toRedirectOperations({
        readFiles: redirectReads,
        writeFiles: redirectWrites,
      }),
    ];
  }

  // Prefixes advance through the same argv; reparsing joined words would turn
  // quoted arguments such as `echo 'hi > file'` into executable redirections.
  const handler = COMMANDS[cmdName];
  if (handler) {
    ops.push(...handler(tokens.slice(commandIndex + 1), cwd));
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
  const bares: string[] = [];
  const words = tokenize(command, fdRedirects, fdCloses, bares);
  // extractRedirects compacts `words` and `bares` together, so the target and
  // its marking are read from the filtered arrays.
  const redirects = extractRedirects(words, cwd, fdRedirects, fdCloses, bares);

  if (['popd', 'source', '.'].includes(words[0] ?? ''))
    return { kind: 'dynamic', redirects };
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
  const targetBare = bares[targetIndex];
  // A target the shell had to decode (`cd $'\x7e'` is the literal directory
  // `~`, never $HOME) may not exist at all — bash then fails the cd and the
  // rest of the segment runs where it already was — so resolve it without
  // tilde expansion and keep the fail-closed marking. An ABSOLUTE target does
  // not depend on the cwd whichever way the cd goes, so quoting alone must not
  // escalate every later write in the segment.
  const targetIsDecoded =
    targetBare !== undefined &&
    targetBare.length === target.length &&
    (!targetBare.includes('1') ||
      (targetBare.startsWith('0') &&
        (target === '~' || target.startsWith('~/')))) &&
    !isShellAbsolutePath(target);

  return {
    kind: 'static',
    cwd: resolvePath(target, cwd, targetBare),
    cwdUnknown:
      targetIsDecoded ||
      (cwdUnknown && !isShellAbsolutePath(target)) ||
      (!!process.env['CDPATH'] &&
        !isShellAbsolutePath(target) &&
        !/^(?:\.|\.\.)(?:\/|$)/.test(target)),
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

interface ShellCwdState {
  cwd: string;
  unknown: boolean;
}

// Keep one representative path, but never grant from it when execution paths
// disagree. This bounds the analysis regardless of the number of &&/|| joins.
function joinCwdStates(
  first: ShellCwdState,
  second: ShellCwdState,
): ShellCwdState {
  return {
    cwd: first.cwd,
    unknown: first.unknown || second.unknown || first.cwd !== second.cwd,
  };
}

function walkCompoundCommand(
  command: string,
  cwd: string,
  depth: number,
  initialCwdUnknown: boolean,
): ShellOperation[] {
  command = removeShellLineContinuations(command);
  const subCommands = splitCompoundCommandSegments(stripHeredocBodies(command));

  const ops: ShellOperation[] = [];
  let succeeded: ShellCwdState = { cwd, unknown: initialCwdUnknown };
  let failed = succeeded;
  let listStart = succeeded;
  let previous = '';

  for (let index = 0; index < subCommands.length; index++) {
    const input =
      previous === '&&'
        ? succeeded
        : previous === '||'
          ? failed
          : previous === '&'
            ? listStart
            : joinCwdStates(succeeded, failed);
    if (previous !== '&&' && previous !== '||') listStart = input;

    // A pipeline runs its commands in separate processes. Analyse their file
    // effects from the pipeline's input cwd, without carrying a cd to a sibling
    // or to the foreground list that follows it.
    let pipelineEnd = index;
    while (
      ['|', '|&'].includes(subCommands[pipelineEnd]!.terminator) &&
      pipelineEnd + 1 < subCommands.length
    )
      pipelineEnd++;
    let nextSuccess = input;
    let nextFailure = input;

    for (let part = index; part <= pipelineEnd; part++) {
      const rawSub = subCommands[part]!.command;
      const sub = stripShellCommandNegation(rawSub);
      const cdTarget = resolveCdTargetCwd(sub, input.cwd, input.unknown);
      if (cdTarget.kind !== 'not-cd') {
        const redirectOps = toRedirectOperations(cdTarget.redirects);
        ops.push(
          ...(input.unknown
            ? markCwdUnknownOps(redirectOps, sub, input.cwd)
            : redirectOps),
        );
        if (cdTarget.kind === 'static') {
          nextSuccess = { cwd: cdTarget.cwd, unknown: cdTarget.cwdUnknown };
          nextFailure = input;
        } else {
          // source/. can change cwd even when the sourced command fails.
          nextSuccess = nextFailure = { ...input, unknown: true };
        }
      } else {
        // Unwrap after the outer split so sibling segments remain visible.
        const strictPrefix = stripShellCommandPrefixes(sub);
        const unprefixed =
          strictPrefix ?? stripShellCommandPrefixes(sub, true) ?? sub;
        const subCwdUnknown = input.unknown || strictPrefix === undefined;
        const subOps = extractShellOperations(sub, input.cwd, depth);
        ops.push(
          ...(subCwdUnknown
            ? markCwdUnknownOps(subOps, sub, input.cwd)
            : subOps),
        );
        const unwrapped = stripShellWrapper(unprefixed);
        if (unwrapped !== unprefixed) {
          if (depth < MAX_SHELL_UNWRAP_DEPTH) {
            ops.push(
              ...walkCompoundCommand(
                unwrapped,
                input.cwd,
                depth + 1,
                subCwdUnknown,
              ),
            );
          } else {
            shellSemanticsDebugLogger.warn(
              `Shell wrapper unwrap depth limit reached (${MAX_SHELL_UNWRAP_DEPTH}); analysing remaining command as-is.`,
            );
          }
          // An explicit child shell cannot change the parent's cwd.
          nextSuccess = nextFailure = input;
        } else {
          nextSuccess = nextFailure = shellCommandMayChangeCwd(sub)
            ? { ...input, unknown: true }
            : input;
        }
      }

      if (sub.startsWith('(') && sub.endsWith(')')) {
        // A complete parenthesized segment is a subshell, not a parent cd.
        nextSuccess = nextFailure = input;
      } else if (
        (rawSub.slice(0, rawSub.length - sub.length).match(/!/g)?.length ?? 0) %
        2
      ) {
        [nextSuccess, nextFailure] = [nextFailure, nextSuccess];
      }
    }
    if (pipelineEnd !== index) nextSuccess = nextFailure = input;

    // && / || are left associative. Carry the branch that skipped this command
    // into the appropriate result, rather than treating the final cd as certain.
    if (previous === '&&') {
      failed = joinCwdStates(nextFailure, failed);
      succeeded = nextSuccess;
    } else if (previous === '||') {
      succeeded = joinCwdStates(nextSuccess, succeeded);
      failed = nextFailure;
    } else {
      succeeded = nextSuccess;
      failed = nextFailure;
    }
    previous = subCommands[pipelineEnd]!.terminator;
    index = pipelineEnd;
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
      // `>|` / `N>|` are the clobber spellings and must be tried before the
      // bare `>` alternatives, or `>|/abs/p.txt` yields `|/abs/p.txt` — not a
      // shell-absolute path, so a `cd $D && … >|/abs/p.txt` was flagged
      // `pathMayDependOnCwd` while the `>` form was not.
      /^(?:1>>|[12]?>\||[12]?>&|<&|1>|>>|>|2>>|2>|&>>|&>|<)([\s\S]+)$/,
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
