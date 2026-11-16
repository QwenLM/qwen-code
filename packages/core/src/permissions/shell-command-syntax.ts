/**
 * @license
 * Copyright 2025 Qwen team
 * SPDX-License-Identifier: Apache-2.0
 */

import { tokenizeShellWords } from '../utils/shell-word-tokenizer.js';

/** Remove Bash continuations without changing literal single-quoted text. */
export function removeShellLineContinuations(command: string): string {
  let result = '';
  let quote = '';
  let pendingDollar = false;
  let wordStart = true;
  for (let index = 0; index < command.length; index++) {
    const character = command[index]!;
    const afterDollar: boolean = pendingDollar;
    pendingDollar = false;
    if (character === '\\' && quote !== "'") {
      if (command[index + 1] === '\n' && quote !== "$'") {
        pendingDollar = afterDollar;
        index++;
        continue;
      }
      result += character;
      if (index + 1 < command.length) result += command[++index];
      wordStart = false;
      continue;
    }
    if (!quote && character === '#' && wordStart) {
      const end = command.indexOf('\n', index);
      if (end < 0) return result + command.slice(index);
      result += command.slice(index, end + 1);
      index = end;
      wordStart = true;
      continue;
    }
    result += character;
    if (quote) {
      if (character === quote || (quote === "$'" && character === "'")) {
        quote = '';
      }
    } else if (character === "'" || character === '"') {
      quote = character === "'" && afterDollar ? "$'" : character;
    } else if (character === '$') {
      pendingDollar = !afterDollar;
    }
    wordStart = !quote && /[ \t\n;&|()<>]/.test(character);
  }
  return result;
}

/**
 * Hide only a fully parsed constant integer expression from substitution scans.
 * Arithmetic with variables/arrays is executable: Bash recursively expands it.
 */
export function maskConstantArithmetic(command: string): string {
  let result = '';
  let quote = '';
  for (let index = 0; index < command.length; index++) {
    const character = command[index]!;
    if (character === '\\' && quote !== "'") {
      result += command.slice(index, index + 2);
      index++;
      continue;
    }
    if (quote === "'" || quote === "$'") {
      result += character;
      if (character === "'") quote = '';
      continue;
    }
    if (command.startsWith('$((', index)) {
      const end = constantArithmeticEnd(command, index + 3);
      if (end !== undefined) {
        result += '0'.repeat(end - index);
        index = end - 1;
        continue;
      }
    }
    result += character;
    if (character === '"') quote = quote ? '' : '"';
    else if (character === "'" && !quote) {
      quote = command[index - 1] === '$' ? "$'" : "'";
    }
  }
  return result;
}

function constantArithmeticEnd(
  text: string,
  start: number,
): number | undefined {
  let index = start;
  let depth = 0;
  let expectOperand = true;
  while (index < text.length) {
    const character = text[index]!;
    if (character === ' ' || character === '\t') {
      index++;
    } else if (expectOperand && (character === '+' || character === '-')) {
      index++;
    } else if (expectOperand && character === '(') {
      depth++;
      index++;
    } else if (expectOperand && /[0-9]/.test(character)) {
      const number = /^(?:0|[1-9][0-9]*)/.exec(text.slice(index))![0];
      index += number.length;
      expectOperand = false;
    } else if (!expectOperand && character === ')' && depth > 0) {
      depth--;
      index++;
    } else if (!expectOperand && depth === 0 && text.startsWith('))', index)) {
      return index + 2;
    } else if (!expectOperand && /[+*/%-]/.test(character)) {
      expectOperand = true;
      index++;
    } else {
      return undefined;
    }
  }
  return undefined;
}

interface ShellWord {
  text: string;
  bare: string;
  hasExpansion: boolean;
}

export interface StaticShellCommand {
  words: string;
  redirects: Array<{ kind: 'read' | 'write' | 'readwrite'; target: string }>;
}

/**
 * A restrictive-only view of static words and file effects. Uses the same quote
 * removal as the file-operation tracker. Unknown syntax has no semantic view;
 * it must not manufacture a match for an unrelated command or target.
 */
export function staticShellCommand(
  command: string,
  pattern = false,
): StaticShellCommand | undefined {
  const bares: string[] = [];
  const expansions = new Set<number>();
  const tokens = tokenizeShellWords(
    removeShellLineContinuations(command),
    undefined,
    undefined,
    bares,
    true,
    expansions,
  );
  const pieces: Array<ShellWord | { operator: string }> = [];
  for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex++) {
    const text = tokens[tokenIndex]!;
    const bare = bares[tokenIndex]!;
    if (text.startsWith('#') && bare[0] === '1') break;
    const hasExpansion = expansions.has(tokenIndex);
    let start = 0;
    for (let index = 0; index < text.length; index++) {
      if (bare[index] !== '1') continue;
      const character = text[index]!;
      if (';|(){}'.includes(character)) return undefined;
      if (character === '&' && text[index + 1] !== '>') return undefined;
      if (!'<>&'.includes(character)) continue;
      const prefix = text.slice(start, index);
      const prefixBare = bare.slice(start, index);
      if (prefix && !(/^\d+$/.test(prefix) && /^1+$/.test(prefixBare))) {
        pieces.push({ text: prefix, bare: prefixBare, hasExpansion });
      }
      const syntax = text
        .slice(index)
        .split('')
        .map((char, offset) => (bare[index + offset] === '1' ? char : '\0'))
        .join('');
      const operator = /^(?:&>>?|>>|>\||<>|[<>]&|>|<)/.exec(syntax)?.[0];
      if (!operator || syntax.startsWith('<<')) return undefined;
      pieces.push({ operator });
      index += operator.length - 1;
      start = index + 1;
    }
    if (start < text.length || text.length === 0) {
      pieces.push({
        text: text.slice(start),
        bare: bare.slice(start),
        hasExpansion,
      });
    }
  }
  const words: ShellWord[] = [];
  const redirects: StaticShellCommand['redirects'] = [];
  for (let index = 0; index < pieces.length; index++) {
    const piece = pieces[index]!;
    if ('operator' in piece) {
      const target = pieces[++index];
      if (!target || !('text' in target) || target.hasExpansion) {
        return undefined;
      }
      if (
        !pattern &&
        /[*?[\]]/.test(
          target.text
            .split('')
            .filter((_, i) => target.bare[i] === '1')
            .join(''),
        )
      ) {
        return undefined;
      }
      if (piece.operator.endsWith('&')) {
        // Descriptor copies and closes do not open a file.
        if (/^(?:\d+|-)$/.test(target.text)) continue;
        return undefined;
      }
      redirects.push({
        kind:
          piece.operator === '<>'
            ? 'readwrite'
            : piece.operator === '<'
              ? 'read'
              : 'write',
        target: encodeWord(target, pattern),
      });
    } else {
      // Only unquoted prefix assignments and negation are syntax.
      if (
        words.length === 0 &&
        ((piece.text === '!' && piece.bare === '1') ||
          (/^[A-Za-z_][A-Za-z0-9_]*=/.test(piece.text) &&
            /^1+$/.test(piece.bare.slice(0, piece.text.indexOf('=') + 1))))
      )
        continue;
      if (piece.hasExpansion) return undefined;
      words.push(piece);
    }
  }
  return words.length > 0
    ? {
        words: words.map((word) => encodeWord(word, pattern)).join(' '),
        redirects,
      }
    : undefined;
}

function encodeWord(word: ShellWord, pattern: boolean): string {
  // Encode word contents independently of separators and wildcard syntax.
  // UTF-16 units also preserve the tracker's surrogate-escaped file bytes.
  return word.text
    .split('')
    .map((character, index) =>
      pattern && character === '*' && word.bare[index] === '1'
        ? '*'
        : `%${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
    )
    .join('');
}
