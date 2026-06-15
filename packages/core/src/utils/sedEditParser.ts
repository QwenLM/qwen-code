/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { parse } from 'shell-quote';

const BACKSLASH_PLACEHOLDER = '\x00BACKSLASH\x00';
const PLUS_PLACEHOLDER = '\x00PLUS\x00';
const QUESTION_PLACEHOLDER = '\x00QUESTION\x00';
const PIPE_PLACEHOLDER = '\x00PIPE\x00';
const LPAREN_PLACEHOLDER = '\x00LPAREN\x00';
const RPAREN_PLACEHOLDER = '\x00RPAREN\x00';
const LBRACE_PLACEHOLDER = '\x00LBRACE\x00';
const RBRACE_PLACEHOLDER = '\x00RBRACE\x00';
const ESCAPED_AMPERSAND_PLACEHOLDER = '\x00ESCAPED_AMPERSAND\x00';
const ESCAPED_BACKSLASH_PLACEHOLDER = '\x00ESCAPED_BACKSLASH\x00';

const BACKSLASH_PLACEHOLDER_RE = new RegExp(BACKSLASH_PLACEHOLDER, 'g');
const PLUS_PLACEHOLDER_RE = new RegExp(PLUS_PLACEHOLDER, 'g');
const QUESTION_PLACEHOLDER_RE = new RegExp(QUESTION_PLACEHOLDER, 'g');
const PIPE_PLACEHOLDER_RE = new RegExp(PIPE_PLACEHOLDER, 'g');
const LPAREN_PLACEHOLDER_RE = new RegExp(LPAREN_PLACEHOLDER, 'g');
const RPAREN_PLACEHOLDER_RE = new RegExp(RPAREN_PLACEHOLDER, 'g');
const LBRACE_PLACEHOLDER_RE = new RegExp(LBRACE_PLACEHOLDER, 'g');
const RBRACE_PLACEHOLDER_RE = new RegExp(RBRACE_PLACEHOLDER, 'g');
const ESCAPED_AMPERSAND_PLACEHOLDER_RE = new RegExp(
  ESCAPED_AMPERSAND_PLACEHOLDER,
  'g',
);
const ESCAPED_BACKSLASH_PLACEHOLDER_RE = new RegExp(
  ESCAPED_BACKSLASH_PLACEHOLDER,
  'g',
);

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

    if (arg === '-i' || arg === '--in-place') {
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

function hasShellVariableReference(value: string): boolean {
  return /\$(?:[A-Za-z_][A-Za-z0-9_]*|\{|\d|[#?@$!*])/u.test(value);
}

function canCompileSedPattern(sedInfo: SedEditInfo): boolean {
  try {
    new RegExp(toJavascriptPattern(sedInfo));
    return true;
  } catch {
    return false;
  }
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
  const jsPattern = toJavascriptPattern(sedInfo);
  const occurrence = getOccurrence(sedInfo.flags);
  const replaceAll = sedInfo.flags.includes('g');

  try {
    const regex = new RegExp(jsPattern);
    return content
      .split(/(\r?\n)/)
      .map((part, index) => {
        if (index % 2 === 1) {
          return part;
        }
        return replaceLine(part, regex, sedInfo.replacement, {
          occurrence,
          replaceAll,
        });
      })
      .join('');
  } catch {
    return content;
  }
}

function toJavascriptPattern(sedInfo: SedEditInfo): string {
  let jsPattern = sedInfo.pattern.replace(/\\\//g, '/');

  if (!sedInfo.extendedRegex) {
    jsPattern = jsPattern
      .replace(/\\\\/g, BACKSLASH_PLACEHOLDER)
      .replace(/\\\+/g, PLUS_PLACEHOLDER)
      .replace(/\\\?/g, QUESTION_PLACEHOLDER)
      .replace(/\\\|/g, PIPE_PLACEHOLDER)
      .replace(/\\\(/g, LPAREN_PLACEHOLDER)
      .replace(/\\\)/g, RPAREN_PLACEHOLDER)
      .replace(/\\\{/g, LBRACE_PLACEHOLDER)
      .replace(/\\\}/g, RBRACE_PLACEHOLDER)
      .replace(/\+/g, '\\+')
      .replace(/\?/g, '\\?')
      .replace(/\|/g, '\\|')
      .replace(/\(/g, '\\(')
      .replace(/\)/g, '\\)')
      .replace(/\{/g, '\\{')
      .replace(/\}/g, '\\}')
      .replace(BACKSLASH_PLACEHOLDER_RE, '\\\\')
      .replace(PLUS_PLACEHOLDER_RE, '+')
      .replace(QUESTION_PLACEHOLDER_RE, '?')
      .replace(PIPE_PLACEHOLDER_RE, '|')
      .replace(LPAREN_PLACEHOLDER_RE, '(')
      .replace(RPAREN_PLACEHOLDER_RE, ')')
      .replace(LBRACE_PLACEHOLDER_RE, '{')
      .replace(RBRACE_PLACEHOLDER_RE, '}');
  }

  return jsPattern;
}

function getOccurrence(flags: string): number | null {
  const match = flags.match(/[1-9][0-9]*/);
  return match ? Number(match[0]) : null;
}

function replaceLine(
  line: string,
  regex: RegExp,
  replacement: string,
  options: {
    occurrence: number | null;
    replaceAll: boolean;
  },
): string {
  if (line === '') {
    return line;
  }

  let seen = 0;
  const globalRegex = new RegExp(
    regex.source,
    regex.flags.includes('g') ? regex.flags : `${regex.flags}g`,
  );

  return line.replace(globalRegex, (...args: unknown[]) => {
    seen++;
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
    return buildReplacement(String(args[0]), captures, replacement);
  });
}

function buildReplacement(
  match: string,
  captures: readonly string[],
  replacement: string,
): string {
  let prepared = replacement
    .replace(/\\\//g, '/')
    .replace(/\\\\/g, ESCAPED_BACKSLASH_PLACEHOLDER)
    .replace(/\\&/g, ESCAPED_AMPERSAND_PLACEHOLDER);

  prepared = prepared.replace(/\\([1-9])/g, (_match, digit: string) => {
    return captures[Number(digit) - 1] ?? '';
  });

  return prepared
    .replace(/&/g, match)
    .replace(ESCAPED_AMPERSAND_PLACEHOLDER_RE, '&')
    .replace(ESCAPED_BACKSLASH_PLACEHOLDER_RE, '\\');
}
