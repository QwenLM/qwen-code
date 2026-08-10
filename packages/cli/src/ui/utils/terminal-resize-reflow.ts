/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { createDebugLogger } from '@qwen-code/qwen-code-core';
import stringWidth from 'string-width';
import stripAnsi from 'strip-ansi';

const debugLogger = createDebugLogger('RESIZE_REFLOW');

const ESC = '\u001B[';
const ERASE_LINE = `${ESC}2K`;
const CURSOR_UP_ONE = `${ESC}1A`;
const CURSOR_LEFT = `${ESC}G`;
const CLEAR_VIEWPORT = `${ESC}2J${ESC}H`;

// How long after a shrink every VP redraw starts from a clean viewport.
const CLEAR_WINDOW_MS = 600;

const ERASE_LINES_PATTERN = new RegExp(
  `(?:${escapeRegExp(ERASE_LINE + CURSOR_UP_ONE)})+${escapeRegExp(
    ERASE_LINE + CURSOR_LEFT,
  )}`,
);

// Live frames are >= 8 rows; shorter printable bursts (console output, Static
// history appends) must not be mistaken for a redraw.
const MIN_FRAME_LINES = 8;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function eraseLines(count: number): string {
  let clear = '';
  for (let i = 0; i < count; i++) {
    clear += ERASE_LINE + (i < count - 1 ? CURSOR_UP_ONE : '');
  }
  if (count) {
    clear += CURSOR_LEFT;
  }
  return clear;
}

function countEraseLines(sequence: string): number {
  let count = 0;
  let index = 0;
  while ((index = sequence.indexOf(ERASE_LINE, index)) !== -1) {
    count++;
    index += ERASE_LINE.length;
  }
  return count;
}

function wrappedLineCount(width: number, columns: number): number {
  if (columns <= 0) return 1;
  return Math.max(1, Math.ceil(width / columns));
}

function reflowedHeight(lineWidths: number[], columns: number): number {
  let total = 0;
  for (const width of lineWidths) {
    total += wrappedLineCount(width, columns);
  }
  return total;
}

function reflowWidths(lineWidths: number[], columns: number): number[] {
  const next: number[] = [];
  for (const width of lineWidths) {
    let remaining = width;
    while (remaining > columns) {
      next.push(columns);
      remaining -= columns;
    }
    next.push(remaining);
  }
  return next;
}

function frameLineWidths(content: string): number[] | undefined {
  const lines = content.split('\n');
  if (content.endsWith('\n')) lines.pop();
  if (lines.length < MIN_FRAME_LINES) return undefined;
  return lines.map((line) => stringWidth(stripAnsi(line)));
}

export interface ResizeReflowOptions {
  /** VP / alternate-screen mode: the shrink clear may blank the viewport. */
  virtualViewport?: boolean;
}

export interface TerminalResizeReflowHandle {
  restore: () => void;
  /**
   * Clear the viewport and replay the last frame that reached the terminal.
   * Ink skips redraws whose output is unchanged, so a wake/SIGCONT repaint
   * cannot rely on React alone after an external clear (review #8831).
   */
  repaint: () => void;
}

/**
 * Corrects Ink's shrink-time clear on reflow-capable terminals (issue #8557).
 *
 * Ink's `resized()` clears with `eraseLines(previousLineCount)` computed at
 * the OLD width; after the terminal reflows the printed frame into more
 * physical rows at the new width, that erase under-erases and the frame top
 * (banner) is stranded as duplicate copies on every terminal.
 *
 * - VP (alternate screen): the whole viewport is ours, so the stale clear is
 *   replaced with a viewport-wide clear (2J+H) — exact row counts are
 *   uncomputable anyway (full-width wrap boundaries add rows no width model
 *   predicts), and over-erasing clamps harmlessly on the alt screen.
 * - Static: the live region is amplified to the reflowed height of the last
 *   frame that actually reached the terminal; walking further up would eat
 *   committed scrollback, so the count stays conservative there.
 */
export function installTerminalResizeReflow(
  stdout: NodeJS.WriteStream,
  options: ResizeReflowOptions = {},
): TerminalResizeReflowHandle {
  if (process.env['QWEN_CODE_LEGACY_RESIZE_ERASE'] === '1') {
    return { restore: () => {}, repaint: () => {} };
  }
  const isVP = options.virtualViewport ?? false;
  let lastWidth = stdout.columns ?? 0;
  let lineWidths: number[] = [];
  let lastFrameContent = '';
  let pendingAmplify = 0;
  // After a shrink, every redraw (not just Ink's clear) erases with a stale
  // row count against the reflowed on-screen frame, re-stranding the frame
  // top each time. For this window, start every VP redraw from a clean
  // viewport instead.
  let clearUntil = 0;
  debugLogger.debug('installed', { width: lastWidth, isVP });

  const onResize = () => {
    const width = stdout.columns ?? lastWidth;
    debugLogger.debug('resize-event', {
      width,
      lastWidth,
      model: lineWidths.length,
    });
    if (width > 0 && width < lastWidth && lineWidths.length > 0) {
      if (isVP) {
        clearUntil = Date.now() + CLEAR_WINDOW_MS;
      } else {
        pendingAmplify = reflowedHeight(lineWidths, width);
      }
      debugLogger.debug('shrink', {
        from: lastWidth,
        to: width,
        modelLines: lineWidths.length,
        pendingAmplify,
        clearUntil,
      });
      lineWidths = reflowWidths(lineWidths, width);
    }
    lastWidth = width;
  };
  stdout.on('resize', onResize);

  const originalWrite = stdout.write;
  const reflowWrite = function (
    this: NodeJS.WriteStream,
    chunk: unknown,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ) {
    if (typeof chunk === 'string') {
      ERASE_LINES_PATTERN.lastIndex = 0;
      const match = ERASE_LINES_PATTERN.exec(chunk);
      if (match) {
        const content = chunk.slice(match.index + match[0].length);
        const widths = frameLineWidths(content);
        debugLogger.debug('match', { modelLines: widths?.length ?? 0 });
        if (widths) {
          lineWidths = widths;
          lastFrameContent = content;
        }
        if (isVP && Date.now() < clearUntil) {
          debugLogger.debug('clear-viewport');
          chunk =
            chunk.slice(0, match.index) +
            CLEAR_VIEWPORT +
            chunk.slice(match.index + match[0].length);
        } else if (pendingAmplify > 0) {
          const count = countEraseLines(match[0]);
          const target = pendingAmplify;
          pendingAmplify = 0;
          if (count < target) {
            debugLogger.debug('amplify', { original: count, target });
            chunk =
              chunk.slice(0, match.index) +
              eraseLines(target) +
              chunk.slice(match.index + match[0].length);
          }
        }
      }
    }
    return originalWrite.call(
      this,
      chunk as string | Uint8Array,
      encodingOrCallback as BufferEncoding,
      callback,
    );
  } as typeof stdout.write;
  stdout.write = reflowWrite;

  return {
    restore: () => {
      if (stdout.write === reflowWrite) {
        stdout.write = originalWrite;
      }
      stdout.off('resize', onResize);
    },
    repaint: () => {
      originalWrite.call(stdout, CLEAR_VIEWPORT + lastFrameContent);
    },
  };
}
