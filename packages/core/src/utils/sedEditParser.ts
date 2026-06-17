/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { parse } from 'shell-quote';
import { getErrorMessage } from './errors.js';

const BRE_OPERATORS = new Set(['+', '?', '|', '(', ')', '{', '}']);
const SIMPLE_REGEX_QUANTIFIERS = new Set(['*', '+', '?']);

export interface SedEditInfo {
  filePath: string;
  pattern: string;
  replacement: string;
  flags: string;
  extendedRegex: boolean;
}

export function parseSedEditCommand(command: string): SedEditInfo | null {
  const trimmed = command.trim();
  const sedMatch = trimmed.match(/^\s*sed\s+/);
  if (!sedMatch) return null;

  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(trimmed.slice(sedMatch[0].length), (key) => `$${key}`);
  } catch {
    return null;
  }

  const args: string[] = [];
  for (const token of parsed) {
    if (typeof token !== 'string') {
      return null;
    }
    args.push(token);
  }

  let hasInPlaceFlag = false;
  let extendedRegex = false;
  let expression: string | null = null;
  let filePath: string | null = null;

  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;

    if (isSafeCombinedFlagArg(arg)) {
      for (const flag of arg.slice(1)) {
        if (flag === 'i') {
          hasInPlaceFlag = true;
        } else {
          extendedRegex = true;
        }
      }
      i++;
      continue;
    }

    if (arg === '-i') {
      hasInPlaceFlag = true;
      i++;
      if (i < args.length) {
        const nextArg = args[i]!;
        if (nextArg === '') {
          i++;
        }
      }
      continue;
    }
    if (arg === '--in-place') {
      hasInPlaceFlag = true;
      i++;
      continue;
    }
    if (arg === '--in-place=') {
      hasInPlaceFlag = true;
      i++;
      continue;
    }
    if (arg.startsWith('-i') || arg.startsWith('--in-place=')) {
      return null;
    }

    if (arg === '-E' || arg === '-r' || arg === '--regexp-extended') {
      extendedRegex = true;
      i++;
      continue;
    }

    if (arg === '-e' || arg === '--expression') {
      if (expression !== null || i + 1 >= args.length) {
        return null;
      }
      expression = args[i + 1]!;
      i += 2;
      continue;
    }
    if (arg.startsWith('--expression=')) {
      if (expression !== null) {
        return null;
      }
      expression = arg.slice('--expression='.length);
      i++;
      continue;
    }

    if (arg.startsWith('-')) {
      return null;
    }

    if (expression === null) {
      expression = arg;
    } else if (filePath === null) {
      filePath = arg;
    } else {
      return null;
    }
    i++;
  }

  if (!hasInPlaceFlag || !expression || !filePath) {
    return null;
  }
  if (hasShellVariableReference(expression)) {
    return null;
  }
  if (filePath.startsWith('~') || filePath.includes('$')) {
    return null;
  }

  const substitution = parseSubstitution(expression);
  if (substitution === null) {
    return null;
  }

  const sedInfo = {
    filePath,
    ...substitution,
    extendedRegex,
  };
  if (!canCompileSedPattern(sedInfo)) {
    return null;
  }
  return sedInfo;
}

function isSafeCombinedFlagArg(arg: string): boolean {
  if (!arg.startsWith('-') || arg.startsWith('--') || arg.length <= 2) {
    return false;
  }
  const flags = arg.slice(1);
  // GNU sed treats everything after -i in a combined flag as the backup suffix:
  // -iE means in-place with .E backup, not -i + -E. Only forms with i last
  // (for example, -Ei/-ri) are safe.
  if (flags.startsWith('i') || !/^[Eri]+$/u.test(flags)) {
    return false;
  }
  return true;
}

function hasShellVariableReference(value: string): boolean {
  return (
    value.includes('`') ||
    /\$(?:[A-Za-z_][A-Za-z0-9_]*|\{|\(|\d|[#?@$!*])/u.test(value)
  );
}

function canCompileSedPattern(sedInfo: SedEditInfo): boolean {
  try {
    const jsPattern = toJavascriptPattern(sedInfo);
    if (
      hasPosixBracketExpression(jsPattern) ||
      hasSedJavascriptDivergentEscape(jsPattern)
    ) {
      return false;
    }
    new RegExp(jsPattern);
    if (
      hasReplacementBackrefBeyondCaptures(
        sedInfo.replacement,
        countCapturingGroups(jsPattern),
      )
    ) {
      return false;
    }
    return !hasUnsafeQuantifiedGroup(jsPattern);
  } catch {
    return false;
  }
}

function hasPosixBracketExpression(pattern: string): boolean {
  return /\[\[:[A-Za-z]+:\]\]/u.test(pattern);
}

function hasSedJavascriptDivergentEscape(pattern: string): boolean {
  return /\\[<>dDwWsS]/u.test(pattern);
}

function hasReplacementBackrefBeyondCaptures(
  replacement: string,
  captureCount: number,
): boolean {
  for (let i = 0; i < replacement.length; i++) {
    if (replacement[i] !== '\\') {
      continue;
    }
    const next = replacement[i + 1];
    if (
      next !== undefined &&
      next >= '1' &&
      next <= '9' &&
      Number(next) > captureCount
    ) {
      return true;
    }
    i++;
  }
  return false;
}

function countCapturingGroups(pattern: string): number {
  let count = 0;

  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === '\\') {
      i++;
      continue;
    }
    if (char === '[') {
      i = skipCharacterClass(pattern, i);
      continue;
    }
    if (char === '(' && pattern[i + 1] !== '?') {
      count++;
    }
  }

  return count;
}

function hasUnsafeQuantifiedGroup(pattern: string): boolean {
  const groups: Array<{ hasAlternation: boolean; hasQuantifier: boolean }> = [];

  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === '\\') {
      i++;
      continue;
    }
    if (char === '[') {
      i = skipCharacterClass(pattern, i);
      continue;
    }
    if (char === '(') {
      groups.push({ hasAlternation: false, hasQuantifier: false });
      continue;
    }
    if (char === '|' && groups.length > 0) {
      groups[groups.length - 1]!.hasAlternation = true;
      continue;
    }
    if (char === ')') {
      const group = groups.pop();
      if (group === undefined) {
        continue;
      }
      const quantifierEnd = getRegexQuantifierEnd(pattern, i + 1);
      if (quantifierEnd !== null) {
        if (group.hasAlternation || group.hasQuantifier) {
          return true;
        }
        if (groups.length > 0) {
          groups[groups.length - 1]!.hasQuantifier = true;
        }
        i = quantifierEnd - 1;
      }
      if (groups.length > 0) {
        const parent = groups[groups.length - 1]!;
        parent.hasAlternation ||= group.hasAlternation;
        parent.hasQuantifier ||= group.hasQuantifier;
      }
      continue;
    }

    const quantifierEnd = getRegexQuantifierEnd(pattern, i);
    if (quantifierEnd !== null) {
      if (groups.length > 0) {
        groups[groups.length - 1]!.hasQuantifier = true;
      }
      i = quantifierEnd - 1;
    }
  }

  return false;
}

function skipCharacterClass(pattern: string, start: number): number {
  for (let i = start + 1; i < pattern.length; i++) {
    if (pattern[i] === '\\') {
      i++;
      continue;
    }
    if (pattern[i] === ']') {
      return i;
    }
  }
  return pattern.length - 1;
}

function getRegexQuantifierEnd(pattern: string, start: number): number | null {
  const char = pattern[start];
  if (char === undefined) {
    return null;
  }
  if (SIMPLE_REGEX_QUANTIFIERS.has(char)) {
    return start + 1;
  }
  if (char !== '{') {
    return null;
  }

  let i = start + 1;
  let hasDigit = false;
  while (isAsciiDigit(pattern[i])) {
    hasDigit = true;
    i++;
  }
  if (!hasDigit) {
    return null;
  }
  if (pattern[i] === ',') {
    i++;
    while (isAsciiDigit(pattern[i])) {
      i++;
    }
  }
  return pattern[i] === '}' ? i + 1 : null;
}

function isAsciiDigit(char: string | undefined): boolean {
  return char !== undefined && char >= '0' && char <= '9';
}

function parseSubstitution(
  expression: string,
): Pick<SedEditInfo, 'pattern' | 'replacement' | 'flags'> | null {
  if (/[\r\n]/.test(expression)) {
    return null;
  }
  if (!expression.startsWith('s/')) {
    return null;
  }

  const rest = expression.slice(2);
  let pattern = '';
  let replacement = '';
  let flags = '';
  let state: 'pattern' | 'replacement' | 'flags' = 'pattern';

  for (let i = 0; i < rest.length; i++) {
    const char = rest[i]!;
    if (char === '\\' && i + 1 < rest.length) {
      const escaped = char + rest[i + 1]!;
      if (state === 'pattern') {
        pattern += escaped;
      } else if (state === 'replacement') {
        replacement += escaped;
      } else {
        flags += escaped;
      }
      i++;
      continue;
    }

    if (char === '/') {
      if (state === 'pattern') {
        state = 'replacement';
      } else if (state === 'replacement') {
        state = 'flags';
      } else {
        return null;
      }
      continue;
    }

    if (state === 'pattern') {
      pattern += char;
    } else if (state === 'replacement') {
      replacement += char;
    } else {
      flags += char;
    }
  }

  if (
    !pattern ||
    state !== 'flags' ||
    !isSupportedFlags(flags) ||
    hasUnsupportedReplacementEscape(replacement)
  ) {
    return null;
  }

  return { pattern, replacement, flags };
}

function isSupportedFlags(flags: string): boolean {
  if (!/^[g0-9]*$/.test(flags)) {
    return false;
  }

  const digitRuns = flags.match(/\d+/g) ?? [];
  if (digitRuns.length > 1) {
    return false;
  }
  if (digitRuns.length === 0) {
    return true;
  }
  return /^[1-9][0-9]*$/.test(digitRuns[0]!);
}

function hasUnsupportedReplacementEscape(replacement: string): boolean {
  for (let i = 0; i < replacement.length; i++) {
    if (replacement[i] !== '\\') {
      continue;
    }
    const next = replacement[i + 1];
    if (next === undefined || !/[\\/&1-9]/.test(next)) {
      return true;
    }
    i++;
  }
  return false;
}

export function applySedSubstitution(
  content: string,
  sedInfo: SedEditInfo,
): string {
  if (content.length === 0) {
    return '';
  }

  const jsPattern = toJavascriptPattern(sedInfo);
  const occurrence = getOccurrence(sedInfo.flags);
  const replaceAll = sedInfo.flags.includes('g');

  try {
    const regex = new RegExp(jsPattern);
    const globalRegex = new RegExp(
      regex.source,
      regex.flags.includes('g') ? regex.flags : `${regex.flags}g`,
    );
    const parts = content.split(/(\n)/);
    const processableParts = content.endsWith('\n')
      ? parts.slice(0, -1)
      : parts;
    return processableParts
      .map((part, index) => {
        if (index % 2 === 1) {
          return part;
        }
        return replaceLine(part, globalRegex, sedInfo.replacement, {
          occurrence,
          replaceAll,
        });
      })
      .join('');
  } catch (err) {
    throw new Error(`sed pattern simulation failed: ${getErrorMessage(err)}`);
  }
}

function toJavascriptPattern(sedInfo: SedEditInfo): string {
  const pattern = unescapeSedDelimiter(sedInfo.pattern);

  if (sedInfo.extendedRegex) {
    return pattern;
  }

  let jsPattern = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === '\\' && i + 1 < pattern.length) {
      const next = pattern[i + 1]!;
      if (BRE_OPERATORS.has(next)) {
        jsPattern += next;
      } else if (next === '\\') {
        jsPattern += '\\\\';
      } else {
        jsPattern += char + next;
      }
      i++;
      continue;
    }

    jsPattern += BRE_OPERATORS.has(char) ? `\\${char}` : char;
  }
  return jsPattern;
}

function unescapeSedDelimiter(pattern: string): string {
  let result = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === '\\' && pattern[i + 1] === '/') {
      result += '/';
      i++;
      continue;
    }
    result += char;
  }
  return result;
}

function getOccurrence(flags: string): number | null {
  const match = flags.match(/[1-9][0-9]*/);
  return match ? Number(match[0]) : null;
}

function replaceLine(
  line: string,
  globalRegex: RegExp,
  replacement: string,
  options: {
    occurrence: number | null;
    replaceAll: boolean;
  },
): string {
  let seen = 0;
  let lastMatchWasNonEmpty = false;
  let lastMatchEnd = -1;
  globalRegex.lastIndex = 0;

  return line.replace(globalRegex, (...args: unknown[]) => {
    const match = String(args[0]);
    const offset = Number(args[args.length - 2]);
    if (
      match.length === 0 &&
      offset === lastMatchEnd &&
      seen > 0 &&
      lastMatchWasNonEmpty
    ) {
      return '';
    }

    seen++;
    lastMatchWasNonEmpty = match.length > 0;
    lastMatchEnd = offset + match.length;
    const shouldReplace =
      options.occurrence === null
        ? options.replaceAll || seen === 1
        : options.replaceAll
          ? seen >= options.occurrence
          : seen === options.occurrence;
    if (!shouldReplace) {
      return String(args[0]);
    }

    const captures = args
      .slice(1, -2)
      .map((value) => (value === undefined ? '' : String(value)));
    return buildReplacement(match, captures, replacement);
  });
}

function buildReplacement(
  match: string,
  captures: readonly string[],
  replacement: string,
): string {
  let result = '';
  for (let i = 0; i < replacement.length; i++) {
    const char = replacement[i]!;
    if (char === '\\' && i + 1 < replacement.length) {
      const next = replacement[i + 1]!;
      if (next === '/') {
        result += '/';
      } else if (next === '&') {
        result += '&';
      } else if (next === '\\') {
        result += '\\';
      } else if (next >= '1' && next <= '9') {
        result += captures[Number(next) - 1] ?? '';
      } else {
        result += char + next;
      }
      i++;
      continue;
    }

    result += char === '&' ? match : char;
  }
  return result;
}
