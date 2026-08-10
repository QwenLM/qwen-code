/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import ansiEscapes from 'ansi-escapes';
import { createDebugLogger } from '@qwen-code/qwen-code-core';
import stringWidth from 'string-width';
import stripAnsi from 'strip-ansi';
import {
  countOccurrences,
  createEraseLinesPattern,
  ERASE_LINE,
} from './terminalRedrawOptimizer.js';

const debugLogger = createDebugLogger('RESIZE_REFLOW');

const CLEAR_VIEWPORT = ansiEscapes.clearViewport;

// How long after a shrink every VP redraw starts from a clean viewport.
const CLEAR_WINDOW_MS = 600;

const ERASE_LINES_PATTERN = createEraseLinesPattern();

// Live frames are >= 8 rows; shorter printable bursts (console output, small
// redraws) must not be mistaken for a frame and clobber the model.
const MIN_FRAME_LINES = 8;

// Physical rows a logical line occupies once the terminal soft-wraps it at
// `columns`. Wide (2-cell) characters that do not fit a row's remaining
// cells wrap and waste a cell, so rows are greedy-packed per character
// rather than dividing total width.
function greedyRows(charWidths: number[], columns: number): number[][] {
  const rows: number[][] = [];
  let current: number[] = [];
  let used = 0;
  const flush = () => {
    rows.push(current);
    current = [];
    used = 0;
  };
  for (const width of charWidths) {
    if (width <= 0) continue;
    if (used > 0 && used + width > columns) flush();
    current.push(width);
    used += width;
  }
  if (current.length > 0 || rows.length === 0) flush();
  return rows;
}

function lineCharWidths(line: string): number[] {
  const widths: number[] = [];
  for (const ch of line) {
    widths.push(stringWidth(ch));
  }
  return widths;
}

interface FrameModel {
  // Raw content of the last frame that reached the terminal; rows are
  // packed lazily (the model is only consumed on shrink/wake).
  content: string;
  columns: number;
  // Ink counts the cursor-below line for non-fullscreen frames (the trailing
  // '\n' it appends); the amplification target must include it.
  trailingNewline: boolean;
}

function reflowModel(model: FrameModel, columns: number): number {
  // Re-pack from the raw frame in one step on every shrink: reflow terminals
  // track logical lines, so segmenting an already-segmented model compounds
  // (sum-of-ceils >= ceil-of-sum) and consecutive shrinks would over-erase
  // into committed scrollback.
  const lines = model.content.split('\n');
  if (model.trailingNewline && lines[lines.length - 1] === '') lines.pop();
  let total = 0;
  for (const line of lines) {
    total += greedyRows(lineCharWidths(line), columns).length;
  }
  return total + (model.trailingNewline ? 1 : 0);
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
   * cannot rely on React alone after an external clear. Only the wake path
   * may call this — ordinary refreshStatic callers must stay write-free in
   * VP (replaying the pre-change frame would flash stale content). Absent
   * under QWEN_CODE_LEGACY_RESIZE_ERASE: the wake path then falls back to a
   * bare viewport clear plus the static remount bump.
   */
  repaint?: () => void;
}

export interface WakeRepaintDeps {
  isVP: boolean;
  repaintViewport?: () => void;
  clearViewportFallback: () => void;
  refreshStatic: () => void;
  remountStaticHistory: () => void;
}

/**
 * Wake/SIGCONT selection, extracted for unit coverage: VP repaints by
 * clearing the viewport and replaying the last frame (Ink skips
 * unchanged-output redraws), and must bump the static remount key so
 * one-shot <Static> history (agent tabs) is re-emitted over the clear;
 * static mode uses the ordinary refreshStatic.
 */
export function buildWakeRepaint(deps: WakeRepaintDeps): () => void {
  return () => {
    if (deps.isVP) {
      (deps.repaintViewport ?? deps.clearViewportFallback)();
      deps.remountStaticHistory();
    } else {
      deps.refreshStatic();
    }
  };
}

/**
 * Corrects Ink's shrink-time clear on reflow-capable terminals (issue #8557).
 *
 * Ink's `resized()` clears with `eraseLines(previousLineCount)` computed at
 * the OLD width; after the terminal reflows the printed frame into more
 * physical rows at the new width, that erase under-erases and the frame top
 * (banner) is stranded as duplicate copies on every terminal.
 *
 * - VP (alternate screen): the whole viewport is ours, so for a short window
 *   after a shrink every redraw starts from a viewport-wide clear (2J+H) —
 *   exact row counts are uncomputable anyway (full-width wrap boundaries add
 *   rows no width model predicts), and over-erasing clamps harmlessly on the
 *   alt screen.
 * - Static: the live region is amplified to the reflowed height of the last
 *   frame that actually reached the terminal (greedy-packed per character,
 *   plus Ink's cursor-below line); walking further up would eat committed
 *   scrollback, so the count stays conservative there.
 */
export function installTerminalResizeReflow(
  stdout: NodeJS.WriteStream,
  options: ResizeReflowOptions = {},
): TerminalResizeReflowHandle {
  if (process.env['QWEN_CODE_LEGACY_RESIZE_ERASE'] === '1') {
    return { restore: () => {} };
  }
  const isVP = options.virtualViewport ?? false;
  let lastWidth = stdout.columns ?? 0;
  const model: FrameModel = {
    content: '',
    columns: lastWidth,
    trailingNewline: false,
  };
  let pendingAmplify = 0;
  // Ink's post-shrink redraw arrives bare (log.clear() resets its counter to
  // 0). A clear-only write arms the handoff; consecutive bare writes then
  // each re-model (last wins: the static append precedes the live frame),
  // and only printable writes consume it — Ink's standalone synchronized-
  // output control writes must not.
  let expectFrame = false;
  // After a shrink, every redraw (not just Ink's clear) erases with a stale
  // row count against the reflowed on-screen frame, re-stranding the frame
  // top each time. For this window, start every VP redraw from a clean
  // viewport instead.
  let clearUntil = 0;
  debugLogger.debug('installed', { width: lastWidth, isVP });

  const modelFrame = (content: string) => {
    if (content.split('\n').length < MIN_FRAME_LINES) return;
    model.content = content;
    model.columns = stdout.columns ?? lastWidth;
    model.trailingNewline = content.endsWith('\n');
  };

  const onResize = () => {
    const width = stdout.columns ?? lastWidth;
    debugLogger.debug('resize-event', {
      width,
      lastWidth,
      modeled: model.content.length > 0,
    });
    if (width > 0 && width < lastWidth && model.content.length > 0) {
      if (isVP) {
        clearUntil = Date.now() + CLEAR_WINDOW_MS;
      } else {
        pendingAmplify = reflowModel(model, width);
      }
      debugLogger.debug('shrink', {
        from: lastWidth,
        to: width,
        pendingAmplify,
        clearUntil,
      });
    } else if (width > lastWidth) {
      // A grow invalidates a pending shrink amplification: the stale count
      // was computed for a narrower width and would over-erase past the live
      // frame into committed scrollback.
      pendingAmplify = 0;
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
      const match = ERASE_LINES_PATTERN.exec(chunk);
      if (match) {
        const content = chunk.slice(match.index + match[0].length);
        const printable = stripAnsi(content).trim() !== '';
        if (printable) {
          modelFrame(content);
          expectFrame = false;
        } else {
          // Clear-only write (Ink's log.clear): the redraw follows bare.
          expectFrame = true;
        }
        debugLogger.debug('match', { printable });
        if (isVP && Date.now() < clearUntil) {
          debugLogger.debug('clear-viewport');
          chunk =
            chunk.slice(0, match.index) +
            CLEAR_VIEWPORT +
            chunk.slice(match.index + match[0].length);
        } else if (pendingAmplify > 0) {
          const count = countOccurrences(match[0], ERASE_LINE);
          const target = pendingAmplify;
          pendingAmplify = 0;
          if (count < target) {
            debugLogger.debug('amplify', { original: count, target });
            chunk =
              chunk.slice(0, match.index) +
              ansiEscapes.eraseLines(target) +
              chunk.slice(match.index + match[0].length);
          }
        }
      } else if (expectFrame && stripAnsi(chunk).trim() !== '') {
        // Bare redraw (or static append preceding it): model each printable
        // bare write, last one wins; stay armed until the next erase-prefixed
        // or clear-only write closes the commit.
        modelFrame(chunk);
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
      const columns = stdout.columns ?? lastWidth;
      originalWrite.call(
        stdout,
        model.columns === columns && model.content
          ? CLEAR_VIEWPORT + model.content
          : CLEAR_VIEWPORT,
      );
    },
  };
}
