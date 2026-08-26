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

// Incremental-rendering frame vocabulary (Ink's patched createIncremental):
// after a cursorUp to the frame top, `ESC[E` keeps a line and
// `ESC[1G <content> ESC[K` rewrites one.
const CURSOR_NEXT_LINE = `${ESC}E`;
const CURSOR_TO_FIRST_COLUMN = `${ESC}1G`; // ansi-escapes cursorTo(0)
const ERASE_END_LINE = `${ESC}K`;
const CURSOR_HIDE = `${ESC}?25l`;

// eslint-disable-next-line no-control-regex
const LEADING_CURSOR_UP_RE = /^\u001B\[(\d+)A/;
// eslint-disable-next-line no-control-regex
const RETURN_PREFIX_DOWN_RE = /^\u001B\[\d+B/;
// Ink's trailing cursor suffix: optional cursorUp, cursorTo(x), showCursor.
// eslint-disable-next-line no-control-regex
const CURSOR_SUFFIX_RE = /(?:\u001B\[\d+A)?\u001B\[\d+G\u001B\[\?25h$/;
// eslint-disable-next-line no-control-regex
const CURSOR_SUFFIX_ONLY_RE = /^(?:\u001B\[\d+A)?\u001B\[\d+G\u001B\[\?25h$/;
// eslint-disable-next-line no-control-regex
const SGR_RE = /^\u001B\[[0-9;]*m/;

// How long after a shrink every VP redraw starts from a clean viewport.
export const CLEAR_WINDOW_MS = 600;

// The post-clear bare-write handoff (static append + live frame) happens
// within one synchronous Ink render; stray bare writes (notification bell,
// kitty APC images) arrive later and must not reach the model.
const HANDOFF_WINDOW_MS = 50;

const ERASE_LINES_PATTERN = createEraseLinesPattern();

// VP shrink diffs can erase exactly one line, and Ink's eraseLines(1) is
// `ESC[2K ESC[G` with no cursorUp pair, which the shared (+) pattern misses.
// eslint-disable-next-line no-control-regex
const VP_ERASE_LINES_RE = /(?:\u001B\[2K\u001B\[1A)*\u001B\[2K\u001B\[G/;

// Live frames are >= 8 rows; shorter printable bursts (console output, small
// redraws) must not be mistaken for a frame and clobber the model.
const MIN_FRAME_LINES = 8;

// The patched Ink publishes its reset-write fullscreen decision on the stream
// under this key right before writing a clearTerminal reset (see
// patches/ink+7.0.3.patch). That decision — outputHeight >= viewportRows at
// the payload's render width — is what fixes log.sync()'s trailing-newline
// slot; re-deriving it by re-wrapping the stored bytes at the current width
// diverges on width drift, boundary heights, and literal tabs.
const INK_RESET_FULLSCREEN = Symbol.for('qwen.ink.resetFullscreen');

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

function packedRowCount(lines: string[], columns: number): number {
  let total = 0;
  for (const line of lines) {
    total += greedyRows(lineCharWidths(line), columns).length;
  }
  return total;
}

function reflowModel(model: FrameModel, columns: number): number {
  // Re-pack from the raw frame in one step on every shrink: reflow terminals
  // track logical lines, so segmenting an already-segmented model compounds
  // (sum-of-ceils >= ceil-of-sum) and consecutive shrinks would over-erase
  // into committed scrollback. Widths come from ANSI-stripped lines — SGR
  // parameter bytes are invisible and would pack as phantom cells otherwise.
  const lines = stripAnsi(model.content).split('\n');
  if (model.trailingNewline && lines[lines.length - 1] === '') lines.pop();
  return packedRowCount(lines, columns) + (model.trailingNewline ? 1 : 0);
}

/**
 * Splits a stored frame into visible lines for diff application. The
 * stored content may carry Ink's trailing cursor suffix; the diff state
 * tracks content lines only.
 */
function splitStoredFrame(model: FrameModel): {
  lines: string[];
  trailingNewline: boolean;
} {
  let body = model.content.replace(CURSOR_SUFFIX_RE, '');
  if (model.trailingNewline && body.endsWith('\n')) {
    body = body.slice(0, -1);
  }
  return { lines: body.split('\n'), trailingNewline: model.trailingNewline };
}

/**
 * Parses the head of an incremental frame: an optional return-to-bottom
 * prefix (hideCursor?, cursorDown?, cursorTo(0)), then the leading cursorUp
 * whose count names the previous frame's height for grow/same-height frames
 * and the new height for erase-prefixed shrink frames.
 */
function parseDiffHead(
  chunk: string,
): { headCount: number; pos: number } | null {
  let pos = 0;
  if (chunk.startsWith(CURSOR_HIDE, pos)) pos += CURSOR_HIDE.length;
  const down = RETURN_PREFIX_DOWN_RE.exec(chunk.slice(pos));
  if (down) pos += down[0].length;
  if (chunk.startsWith(CURSOR_TO_FIRST_COLUMN, pos)) {
    pos += CURSOR_TO_FIRST_COLUMN.length;
  }
  const head = LEADING_CURSOR_UP_RE.exec(chunk.slice(pos));
  if (!head) return null;
  return { headCount: Number(head[1]), pos: pos + head[0].length };
}

/**
 * A diff head must be followed by line ops (`ESC[E` keeps, `ESC[1G`
 * rewrites); cursor-only writes carry a leading cursorUp too and must not
 * be mistaken for a diff.
 */
function startsWithLineOp(chunk: string, pos: number): boolean {
  return (
    chunk.startsWith(CURSOR_NEXT_LINE, pos) ||
    chunk.startsWith(CURSOR_TO_FIRST_COLUMN, pos)
  );
}

/**
 * Applies one incremental (line-diff) frame to the stored model, mirroring
 * Ink's createIncremental op stream: move to the frame top, then per line
 * either keep it (`ESC[E`) or rewrite it (`ESC[1G <content> ESC[K`).
 * Incremental frames carry no full content of their own, so the model can
 * only advance by transforming its current lines. Returns true when the
 * chunk parsed completely and the model advanced; any deviation leaves the
 * model untouched — a stale replay beats a corrupt one.
 */
function applyIncrementalDiff(
  model: FrameModel,
  chunk: string,
  columns: number,
  shrink?: { eraseCount: number },
): boolean {
  if (!model.content) return false;
  const { lines, trailingNewline } = splitStoredFrame(model);
  const head = parseDiffHead(chunk);
  if (!head) return false;
  let pos = head.pos;
  const headCount = head.headCount;

  let targetHeight: number;
  if (shrink) {
    // eraseLines count = prevVisible - nextVisible + trailing-newline slot;
    // the cursorUp after it names the new visible height directly.
    targetHeight = headCount;
    if (
      shrink.eraseCount !==
      lines.length - targetHeight + (trailingNewline ? 1 : 0)
    ) {
      return false;
    }
  } else {
    // cursorUp(previousLines.length - 1); previousLines is the split of the
    // rendered output, which carries one extra element for a trailing '\n'.
    if (headCount !== lines.length - 1 + (trailingNewline ? 1 : 0)) {
      return false;
    }
    targetHeight = -1;
  }

  const next = lines.slice();
  let row = 0;
  let consumed = 0;
  let frameTrailingNewline = false;
  let suffix = '';
  let slotKept = false;

  while (pos < chunk.length) {
    if (chunk.startsWith(CURSOR_NEXT_LINE, pos)) {
      if (row >= next.length) {
        // Ink grows a non-fullscreen frame by the previous frame's
        // trailing-newline slot: exactly one keep past the stored end
        // appends the blank slot row.
        if (row > next.length || !trailingNewline || slotKept) return false;
        next.push('');
        slotKept = true;
      }
      pos += CURSOR_NEXT_LINE.length;
      row++;
      consumed++;
      frameTrailingNewline = true;
      continue;
    }
    if (LEADING_CURSOR_UP_RE.test(chunk.slice(pos))) {
      // Line ops never emit cursor-up; this starts the cursor suffix.
      suffix = chunk.slice(pos);
      pos = chunk.length;
      break;
    }
    if (CURSOR_SUFFIX_ONLY_RE.test(chunk.slice(pos))) {
      // Cursor suffix without cursorUp (cursor already on the bottom row);
      // Ink emits it at the composer's column, so match any G column.
      suffix = chunk.slice(pos);
      pos = chunk.length;
      break;
    }
    if (chunk.startsWith(CURSOR_TO_FIRST_COLUMN, pos)) {
      pos += CURSOR_TO_FIRST_COLUMN.length;
      let text = '';
      let terminated = false;
      while (pos < chunk.length) {
        const char = chunk[pos];
        if (char === '\u001B') {
          if (chunk.startsWith(ERASE_END_LINE, pos)) {
            pos += ERASE_END_LINE.length;
            terminated = true;
            break;
          }
          if (chunk.startsWith(ESC, pos)) {
            // Only SGR travels inside line content.
            const sgr = SGR_RE.exec(chunk.slice(pos));
            if (!sgr) return false;
            text += sgr[0];
            pos += sgr[0].length;
            continue;
          }
          if (chunk[pos + 1] === ']') {
            // OSC payload (hyperlinks, inline images): pass through intact.
            const bel = chunk.indexOf('\u0007', pos);
            const st = chunk.indexOf('\u001B\\', pos);
            const end =
              bel !== -1 && (st === -1 || bel < st)
                ? bel + 1
                : st !== -1
                  ? st + 2
                  : -1;
            if (end === -1) return false;
            text += chunk.slice(pos, end);
            pos = end;
            continue;
          }
          if (chunk[pos + 1] === 'P') {
            // DCS payload (tmux/screen multiplexer-wrapped OSC 8): pass
            // through opaquely to the terminating ST.
            const st = chunk.indexOf('\u001B\\', pos + 2);
            if (st === -1) return false;
            text += chunk.slice(pos, st + 2);
            pos = st + 2;
            continue;
          }
          return false;
        }
        // Rewritten lines terminate with ESC[K before any newline.
        if (char === '\n') return false;
        text += char;
        pos++;
      }
      if (!terminated) return false;
      if (row === next.length) next.push(text);
      else next[row] = text;
      row++;
      consumed++;
      if (chunk[pos] === '\n') {
        pos++;
        frameTrailingNewline = true;
      } else {
        frameTrailingNewline = false;
      }
      continue;
    }
    return false;
  }

  if (suffix && !CURSOR_SUFFIX_ONLY_RE.test(suffix)) return false;

  let height: number;
  if (shrink) {
    height = targetHeight;
    if (consumed !== height && consumed !== height - 1) return false;
    // Ink emits no op for a kept LAST line without a trailing newline.
    if (consumed === height - 1) frameTrailingNewline = false;
  } else if (consumed === lines.length - 1) {
    // Same-height frame whose kept last line carries no trailing newline.
    height = lines.length;
    frameTrailingNewline = false;
  } else if (consumed >= lines.length) {
    height = consumed;
  } else {
    return false;
  }

  next.length = height;
  model.content = next.join('\n') + (frameTrailingNewline ? '\n' : '') + suffix;
  model.trailingNewline = frameTrailingNewline;
  // Width can change between frames (a grow does not re-anchor); refresh on
  // every applied diff so repaint replays content instead of blanking the
  // viewport.
  model.columns = columns;
  return true;
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
 *
 * VP additionally runs Ink's incremental renderer, whose frames are line
 * diffs rather than erase-prefixed full frames; the model therefore anchors
 * on the first bare frame, defers reset anchoring to the next diff's head
 * count, and applies each diff as a transform, so the wake repaint always
 * has the current frame to replay.
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
  // VP only: the alternate-screen entry clear arms a one-shot capture of the
  // first bare frame; incremental diffs alone cannot reconstruct a frame.
  let expectFirstFrame = false;
  // VP only: a clearTerminal reset write carries the full live frame but may
  // prepend re-emitted <Static> transcript (agent tabs), and omits the
  // trailing-newline slot Ink syncs for non-fullscreen frames — hold it and
  // anchor the trailing live-frame window the next diff's head count names.
  let pendingResetFrame = '';
  // Ink's fullscreen decision for the pending reset write, when published
  // (patched Ink); undefined falls back to the wrapped-height classifier.
  let pendingResetFullscreen: boolean | undefined;
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
    pendingResetFrame = '';
    pendingResetFullscreen = undefined;
    model.content = content;
    model.columns = stdout.columns ?? lastWidth;
    // Ink appends the cursor suffix AFTER the frame's trailing newline, so
    // detect the newline on the ANSI-stripped content (the suffix is either
    // pure control bytes or a one-cell cursor block, never a '\n').
    model.trailingNewline = stripAnsi(content).endsWith('\n');
  };

  const anchorPendingReset = (
    headCount: number,
    shrink?: { eraseCount: number },
  ): boolean => {
    const width = stdout.columns ?? lastWidth;
    const rows = stdout.rows ?? 0;
    // A reset write never carries Ink's synced trailing-newline slot; a
    // trailing empty element is a genuinely blank bottom row of the live
    // frame and must stay in the anchoring window.
    const pendingLines = pendingResetFrame.split('\n');
    const candidate = (trailing: boolean): string[] | null => {
      const height =
        (shrink ? shrink.eraseCount + headCount : headCount + 1) -
        (trailing ? 1 : 0);
      if (height <= 0 || height > pendingLines.length) return null;
      return pendingLines.slice(-height);
    };
    let anchor: string[] | null = null;
    let trailing = false;
    if (pendingResetFullscreen !== undefined) {
      // Ink published its actual fullscreen decision for this reset write:
      // the synced slot state is exactly its negation. The head equation
      // cannot break the tie itself (an N-line slotless frame and an
      // (N-1)-line slotted frame emit identical cursorUp counts), so without
      // this the wrong candidate transforms instead of being rejected.
      trailing = !pendingResetFullscreen;
      anchor = candidate(trailing);
    } else {
      // No published decision (synthetic writer, unpatched Ink): classify
      // with Ink's fullscreen rule (wrapped height >= viewport), trying the
      // slotted window first: on the boundary a one-line-short anchor rejects
      // later diffs instead of corrupting kept lines.
      for (const isTrailing of [true, false]) {
        const lines = candidate(isTrailing);
        if (lines === null) continue;
        const isFullscreen =
          packedRowCount(lines.map(stripAnsi), width) >= rows;
        if (isTrailing ? isFullscreen : !isFullscreen) continue;
        anchor = lines;
        trailing = isTrailing;
        break;
      }
    }
    if (anchor === null) return false;
    pendingResetFrame = '';
    pendingResetFullscreen = undefined;
    model.content = anchor.join('\n') + (trailing ? '\n' : '');
    model.columns = width;
    model.trailingNewline = trailing;
    debugLogger.debug('reset-anchor', { lines: anchor.length, trailing });
    return true;
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
      const currentWidth = stdout.columns ?? lastWidth;
      const match = (isVP ? VP_ERASE_LINES_RE : ERASE_LINES_PATTERN).exec(
        chunk,
      );
      if (match) {
        const content = chunk.slice(match.index + match[0].length);
        const eraseCount = countOccurrences(match[0], ERASE_LINE);
        // VP incremental shrink-diff frames carry the erase prefix in front
        // of a cursorUp to the frame top plus line ops; apply them as a
        // transform instead of mistaking the fragment for a full frame.
        // Such a frame is self-consistent against the post-shrink screen,
        // so it also skips the clear-window rewrite below.
        const head = isVP ? parseDiffHead(content) : null;
        let incrementalShrinkDiff = false;
        if (head !== null) {
          if (pendingResetFrame !== '' && startsWithLineOp(content, head.pos)) {
            anchorPendingReset(head.headCount, { eraseCount });
          }
          incrementalShrinkDiff = applyIncrementalDiff(
            model,
            content,
            currentWidth,
            { eraseCount },
          );
          debugLogger.debug('shrink-diff', {
            applied: incrementalShrinkDiff,
            eraseCount,
            headCount: head.headCount,
            modelLines:
              model.content === '' ? 0 : splitStoredFrame(model).lines.length,
          });
        }
        if (incrementalShrinkDiff) {
          expectFrame = false;
          expectFirstFrame = false;
          barePrintableCount = 0;
        } else {
          const printable = stripAnsi(content).trim() !== '';
          if (printable && head === null) {
            // Erase-prefixed printable writes are authoritative Ink renders of
            // the new live region (console interleaving arrives as clear-only +
            // bare), so they update the model even below MIN_FRAME_LINES —
            // rejecting them would freeze the amplification target on a stale
            // larger frame after every turn commit. A diff-shaped head means a
            // rejected incremental diff, not a full frame; storing its
            // control-op fragment would corrupt the model.
            modelFrame(content, true);
            expectFrame = false;
            expectFirstFrame = false;
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
            const target = pendingAmplify;
            pendingAmplify = 0;
            if (eraseCount < target) {
              // A return-to-bottom prefix's cursorDown was computed from
              // PRE-reflow geometry; the screen grew by (target - eraseCount)
              // rows, so advance the cursor by that delta too or the amplified
              // erase window shifts up into scrollback. Terminals clamp cursor
              // moves at the bottom row, keeping this safe.
              const delta = target - eraseCount;
              const prefix = chunk
                .slice(0, match.index)
                .replace(
                  CURSOR_DOWN_PATTERN,
                  (_m, n: string) => `${ESC}${Number(n) + delta}B`,
                );
              debugLogger.debug('amplify', { original: eraseCount, target });
              chunk =
                prefix +
                ansiEscapes.eraseLines(target) +
                chunk.slice(match.index + match[0].length);
            }
          }
        }
      } else if (chunk.includes(CLEAR_TERMINAL)) {
        // Overflow-path full reset (clearTerminal + full static history +
        // live frame as one write, with NO preceding log.clear()): the chunk
        // is not a frame, so drop the model until a clean erase-prefixed
        // write re-anchors it. Not gated on expectFrame — the reset write
        // arrives unarmed in the normal interactive state.
        expectFrame = false;
        expectFirstFrame = false;
        barePrintableCount = 0;
        if (isVP) {
          const after = chunk.slice(
            chunk.indexOf(CLEAR_TERMINAL) + CLEAR_TERMINAL.length,
          );
          if (after === '') {
            // Alternate-screen entry: the first frame follows as a single
            // bare write — arm its capture. Incremental diffs alone cannot
            // reconstruct a frame, so without this anchor the wake repaint
            // would only have a clear to replay.
            model.content = '';
            expectFirstFrame = true;
            handoffUntil = Date.now() + HANDOFF_WINDOW_MS;
            debugLogger.debug('first-frame', { state: 'armed' });
          } else if (stripAnsi(after).trim() !== '') {
            // VP overflow full reset: the write carries the full live frame
            // but may prepend re-emitted <Static> transcript (agent tabs),
            // and the bytes omit the trailing-newline slot Ink syncs for
            // non-fullscreen frames. Defer the anchor until the next diff's
            // head count validates the trailing live-frame window; the last
            // good model stays the fallback replay meanwhile.
            pendingResetFrame = after;
            // Ink publishes the fullscreen decision for exactly this write;
            // consume it so the deferred anchor slots the window the way
            // log.sync() did (a later reset re-publishes its own).
            const marker = (stdout as unknown as Record<symbol, unknown>)[
              INK_RESET_FULLSCREEN
            ];
            pendingResetFullscreen =
              typeof marker === 'boolean' ? marker : undefined;
            delete (stdout as unknown as Record<symbol, unknown>)[
              INK_RESET_FULLSCREEN
            ];
            debugLogger.debug('reset', {
              pending: true,
              markerKnown: pendingResetFullscreen !== undefined,
            });
          } else {
            model.content = '';
          }
        } else {
          model.content = '';
        }
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
          // strays cannot clobber the model during idle. In VP the burst can
          // also settle into a bare incremental diff (a width shrink during
          // streaming redraws bare once, then diffs): that transforms the
          // frame just captured — storing a diff-shaped write as a frame
          // corrupts the model whether the diff applies or not.
          barePrintableCount++;
          if (isVP && applyIncrementalDiff(model, chunk, currentWidth)) {
            debugLogger.debug('diff', { applied: true, armed: true });
            expectFrame = false;
            barePrintableCount = 0;
          } else if (parseDiffHead(chunk) === null) {
            modelFrame(chunk, barePrintableCount > 1);
            if (barePrintableCount > 1) expectFrame = false;
          }
        }
      } else if (expectFirstFrame) {
        if (Date.now() >= handoffUntil) {
          expectFirstFrame = false;
          debugLogger.debug('first-frame', { state: 'expired' });
        } else if (stripAnsi(chunk).trim() !== '') {
          // The first VP frame arrives bare (no erase prefix); anchor the
          // model with it — every later frame is a diff against this one.
          expectFirstFrame = false;
          modelFrame(chunk, true);
          debugLogger.debug('first-frame', { state: 'captured' });
        }
      } else if (isVP && (pendingResetFrame !== '' || model.content !== '')) {
        // Incremental grow/same-height frame: apply it as a transform. After
        // a reset the anchor may still be pending — the diff's head count
        // names the synced live frame's height and validates the trailing
        // window to anchor on. Whole-chunk cursor suffixes (log.sync after a
        // reset write: cursorUp + cursorTo(0) + show when the composer sits
        // at column 0) parse as a diff head followed by an `ESC[1G` line-op
        // start, but carry no frame — anchoring on their moveUp count would
        // slot a one-line window.
        const diffHead = parseDiffHead(chunk);
        if (
          diffHead !== null &&
          pendingResetFrame !== '' &&
          startsWithLineOp(chunk, diffHead.pos) &&
          !CURSOR_SUFFIX_ONLY_RE.test(chunk)
        ) {
          anchorPendingReset(diffHead.headCount);
        }
        if (model.content !== '') {
          const applied = applyIncrementalDiff(model, chunk, currentWidth);
          debugLogger.debug('diff', { applied });
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
