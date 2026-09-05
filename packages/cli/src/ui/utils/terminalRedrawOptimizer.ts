/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import ansiEscapes from 'ansi-escapes';

import { isWsl } from '@qwen-code/qwen-code-core';

const ESC = '\u001B[';
export const ERASE_LINE = `${ESC}2K`;
const CURSOR_UP_ONE = `${ESC}1A`;
const CURSOR_DOWN_ONE = `${ESC}1B`;
const CURSOR_LEFT = `${ESC}G`;

export function createEraseLinesPattern(flags?: string): RegExp {
  return new RegExp(
    `(?:${escapeRegExp(ERASE_LINE + CURSOR_UP_ONE)})+${escapeRegExp(
      ERASE_LINE + CURSOR_LEFT,
    )}`,
    flags,
  );
}

const MULTILINE_ERASE_LINES_PATTERN = createEraseLinesPattern('g');

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function countOccurrences(value: string, search: string): number {
  // Match core's editHelper.countOccurrences empty-needle semantics; without
  // this guard indexOf('', 0) never advances and the loop hangs.
  if (search === '') return 0;
  let count = 0;
  let index = 0;

  while ((index = value.indexOf(search, index)) !== -1) {
    count++;
    index += search.length;
  }

  return count;
}

export interface TerminalRedrawStatsSnapshot {
  stdoutWriteCount: number;
  stdoutBytes: number;
  clearTerminalCount: number;
  eraseLinesOptimizedCount: number;
}

const terminalRedrawStats: TerminalRedrawStatsSnapshot = {
  stdoutWriteCount: 0,
  stdoutBytes: 0,
  clearTerminalCount: 0,
  eraseLinesOptimizedCount: 0,
};

export function getTerminalRedrawStatsSnapshot(): TerminalRedrawStatsSnapshot {
  return { ...terminalRedrawStats };
}

export function resetTerminalRedrawStats(): void {
  terminalRedrawStats.stdoutWriteCount = 0;
  terminalRedrawStats.stdoutBytes = 0;
  terminalRedrawStats.clearTerminalCount = 0;
  terminalRedrawStats.eraseLinesOptimizedCount = 0;
}

function getChunkByteLength(
  chunk: string | Uint8Array,
  encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
): number {
  if (typeof chunk === 'string') {
    const encoding =
      typeof encodingOrCallback === 'string' ? encodingOrCallback : undefined;
    return Buffer.byteLength(chunk, encoding);
  }

  return chunk.byteLength;
}

function optimizeMultilineEraseLinesWithCount(output: string): {
  output: string;
  optimizedSequenceCount: number;
} {
  let optimizedSequenceCount = 0;

  const optimizedOutput = output.replace(
    MULTILINE_ERASE_LINES_PATTERN,
    (sequence) => {
      const lineCount = countOccurrences(sequence, ERASE_LINE);
      const cursorUpCount = lineCount - 1;

      if (cursorUpCount <= 1) {
        return sequence;
      }

      optimizedSequenceCount += 1;

      let boundedErase = `${ESC}${cursorUpCount}A`;

      for (let line = 0; line < lineCount; line++) {
        boundedErase += ERASE_LINE;

        if (line < lineCount - 1) {
          boundedErase += CURSOR_DOWN_ONE;
        }
      }

      return `${boundedErase}${ESC}${cursorUpCount}A${CURSOR_LEFT}`;
    },
  );

  return { output: optimizedOutput, optimizedSequenceCount };
}

/**
 * Ink clears dynamic output via ansi-escapes.eraseLines(), which emits a
 * clear-line + cursor-up pair for every previous line. That can make terminal
 * scrollback bounce during frequent streaming renders. Collapse the repeated
 * upward cursor movement while still clearing only the same old frame lines.
 */
export function optimizeMultilineEraseLines(output: string): string {
  return optimizeMultilineEraseLinesWithCount(output).output;
}

export function installTerminalRedrawOptimizer(
  stdout: NodeJS.WriteStream,
  // Injectable for tests; production callers omit it and it resolves to
  // process.env at call time.
  env: NodeJS.ProcessEnv = process.env,
): () => void {
  // QWEN_CODE_LEGACY_ERASE_LINES:
  //   '1' — force-disable the optimizer (existing escape hatch)
  //   '0' — force-enable even on WSL, for terminals that handle ConPTY's
  //         batched cursor moves correctly (new in #7897)
  //   unset/anything else — use platform defaults below
  if (env['QWEN_CODE_LEGACY_ERASE_LINES'] === '1') {
    return () => {};
  }

  // During Ink's per-frame erase-and-redraw of streaming output, the optimizer
  // is the only path emitting cursor-down (CSI 1 B) and multi-count cursor-up
  // (CSI n A); Ink's native eraseLines() path uses neither. Ink's
  // cursor-positioning path still emits both sequence classes on cursor moves.
  // ConPTY's (Windows Console Pseudo Terminal) row tracking diverges on those,
  // so the erase lands on the wrong rows and streaming frames stack, causing
  // duplicate text. Skip the optimizer on WSL (ConPTY is the default pty there),
  // unless the user explicitly force-enables it. WT_SESSION is deliberately NOT
  // included: it is set on the Windows side and is not propagated into WSL
  // shells without WSLENV, so it can never be the variable that fires for #7634.
  if (env['QWEN_CODE_LEGACY_ERASE_LINES'] !== '0' && isWsl(env)) {
    return () => {};
  }

  const originalWrite = stdout.write;

  const optimizedWrite = function (
    this: NodeJS.WriteStream,
    chunk: unknown,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ) {
    const optimizedResult =
      typeof chunk === 'string'
        ? optimizeMultilineEraseLinesWithCount(chunk)
        : undefined;
    const optimizedChunk = optimizedResult?.output ?? chunk;

    if (
      typeof optimizedChunk === 'string' ||
      optimizedChunk instanceof Uint8Array ||
      Buffer.isBuffer(optimizedChunk)
    ) {
      terminalRedrawStats.stdoutWriteCount += 1;
      terminalRedrawStats.stdoutBytes += getChunkByteLength(
        optimizedChunk,
        encodingOrCallback,
      );

      if (typeof optimizedChunk === 'string') {
        terminalRedrawStats.clearTerminalCount += countOccurrences(
          optimizedChunk,
          ansiEscapes.clearTerminal,
        );
      }
    }

    if (optimizedResult) {
      terminalRedrawStats.eraseLinesOptimizedCount +=
        optimizedResult.optimizedSequenceCount;
    }

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
