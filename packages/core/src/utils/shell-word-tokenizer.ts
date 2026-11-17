/**
 * @license
 * Copyright 2025 Qwen team
 * SPDX-License-Identifier: Apache-2.0
 */

import { decodeAnsiCBytes, decodeAnsiCEscape } from './shell-utils.js';

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
export function tokenizeShellWords(
  command: string,
  fdRedirects?: Set<number>,
  fdCloses?: Set<number>,
  /** Parallel bare marks per pushed token; '1' = typed unquoted and unescaped. */
  bares?: string[],
  preserveSyntax = false,
  /** Dynamic `$`/backtick words, only for the preserveSyntax view. */
  expansions?: Set<number>,
): string[] {
  const tokens: string[] = [];
  let current = '';
  // One char per char of `current`: '1' if typed unquoted and unescaped.
  let bare = '';
  let hasExpansion = false;
  let wordStarted = false;
  let tildeQuoted = false;
  let tildeOffset = 0;
  let ansiCBytes: number[] = [];
  const flushAnsiC = () => {
    if (ansiCBytes.length === 0) return;
    const text = decodeAnsiCBytes(ansiCBytes);
    current += text;
    bare += '0'.repeat(text.length);
    ansiCBytes = [];
  };
  let inSingle = false;
  let inDouble = false;
  // `$'…'` keeps its own quote state: `\'` does not close it and `\n` is a
  // newline in the word rather than layout, so escapes decode here.
  let inAnsiC = false;
  // A NUL ends the word bash builds inside an ANSI-C quote: `$'a\0b'c` is
  // the word `ac`. Once set, the scan skips to the segment's closing quote
  // without emitting anything; a following concatenation still appends.
  let ansiCTruncated = false;
  let escaped = false;
  // The second `$` of `$$` (the PID) cannot open `$'…'` or `$"…"`: the
  // quote after it is an ordinary quote.
  let pendingDollar = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (
      !inSingle &&
      !inAnsiC &&
      !escaped &&
      ch === '\\' &&
      command[i + 1] === '\n'
    ) {
      i++;
      continue;
    }
    const afterDollar = pendingDollar;
    pendingDollar = false;

    if (
      preserveSyntax &&
      !inSingle &&
      !inDouble &&
      !inAnsiC &&
      !escaped &&
      !wordStarted &&
      ch === '#'
    ) {
      const newline = command.indexOf('\n', i);
      if (newline < 0) break;
      i = newline - 1;
      continue;
    }

    if (inAnsiC) {
      if (ansiCTruncated) {
        // Skip an escaped character so `\'` does not read as the close.
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
          ansiCBytes.push(0x5c);
          continue;
        }
        if (escape.bytes.includes(0)) {
          ansiCTruncated = true;
          i += escape.length - 1;
          continue;
        }
        for (const byte of escape.bytes) ansiCBytes.push(byte);
        i += escape.length - 1;
        continue;
      }
      if (ch === "'") {
        inAnsiC = false;
        continue;
      }
      const literal = String.fromCodePoint(command.codePointAt(i)!);
      for (const byte of Buffer.from(literal)) ansiCBytes.push(byte);
      i += literal.length - 1;
      continue;
    }

    let quoteAt = i + 1;
    while (ch === '$' && command.startsWith('\\\n', quoteAt)) quoteAt += 2;
    if (!(ch === '$' && command[quoteAt] === "'")) flushAnsiC();
    if (ch === "'" || ch === '"' || ch === '\\') {
      if (!current.slice(tildeOffset).includes('/')) tildeQuoted = true;
      wordStarted = true;
    }
    if (escaped) {
      current += ch;
      bare += '0';
      escaped = false;
      continue;
    }
    if (ch === '\\' && !inSingle) {
      escaped = true;
      continue;
    }
    // `$'…'` opens an ANSI-C word; `$"…"` is locale quoting, which quotes
    // like a double-quoted word. Only the introducer is skipped; a
    // backslash-newline between `$` and the quote is removed first.
    if (ch === '$' && !inSingle && !inDouble && !afterDollar) {
      let next = i + 1;
      while (command[next] === '\\' && command[next + 1] === '\n') next += 2;
      if (command[next] === "'") {
        wordStarted = true;
        if (!current.slice(tildeOffset).includes('/')) tildeQuoted = true;
        inAnsiC = true;
        i = next;
        continue;
      }
      if (command[next] === '"') {
        wordStarted = true;
        if (!current.slice(tildeOffset).includes('/')) tildeQuoted = true;
        inDouble = true;
        i = next;
        continue;
      }
      pendingDollar = true;
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
      if (wordStarted) {
        if (preserveSyntax && hasExpansion) expansions?.add(tokens.length);
        if (tildeQuoted && current[tildeOffset] === '~') {
          bare = bare.slice(0, tildeOffset) + '0' + bare.slice(tildeOffset + 1);
        }
        if (current) {
          pushToken(
            tokens,
            current,
            bare,
            fdRedirects,
            fdCloses,
            bares,
            preserveSyntax,
          );
        } else {
          tokens.push('');
          bares?.push('');
        }
        current = '';
        bare = '';
        hasExpansion = false;
        wordStarted = false;
        tildeQuoted = false;
        tildeOffset = 0;
      }
      continue;
    }
    if (!inSingle && !inDouble && '<>|&'.includes(ch)) {
      if (tildeQuoted && current[tildeOffset] === '~') {
        bare = bare.slice(0, tildeOffset) + '0' + bare.slice(tildeOffset + 1);
      }
      tildeOffset = current.length + 1;
      tildeQuoted = false;
    }
    if (!inSingle && (ch === '$' || ch === '`')) hasExpansion = true;
    current += ch;
    wordStarted = true;
    bare += inSingle || inDouble ? '0' : '1';
  }
  flushAnsiC();
  if (preserveSyntax && hasExpansion) expansions?.add(tokens.length);
  if (tildeQuoted && current[tildeOffset] === '~') {
    bare = bare.slice(0, tildeOffset) + '0' + bare.slice(tildeOffset + 1);
  }
  if (current)
    pushToken(
      tokens,
      current,
      bare,
      fdRedirects,
      fdCloses,
      bares,
      preserveSyntax,
    );
  else if (wordStarted) {
    tokens.push('');
    bares?.push('');
  }
  return tokens;
}

function pushToken(
  tokens: string[],
  token: string,
  bare: string,
  fdRedirects: Set<number> | undefined,
  fdCloses?: Set<number>,
  bares?: string[],
  preserveSyntax = false,
): void {
  if (preserveSyntax) {
    tokens.push(token);
    bares?.push(bare);
    return;
  }
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
      return;
    }
    const op = /^[12]?>&|^<&/.exec(normalized)?.[0];
    if (!op || normBare.slice(op.length - 2, op.length) !== '11') {
      tokens.push(normalized);
      bares?.push(normBare);
      return;
    }
    const close = op.length;
    const closes = normalized[close] === '-' && normBare[close] === '1';
    if (!closes || normalized.length === close + 1) {
      fdRedirects.add(tokens.length);
      tokens.push(normalized);
      bares?.push(normBare);
      return;
    }
    if (!chained) {
      fdRedirects.add(tokens.length);
      fdCloses?.add(tokens.length);
      tokens.push(normalized);
      bares?.push(normBare);
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
