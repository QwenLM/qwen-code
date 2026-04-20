/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

const ESC = '\u001B[';
const ERASE_LINE = `${ESC}2K`;
const CURSOR_UP_ONE = `${ESC}1A`;
const CURSOR_DOWN_ONE = `${ESC}1B`;
const CURSOR_LEFT = `${ESC}G`;

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
 * scrollback bounce during frequent streaming renders. Collapse the repeated
 * upward cursor movement while still clearing only the same old frame lines.
 */
export function optimizeMultilineEraseLines(output: string): string {
  return output.replace(MULTILINE_ERASE_LINES_PATTERN, (sequence) => {
    const lineCount = countOccurrences(sequence, ERASE_LINE);
    const cursorUpCount = lineCount - 1;

    if (cursorUpCount <= 1) {
      return sequence;
    }

    let boundedErase = `${ESC}${cursorUpCount}A`;

    for (let line = 0; line < lineCount; line++) {
      boundedErase += ERASE_LINE;

      if (line < lineCount - 1) {
        boundedErase += CURSOR_DOWN_ONE;
      }
    }

    return `${boundedErase}${ESC}${cursorUpCount}A${CURSOR_LEFT}`;
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
