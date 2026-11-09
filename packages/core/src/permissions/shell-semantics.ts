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
import { decodeAnsiCEscape, stripShellWrapper } from '../utils/shell-utils.js';
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
  /**
   * Optional parallel output: one bare-marking string per pushed token, valid
   * while the token array is still unfiltered (extractRedirects consumes it
   * before it removes anything).
   */
  bares?: string[],
  /**
   * Optional parallel output: true when the word's LEADING segment was
   * quoted or decoded, including a zero-width one (`""~/x`). A quote later
   * in the word (`~/"out"`) does not set it: bash expands a tilde prefix
   * that was itself typed bare (#16540 review, R3-9 / R6-1).
   */
  wordQuotedFlags?: boolean[],
): string[] {
  const tokens: string[] = [];
  let current = '';
  // One char per char of `current`: '1' if typed unquoted and unescaped.
  let bare = '';
  // Whether a quoted segment appeared inside the word's TILDE PREFIX —
  // before its first bare `/`. bash suppresses expansion for `"~/x"`,
  // `""~/x` and `~""/x` (witnessed: the last writes `./~/x`), but `~/"out"`
  // still writes `$HOME/out`: a quote after the prefix's slash is data
  // (#16540 review, R3-9 / R6-1).
  let wordQuoted = false;
  let tildePrefixOpen = true;
  let inSingle = false;
  let inDouble = false;
  // `$'…'` keeps its own quote state: `\'` does not close it and `\n` is a
  // newline rather than layout, so decoding escapes here is what keeps
  // `bash -c $'git commit --amend\ntrue'` from reading as one inert word.
  let inAnsiC = false;
  // Bytes accumulated for the ANSI-C word being read. bash builds BYTES from
  // `$'…'`, so decoding one escape at a time turned each byte of a multi-byte
  // UTF-8 sequence into U+FFFD (`\xc3\xa9` became `\uFFFD\uFFFD` while
  // `decodeAnsiCWord` decoded the whole word correctly). The word is decoded
  // once, when its quote closes, exactly like `decodeAnsiCWord`
  // (#16540 review, R1-4 second round).
  let ansiCBytes: number[] | null = null;
  // A word can be empty and still be a word: `cd $''` and `cd ''` hand bash an
  // empty argument, which fails the cd, and the merge base tokenized it that way.
  // Dropping it made the target slot undefined, so the `?? process.env['HOME']`
  // fallback resolved the cwd to $HOME with no `cwdUnknown` flag while bash never
  // left the directory (#16540 review, R4-2).
  let wordStarted = false;
  // `pushToken` drops an empty token, so an empty word is pushed here directly:
  // it carries no redirect syntax and no braces, only the fact that bash saw an
  // argument (#16540 review, R4-2).
  const endWord = () => {
    flushPendingAnsiC();
    if (current) {
      pushToken(
        tokens,
        bares,
        current,
        bare,
        fdRedirects,
        fdCloses,
        wordQuotedFlags,
        wordQuoted,
      );
    } else {
      tokens.push('');
      bares?.push('');
      wordQuotedFlags?.push(wordQuoted);
    }
    current = '';
    bare = '';
    wordQuoted = false;
    tildePrefixOpen = true;
    wordStarted = false;
  };
  const markSegment = (quoted: boolean) => {
    if (quoted && tildePrefixOpen) wordQuoted = true;
    wordStarted = true;
  };
  const pushAnsiCBytes = (bytes: Iterable<number>) => {
    if (ansiCBytes === null) ansiCBytes = [];
    for (const byte of bytes) ansiCBytes.push(byte);
  };
  const pushAnsiCLiteral = (index: number): number => {
    // A literal non-BMP character arrives as a surrogate pair: encoding each
    // UTF-16 unit on its own turns both halves into U+FFFD, so the analysed
    // path stops being the path bash writes (#16540 review, R2-2).
    const codePoint = command.codePointAt(index)!;
    pushAnsiCBytes(Buffer.from(String.fromCodePoint(codePoint), 'utf8'));
    return codePoint > 0xffff ? 1 : 0;
  };
  // Decode the pending ANSI-C bytes into the word: bash concatenates
  // adjacent `$'…'` segments at the BYTE level, so a UTF-8 sequence split
  // across them (`$'\xe4\xbd'$'\xa0'` → 你) decodes once for the whole run,
  // not per segment (#16540 review, R2-7). Called at the word boundary and
  // wherever a NON-ANSI-C segment appends — a plain quoted span breaks the
  // run. A segment's own closing quote and NUL do NOT flush: the next
  // `$'…'` segment of the same word keeps appending bytes, and NUL
  // truncation stays per segment (the scan stops pushing bytes).
  const flushPendingAnsiC = () => {
    if (ansiCBytes === null) return;
    const text = Buffer.from(ansiCBytes).toString('utf8');
    current += text;
    bare += '0'.repeat(text.length);
    ansiCBytes = null;
  };
  // A NUL ends the word bash builds inside an ANSI-C quote: `$'a\0b'c` is the
  // word `ac` — the rest of the quoted segment is dropped, but a following
  // concatenation segment still appends (#16075 review, R11-2). Once set, the
  // scan skips to the segment's closing quote without emitting anything.
  let ansiCTruncated = false;
  // Set by the `\c\` case: the next character of the ANSI-C word is literal.
  let ansiCLiteralNext = false;
  // The second `$` of `$$` (the PID) cannot open `$'…'` or `$"…"`: the quote
  // after it is an ordinary quote. rule-parser.ts pins the same rule for
  // segment boundaries, so the tokenizer must agree rather than add a second
  // reading (#16540 review, R3-1).
  let dollarPending = false;
  let escaped = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    const dollarIntroducer: boolean = dollarPending;
    dollarPending = false;

    if (inAnsiC) {
      // The character after a `\c\` operand is literal text: it is neither a
      // closing quote nor the start of a new escape (#16540 review, R1-5/R2-5).
      if (ansiCLiteralNext) {
        ansiCLiteralNext = false;
        i += pushAnsiCLiteral(i);
        continue;
      }
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
          pushAnsiCBytes(Buffer.from('\\', 'utf8'));
          continue;
        }
        if (escape.text === '\0') {
          // NUL ends THIS segment's contribution; the bytes stay pending so
          // a following concatenation segment appends (`$'a\0b'c` → `ac`).
          ansiCTruncated = true;
          i += escape.length - 1;
          continue;
        }
        pushAnsiCBytes(escape.bytes ?? Buffer.from(escape.text, 'utf8'));
        // Inside `$'…'` a scanning backslash escapes only its operand, so the
        // operand of `\c` does not swallow the backslash after it: in
        // `$'a\c\''` that second backslash still escapes the quote and the word
        // stays open. Consuming all three desynced the state and swallowed the
        // rest of the line (#16540 review, R1-5). The character after that
        // operand is then LITERAL text, not a new escape: bash reads
        // `$'a\c\tb'` as 61 1c 74 62, while re-entering the decoder here turned
        // the `t` into a tab and the two permission paths disagreed about the
        // same word (#16540 review, R2-5).
        if (escape.length === 3 && command[i + 2] === '\\') {
          // The operand backslash is consumed, and when the character it
          // escapes is ITSELF a backslash, that one is consumed too: bash
          // writes 61 1c 74 62 for BOTH `$'a\c\tb'` and `$'a\c\\tb'`. Emitting
          // the extra backslash made it a directory separator in the
          // analysed path — a path bash never opens (#16540 review, R3-3).
          ansiCLiteralNext = true;
          i += 2;
          if (command[i + 1] === '\\' && i + 2 < command.length) i++;
        } else {
          i += escape.length - 1;
        }
        continue;
      }
      if (ch === "'") {
        // Closing quote: the bytes stay pending — the next `$'…'` segment
        // of the same word appends at the byte level (R2-7).
        inAnsiC = false;
        continue;
      }
      i += pushAnsiCLiteral(i);
      continue;
    }

    if (escaped) {
      flushPendingAnsiC();
      current += ch;
      bare += '0';
      escaped = false;
      markSegment(true);
      continue;
    }
    if (ch === '\\' && !inSingle) {
      // Bash removes a backslash-newline continuation outright, joining the
      // word it interrupts — so `git commit \<newline>--amend` is the plain
      // two-word invocation, not a token containing a newline.
      if (command[i + 1] === '\n') {
        // bash removes the continuation before reading the next character, so a
        // pending `$$` lookahead survives it: in `echo x $\<newline>$'a\' >
        // /etc/passwd` the second `$` is the PID and the quote after it is an
        // ordinary quote. Clearing the flag here let that `$` open an ANSI-C word
        // which `\'` never closes, so the redirect was never flushed and the
        // write vanished (#16540 review, R4-1). rule-parser.ts:1095-1099 restores
        // the same flag across a segment boundary.
        dollarPending = dollarIntroducer;
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
      if (command[next] === "'" && !dollarIntroducer) {
        inAnsiC = true;
        markSegment(true);
        // Keep any bytes pending from a PREVIOUS `$'…'` segment of this
        // word: bash concatenates the segments at the byte level, so
        // resetting here split a UTF-8 sequence across them into U+FFFD
        // (#16540 review, R2-7).
        if (ansiCBytes === null) ansiCBytes = [];
        i = next;
        continue;
      }
      if (command[next] === '"' && !dollarIntroducer) {
        inDouble = true;
        markSegment(true);
        i = next;
        continue;
      }
      dollarPending = !dollarIntroducer;
    }
    if (ch === "'" && !inDouble) {
      flushPendingAnsiC();
      // Same opening-only rule as the double quote below (R3-9 / R6-1).
      if (!inSingle) markSegment(true);
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      flushPendingAnsiC();
      // A zero-width quoted segment (`~""/x`) leaves no marking character,
      // so only an OPENING quote can record the word's leading quoting; the
      // closing quote of a later segment must not re-mark a word whose bare
      // prefix (`~/`) already decided the tilde expands (R3-9 / R6-1).
      if (!inDouble) markSegment(true);
      inDouble = !inDouble;
      continue;
    }
    if (!inSingle && !inDouble && (ch === ' ' || ch === '\t')) {
      if (current || wordStarted) {
        endWord();
      }
      continue;
    }
    flushPendingAnsiC();
    current += ch;
    bare += inSingle || inDouble ? '0' : '1';
    if (!inSingle && !inDouble) {
      if (ch === '/') tildePrefixOpen = false;
      markSegment(false);
    }
  }
  if (current || wordStarted) endWord();
  return tokens;
}

function pushToken(
  tokens: string[],
  bares: string[] | undefined,
  token: string,
  bare: string,
  fdRedirects: Set<number> | undefined,
  fdCloses?: Set<number>,
  wordQuotedFlags?: boolean[],
  wordQuoted?: boolean,
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
    // trimShellSyntax only drops leading `(` and trailing `)`/`&`.
    const start = /^\(*/.exec(token)![0].length;
    const normBare = bare.slice(start, start + normalized.length);
    if (!fdRedirects) {
      tokens.push(normalized);
      bares?.push(normBare);
      wordQuotedFlags?.push(wordQuoted ?? false);
      return;
    }
    const op = /^[12]?>&|^<&/.exec(normalized)?.[0];
    if (!op || normBare.slice(op.length - 2, op.length) !== '11') {
      tokens.push(normalized);
      bares?.push(normBare);
      wordQuotedFlags?.push(wordQuoted ?? false);
      return;
    }
    const close = op.length;
    const closes = normalized[close] === '-' && normBare[close] === '1';
    if (!closes || normalized.length === close + 1) {
      fdRedirects.add(tokens.length);
      tokens.push(normalized);
      bares?.push(normBare);
      wordQuotedFlags?.push(wordQuoted ?? false);
      return;
    }
    if (!chained) {
      fdRedirects.add(tokens.length);
      fdCloses?.add(tokens.length);
      tokens.push(normalized);
      bares?.push(normBare);
      wordQuotedFlags?.push(wordQuoted ?? false);
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
function resolvePath(
  p: string,
  cwd: string,
  bare?: string,
  wordWasQuotedOverride?: boolean,
): string {
  // Operand sites reach the command handlers as plain string arrays; the
  // dispatch in extractShellOperations installs the token→marking map for
  // the duration of the handler so a decoded or quoted tilde in an OPERAND
  // (`cat $'\x7e/x'`) stays literal just like at a redirect site
  // (#16540 review, R3-9).
  const operandMarking = operandMarkings?.get(p);
  if (bare === undefined) {
    bare =
      operandMarking?.marking ??
      // A flag VALUE sliced out of its token (`--target-directory=$'\x7e/d'`)
      // is not itself a key in the map; the parent token's marking minus the
      // flag prefix is the value's marking (#16540 review, R6-1).
      markingForFlagValue(p);
  }
  // A zero-width quoted segment (`""~/x`, `~""/x`) leaves no marking
  // character but still quotes the word, so bash keeps the tilde literal
  // (#16540 review, R3-9).
  const wordWasQuoted =
    (operandMarking?.quoted ?? false) ||
    wordWasQuotedOverride === true ||
    (operandMarking === undefined && flagValueWasQuoted(p));
  // Normalize inputs to forward slashes for consistent cross-platform handling
  const normP = p.replace(/\\/g, '/');
  const normCwd = cwd.replace(/\\/g, '/');

  // Only a tilde the user typed unquoted expands: `$'\x7e/x'` decodes to `~/x`
  // and bash opens `./~/x`, so expanding it invented a path under $HOME that no
  // rule can match (#16540 review, R2-8). The first marking character must
  // also BELONG to the tilde: a zero-width quoted segment before it
  // (`""~/x`) leaves the marking starting at `~`'s successor, so a marking
  // shorter than the word means the tilde came from a quoted segment
  // (#16540 review, R3-9).
  const tildeIsBare =
    !wordWasQuoted && (bare === undefined || bare.startsWith('1'));
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

/**
 * Token→bare-marking map installed by extractShellOperations around a
 * command-handler call. The handlers receive plain string arrays, so this
 * is how an operand's quoting reaches resolvePath without rewriting every
 * handler signature. A token spelled two ways in one command merges in the
 * safe direction: ANY bare occurrence expands the tilde, because that
 * occurrence really writes under $HOME and a deny rule must see it
 * (#16540 review, R6-1).
 */
let operandMarkings:
  | Map<string, { marking: string; quoted: boolean }>
  | undefined;

/**
 * The marking of a flag value sliced out of a larger token: find the map key
 * that ends with `=<value>` (or a short flag glued to it) and return the
 * marking's tail of the value's length. The prefix is bare flag syntax, so
 * only the value's own segment decides tilde expansion (#16540 R6-1).
 */
function markingForFlagValue(value: string): string | undefined {
  if (operandMarkings === undefined || value === '') return undefined;
  for (const [token, marking] of operandMarkings) {
    if (!token.startsWith('-') || !token.endsWith(value)) continue;
    const prefixLength = token.length - value.length;
    if (prefixLength <= 0) continue;
    const prefix = token.slice(0, prefixLength);
    // `--flag=value`, `--flag value` glued as `-ovalue`: the prefix must be
    // flag syntax, not part of another path that happens to end alike.
    if (!/^--[\w-]+=$/.test(prefix) && !/^-[A-Za-z]+=?$/.test(prefix)) {
      continue;
    }
    return marking.marking.slice(prefixLength);
  }
  return undefined;
}

/**
 * Whether a sliced flag value came from a quoted or decoded segment: the
 * parent token's marking tail has no bare character for the value's first
 * position (`--target-directory=$'\x7e/d'` decodes to `~/d` with an all-zero
 * tail), so bash keeps the tilde literal (#16540 R6-1).
 */
function flagValueWasQuoted(value: string): boolean {
  const marking = markingForFlagValue(value);
  return marking !== undefined && marking[0] !== '1';
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
  bares?: string[],
  wordQuotedFlags?: boolean[],
): RedirectResult {
  const readFiles: string[] = [];
  const writeFiles: string[] = [];
  const toRemove = new Set<number>();

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    // A quoted operator is data, not an operator. `$'\x3e'` decodes to `>` and
    // the tokenizer marks every decoded character as quoted, so without reading
    // that marking a decoded operator character looked real: `cat $'\x3e' > /tmp/t`
    // reported a read of /tmp/t plus a phantom write to `>` while bash creates
    // /tmp/t (#16540 review, R2-4).
    const tokBare = bares?.[i];
    // Scoped to a token whose characters were ALL quoted or decoded: a partly
    // quoted word like `2">"&1` keeps the fail-safe reading this file already
    // pinned (not an fd duplication, so a literal write to `&1`), while a word
    // that is nothing but decoded quote content is data — `$'\x3e'` is a `>`
    // argument, not a redirect (#16540 review, R2-4).
    const isDecodedDataWord =
      tokBare !== undefined &&
      tokBare.length === tok.length &&
      !tokBare.includes('1');
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
        // The target's quoting survives inside the same token: `>&'~'/out`
        // opens ./~/out, not $HOME/out (#16540 review, R3-9). The `&` prefix
        // of a close-word is syntax this parser added, so that shape keeps
        // the pre-existing whole-word reading.
        (fdOp === '<&' ? readFiles : writeFiles).push(
          resolvePath(
            file,
            cwd,
            fdCloses.has(i) ? undefined : tokBare?.slice(fdOp.length),
            wordQuotedFlags?.[i],
          ),
        );
      }
      continue;
    }

    // ── Separate-token redirect operators ─────────────────────────────────
    if ((tok === '>' || tok === '1>') && !isDecodedDataWord) {
      const target = tokens[i + 1];
      if (target && looksLikePath(target)) {
        if (!isNetworkPseudoDevice(target)) {
          writeFiles.push(
            resolvePath(
              target,
              cwd,
              targetBare(i + 1),
              wordQuotedFlags?.[i + 1],
            ),
          );
        }
        toRemove.add(i);
        toRemove.add(i + 1);
        i++;
      }
    } else if ((tok === '>>' || tok === '1>>') && !isDecodedDataWord) {
      const target = tokens[i + 1];
      if (target && looksLikePath(target)) {
        if (!isNetworkPseudoDevice(target)) {
          writeFiles.push(
            resolvePath(
              target,
              cwd,
              targetBare(i + 1),
              wordQuotedFlags?.[i + 1],
            ),
          );
        }
        toRemove.add(i);
        toRemove.add(i + 1);
        i++;
      }
    } else if ((tok === '<<' || tok === '<<-') && !isDecodedDataWord) {
      toRemove.add(i);
      if (tokens[i + 1]) {
        toRemove.add(i + 1);
        i++;
      }
    } else if (tok === '<' && !isDecodedDataWord) {
      const target = tokens[i + 1];
      if (target && looksLikePath(target)) {
        if (!isNetworkPseudoDevice(target)) {
          readFiles.push(
            resolvePath(
              target,
              cwd,
              targetBare(i + 1),
              wordQuotedFlags?.[i + 1],
            ),
          );
        }
        toRemove.add(i);
        toRemove.add(i + 1);
        i++;
      }
    } else if (
      (tok === '2>' || tok === '2>>' || tok === '&>' || tok === '&>>') &&
      !isDecodedDataWord
    ) {
      // stderr / combined redirect — consume target
      const target = tokens[i + 1];
      if (target) {
        if (
          target !== '/dev/null' &&
          looksLikePath(target) &&
          !isNetworkPseudoDevice(target)
        ) {
          writeFiles.push(
            resolvePath(
              target,
              cwd,
              targetBare(i + 1),
              wordQuotedFlags?.[i + 1],
            ),
          );
        }
        toRemove.add(i);
        toRemove.add(i + 1);
        i++;
      }
    }
    // ── Combined redirect tokens without space: `>file`, `>>file`, etc. ───
    else {
      const m = tok.match(/^(<<-?|1>>|1>|>>|>|2>>|2>|&>>|&>|<)([\s\S]+)$/);
      if (m && !isDecodedDataWord) {
        const op = m[1]!;
        const target = m[2]!;
        const targetMarking = tokBare?.slice(op.length);
        // A zero-width quoted segment inside the target (`>~""/x`) leaves no
        // marking character: the operator's own prefix is all bare, so a
        // target marking with a missing character means a quote the marking
        // cannot show, and bash keeps the tilde literal. A QUOTED operator
        // prefix (`$'\x3e'~/x`) is decoded data, not this shape — its zeros
        // belong to the operator, so only the bare-operator spelling counts
        // (#16540 review, R3-9 / R6-1).
        const targetQuoted =
          wordQuotedFlags?.[i] ||
          (tokBare !== undefined && tokBare.length < tok.length);
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
            readFiles.push(
              resolvePath(target, cwd, targetMarking, targetQuoted),
            );
          } else {
            writeFiles.push(
              resolvePath(target, cwd, targetMarking, targetQuoted),
            );
          }
        }
        toRemove.add(i);
      }
    }
  }

  // Remove redirect tokens from the array in-place, compacting the index-parallel
  // marking with the SAME index set. Callers read a token's marking by position,
  // so filtering one array without the other desyncs every later index
  // (#16540 review, R3-2).
  const filtered = tokens.filter((_, idx) => !toRemove.has(idx));
  tokens.length = 0;
  tokens.push(...filtered);
  if (bares !== undefined) {
    const filteredBares = bares.filter((_, idx) => !toRemove.has(idx));
    bares.length = 0;
    bares.push(...filteredBares);
  }
  if (wordQuotedFlags !== undefined) {
    const filteredQuoted = wordQuotedFlags.filter(
      (_, idx) => !toRemove.has(idx),
    );
    wordQuotedFlags.length = 0;
    wordQuotedFlags.push(...filteredQuoted);
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
  const bares: string[] = [];
  const quotedFlags: boolean[] = [];
  const tokens = tokenize(
    simpleCommand,
    fdRedirects,
    fdCloses,
    bares,
    quotedFlags,
  );
  if (tokens.length === 0) return [];

  // Extract I/O redirections before dispatching to the command handler.
  // This mutates `tokens` in-place by removing redirect tokens.
  const { readFiles: redirectReads, writeFiles: redirectWrites } =
    extractRedirects(tokens, cwd, fdRedirects, fdCloses, bares, quotedFlags);

  while (tokens[0] && isEnvAssignmentToken(tokens[0])) {
    tokens.shift();
    bares.shift();
    quotedFlags.shift();
  }

  return dispatchShellOperations(
    tokens,
    bares,
    quotedFlags,
    cwd,
    redirectReads,
    redirectWrites,
  );
}

/**
 * Dispatch already-tokenized words whose redirect extraction has run. The
 * PREFIX_COMMANDS recursion enters here with the index-parallel markings
 * sliced by the same startIdx, so a prefix never re-tokenizes decoded text
 * and loses its quoting (#16540 review, R6-1).
 */
function dispatchShellOperations(
  tokens: string[],
  bares: string[],
  quotedFlags: boolean[],
  cwd: string,
  redirectReads: string[] = [],
  redirectWrites: string[] = [],
): ShellOperation[] {
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
      // Recurse on the token slice with its index-parallel markings: joining
      // the decoded tokens back into text and re-tokenizing lost the quoting
      // (`sudo tee '~/y'` re-read the bare word `~/y` and invented a $HOME
      // write bash never makes) (#16540 review, R6-1).
      ops.push(
        ...dispatchShellOperations(
          tokens.slice(startIdx),
          bares.slice(startIdx),
          quotedFlags.slice(startIdx),
          cwd,
        ),
      );
    }
  } else {
    // ── Dispatch to the known-command handler ─────────────────────────────
    const handler = COMMANDS[cmdName];
    if (handler) {
      const args = tokens.slice(1);
      // Install the operand markings for the handler's resolvePath calls
      // (R3-9). Duplicate spellings merge in the safe direction: a position
      // is bare if ANY occurrence typed it bare, because that occurrence
      // expands the tilde and really writes under $HOME — an out-of-workspace
      // target a deny rule must see (#16540 review, R6-1).
      const markings = new Map<string, { marking: string; quoted: boolean }>();
      for (let t = 1; t < tokens.length; t++) {
        const token = tokens[t]!;
        const marking = bares[t] ?? '';
        const quoted = quotedFlags[t] ?? false;
        const prior = markings.get(token);
        if (prior === undefined) {
          markings.set(token, { marking, quoted });
        } else {
          let merged = '';
          for (
            let c = 0;
            c < Math.max(prior.marking.length, marking.length);
            c++
          ) {
            merged +=
              prior.marking[c] === '1' || marking[c] === '1' ? '1' : '0';
          }
          markings.set(token, {
            marking: merged,
            quoted: prior.quoted && quoted,
          });
        }
      }
      const outerMarkings = operandMarkings;
      operandMarkings = markings;
      try {
        ops.push(...handler(args, cwd));
      } finally {
        operandMarkings = outerMarkings;
      }
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
  const bares: string[] = [];
  const words = tokenize(command, fdRedirects, fdCloses, bares);
  // extractRedirects compacts `words` and `bares` together, so the target and its
  // marking are read from the filtered arrays: a redirect written BEFORE the
  // directory (`cd 2>/dev/null /etc`) is gone by then, and reading a pre-filter
  // snapshot made that redirect the cwd (#16540 review, R3-2 fix-induced).
  const redirects = extractRedirects(words, cwd, fdRedirects, fdCloses, bares);

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
  const targetBare = bares[targetIndex];
  // A target the shell had to decode (`cd $'\x7e'` is the literal directory
  // `~`, never $HOME) may not exist at all — bash then fails the cd and the
  // rest of the segment runs where it already was — so resolve it without
  // tilde expansion and keep the fail-closed marking. An ABSOLUTE target does
  // not depend on the cwd whichever way the cd goes, exactly like an unquoted
  // absolute path, so quoting alone must not escalate every later write in the
  // segment (#16540 review, R4-7).
  const targetIsDecoded =
    targetBare !== undefined &&
    targetBare.length === target.length &&
    !targetBare.includes('1') &&
    !isShellAbsolutePath(target);

  return {
    kind: 'static',
    cwd: resolvePath(target, cwd, targetBare),
    cwdUnknown: targetIsDecoded || (cwdUnknown && !isShellAbsolutePath(target)),
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
