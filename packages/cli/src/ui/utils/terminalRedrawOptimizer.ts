/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

const ESC = '\u001B[';
const ERASE_LINE = `${ESC}2K`;
const CURSOR_UP_ONE = `${ESC}1A`;
const CURSOR_LEFT = `${ESC}G`;
const ERASE_DOWN = `${ESC}J`;

const MULTILINE_ERASE_LINES_PATTERN = new RegExp(
  `(?:${escapeRegExp(ERASE_LINE + CURSOR_UP_ONE)})+${escapeRegExp(
    ERASE_LINE + CURSOR_LEFT,
  )}`,
  'g',
);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countOccurrences(value: string, search: string): number {
  let count = 0;
  let index = 0;

  while ((index = value.indexOf(search, index)) !== -1) {
    count++;
    index += search.length;
  }

  return count;
}

/**
 * Ink clears dynamic output via ansi-escapes.eraseLines(), which emits a
 * clear-line + cursor-up pair for every previous line. That can make terminal
 * scrollback bounce during frequent streaming renders. Collapse that exact
 * multiline erase sequence into one relative cursor move and erase-down.
 */
export function optimizeMultilineEraseLines(output: string): string {
  return output.replace(MULTILINE_ERASE_LINES_PATTERN, (sequence) => {
    const lineCount = countOccurrences(sequence, ERASE_LINE);
    const cursorUpCount = lineCount - 1;

    return `${ESC}${cursorUpCount}A${ERASE_DOWN}${CURSOR_LEFT}`;
  });
}

export function installTerminalRedrawOptimizer(
  stdout: NodeJS.WriteStream,
): () => void {
  if (process.env['QWEN_CODE_LEGACY_ERASE_LINES'] === '1') {
    return () => {};
  }

  const originalWrite = stdout.write;

  const optimizedWrite = function (
    this: NodeJS.WriteStream,
    chunk: unknown,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ) {
    const optimizedChunk =
      typeof chunk === 'string' ? optimizeMultilineEraseLines(chunk) : chunk;

    return originalWrite.call(
      this,
      optimizedChunk as string | Uint8Array,
      encodingOrCallback as BufferEncoding,
      callback,
    );
  } as typeof stdout.write;

  stdout.write = optimizedWrite;

  return () => {
    if (stdout.write === optimizedWrite) {
      stdout.write = originalWrite;
    }
  };
}
