/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export type AnsiCode = {
  type: 'ansi';
  code: string;
  endCode: string;
};

export type StyledChar = {
  value: string;
  styles: AnsiCode[];
};

function stylesEqual(left: readonly AnsiCode[], right: readonly AnsiCode[]) {
  return (
    left.length === right.length &&
    left.every(
      (style, index) =>
        style.code === right[index]?.code &&
        style.endCode === right[index]?.endCode,
    )
  );
}

export function tokenize(value: string): StyledChar[] {
  return [...value].map((char) => ({
    value: char,
    styles: [],
  }));
}

export function styledCharsFromTokens(tokens: StyledChar[]): StyledChar[] {
  return tokens;
}

export function diffAnsiCodes(
  from: readonly AnsiCode[],
  to: readonly AnsiCode[],
): AnsiCode[] {
  if (stylesEqual(from, to)) {
    return [];
  }

  const removals = [...from].reverse().map((style) => ({
    type: 'ansi' as const,
    code: style.endCode,
    endCode: '',
  }));
  const additions = to.map((style) => ({
    type: 'ansi' as const,
    code: style.code,
    endCode: style.endCode,
  }));

  return [...removals, ...additions];
}

export function ansiCodesToString(codes: readonly AnsiCode[]): string {
  return codes.map((code) => code.code).join('');
}
