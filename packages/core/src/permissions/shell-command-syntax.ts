/**
 * @license
 * Copyright 2025 Qwen team
 * SPDX-License-Identifier: Apache-2.0
 */

import { tokenizeShellWords } from '../utils/shell-word-tokenizer.js';
import { stripShellCommandPrefixes } from '../utils/shell-utils.js';
import { SHELL_ASSIGNMENT_PREFIX } from '../utils/shell-command-prefixes.js';
import { ShellCommentContext } from '../utils/shell-comment-context.js';

/** Remove Bash continuations without changing literal single-quoted text. */
export function removeShellLineContinuations(command: string): string {
  let result = '';
  let quote = '';
  let pendingDollar = false;
  const comments = new ShellCommentContext();
  for (let index = 0; index < command.length; index++) {
    const character = command[index]!;
    const afterDollar: boolean = pendingDollar;
    pendingDollar = false;
    const comment = comments.read(
      command,
      index,
      quote === "'" || quote === "$'",
      quote === '"',
    );
    if (comment) {
      result += command.slice(index, comment.end + 1);
      index = comment.end;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      if (command[index + 1] === '\n' && quote !== "$'") {
        pendingDollar = afterDollar;
        index++;
        continue;
      }
      result += character;
      if (index + 1 < command.length) result += command[++index];
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

/** Shared cwd invalidation for the Bash matcher and virtual-operation tracker. */
export function shellCommandMayChangeCwd(command: string): boolean {
  const unprefixed = stripShellCommandPrefixes(command) ?? command;
  let first = staticShellCommand(unprefixed)?.words.split(' ')[0];
  if (!first) {
    const bares: string[] = [];
    const expansions = new Set<number>();
    const tokens = tokenizeShellWords(
      unprefixed,
      undefined,
      undefined,
      bares,
      true,
      expansions,
    );
    const dynamic = tokens.findIndex((_, index) => expansions.has(index));
    // Only the static prefix can identify the executable. Keep the original
    // redirect and quote markings when an argument after it expands.
    const prefix = tokens
      .slice(0, dynamic < 0 ? tokens.length : dynamic)
      .map(
        (word, index) =>
          word
            .split('')
            .map((character, offset) =>
              bares[index]![offset] === '1'
                ? character
                : `'${character.replaceAll("'", "'\\''")}'`,
            )
            .join('') || "''",
      )
      .join(' ');
    first = staticShellCommand(prefix)?.words.split(' ')[0];
  }
  const name = first?.replace(/%([0-9a-f]{4})/g, (_, unit: string) =>
    String.fromCharCode(Number.parseInt(unit, 16)),
  );
  return (
    name === undefined || ['cd', 'pushd', 'popd', 'source', '.'].includes(name)
  );
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
  cwd?: string,
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
  const pieces: Array<ShellWord | { operator: string; descriptor?: string }> =
    [];
  for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex++) {
    const text = tokens[tokenIndex]!;
    const bare = bares[tokenIndex]!;
    const hasExpansion = expansions.has(tokenIndex);
    let start = 0;
    for (let index = 0; index < text.length; index++) {
      if (bare[index] !== '1') continue;
      const character = text[index]!;
      if (';|(){}\n'.includes(character)) return undefined;
      if (character === '&' && text[index + 1] !== '>') return undefined;
      if (!'<>&'.includes(character)) continue;
      const prefix = text.slice(start, index);
      const prefixBare = bare.slice(start, index);
      const previous = pieces[pieces.length - 1];
      const awaitingTarget =
        previous && 'operator' in previous && !previous.operator.endsWith('&-');
      const descriptor =
        !awaitingTarget && /^\d+$/.test(prefix) && /^1+$/.test(prefixBare)
          ? prefix
          : undefined;
      if (prefix && descriptor === undefined) {
        pieces.push({ text: prefix, bare: prefixBare, hasExpansion });
      }
      const syntax = text
        .slice(index, index + 3)
        .split('')
        .map((char, offset) => (bare[index + offset] === '1' ? char : '\0'))
        .join('');
      const operator = /^(?:&>>?|>>|>\||<>|[<>]&-|[<>]&|>|<)/.exec(syntax)?.[0];
      if (!operator || syntax.startsWith('<<')) return undefined;
      pieces.push({ operator, descriptor });
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
      if (piece.operator.endsWith('&-')) continue;
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
        if (/^(?:\d+-?|-)$/.test(target.text)) continue;
        if (
          piece.operator !== '>&' ||
          (piece.descriptor !== undefined && piece.descriptor !== '1')
        ) {
          return undefined;
        }
      }
      redirects.push({
        kind:
          piece.operator === '<>'
            ? 'readwrite'
            : piece.operator === '<'
              ? 'read'
              : 'write',
        target: encodeWord(normalizeRedirectTarget(target, cwd), pattern),
      });
    } else {
      // Only unquoted prefix assignments and negation are syntax.
      if (
        words.length === 0 &&
        ((piece.text === '!' && piece.bare === '1') ||
          (SHELL_ASSIGNMENT_PREFIX.test(piece.text) &&
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

function normalizeRedirectTarget(word: ShellWord, cwd?: string): ShellWord {
  if (!word.text || (word.text[0] === '~' && word.bare[0] === '1')) return word;
  let { text, bare } = word;
  if (
    cwd?.startsWith('/') &&
    !text.startsWith('/') &&
    // A leading rule wildcard may already match an absolute path.
    !(text[0] === '*' && bare[0] === '1')
  ) {
    const directory = cwd.endsWith('/') ? cwd : `${cwd}/`;
    text = directory + text;
    bare = '0'.repeat(directory.length) + bare;
  }
  // Resolving ".." lexically can change a target after a symlink component.
  const components = [...text.matchAll(/[^/]+/g)].filter(
    ([component]) => component !== '.',
  );
  const prefix =
    text.startsWith('//') && !text.startsWith('///')
      ? '//'
      : text.startsWith('/')
        ? '/'
        : '';
  const suffix = text.endsWith('/') && components.length > 0 ? '/' : '';
  return {
    ...word,
    text:
      (prefix + components.map(([component]) => component).join('/') || '.') +
      suffix,
    bare:
      ('0'.repeat(prefix.length) +
        components
          .map((match) =>
            bare.slice(match.index, match.index + match[0].length),
          )
          .join('0') || '0') + (suffix ? '0' : ''),
  };
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
