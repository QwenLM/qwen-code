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
  // sed treats everything after -i in a combined flag as the backup suffix:
  // -iE means in-place with an .E backup, not -i + -E. Only forms with i last
  // (for example, -Ei/-ri) are safe.
  //
  // Testing `startsWith('i')` only rejected i FIRST, not i anywhere but last,
  // so -Eir and -riE were accepted. Real sed reads those as -E plus in-place
  // with the backup suffix `r` / `E`, writing an f.txtr or f.txtE alongside
  // the edit. The simulation creates no backup, so the user asked for one and
  // silently did not get it -- the same reason `-i.bak` is already declined a
  // few lines up, just spelled as a combined flag.
  if (!/^[Er]*i?$/u.test(flags)) {
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
      hasLeadingBracketLiteral(jsPattern) ||
      hasSedJavascriptDivergentEscape(jsPattern) ||
      hasBracketCharacterEscape(sedInfo.pattern)
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
    return !(
      hasUnsafeQuantifiedGroup(jsPattern) ||
      hasLiveAnchorInAlternation(jsPattern) ||
      hasAmbiguousAlternation(jsPattern)
    );
  } catch {
    return false;
  }
}

function hasPosixBracketExpression(pattern: string): boolean {
  return /\[\[:[A-Za-z]+:\]\]/u.test(pattern);
}

/**
 * `]` immediately after `[` or `[^` is a literal member of a POSIX bracket
 * expression, but means something else entirely in JavaScript: `[]` is an
 * empty class that matches nothing, and `[^]` matches ANY character. So
 * `s/[]a]/X/g` silently does nothing, and `s/[^]]/X/g` on `a]b` writes `Xb`
 * where sed writes `X]X` -- a byte deleted from the user's file.
 *
 * Since these edits are simulated and written to disk rather than handed to
 * sed, declining is the safe answer: the command then runs as the real sed
 * and behaves exactly as asked. That is already what this parser does for
 * the other constructs it cannot translate faithfully -- see
 * `hasPosixBracketExpression` above.
 *
 * The test is deliberately blunt and matches the byte sequence anywhere, so
 * a pattern such as `[a[]]` (a class containing `[`, which would in fact
 * translate correctly) is declined too. Erring toward the real sed costs
 * nothing but a fast path; erring the other way rewrites a file wrongly.
 */
function hasLeadingBracketLiteral(pattern: string): boolean {
  return /\[\^?\]/u.test(pattern);
}

function hasSedJavascriptDivergentEscape(pattern: string): boolean {
  return /\\[<>dDwWsS]/u.test(pattern);
}

/**
 * True when a bracket expression holds a character escape such as `\t`,
 * `\n` or `\x41`. GNU sed expands these, so `[ \t]` is a space or a TAB;
 * POSIX reads a backslash and a `t`, as the translation does. The seds
 * disagree, so the caller declines the pattern and real sed runs it.
 */
function hasBracketCharacterEscape(pattern: string): boolean {
  let inCharacterClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === '\\') {
      const next = pattern[i + 1] ?? '';
      if (inCharacterClass && /[ntrfvadoxc]/u.test(next)) {
        return true;
      }
      // Inside a bracket only `\\` pairs up, so `[\\t]` ends in a plain `t`.
      if (!inCharacterClass || next === '\\') {
        i++;
      }
      continue;
    }
    if (char === '[') {
      inCharacterClass = true;
    } else if (char === ']') {
      inCharacterClass = false;
    }
  }
  return false;
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

// A live ^ or $ on one alternative, or nested inside one, disagrees with
// POSIX (`^a|ab` on "ab" is "Xb" in JavaScript and "X" in GNU sed). Anchors
// that merely sit outside a group are not decided here.
function hasLiveAnchorInAlternation(pattern: string): boolean {
  const levels: Array<{ hasAnchor: boolean; hasAlternation: boolean }> = [
    { hasAnchor: false, hasAlternation: false },
  ];

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
    const level = levels[levels.length - 1]!;
    if (char === '(') {
      levels.push({ hasAnchor: false, hasAlternation: false });
      continue;
    }
    if (char === ')') {
      if (levels.length === 1) {
        continue;
      }
      const group = levels.pop()!;
      if (group.hasAnchor && group.hasAlternation) {
        return true;
      }
      // A nested group is part of its parent's branch, so an anchor inside it
      // counts at the parent too (`((^a)|ab)`).
      levels[levels.length - 1]!.hasAnchor ||= group.hasAnchor;
      continue;
    }
    if (char === '|') {
      level.hasAlternation = true;
      continue;
    }
    if (char === '^' || char === '$') {
      level.hasAnchor = true;
    }
  }

  return levels.some((level) => level.hasAnchor && level.hasAlternation);
}

// True when some `|` can match different text in JavaScript (leftmost-first)
// than in POSIX sed (leftmost-longest). An alternation is safe only when
// every branch is a non-empty fixed-length run of the same length, or every
// branch starts with a different literal character that cannot be skipped.
// An empty branch is always ambiguous. Declining runs real sed.
function hasAmbiguousAlternation(pattern: string): boolean {
  return spanHasAmbiguousAlternation(pattern, 0, pattern.length);
}

function spanHasAmbiguousAlternation(
  pattern: string,
  start: number,
  end: number,
): boolean {
  const branches: Array<{ start: number; end: number }> = [];
  const groups: Array<{ start: number; end: number }> = [];
  let branchStart = start;
  let sawPipe = false;

  for (let i = start; i < end; i++) {
    const char = pattern[i]!;
    if (char === '\\') {
      i++;
      continue;
    }
    if (char === '[') {
      const close = skipCharacterClass(pattern, i);
      if (close >= end || pattern[close] !== ']') {
        return true;
      }
      i = close;
      continue;
    }
    if (char === '(') {
      const close = findMatchingParen(pattern, i);
      if (close === null || close >= end) {
        return true;
      }
      const contentStart = indexAfterGroupOpen(pattern, i);
      if (contentStart > close) {
        return true;
      }
      groups.push({ start: contentStart, end: close });
      i = close;
      continue;
    }
    if (char === '|') {
      sawPipe = true;
      branches.push({ start: branchStart, end: i });
      branchStart = i + 1;
    }
  }

  if (sawPipe) {
    branches.push({ start: branchStart, end });
    if (branchesAreAmbiguous(pattern, branches)) {
      return true;
    }
  }
  return groups.some((group) =>
    spanHasAmbiguousAlternation(pattern, group.start, group.end),
  );
}

function branchesAreAmbiguous(
  pattern: string,
  branches: ReadonlyArray<{ start: number; end: number }>,
): boolean {
  if (branchesHaveSameFixedLength(pattern, branches)) {
    return false;
  }
  return !branchesHaveDistinctLeadingLiterals(pattern, branches);
}

function branchesHaveSameFixedLength(
  pattern: string,
  branches: ReadonlyArray<{ start: number; end: number }>,
): boolean {
  let expected: number | null = null;
  for (const branch of branches) {
    const length = fixedBranchLength(pattern, branch.start, branch.end);
    if (length === null) {
      return false;
    }
    if (expected === null) {
      expected = length;
    } else if (length !== expected) {
      return false;
    }
  }
  return expected !== null;
}

function branchesHaveDistinctLeadingLiterals(
  pattern: string,
  branches: ReadonlyArray<{ start: number; end: number }>,
): boolean {
  const seen = new Set<string>();
  for (const branch of branches) {
    const literal = leadingPlainLiteral(pattern, branch.start, branch.end);
    if (literal === null || seen.has(literal)) {
      return false;
    }
    seen.add(literal);
  }
  return true;
}

// Length in characters consumed, or null when the branch is empty, optional,
// quantified, or contains a group. `^` and `$` add no length.
function fixedBranchLength(
  pattern: string,
  start: number,
  end: number,
): number | null {
  if (start >= end) {
    return null;
  }
  let length = 0;
  for (let i = start; i < end; i++) {
    const char = pattern[i]!;
    if (char === '\\') {
      const esc = pattern[i + 1];
      if (esc === undefined || i + 1 >= end) {
        return null;
      }
      const kind = classifyEscape(esc);
      if (kind === 'reject') {
        return null;
      }
      if (kind !== 'zero') {
        length++;
      }
      i++;
      continue;
    }
    if (char === '[') {
      const close = skipCharacterClass(pattern, i);
      if (pattern[close] !== ']' || close >= end) {
        return null;
      }
      length++;
      i = close;
      continue;
    }
    if (char === '^' || char === '$') {
      continue;
    }
    if ('()*+?|'.includes(char)) {
      return null;
    }
    if (char === '{') {
      const bounds = readBraceQuantifierBounds(pattern, i);
      if (bounds !== null && bounds.end <= end) {
        return null;
      }
    }
    length++;
  }
  return length > 0 ? length : null;
}

function leadingPlainLiteral(
  pattern: string,
  start: number,
  end: number,
): string | null {
  if (start >= end) {
    return null;
  }
  const char = pattern[start]!;
  let literal: string;
  let next: number;
  if (char === '\\') {
    const esc = pattern[start + 1];
    if (
      esc === undefined ||
      start + 1 >= end ||
      classifyEscape(esc) !== 'literal'
    ) {
      return null;
    }
    literal = escapedLiteralValue(esc);
    next = start + 2;
  } else if (isPlainLiteralChar(char)) {
    literal = char;
    next = start + 1;
  } else {
    return null;
  }
  if (followedByZeroQuantifier(pattern, next, end)) {
    return null;
  }
  return literal;
}

function isPlainLiteralChar(char: string): boolean {
  return !'^$.*+?()[|\\'.includes(char);
}

function followedByZeroQuantifier(
  pattern: string,
  index: number,
  end: number,
): boolean {
  if (index >= end) {
    return false;
  }
  const char = pattern[index]!;
  if (char === '*' || char === '?') {
    return true;
  }
  if (char !== '{') {
    return false;
  }
  const bounds = readBraceQuantifierBounds(pattern, index);
  if (bounds === null || bounds.end > end) {
    return false;
  }
  return bounds.min === 0;
}

function classifyEscape(esc: string): 'literal' | 'class' | 'zero' | 'reject' {
  if ('dDwWsS'.includes(esc)) {
    return 'class';
  }
  if (esc === 'b' || esc === 'B') {
    return 'zero';
  }
  if ('xuc'.includes(esc) || (esc >= '0' && esc <= '9')) {
    return 'reject';
  }
  return 'literal';
}

function escapedLiteralValue(esc: string): string {
  switch (esc) {
    case 'n':
      return '\n';
    case 'r':
      return '\r';
    case 't':
      return '\t';
    case 'f':
      return '\f';
    case 'v':
      return '\v';
    default:
      return esc;
  }
}

// `(?:`, `(?=`, and `(?<name>` are group syntax, not a `?` quantifier. The
// same `(?` exception countCapturingGroups uses when it does not count them.
function indexAfterGroupOpen(pattern: string, open: number): number {
  if (pattern[open + 1] !== '?') {
    return open + 1;
  }
  let i = open + 2;
  const kind = pattern[i];
  if (kind === ':' || kind === '=' || kind === '!') {
    return i + 1;
  }
  if (kind === '<') {
    const next = pattern[i + 1];
    if (next === '=' || next === '!') {
      return i + 2;
    }
    while (i < pattern.length && pattern[i] !== '>') {
      i++;
    }
    return i < pattern.length ? i + 1 : pattern.length;
  }
  while (i < pattern.length && /[a-zA-Z-]/u.test(pattern[i]!)) {
    i++;
  }
  if (pattern[i] === ':') {
    return i + 1;
  }
  return open + 2;
}

function findMatchingParen(pattern: string, open: number): number | null {
  let depth = 0;
  for (let i = open; i < pattern.length; i++) {
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
      depth++;
      continue;
    }
    if (char === ')') {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return null;
}

function hasUnsafeQuantifiedGroup(pattern: string): boolean {
  const groups: Array<{
    hasAlternation: boolean;
    hasQuantifier: boolean;
    hasAnchor: boolean;
  }> = [];

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
      groups.push({
        hasAlternation: false,
        hasQuantifier: false,
        hasAnchor: false,
      });
      continue;
    }
    if (char === '|' && groups.length > 0) {
      groups[groups.length - 1]!.hasAlternation = true;
      continue;
    }
    if ((char === '^' || char === '$') && groups.length > 0) {
      groups[groups.length - 1]!.hasAnchor = true;
    }
    if (char === ')') {
      const group = groups.pop();
      if (group === undefined) {
        continue;
      }
      const quantifierEnd = getRegexQuantifierEnd(pattern, i + 1);
      if (quantifierEnd !== null) {
        if (
          group.hasAlternation ||
          group.hasQuantifier ||
          (group.hasAnchor && isUnsafeAnchoredGroupQuantifier(pattern, i + 1))
        ) {
          return true;
        }
        // A zero-capable quantifier on an anchored group, then another
        // quantifier or alternation, is leftmost-longest in GNU sed and a
        // shorter match in JavaScript. Decline and let real sed run.
        if (
          group.hasAnchor &&
          quantifierAllowsZero(pattern, i + 1) &&
          restHasQuantifierOrAlternation(pattern, quantifierEnd)
        ) {
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
        parent.hasAnchor ||= group.hasAnchor;
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

// `+` (\+ in BRE) and `{1,}` repeat an anchored group and do not match GNU
// sed: sed drops the match, JavaScript keeps a shorter one. `{0,}` is the
// same shape as `*` and matches sed when no quantifier or alternation
// follows, so those stay simulated. `{n,}` for n >= 2 cannot repeat an
// anchored group; sed and JavaScript both leave it unmatched. A finite
// interval with min <= 1 and max >= 2 (`{0,2}`, `{1,2}`) also diverges.
// Intervals with no anchor are not touched.
function isUnsafeAnchoredGroupQuantifier(
  pattern: string,
  start: number,
): boolean {
  if (pattern[start] === '+') {
    return true;
  }
  const bounds = readBraceQuantifierBounds(pattern, start);
  if (bounds === null) {
    return false;
  }
  // `{0,}` is safe. `{1,}` is not. `{2,}` and above stay simulated.
  if (bounds.max === null) {
    return bounds.min === 1;
  }
  return bounds.min <= 1 && bounds.max >= 2;
}

// `*`, `?` (\? in BRE), `{0,n}`, and `{0,}` can match empty.
function quantifierAllowsZero(pattern: string, start: number): boolean {
  const char = pattern[start];
  if (char === '*' || char === '?') {
    return true;
  }
  const bounds = readBraceQuantifierBounds(pattern, start);
  return bounds !== null && bounds.min === 0;
}

function restHasQuantifierOrAlternation(
  pattern: string,
  start: number,
): boolean {
  for (let i = start; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === '\\') {
      i++;
      continue;
    }
    if (char === '[') {
      i = skipCharacterClass(pattern, i);
      continue;
    }
    if (char === '*' || char === '+' || char === '?' || char === '|') {
      return true;
    }
    if (char === '{' && readBraceQuantifierBounds(pattern, i) !== null) {
      return true;
    }
  }
  return false;
}

function readBraceQuantifierBounds(
  pattern: string,
  start: number,
): { min: number; max: number | null; end: number } | null {
  if (pattern[start] !== '{') {
    return null;
  }
  let i = start + 1;
  const minStart = i;
  while (isAsciiDigit(pattern[i])) {
    i++;
  }
  if (i === minStart) {
    return null;
  }
  const min = Number(pattern.slice(minStart, i));
  let max: number | null = min;
  if (pattern[i] === ',') {
    i++;
    const maxStart = i;
    while (isAsciiDigit(pattern[i])) {
      i++;
    }
    max = i === maxStart ? null : Number(pattern.slice(maxStart, i));
  }
  if (pattern[i] !== '}') {
    return null;
  }
  return { min, max, end: i + 1 };
}

function getRegexQuantifierEnd(pattern: string, start: number): number | null {
  const char = pattern[start];
  if (char !== undefined && SIMPLE_REGEX_QUANTIFIERS.has(char)) {
    return start + 1;
  }
  const bounds = readBraceQuantifierBounds(pattern, start);
  return bounds === null ? null : bounds.end;
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
    const globalRegex = new RegExp(jsPattern, 'g');
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

  let jsPattern = '';
  let inCharacterClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (inCharacterClass) {
      // A backslash inside a bracket expression is a literal member in BRE
      // and ERE alike, not an escape as in JS.
      if (char === '\\') {
        jsPattern += '\\\\';
        continue;
      }
      if (char === ']') {
        inCharacterClass = false;
      }
      jsPattern += char;
      continue;
    }

    if (char === '[') {
      inCharacterClass = true;
      jsPattern += char;
      continue;
    }

    if (sedInfo.extendedRegex) {
      if (char === '\\' && i + 1 < pattern.length) {
        jsPattern += char + pattern[i + 1]!;
        i++;
      } else {
        jsPattern += char;
      }
      continue;
    }

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

    // Escaping every non-initial ^/$ made s/\(^foo$\)/ look for the literal
    // characters ^foo$. GNU sed still anchors at those group and \| boundaries.
    if (char === '^' && !isBreCaretAnchor(pattern, i)) {
      jsPattern += '\\^';
      continue;
    }
    if (char === '$' && !isBreDollarAnchor(pattern, i)) {
      jsPattern += '\\$';
      continue;
    }

    jsPattern += BRE_OPERATORS.has(char) ? `\\${char}` : char;
  }
  return jsPattern;
}

function hasOddBackslashRun(pattern: string, index: number): boolean {
  let count = 0;
  for (let j = index; j >= 0 && pattern[j] === '\\'; j--) {
    count++;
  }
  return count % 2 === 1;
}

// BRE anchors ^ at the start of the expression and immediately after \( or \|.
// $ anchors at the end of the pattern, before \) or \|, and before a raw )
// or | that is not the pattern's last character. A final raw ) or | leaves
// $ literal. An even run of backslashes is a literal \, so \\(^ is not a
// group and $\\b keeps $ literal.
function isBreCaretAnchor(pattern: string, index: number): boolean {
  if (index === 0) {
    return true;
  }
  const prev = pattern[index - 1];
  if (index < 2 || (prev !== '(' && prev !== '|')) {
    return false;
  }
  return hasOddBackslashRun(pattern, index - 2);
}

function isBreDollarAnchor(pattern: string, index: number): boolean {
  if (index === pattern.length - 1) {
    return true;
  }
  const next = pattern[index + 1];
  if (next === '\\') {
    const marker = pattern[index + 2];
    return marker === ')' || marker === '|';
  }
  return (next === ')' || next === '|') && index + 1 < pattern.length - 1;
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
