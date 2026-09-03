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
const ESC = '\u001B[';
const CLEAR_TERMINAL = ansiEscapes.clearTerminal;

// Return-to-bottom prefixes carry cursorDown computed from pre-reflow
// geometry; the amplified erase needs the cursor advanced by the reflow
// delta too, or the erase window shifts up into scrollback.
// eslint-disable-next-line no-control-regex
const CURSOR_DOWN_PATTERN = /\x1b\[(\d+)B/;

// How long after a shrink every VP redraw starts from a clean viewport.
export const CLEAR_WINDOW_MS = 600;

// The post-clear bare-write handoff (static append + live frame) happens
// within one synchronous Ink render; stray bare writes (notification bell,
// kitty APC images) arrive later and must not reach the model.
const HANDOFF_WINDOW_MS = 50;

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
  // Grapheme-cluster widths: multi-code-point clusters (ZWJ emoji, skin-tone
  // modifiers) occupy one cell block, so per-code-point sums over-count and
  // would over-erase into committed scrollback. Tabs advance to the next
  // 8-column stop (stringWidth('\t') is 0) or tab-indented frames under-count.
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const widths: number[] = [];
  let col = 0;
  for (const { segment } of segmenter.segment(line)) {
    const width = segment === '\t' ? 8 - (col % 8) : stringWidth(segment);
    widths.push(width);
    col += width;
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
  // into committed scrollback. Widths come from ANSI-stripped lines — SGR
  // parameter bytes are invisible and would pack as phantom cells otherwise.
  const lines = stripAnsi(model.content).split('\n');
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
   * under QWEN_CODE_LEGACY_RESIZE_ERASE: the VP wake path then stays
   * write-free (static remount bump only), matching pre-PR behavior.
   */
  repaint?: () => void;
}

export interface WakeRepaintDeps {
  isVP: boolean;
  repaintViewport?: () => void;
  refreshStatic: () => void;
  remountStaticHistory: () => void;
}

/**
 * Wake/SIGCONT selection, extracted for unit coverage: VP repaints by
 * replaying the last frame over a clean viewport (Ink skips unchanged-output
 * redraws) and bumps the static remount key so one-shot <Static> history
 * (agent tabs) is re-emitted over the clear. Without a repaint (the legacy
 * escape hatch) VP wake stays write-free — a bare viewport clear would blank
 * the screen, since Ink then writes zero bytes for byte-identical output —
 * matching pre-PR behavior (stale but visible). Static mode uses the
 * ordinary refreshStatic.
 */
export function buildWakeRepaint(deps: WakeRepaintDeps): () => void {
  return () => {
    if (deps.isVP) {
      deps.repaintViewport?.();
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
  // Printable bare writes seen in the current armed burst; the second one is
  // the live frame following a static append and bypasses MIN_FRAME_LINES.
  let barePrintableCount = 0;
  // The handoff closes shortly after arming: the commit's bare writes land in
  // one synchronous render; later stray bare writes are ignored.
  let handoffUntil = 0;
  // After a shrink, every redraw (not just Ink's clear) erases with a stale
  // row count against the reflowed on-screen frame, re-stranding the frame
  // top each time. For this window, start every VP redraw from a clean
  // viewport instead.
  let clearUntil = 0;
  debugLogger.debug('installed', { width: lastWidth, isVP });

  const modelFrame = (content: string, bypassMin = false) => {
    if (!bypassMin && content.split('\n').length < MIN_FRAME_LINES) return;
    model.content = content;
    model.columns = stdout.columns ?? lastWidth;
    // Ink appends the cursor suffix AFTER the frame's trailing newline, so
    // detect the newline on the ANSI-stripped content (the suffix is either
    // pure control bytes or a one-cell cursor block, never a '\n').
    model.trailingNewline = stripAnsi(content).endsWith('\n');
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
          // Erase-prefixed printable writes are authoritative Ink renders of
          // the new live region (console interleaving arrives as clear-only +
          // bare), so they update the model even below MIN_FRAME_LINES —
          // rejecting them would freeze the amplification target on a stale
          // larger frame after every turn commit.
          modelFrame(content, true);
          expectFrame = false;
          barePrintableCount = 0;
        } else {
          // Clear-only write (Ink's log.clear): the redraw follows bare.
          expectFrame = true;
          barePrintableCount = 0;
          handoffUntil = Date.now() + HANDOFF_WINDOW_MS;
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
            // A return-to-bottom prefix's cursorDown was computed from
            // PRE-reflow geometry; the screen grew by (target - count) rows,
            // so advance the cursor by that delta too or the amplified erase
            // window shifts up into scrollback. Terminals clamp cursor moves
            // at the bottom row, keeping this safe.
            const delta = target - count;
            const prefix = chunk
              .slice(0, match.index)
              .replace(
                CURSOR_DOWN_PATTERN,
                (_m, n: string) => `${ESC}${Number(n) + delta}B`,
              );
            debugLogger.debug('amplify', { original: count, target });
            chunk =
              prefix +
              ansiEscapes.eraseLines(target) +
              chunk.slice(match.index + match[0].length);
          }
        }
      } else if (chunk.includes(CLEAR_TERMINAL)) {
        // Overflow-path full reset (clearTerminal + full static history +
        // live frame as one write, with NO preceding log.clear()): the chunk
        // is not a frame, so drop the model until a clean erase-prefixed
        // write re-anchors it. Not gated on expectFrame — the reset write
        // arrives unarmed in the normal interactive state.
        expectFrame = false;
        barePrintableCount = 0;
        model.content = '';
      } else if (expectFrame) {
        if (Date.now() >= handoffUntil) {
          // The commit's bare writes land in one synchronous render; a bare
          // write this late is a stray (notification bell, kitty APC image,
          // tmux DCS), not the handoff.
          expectFrame = false;
        } else if (stripAnsi(chunk).trim() !== '') {
          // Bare redraw (or static append preceding it): model each printable
          // bare write, last one wins; the second printable bare write of a
          // commit is the live frame and replaces the model even below
          // MIN_FRAME_LINES. Once the live frame is consumed, disarm so later
          // strays cannot clobber the model during idle.
          barePrintableCount++;
          modelFrame(chunk, barePrintableCount > 1);
          if (barePrintableCount > 1) expectFrame = false;
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
