/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * VP wake/SIGCONT repaint coverage for Ink's incremental rendering mode.
 *
 * Incremental frames are line diffs (cursorUp to the frame top, then
 * `ESC[E` keeps / `ESC[1G <content> ESC[K` rewrites per line) that never
 * match the erase-prefix pattern the interceptor models standard frames
 * from. These tests pin the model maintenance that keeps the wake repaint
 * replayable under that mode: without it repaint() blanks the viewport and
 * Ink writes zero bytes for unchanged output (the screen stays blank).
 */

import { EventEmitter } from 'node:events';
import { createElement, act, useState } from 'react';
import { Box, Text, render, type Instance } from 'ink';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ansiEscapes from 'ansi-escapes';
import { installTerminalResizeReflow } from './terminal-resize-reflow.js';
import { wrapForMultiplexer } from './osc8.js';

const ESC = '\u001B[';
const BSU = `${ESC}?2026h`;
const CURSOR_NEXT_LINE = `${ESC}E`;
const CURSOR_TO_COL0 = `${ESC}1G`;
const ERASE_END_LINE = `${ESC}K`;
const CURSOR_SHOW = `${ESC}?25h`;
const CURSOR_HIDE = `${ESC}?25l`;

// Production diff frames carry the return-to-bottom prefix whenever the
// input cursor was shown (the normal prompt state with a TextInput).
const RETURN_PREFIX = `${CURSOR_HIDE}${ESC}2B${CURSOR_TO_COL0}`;

// The patched Ink publishes its reset-write fullscreen decision under this
// key (patches/ink+7.0.3.patch); reset fixtures set it the way Ink does so
// the deferred anchor is tested against the production slot authority.
const INK_RESET_FULLSCREEN = Symbol.for('qwen.ink.resetFullscreen');

function frameLines(width: number, rows: number): string[] {
  return Array.from(
    { length: rows },
    (_, i) => `line-${i}-` + 'x'.repeat(width),
  );
}

/**
 * Builds an incremental diff frame exactly like the patched Ink
 * log-update createIncremental renderer: height branch, per-line ops,
 * optional return-to-bottom prefix and trailing cursor suffix.
 */
function incrementalDiffFrame(
  prev: string[],
  next: string[],
  opts: {
    trailingNewline: boolean;
    prevTrailingNewline?: boolean;
    returnPrefix?: string;
    cursorSuffix?: string;
  },
): string {
  const prevTrailingNewline = opts.prevTrailingNewline ?? false;
  let out = opts.returnPrefix ?? '';
  if (next.length < prev.length) {
    const extraSlot = prevTrailingNewline ? 1 : 0;
    out +=
      ansiEscapes.eraseLines(prev.length - next.length + extraSlot) +
      `${ESC}${next.length}A`;
  } else {
    out += `${ESC}${prev.length + (prevTrailingNewline ? 1 : 0) - 1}A`;
  }
  for (let i = 0; i < next.length; i++) {
    const isLast = i === next.length - 1;
    if (next[i] === prev[i]) {
      if (!isLast || opts.trailingNewline) out += CURSOR_NEXT_LINE;
      continue;
    }
    out +=
      CURSOR_TO_COL0 +
      next[i] +
      ERASE_END_LINE +
      (isLast && !opts.trailingNewline ? '' : '\n');
  }
  return out + (opts.cursorSuffix ?? '');
}

class FakeStdout extends EventEmitter {
  columns = 120;
  rows = 40;
  isTTY = true;
  written: string[] = [];
  write(chunk: string | Uint8Array, cb?: unknown): boolean {
    this.written.push(
      typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString(),
    );
    if (typeof cb === 'function') (cb as () => void)();
    return true;
  }
}

/**
 * Minimal alternate-screen grid emulator: replays raw byte streams the way a
 * non-reflowing terminal grid applies them (xterm.js alternate-buffer
 * semantics). Width shrinks truncate rows in place instead of re-wrapping
 * them — the physical condition an incremental diff's keep-ops cannot
 * survive once the viewport was cleared or resized under them.
 */
class MiniTerminal {
  private rows: string[];
  private row = 0;
  private col = 0;

  constructor(
    private width: number,
    private readonly height: number,
  ) {
    this.rows = Array.from({ length: height }, () => '');
  }

  resize(width: number): void {
    this.width = width;
    this.rows = this.rows.map((r) => r.slice(0, width));
    this.col = Math.min(this.col, width);
  }

  screenText(): string {
    return this.rows.map((r) => r.trimEnd()).join('\n');
  }

  private writeChar(char: string): void {
    if (this.col >= this.width) return;
    const current = this.rows[this.row] ?? '';
    this.rows[this.row] =
      current.slice(0, this.col) + char + current.slice(this.col + 1);
    this.col += 1;
  }

  feed(chunk: string): void {
    let i = 0;
    while (i < chunk.length) {
      const char = chunk[i]!;
      if (char === '\u001B') {
        if (chunk[i + 1] === '[') {
          // eslint-disable-next-line no-control-regex
          const m = /^\u001B\[([?]?)([\d;]*)([@-~])/.exec(chunk.slice(i));
          if (!m) break;
          const n = parseInt(m[2]!, 10) || 1;
          if (m[1] !== '?') {
            switch (m[3]) {
              case 'A':
                this.row = Math.max(0, this.row - n);
                break;
              case 'B':
                this.row = Math.min(this.height - 1, this.row + n);
                break;
              case 'C':
                this.col = Math.min(this.width, this.col + n);
                break;
              case 'D':
                this.col = Math.max(0, this.col - n);
                break;
              case 'E':
                this.row = Math.min(this.height - 1, this.row + n);
                this.col = 0;
                break;
              case 'F':
                this.row = Math.max(0, this.row - n);
                this.col = 0;
                break;
              case 'G':
                this.col = Math.min(this.width, n - 1);
                break;
              case 'H':
                this.row = 0;
                this.col = 0;
                break;
              case 'J':
                if (m[2] === '' || m[2] === '0') {
                  this.rows[this.row] = (this.rows[this.row] ?? '').slice(
                    0,
                    this.col,
                  );
                  for (let r = this.row + 1; r < this.height; r++) {
                    this.rows[r] = '';
                  }
                } else {
                  this.rows = Array.from({ length: this.height }, () => '');
                }
                break;
              case 'K':
                if (m[2] === '' || m[2] === '0') {
                  this.rows[this.row] = (this.rows[this.row] ?? '').slice(
                    0,
                    this.col,
                  );
                } else {
                  this.rows[this.row] = '';
                }
                break;
              default:
                break;
            }
          }
          i += m[0].length;
          continue;
        }
        if (chunk[i + 1] === ']') {
          const bel = chunk.indexOf('\u0007', i);
          const st = chunk.indexOf('\u001B\\', i);
          const end =
            bel !== -1 && (st === -1 || bel < st)
              ? bel + 1
              : st !== -1
                ? st + 2
                : chunk.length;
          i = end;
          continue;
        }
        i += 2;
        continue;
      }
      if (char === '\n') {
        if (this.row >= this.height - 1) {
          this.rows.shift();
          this.rows.push('');
        } else {
          this.row += 1;
        }
        this.col = 0;
        i++;
        continue;
      }
      if (char === '\r') {
        this.col = 0;
        i++;
        continue;
      }
      if (char === '\x07') {
        i++;
        continue;
      }
      this.writeChar(char);
      i++;
    }
  }
}

// Mirrors the patched Ink: renderInteractiveFrame publishes its fullscreen
// decision on the stream immediately before writing a clearTerminal reset.
const publishResetFullscreen = (stdout: FakeStdout, isFullscreen: boolean) => {
  (stdout as unknown as Record<symbol, unknown>)[INK_RESET_FULLSCREEN] =
    isFullscreen;
};

describe('installTerminalResizeReflow (VP incremental rendering)', () => {
  beforeEach(() => {
    vi.stubEnv('QWEN_CODE_LEGACY_RESIZE_ERASE', '');
    vi.stubEnv('QWEN_CODE_LEGACY_ERASE_LINES', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('tracks same-height diffs so repaint replays the updated frame', () => {
    const stdout = new FakeStdout();
    const { restore, repaint } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
      { virtualViewport: true },
    );
    try {
      const prev = frameLines(20, 10);
      stdout.write(ansiEscapes.eraseLines(10) + prev.join('\n'));
      const next = prev.slice();
      next[2] = 'CHANGED-LINE';
      stdout.write(
        incrementalDiffFrame(prev, next, {
          trailingNewline: false,
          returnPrefix: RETURN_PREFIX,
        }),
      );
      stdout.written.length = 0;
      repaint!();
      expect(stdout.written.length).toBe(1);
      const replay = stdout.written[0]!;
      expect(replay.startsWith(ansiEscapes.clearViewport)).toBe(true);
      expect(replay).toContain('CHANGED-LINE');
      expect(replay).toContain('line-0-');
      expect(replay).toContain('line-9-');
      expect(replay).not.toContain(prev[2]!);
    } finally {
      restore();
    }
  });

  it('tracks growing frames (appended lines)', () => {
    const stdout = new FakeStdout();
    const { restore, repaint } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
      { virtualViewport: true },
    );
    try {
      const prev = frameLines(20, 10);
      stdout.write(ansiEscapes.eraseLines(10) + prev.join('\n'));
      const next = [...prev, 'appended-a', 'appended-b'];
      stdout.write(
        incrementalDiffFrame(prev, next, { trailingNewline: false }),
      );
      stdout.written.length = 0;
      repaint!();
      const replay = stdout.written[0]!;
      expect(replay).toContain('appended-a\nappended-b');
    } finally {
      restore();
    }
  });

  it('tracks height-shrink diffs arriving behind an erase prefix', () => {
    const stdout = new FakeStdout();
    const { restore, repaint } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
      { virtualViewport: true },
    );
    try {
      const prev = frameLines(20, 10);
      stdout.write(ansiEscapes.eraseLines(10) + prev.join('\n'));
      const next = prev.slice(0, 6);
      next[1] = 'CHANGED-LINE';
      stdout.write(
        incrementalDiffFrame(prev, next, { trailingNewline: false }),
      );
      stdout.written.length = 0;
      repaint!();
      const replay = stdout.written[0]!;
      expect(replay).toContain('CHANGED-LINE');
      expect(replay).toContain('line-5-');
      expect(replay).not.toContain('line-6-');
    } finally {
      restore();
    }
  });

  it('rewrites an erase-prefixed shrink diff inside the clear window to a full repaint', () => {
    const stdout = new FakeStdout();
    const { restore, repaint } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
      { virtualViewport: true },
    );
    try {
      const prev = frameLines(20, 10);
      stdout.write(ansiEscapes.eraseLines(10) + prev.join('\n'));
      // A width shrink arms the clear window: ordinary erase-prefixed writes
      // get their erase prefix swapped for CLEAR_VIEWPORT while it is armed.
      // An incremental shrink diff inside the window cannot paint its kept
      // lines onto the resized viewport either — it must become a full
      // repaint of the transformed frame, not a raw pass-through.
      stdout.columns = 12;
      stdout.emit('resize');
      const next = prev.slice(0, 6);
      next[1] = 'CHANGED-LINE';
      const diff = incrementalDiffFrame(prev, next, {
        trailingNewline: false,
        returnPrefix: RETURN_PREFIX,
      });
      stdout.written.length = 0;
      stdout.write(diff);
      expect(stdout.written).toEqual([
        RETURN_PREFIX + ansiEscapes.clearViewport + next.join('\n'),
      ]);
      stdout.written.length = 0;
      repaint!();
      const replay = stdout.written[0]!;
      expect(replay).toContain('CHANGED-LINE');
      expect(replay).toContain('line-5-');
      expect(replay).not.toContain('line-6-');
    } finally {
      restore();
    }
  });

  it('repaints a bare diff armed in the clear window instead of corrupting the resized grid', () => {
    // Production capture from the #9970 review: after a width shrink, Ink's
    // resized() clear-only erase is rewritten to a viewport clear, and the
    // post-shrink redraw can arrive as a bare incremental diff computed
    // against the PRE-shrink frame. Passing that diff through left the
    // cleared grid with only the rewritten lines — the composer row
    // vanished. The armed diff must become a full repaint.
    const stdout = new FakeStdout();
    const { restore } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
      { virtualViewport: true },
    );
    const term = new MiniTerminal(100, 32);
    const feedWritten = () => {
      for (const w of stdout.written) term.feed(w);
      stdout.written.length = 0;
    };
    try {
      const prev = [
        ...frameLines(20, 10),
        '> and now a follow-up line that fits',
      ];
      stdout.write(ansiEscapes.eraseLines(11) + prev.join('\n'));
      feedWritten();
      expect(term.screenText()).toContain('and now a follow-up');

      // Shrink to 70: the grid truncates without reflow and the interceptor
      // arms the clear window.
      term.resize(70);
      stdout.columns = 70;
      stdout.emit('resize');
      stdout.write(RETURN_PREFIX + ansiEscapes.eraseLines(11));
      feedWritten();

      // The redraw arrives as a bare diff against the pre-shrink frame: it
      // rewrites one line and keeps the rest, composer included.
      const next = prev.slice();
      next[3] = 'reflowed-line-three';
      stdout.write(
        incrementalDiffFrame(prev, next, {
          trailingNewline: false,
          returnPrefix: RETURN_PREFIX,
        }),
      );
      feedWritten();

      const screen = term.screenText();
      expect(screen).toContain('reflowed-line-three');
      expect(screen).toContain('and now a follow-up');
      expect(screen).toContain('line-0-');
      expect(screen).toContain('line-9-');
    } finally {
      restore();
    }
  });

  it('repaints an unarmed bare diff inside the clear window instead of passing it through', () => {
    const stdout = new FakeStdout();
    const { restore } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
      { virtualViewport: true },
    );
    try {
      const prev = frameLines(20, 10);
      stdout.write(ansiEscapes.eraseLines(10) + prev.join('\n'));
      // Width shrink arms the clear window; a bare diff can land inside it
      // without any clear-only write arming the handoff.
      stdout.columns = 12;
      stdout.emit('resize');
      const next = prev.slice();
      next[2] = 'WINDOW-UPDATE';
      const diff = incrementalDiffFrame(prev, next, {
        trailingNewline: false,
        returnPrefix: RETURN_PREFIX,
      });
      stdout.written.length = 0;
      stdout.write(diff);
      expect(stdout.written).toEqual([
        ansiEscapes.clearViewport + next.join('\n'),
      ]);
    } finally {
      restore();
    }
  });

  it('repaints a stale erase-prefixed diff inside the clear window', () => {
    const stdout = new FakeStdout();
    const { restore } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
      { virtualViewport: true },
    );
    try {
      const prev = frameLines(20, 10);
      stdout.write(ansiEscapes.eraseLines(10) + prev.join('\n'));
      const rejected = prev.slice();
      rejected[4] = `unsupported-${ESC}6n-content`;
      stdout.write(
        incrementalDiffFrame(prev, rejected, {
          trailingNewline: false,
          returnPrefix: RETURN_PREFIX,
        }),
      );

      stdout.columns = 12;
      stdout.emit('resize');
      const next = rejected.slice(0, 6);
      next[1] = 'NEW-LINE';
      stdout.written.length = 0;
      stdout.write(
        incrementalDiffFrame(rejected, next, {
          trailingNewline: false,
          returnPrefix: RETURN_PREFIX,
        }),
      );
      expect(stdout.written).toEqual([
        RETURN_PREFIX + ansiEscapes.clearViewport + prev.join('\n'),
      ]);
    } finally {
      restore();
    }
  });

  it('repaints a rejected armed diff inside the clear window', () => {
    const stdout = new FakeStdout();
    const { restore } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
      { virtualViewport: true },
    );
    try {
      const prev = frameLines(20, 10);
      stdout.write(ansiEscapes.eraseLines(10) + prev.join('\n'));
      stdout.columns = 12;
      stdout.emit('resize');
      stdout.write(RETURN_PREFIX + ansiEscapes.eraseLines(10));

      const rejected = prev.slice();
      rejected[4] = `unsupported-${ESC}6n-content`;
      stdout.written.length = 0;
      stdout.write(
        incrementalDiffFrame(prev, rejected, {
          trailingNewline: false,
          returnPrefix: RETURN_PREFIX,
        }),
      );
      expect(stdout.written).toEqual([
        ansiEscapes.clearViewport + prev.join('\n'),
      ]);
    } finally {
      restore();
    }
  });

  it('repaints a stale idle diff inside the clear window', () => {
    const stdout = new FakeStdout();
    const { restore } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
      { virtualViewport: true },
    );
    try {
      const prev = frameLines(20, 10);
      stdout.write(ansiEscapes.eraseLines(10) + prev.join('\n'));
      const rejected = prev.slice();
      rejected[4] = `unsupported-${ESC}6n-content`;
      stdout.write(
        incrementalDiffFrame(prev, rejected, {
          trailingNewline: false,
          returnPrefix: RETURN_PREFIX,
        }),
      );

      stdout.columns = 12;
      stdout.emit('resize');
      const followUp = rejected.slice();
      followUp[0] = 'FOLLOW-UP-MUST-NOT-MIX';
      stdout.written.length = 0;
      stdout.write(
        incrementalDiffFrame(rejected, followUp, {
          trailingNewline: false,
          returnPrefix: RETURN_PREFIX,
        }),
      );
      expect(stdout.written).toEqual([
        ansiEscapes.clearViewport + prev.join('\n'),
      ]);
    } finally {
      restore();
    }
  });

  it('does not clobber the frame model on a mid-content erase sequence', () => {
    // R10-1: a benign write merely CONTAINING eraseLines(1) mid-content
    // (echoed nested-TUI output, a library writing stdout directly) is not
    // an erase-prefixed frame write. The erase match must anchor to the
    // write head; otherwise the tail after the mid-content match clobbers
    // the frame model and the wake repaint replays the fragment.
    const stdout = new FakeStdout();
    const { restore, repaint } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
      { virtualViewport: true },
    );
    try {
      const frame = frameLines(20, 10);
      stdout.write(ansiEscapes.eraseLines(10) + frame.join('\n'));
      stdout.write(`log ${ESC}2K${ESC}G noise`);
      stdout.written.length = 0;
      repaint!();
      expect(stdout.written.length).toBe(1);
      const replay = stdout.written[0]!;
      expect(replay.startsWith(ansiEscapes.clearViewport)).toBe(true);
      // The anchored frame survives; the log fragment does not replace it.
      expect(replay).toContain('line-0-');
      expect(replay).toContain('line-9-');
      expect(replay).not.toContain(' noise');
    } finally {
      restore();
    }
  });

  it('passes a mid-content erase write through an armed clear window unspliced', () => {
    // R10-1 clear-window variant: inside the post-shrink window, ordinary
    // erase-prefixed writes get CLEAR_VIEWPORT spliced in — a write only
    // CONTAINING the erase sequence mid-content must pass through as-is,
    // not blank the screen mid-log-write.
    const stdout = new FakeStdout();
    const { restore } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
      { virtualViewport: true },
    );
    try {
      const frame = frameLines(20, 10);
      stdout.write(ansiEscapes.eraseLines(10) + frame.join('\n'));
      stdout.columns = 12;
      stdout.emit('resize');
      const write = `log ${ESC}2K${ESC}G noise`;
      stdout.written.length = 0;
      stdout.write(write);
      expect(stdout.written).toEqual([write]);
    } finally {
      restore();
    }
  });
  it('does not clobber the frame model on a mid-content clearTerminal sequence', () => {
    // R11-6: a benign write merely CONTAINING clearTerminal mid-content
    // (echoed nested-TUI output, a library writing stdout directly) is not
    // a reset write. The reset match must anchor to the write head the way
    // the erase match does; otherwise the junk tail arms a pending reset
    // that the next genuine diff slots into the model, replacing the live
    // frame with the fragment.
    const stdout = new FakeStdout();
    const { restore, repaint } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
      { virtualViewport: true },
    );
    try {
      const frame = frameLines(20, 10);
      stdout.write(ansiEscapes.eraseLines(10) + frame.join('\n'));
      const junk = Array.from(
        { length: 10 },
        (_, i) => `JUNK-${i}-` + 'z'.repeat(20),
      );
      stdout.write(`log ${ansiEscapes.clearTerminal}${junk.join('\n')}`);
      stdout.written.length = 0;
      repaint!();
      expect(stdout.written.length).toBe(1);
      let replay = stdout.written[0]!;
      expect(replay.startsWith(ansiEscapes.clearViewport)).toBe(true);
      // The anchored frame survives the junk write.
      expect(replay).toContain('line-0-');
      expect(replay).toContain('line-9-');
      expect(replay).not.toContain('JUNK-');
      // A following genuine diff still applies to the anchored frame.
      const next = frame.slice();
      next[3] = 'AFTER-NOISE-UPDATE';
      stdout.write(
        incrementalDiffFrame(frame, next, {
          trailingNewline: false,
          returnPrefix: RETURN_PREFIX,
        }),
      );
      stdout.written.length = 0;
      repaint!();
      replay = stdout.written[0]!;
      expect(replay).toContain('AFTER-NOISE-UPDATE');
      expect(replay).toContain('line-0-');
      expect(replay).toContain('line-9-');
      expect(replay).not.toContain('JUNK-');
    } finally {
      restore();
    }
  });

  it('does not blank the frame model on a mid-content clearTerminal with an empty tail', () => {
    // R11-6 empty-tail variant: a mid-content match whose tail is empty
    // would hit the alternate-screen-entry sub-branch — blanking a good
    // model and arming expectFirstFrame — unless the reset match is
    // anchored to the write head.
    const stdout = new FakeStdout();
    const { restore, repaint } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
      { virtualViewport: true },
    );
    try {
      const frame = frameLines(20, 10);
      stdout.write(ansiEscapes.eraseLines(10) + frame.join('\n'));
      stdout.write(`log ${ansiEscapes.clearTerminal}`);
      stdout.written.length = 0;
      repaint!();
      expect(stdout.written.length).toBe(1);
      const replay = stdout.written[0]!;
      expect(replay.startsWith(ansiEscapes.clearViewport)).toBe(true);
      expect(replay).toContain('line-0-');
      expect(replay).toContain('line-9-');
    } finally {
      restore();
    }
  });

  it('preserves trailing cursor suffixes across diff application', () => {
    const stdout = new FakeStdout();
    const { restore, repaint } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
      { virtualViewport: true },
    );
    try {
      const prev = frameLines(20, 10);
      stdout.write(ansiEscapes.eraseLines(10) + prev.join('\n'));
      const next = prev.slice();
      next[3] = 'CHANGED-LINE';
      const suffix = `${ESC}3A${ESC}5G${CURSOR_SHOW}`;
      stdout.write(
        incrementalDiffFrame(prev, next, {
          trailingNewline: false,
          cursorSuffix: suffix,
        }),
      );
      stdout.written.length = 0;
      repaint!();
      const replay = stdout.written[0]!;
      expect(replay).toContain('CHANGED-LINE');
      expect(replay.endsWith(suffix)).toBe(true);
    } finally {
      restore();
    }
  });

  it('handles the bottom-row cursor suffix (no cursorUp before it)', () => {
    const stdout = new FakeStdout();
    const { restore, repaint } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
      { virtualViewport: true },
    );
    try {
      const prev = frameLines(20, 10);
      stdout.write(ansiEscapes.eraseLines(10) + prev.join('\n'));
      const next = prev.slice();
      next[9] = 'BOTTOM-LINE';
      // Composer on the last row: moveUp is 0, suffix is cursorTo + show.
      const suffix = `${ESC}1G${CURSOR_SHOW}`;
      stdout.write(
        incrementalDiffFrame(prev, next, {
          trailingNewline: false,
          cursorSuffix: suffix,
        }),
      );
      stdout.written.length = 0;
      repaint!();
      const replay = stdout.written[0]!;
      expect(replay).toContain('BOTTOM-LINE');
      expect(replay.endsWith(suffix)).toBe(true);
    } finally {
      restore();
    }
  });

  it('keeps the last good frame when a diff does not match the model', () => {
    const stdout = new FakeStdout();
    const { restore, repaint } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
      { virtualViewport: true },
    );
    try {
      const prev = frameLines(20, 10);
      stdout.write(ansiEscapes.eraseLines(10) + prev.join('\n'));
      // Leading cursorUp count contradicts the modeled frame (9 expected).
      const drifted = `${ESC}5A${CURSOR_NEXT_LINE}${CURSOR_TO_COL0}HIJACK${ERASE_END_LINE}`;
      stdout.write(drifted);
      stdout.written.length = 0;
      repaint!();
      const replay = stdout.written[0]!;
      expect(replay).not.toContain('HIJACK');
      expect(replay).toContain('line-0-');
      expect(replay).toContain('line-9-');
    } finally {
      restore();
    }
  });

  it('ignores cursor-only updates and noise writes', () => {
    const stdout = new FakeStdout();
    const { restore, repaint } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
      { virtualViewport: true },
    );
    try {
      const prev = frameLines(20, 10);
      stdout.write(ansiEscapes.eraseLines(10) + prev.join('\n'));
      stdout.write(
        `${CURSOR_HIDE}${ESC}3B${CURSOR_TO_COL0}${ESC}2A${ESC}5G${CURSOR_SHOW}`,
      );
      stdout.write('\x07');
      stdout.write('short console noise');
      stdout.written.length = 0;
      repaint!();
      const replay = stdout.written[0]!;
      expect(replay).toContain('line-0-');
      expect(replay).toContain('line-9-');
    } finally {
      restore();
    }
  });

  it('anchors the first bare frame after the alternate-screen entry clear', () => {
    const stdout = new FakeStdout();
    const { restore, repaint } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
      { virtualViewport: true },
    );
    try {
      stdout.write(ansiEscapes.clearTerminal);
      // The synchronized-output control write must not consume the arm.
      stdout.write(BSU);
      const lines = frameLines(60, 12);
      stdout.write(lines.join('\n'));
      stdout.written.length = 0;
      repaint!();
      const replay = stdout.written[0]!;
      expect(replay).toContain('line-0-');
      expect(replay).toContain('line-11-');
    } finally {
      restore();
    }
  });

  it('anchors a fullscreen overflow reset through the next diff', () => {
    const stdout = new FakeStdout();
    const { restore, repaint } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
      { virtualViewport: true },
    );
    try {
      const prev = frameLines(20, 10);
      stdout.write(ansiEscapes.eraseLines(10) + prev.join('\n'));
      // Fullscreen reset (45 lines >= 40 viewport rows): Ink syncs without
      // a trailing-newline slot and the next diff's cursorUp reflects that.
      // Deliberately no published decision: this pins the wrapped-height
      // classifier fallback for reset writers that do not publish one.
      const reset = frameLines(60, 45);
      stdout.write(ansiEscapes.clearTerminal + reset.join('\n'));
      const next = reset.slice();
      next[44] = 'AFTER-RESET';
      stdout.write(
        incrementalDiffFrame(reset, next, {
          trailingNewline: false,
          returnPrefix: RETURN_PREFIX,
        }),
      );
      stdout.written.length = 0;
      repaint!();
      const replay = stdout.written[0]!;
      expect(replay).toContain('AFTER-RESET');
      expect(replay).toContain('line-0-');
    } finally {
      restore();
    }
  });

  it('applies a bare diff that follows the post-shrink bare redraw', () => {
    const stdout = new FakeStdout();
    const { restore, repaint } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
      { virtualViewport: true },
    );
    try {
      const prev = frameLines(20, 10);
      stdout.write(ansiEscapes.eraseLines(10) + prev.join('\n'));
      // Width shrink mid-stream: Ink's resized() writes a clear-only erase
      // (arming the handoff) and redraws the full frame bare; the next
      // throttled render is already a bare incremental diff.
      stdout.columns = 12;
      stdout.emit('resize');
      stdout.write(RETURN_PREFIX + ansiEscapes.eraseLines(10));
      stdout.write(prev.join('\n'));
      const next = prev.slice();
      next[4] = 'STREAMED-UPDATE-1';
      stdout.write(
        incrementalDiffFrame(prev, next, {
          trailingNewline: false,
          returnPrefix: RETURN_PREFIX,
        }),
      );
      const next2 = next.slice();
      next2[7] = 'STREAMED-UPDATE-2';
      stdout.write(
        incrementalDiffFrame(next, next2, {
          trailingNewline: false,
          returnPrefix: RETURN_PREFIX,
        }),
      );
      stdout.written.length = 0;
      repaint!();
      const replay = stdout.written[0]!;
      expect(replay).toContain('line-0-');
      expect(replay).toContain('line-9-');
      expect(replay).toContain('STREAMED-UPDATE-1');
      expect(replay).toContain('STREAMED-UPDATE-2');
    } finally {
      restore();
    }
  });

  it('recovers when the post-shrink bare frame lands after the handoff window', () => {
    const stdout = new FakeStdout();
    const { restore, repaint } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
      { virtualViewport: true },
    );
    const dateNow = vi.spyOn(Date, 'now');
    try {
      let now = 1_000_000;
      dateNow.mockImplementation(() => now);
      const prev = frameLines(20, 10);
      stdout.write(ansiEscapes.eraseLines(10) + prev.join('\n'));
      // Width shrink arms the bare-write handoff; the throttled re-render
      // of the re-laid-out tree lands AFTER the window expires. The stale
      // pre-shrink model (10 lines) and the post-shrink frame (14 wrapped
      // lines) differ in height, so every later diff fails the head
      // equation against the stale model unless the late frame is
      // captured.
      stdout.columns = 12;
      stdout.emit('resize');
      stdout.write(RETURN_PREFIX + ansiEscapes.eraseLines(10));
      now += 100; // past the 50 ms handoff window
      const redrawn = frameLines(8, 14).map((line) => `${line}-late`);
      stdout.write(redrawn.join('\n'));
      const next = redrawn.slice();
      next[4] = 'LATE-UPDATE';
      stdout.write(
        incrementalDiffFrame(redrawn, next, {
          trailingNewline: false,
          returnPrefix: RETURN_PREFIX,
        }),
      );
      stdout.written.length = 0;
      repaint!();
      const replay = stdout.written[0]!;
      expect(replay).not.toBe(ansiEscapes.clearViewport);
      expect(replay).toContain('LATE-UPDATE');
      expect(replay).toContain('line-0-');
      expect(replay).toContain('line-13-');
    } finally {
      dateNow.mockRestore();
      restore();
    }
  });

  it('captures a late two-write burst whose append stored nothing', () => {
    const stdout = new FakeStdout();
    const { restore, repaint } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
      { virtualViewport: true },
    );
    const dateNow = vi.spyOn(Date, 'now');
    try {
      let now = 1_000_000;
      dateNow.mockImplementation(() => now);
      const prev = frameLines(20, 10);
      stdout.write(ansiEscapes.eraseLines(10) + prev.join('\n'));
      // Width shrink arms the bare-write handoff via the clear-only erase;
      // the commit burst then lands as TWO bare writes after the window
      // expires: a short static append followed by the live-frame redraw.
      stdout.columns = 12;
      stdout.emit('resize');
      stdout.write(RETURN_PREFIX + ansiEscapes.eraseLines(10));
      now += 100; // past the 50 ms handoff window
      // The append is below MIN_FRAME_LINES: modelFrame rejects it and
      // stores nothing. The late-burst exception must survive this
      // rejected write so the redraw that follows is still capturable —
      // keying it on the write count instead of on whether a frame was
      // captured drops the redraw and freezes the stale model.
      stdout.write('static append');
      const redrawn = frameLines(8, 14).map((line) => `${line}-late2`);
      stdout.write(redrawn.join('\n'));
      const next = redrawn.slice();
      next[4] = 'LATE-UPDATE-2';
      stdout.write(
        incrementalDiffFrame(redrawn, next, {
          trailingNewline: false,
          returnPrefix: RETURN_PREFIX,
        }),
      );
      stdout.written.length = 0;
      repaint!();
      const replay = stdout.written[0]!;
      expect(replay).not.toBe(ansiEscapes.clearViewport);
      expect(replay).toContain('LATE-UPDATE-2');
      expect(replay).toContain('line-0-');
      expect(replay).toContain('line-13-');
    } finally {
      dateNow.mockRestore();
      restore();
    }
  });

  it('captures a late two-write burst whose stored append precedes the live frame', () => {
    const stdout = new FakeStdout();
    const { restore, repaint } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
      { virtualViewport: true },
    );
    const dateNow = vi.spyOn(Date, 'now');
    try {
      let now = 1_000_000;
      dateNow.mockImplementation(() => now);
      const prev = frameLines(20, 10);
      stdout.write(ansiEscapes.eraseLines(10) + prev.join('\n'));
      // Width shrink arms the bare-write handoff via the clear-only erase;
      // the commit burst then lands as TWO bare writes after the window
      // expires, and the static append is tall enough to be stored. The
      // stored append must not be mistaken for the captured live frame:
      // the redraw that follows still has to be captured, or the model
      // freezes on the append and every later diff fails the head equation.
      stdout.columns = 12;
      stdout.emit('resize');
      stdout.write(RETURN_PREFIX + ansiEscapes.eraseLines(10));
      now += 100; // past the 50 ms handoff window
      const append = frameLines(20, 10).map((line) => `append-${line}`);
      stdout.write(append.join('\n')); // >= MIN_FRAME_LINES: stored
      const redrawn = frameLines(8, 14).map((line) => `${line}-late3`);
      stdout.write(redrawn.join('\n'));
      const next = redrawn.slice();
      next[4] = 'LATE-UPDATE-3';
      stdout.write(
        incrementalDiffFrame(redrawn, next, {
          trailingNewline: false,
          returnPrefix: RETURN_PREFIX,
        }),
      );
      stdout.written.length = 0;
      repaint!();
      const replay = stdout.written[0]!;
      expect(replay).not.toBe(ansiEscapes.clearViewport);
      expect(replay).toContain('LATE-UPDATE-3');
      expect(replay).toContain('line-13-');
      expect(replay).not.toContain('append-line-');
    } finally {
      dateNow.mockRestore();
      restore();
    }
  });

  it('captures the first VP frame when it lands long after the entry clear', () => {
    const stdout = new FakeStdout();
    const { restore, repaint } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
      { virtualViewport: true },
    );
    const dateNow = vi.spyOn(Date, 'now');
    try {
      let now = 1_000_000;
      dateNow.mockImplementation(() => now);
      // Alternate-screen entry: the clear arms first-frame capture.
      stdout.write(ansiEscapes.clearTerminal);
      // Slow boot: the reconciliation + flush of the first frame lands far
      // past any short handoff window. Ink owns the just-cleared screen, so
      // the first bare printable write is the first frame regardless.
      now += 500;
      const first = frameLines(20, 12);
      stdout.write(first.join('\n'));
      const next = first.slice();
      next[3] = 'AFTER-BOOT-UPDATE';
      stdout.write(
        incrementalDiffFrame(first, next, { trailingNewline: false }),
      );
      stdout.written.length = 0;
      repaint!();
      const replay = stdout.written[0]!;
      expect(replay).not.toBe(ansiEscapes.clearViewport);
      expect(replay).toContain('line-0-');
      expect(replay).toContain('line-11-');
      expect(replay).toContain('AFTER-BOOT-UPDATE');
    } finally {
      dateNow.mockRestore();
      restore();
    }
  });
  it('does not force-store a bare diff off a sticky first-frame arm', () => {
    // R11-3: the alternate-screen entry clear arms expectFirstFrame; a
    // clear-only erase write (Ink log.clear) arms the handoff burst before
    // the first bare frame lands. The burst's capture/disarm transitions
    // must clear expectFirstFrame too — otherwise the sticky arm later
    // force-stores a bare incremental diff as the model frame, bypassing
    // MIN_FRAME_LINES, and every following diff fails the head-count
    // equation against the corrupt model.
    const stdout = new FakeStdout();
    const { restore, repaint } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
      { virtualViewport: true },
    );
    try {
      stdout.write(ansiEscapes.clearTerminal);
      stdout.write(RETURN_PREFIX + ansiEscapes.eraseLines(12));
      const frame = frameLines(20, 12);
      stdout.write(frame.join('\n'));
      const next = frame.slice();
      next[2] = 'DIFF-ONE';
      stdout.write(
        incrementalDiffFrame(frame, next, {
          trailingNewline: false,
          returnPrefix: RETURN_PREFIX,
        }),
      );
      const next2 = next.slice();
      next2[5] = 'DIFF-TWO';
      stdout.write(
        incrementalDiffFrame(next, next2, {
          trailingNewline: false,
          returnPrefix: RETURN_PREFIX,
        }),
      );
      stdout.written.length = 0;
      repaint!();
      expect(stdout.written.length).toBe(1);
      const replay = stdout.written[0]!;
      expect(replay.startsWith(ansiEscapes.clearViewport)).toBe(true);
      expect(replay).toContain('DIFF-ONE');
      expect(replay).toContain('DIFF-TWO');
      expect(replay).toContain('line-0-');
      expect(replay).toContain('line-11-');
      // The stored model is frame content — never raw diff ops.
      expect(replay.slice(ansiEscapes.clearViewport.length)).not.toContain(
        '\u001B',
      );
    } finally {
      restore();
    }
  });

  it('a post-window stray bell cannot clobber a captured single-write VP burst', () => {
    const stdout = new FakeStdout();
    const { restore, repaint } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
      { virtualViewport: true },
    );
    const dateNow = vi.spyOn(Date, 'now');
    try {
      let now = 1_000_000;
      dateNow.mockImplementation(() => now);
      const prev = frameLines(20, 10);
      stdout.write(ansiEscapes.eraseLines(10) + prev.join('\n'));
      // Shrink arms the handoff; the single bare redraw is captured inside
      // the window, then a stray bell arrives after the window expires.
      stdout.columns = 12;
      stdout.emit('resize');
      stdout.write(RETURN_PREFIX + ansiEscapes.eraseLines(10));
      stdout.write(prev.join('\n')); // bare redraw: captured, position 1
      now += 100; // past the 50 ms handoff window
      stdout.write('\x07'); // notification bell: must not become the model
      stdout.written.length = 0;
      repaint!();
      // The wake repaint replays the captured frame — not CLEAR_VIEWPORT
      // plus the bell.
      expect(stdout.written).toEqual([
        ansiEscapes.clearViewport + prev.join('\n'),
      ]);
    } finally {
      dateNow.mockRestore();
      restore();
    }
  });

  it('anchors only the live frame when a reset carries <Static> transcript', () => {
    const stdout = new FakeStdout();
    const { restore, repaint } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
      { virtualViewport: true },
    );
    try {
      const prev = frameLines(20, 10);
      stdout.write(ansiEscapes.eraseLines(10) + prev.join('\n'));
      // A VP overflow reset re-emits committed agent-tab history (<Static>)
      // ahead of the live frame, while Ink syncs its diff state to the live
      // frame only (with the trailing-newline slot of a non-fullscreen
      // frame).
      const transcript = ['committed-a', 'committed-b', 'committed-c'];
      const reset = frameLines(20, 10).map((line) => `${line}-r2`);
      publishResetFullscreen(stdout, false);
      stdout.write(
        ansiEscapes.clearTerminal +
          transcript.join('\n') +
          '\n' +
          reset.join('\n') +
          '\n',
      );
      const next = reset.slice();
      next[5] = 'POST-RESET-UPDATE';
      stdout.write(
        incrementalDiffFrame(reset, next, {
          trailingNewline: true,
          prevTrailingNewline: true,
          returnPrefix: RETURN_PREFIX,
        }),
      );
      // The real second diff after a slotted reset keeps the slot
      // (consumed >= lines.length): both updates must land.
      const next2 = next.slice();
      next2[7] = 'SECOND-UPDATE';
      stdout.write(
        incrementalDiffFrame(next, next2, {
          trailingNewline: true,
          prevTrailingNewline: true,
          returnPrefix: RETURN_PREFIX,
        }),
      );
      stdout.written.length = 0;
      repaint!();
      const replay = stdout.written[0]!;
      expect(replay).toContain('POST-RESET-UPDATE');
      expect(replay).toContain('SECOND-UPDATE');
      expect(replay).toContain('line-0-');
      expect(replay).not.toContain('committed-');
    } finally {
      restore();
    }
  });

  it('rebuilds the trailing-newline slot of a leaving-fullscreen reset', () => {
    const stdout = new FakeStdout();
    const { restore, repaint } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
      { virtualViewport: true },
    );
    try {
      const prev = frameLines(20, 45);
      stdout.write(ansiEscapes.eraseLines(45) + prev.join('\n'));
      // The reply collapses below the viewport: Ink writes clearTerminal +
      // outputToRender, which carries the synced trailing-newline slot of the
      // new sub-viewport frame (Ink publishes non-fullscreen). The next
      // same-height diff carries cursorUp(lines), reflecting the slot.
      const reset = frameLines(20, 30).map((line) => `${line}-r3`);
      publishResetFullscreen(stdout, false);
      stdout.write(ansiEscapes.clearTerminal + reset.join('\n') + '\n');
      const next = reset.slice();
      next[2] = 'COLLAPSED-UPDATE';
      stdout.write(
        incrementalDiffFrame(reset, next, {
          trailingNewline: true,
          prevTrailingNewline: true,
          returnPrefix: RETURN_PREFIX,
        }),
      );
      stdout.written.length = 0;
      repaint!();
      const replay = stdout.written[0]!;
      expect(replay).toContain('COLLAPSED-UPDATE');
      expect(replay).toContain('line-0-');
    } finally {
      restore();
    }
  });

  it('drops a pending reset anchor when a shrink re-anchors the model', () => {
    const stdout = new FakeStdout();
    const { restore, repaint } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
      { virtualViewport: true },
    );
    try {
      const prev = frameLines(20, 10);
      stdout.write(ansiEscapes.eraseLines(10) + prev.join('\n'));
      const transcript = ['committed-x', 'committed-y'];
      const reset = frameLines(20, 10).map((line) => `${line}-r5`);
      publishResetFullscreen(stdout, false);
      stdout.write(
        ansiEscapes.clearTerminal +
          transcript.join('\n') +
          '\n' +
          reset.join('\n'),
      );
      // A width shrink lands before any diff: Ink clears and redraws the
      // full frame bare, which re-anchors the model outright.
      stdout.columns = 12;
      stdout.emit('resize');
      stdout.write(RETURN_PREFIX + ansiEscapes.eraseLines(10));
      const redrawn = frameLines(8, 10).map((line) => `${line}-narrow`);
      stdout.write(redrawn.join('\n'));
      const next = redrawn.slice();
      next[6] = 'NARROW-UPDATE';
      stdout.write(
        incrementalDiffFrame(redrawn, next, {
          trailingNewline: false,
          returnPrefix: RETURN_PREFIX,
        }),
      );
      const next2 = next.slice();
      next2[8] = 'NARROW-UPDATE-2';
      stdout.write(
        incrementalDiffFrame(next, next2, {
          trailingNewline: false,
          returnPrefix: RETURN_PREFIX,
        }),
      );
      stdout.written.length = 0;
      repaint!();
      const replay = stdout.written[0]!;
      expect(replay).toContain('NARROW-UPDATE');
      expect(replay).toContain('NARROW-UPDATE-2');
      expect(replay).toContain('-narrow');
      expect(replay).not.toContain('committed-');
      expect(replay).not.toContain('-r5');
    } finally {
      restore();
    }
  });

  it('does not anchor a pending reset on a cursor-only update', () => {
    const stdout = new FakeStdout();
    const { restore, repaint } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
      { virtualViewport: true },
    );
    try {
      const prev = frameLines(20, 10);
      stdout.write(ansiEscapes.eraseLines(10) + prev.join('\n'));
      const reset = frameLines(20, 10).map((line) => `${line}-rc`);
      publishResetFullscreen(stdout, false);
      stdout.write(ansiEscapes.clearTerminal + reset.join('\n'));
      // Cursor-only update (output unchanged): carries a leading cursorUp
      // but no line ops, so it must not trigger the deferred anchor.
      stdout.write(
        `${CURSOR_HIDE}${ESC}2B${CURSOR_TO_COL0}${ESC}2A${ESC}5G${CURSOR_SHOW}`,
      );
      const next = reset.slice();
      next[3] = 'AFTER-CURSOR-MOVE';
      stdout.write(
        incrementalDiffFrame(reset, next, {
          trailingNewline: true,
          prevTrailingNewline: true,
          returnPrefix: RETURN_PREFIX,
        }),
      );
      stdout.written.length = 0;
      repaint!();
      const replay = stdout.written[0]!;
      expect(replay).toContain('AFTER-CURSOR-MOVE');
      expect(replay).toContain('line-0-');
      expect(replay).toContain('-rc');
    } finally {
      restore();
    }
  });

  it('does not anchor a pending reset on a column-0 cursor-only sequence', () => {
    const stdout = new FakeStdout();
    const { restore, repaint } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
      { virtualViewport: true },
    );
    try {
      const prev = frameLines(20, 10);
      stdout.write(ansiEscapes.eraseLines(10) + prev.join('\n'));
      const reset = frameLines(20, 10).map((line) => `${line}-rco`);
      publishResetFullscreen(stdout, false);
      stdout.write(ansiEscapes.clearTerminal + reset.join('\n'));
      // Ink's buildCursorOnlySequence with the composer at column 0:
      // hide + return-to-bottom + cursorUp + cursorTo(0) + show. The
      // trailing ESC[1G parses as a line-op start, but the write carries
      // no frame — its moveUp count must not name the anchoring window.
      stdout.write(
        `${CURSOR_HIDE}${ESC}2B${CURSOR_TO_COL0}${ESC}2A${ESC}1G${CURSOR_SHOW}`,
      );
      const next = reset.slice();
      next[6] = 'AFTER-CARET-MOVE';
      stdout.write(
        incrementalDiffFrame(reset, next, {
          trailingNewline: true,
          prevTrailingNewline: true,
          returnPrefix: RETURN_PREFIX,
        }),
      );
      stdout.written.length = 0;
      repaint!();
      const replay = stdout.written[0]!;
      expect(replay).toContain('AFTER-CARET-MOVE');
      expect(replay).toContain('line-0-');
      expect(replay).toContain('line-9-');
    } finally {
      restore();
    }
  });

  it('does not anchor a pending reset on the log.sync cursor suffix', () => {
    const stdout = new FakeStdout();
    const { restore, repaint } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
      { virtualViewport: true },
    );
    try {
      const prev = frameLines(20, 10);
      stdout.write(ansiEscapes.eraseLines(10) + prev.join('\n'));
      const reset = frameLines(20, 10).map((line) => `${line}-r7`);
      publishResetFullscreen(stdout, false);
      stdout.write(ansiEscapes.clearTerminal + reset.join('\n'));
      // log.sync's cursor suffix follows the reset write; with the composer
      // at column 0 it parses as a diff head plus an `ESC[1G` line-op start,
      // but its moveUp count must not name the anchoring window.
      stdout.write(`${ESC}1A${ESC}1G${CURSOR_SHOW}`);
      const next = reset.slice();
      next[4] = 'POST-SYNC-UPDATE';
      stdout.write(
        incrementalDiffFrame(reset, next, {
          trailingNewline: true,
          prevTrailingNewline: true,
          returnPrefix: RETURN_PREFIX,
        }),
      );
      stdout.written.length = 0;
      repaint!();
      const replay = stdout.written[0]!;
      expect(replay).toContain('POST-SYNC-UPDATE');
      expect(replay).toContain('line-0-');
      expect(replay).toContain('-r7');
    } finally {
      restore();
    }
  });

  it('does not anchor a pending reset on an erase write without line ops', () => {
    const stdout = new FakeStdout();
    const { restore, repaint } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
      { virtualViewport: true },
    );
    try {
      const prev = frameLines(20, 10);
      stdout.write(ansiEscapes.eraseLines(10) + prev.join('\n'));
      const reset = frameLines(20, 10).map((line) => `${line}-re`);
      publishResetFullscreen(stdout, false);
      stdout.write(ansiEscapes.clearTerminal + reset.join('\n'));
      // Erase-prefixed write with a cursorUp head but no line ops: the
      // deferred anchor must not fire, leaving the last good model.
      stdout.write(ansiEscapes.eraseLines(3) + `${ESC}2A`);
      stdout.written.length = 0;
      repaint!();
      const replay = stdout.written[0]!;
      expect(replay).toContain('line-0-');
      expect(replay).not.toContain('-re');
    } finally {
      restore();
    }
  });
  it('drops a pending reset anchor on a second reset with a control-only tail', () => {
    // R11-4: a printable-tail reset arms pendingResetFrame, deferring the
    // anchor to the next diff's head count. If a second clearTerminal
    // write with a control-only tail lands before that diff, the screen is
    // cleared again — the stale pending bytes of the FIRST reset must be
    // dropped like at every other reset site, or the next bare diff slots
    // a model from two resets ago.
    const stdout = new FakeStdout();
    const { restore, repaint } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
      { virtualViewport: true },
    );
    try {
      const prev = frameLines(20, 10);
      stdout.write(ansiEscapes.eraseLines(10) + prev.join('\n'));
      const transcript = ['committed-a', 'committed-b'];
      const reset = frameLines(20, 10).map((line) => `${line}-rA`);
      publishResetFullscreen(stdout, false);
      stdout.write(
        ansiEscapes.clearTerminal +
          transcript.join('\n') +
          '\n' +
          reset.join('\n'),
      );
      stdout.write(ansiEscapes.clearTerminal + CURSOR_HIDE);
      const next = reset.slice();
      next[5] = 'POST-SECOND-RESET';
      stdout.write(
        incrementalDiffFrame(reset, next, {
          trailingNewline: true,
          prevTrailingNewline: true,
          returnPrefix: RETURN_PREFIX,
        }),
      );
      stdout.written.length = 0;
      repaint!();
      // The model is empty: the second reset dropped the stale anchor and
      // the orphaned diff applied to nothing, so repaint is a bare clear.
      expect(stdout.written).toEqual([ansiEscapes.clearViewport]);
    } finally {
      restore();
    }
  });

  it('refreshes the modeled width when diffs apply after a grow', () => {
    const stdout = new FakeStdout();
    stdout.columns = 50;
    const { restore, repaint } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
      { virtualViewport: true },
    );
    try {
      stdout.write(ansiEscapes.clearTerminal);
      const prev = frameLines(10, 10);
      stdout.write(prev.join('\n'));
      stdout.columns = 120;
      stdout.emit('resize');
      const next = prev.slice();
      next[3] = 'GROWN-UPDATE';
      stdout.write(
        incrementalDiffFrame(prev, next, {
          trailingNewline: false,
          returnPrefix: RETURN_PREFIX,
        }),
      );
      stdout.written.length = 0;
      repaint!();
      const replay = stdout.written[0]!;
      expect(replay.startsWith(ansiEscapes.clearViewport)).toBe(true);
      expect(replay).not.toBe(ansiEscapes.clearViewport);
      expect(replay).toContain('GROWN-UPDATE');
    } finally {
      restore();
    }
  });

  it('refreshes the modeled width after a write-free grow', () => {
    const stdout = new FakeStdout();
    stdout.columns = 50;
    const { restore, repaint } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
      { virtualViewport: true },
    );
    try {
      stdout.write(ansiEscapes.clearTerminal);
      const frame = frameLines(10, 10);
      stdout.write(frame.join('\n'));

      stdout.columns = 120;
      stdout.emit('resize');
      stdout.written.length = 0;
      repaint!();
      expect(stdout.written).toEqual([
        ansiEscapes.clearViewport + frame.join('\n'),
      ]);
    } finally {
      restore();
    }
  });

  it('replays styled (SGR) and OSC-8 hyperlink rewrites byte-intact', () => {
    const stdout = new FakeStdout();
    const { restore, repaint } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
      { virtualViewport: true },
    );
    try {
      const prev = frameLines(20, 10);
      stdout.write(ansiEscapes.eraseLines(10) + prev.join('\n'));
      const green = `${ESC}32mgreen${ESC}39m`;
      const link = '\u001B]8;;https://example.com\u0007example\u001B]8;;\u0007';
      const next = prev.slice();
      next[1] = `styled ${green} line`;
      next[2] = `link ${link} line`;
      stdout.write(
        incrementalDiffFrame(prev, next, {
          trailingNewline: false,
          returnPrefix: RETURN_PREFIX,
        }),
      );
      stdout.written.length = 0;
      repaint!();
      const replay = stdout.written[0]!;
      expect(replay).toContain(next[1]!);
      expect(replay).toContain(next[2]!);
    } finally {
      restore();
    }
  });

  it('does not store a rejected erase-prefixed diff as the frame', () => {
    const stdout = new FakeStdout();
    const { restore, repaint } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
      { virtualViewport: true },
    );
    try {
      const prev = frameLines(20, 10);
      stdout.write(ansiEscapes.eraseLines(10) + prev.join('\n'));
      // A shrink/height-change frame against a stale model: the head parses,
      // applyIncrementalDiff rejects (it expects headCount 9), and the raw
      // control-op fragment must not become model.content.
      stdout.write(
        ansiEscapes.eraseLines(3) +
          `${ESC}3A${CURSOR_NEXT_LINE}${CURSOR_TO_COL0}NEW-LINE${ERASE_END_LINE}`,
      );
      stdout.written.length = 0;
      repaint!();
      const replay = stdout.written[0]!;
      expect(replay).not.toContain('NEW-LINE');
      expect(replay).toContain('line-0-');
      expect(replay).toContain('line-9-');
    } finally {
      restore();
    }
  });

  it('does not advance a stale model after unsupported line content rejects a diff', () => {
    const stdout = new FakeStdout();
    const { restore, repaint } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
      { virtualViewport: true },
    );
    try {
      const prev = frameLines(20, 10);
      stdout.write(ansiEscapes.eraseLines(10) + prev.join('\n'));
      const rejected = prev.slice();
      rejected[4] = `unsupported-${ESC}6n-content`;
      stdout.write(
        incrementalDiffFrame(prev, rejected, {
          trailingNewline: false,
          returnPrefix: RETURN_PREFIX,
        }),
      );
      const followUp = rejected.slice();
      followUp[0] = 'FOLLOW-UP-MUST-NOT-MIX';
      stdout.write(
        incrementalDiffFrame(rejected, followUp, {
          trailingNewline: false,
          returnPrefix: RETURN_PREFIX,
        }),
      );

      stdout.written.length = 0;
      repaint!();
      const replay = stdout.written[0]!;
      expect(replay).toContain(prev[0]!);
      expect(replay).toContain(prev[4]!);
      expect(replay).not.toContain('FOLLOW-UP-MUST-NOT-MIX');
      expect(replay).not.toContain('unsupported-');
    } finally {
      restore();
    }
  });

  it('does not arm a late bare-frame handoff after rejecting a shrink diff', () => {
    const stdout = new FakeStdout();
    const { restore, repaint } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
      { virtualViewport: true },
    );
    const dateNow = vi.spyOn(Date, 'now');
    try {
      let now = 1_000_000;
      dateNow.mockImplementation(() => now);
      const prev = frameLines(20, 10);
      stdout.write(ansiEscapes.eraseLines(10) + prev.join('\n'));
      stdout.write(
        ansiEscapes.eraseLines(3) +
          `${ESC}3A${CURSOR_NEXT_LINE}${CURSOR_TO_COL0}REJECTED${ERASE_END_LINE}`,
      );
      now += 100;
      const stray = frameLines(12, 9).map((line) => `STRAY-${line}`);
      stdout.write(stray.join('\n'));

      stdout.written.length = 0;
      repaint!();
      const replay = stdout.written[0]!;
      expect(replay).toContain(prev[0]!);
      expect(replay).toContain(prev[9]!);
      expect(replay).not.toContain('STRAY-');
    } finally {
      dateNow.mockRestore();
      restore();
    }
  });

  it('keeps the good frame when the armed handoff receives a rejected bare diff', () => {
    const stdout = new FakeStdout();
    const { restore, repaint } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
      { virtualViewport: true },
    );
    try {
      const prev = frameLines(20, 10);
      stdout.write(ansiEscapes.eraseLines(10) + prev.join('\n'));
      // Clear-only write arms the post-clear handoff.
      stdout.write(RETURN_PREFIX + ansiEscapes.eraseLines(10));
      // First printable bare write: a short static append.
      stdout.write('static append');
      // Second printable bare write: a bare diff whose head contradicts the
      // model. It must not replace the good frame.
      stdout.write(
        `${ESC}5A${CURSOR_NEXT_LINE}${CURSOR_TO_COL0}BAD-FRAG${ERASE_END_LINE}`,
      );
      stdout.written.length = 0;
      repaint!();
      const replay = stdout.written[0]!;
      expect(replay).not.toContain('BAD-FRAG');
      expect(replay).toContain('line-0-');
      expect(replay).toContain('line-9-');
    } finally {
      restore();
    }
  });

  it('accepts the trailing-newline slot keep at the frame boundary', () => {
    const stdout = new FakeStdout();
    const { restore, repaint } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
      { virtualViewport: true },
    );
    try {
      const prev = frameLines(20, 10);
      stdout.write(ansiEscapes.eraseLines(10) + prev.join('\n') + '\n');
      // Ink grows the non-fullscreen frame by the previous frame's slot: one
      // keep past the stored end.
      stdout.write(`${ESC}10A` + CURSOR_NEXT_LINE.repeat(11));
      const grown = [...prev, ''];
      const next = grown.slice();
      next[9] = 'LINE-9-CHANGED';
      stdout.write(
        incrementalDiffFrame(grown, next, {
          trailingNewline: true,
          prevTrailingNewline: true,
          returnPrefix: RETURN_PREFIX,
        }),
      );
      stdout.written.length = 0;
      repaint!();
      const replay = stdout.written[0]!;
      expect(replay).toContain('LINE-9-CHANGED');
    } finally {
      restore();
    }
  });

  it('applies a shrink diff that erases exactly one line', () => {
    const stdout = new FakeStdout();
    const { restore, repaint } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
      { virtualViewport: true },
    );
    try {
      const prev = frameLines(20, 10);
      stdout.write(ansiEscapes.eraseLines(10) + prev.join('\n'));
      // Slotless frame loses exactly one line: eraseLines(1) is `ESC[2K ESC[G`,
      // carrying no cursorUp pair.
      const next = prev.slice(0, 9);
      next[2] = 'SHRUNK-UPDATE';
      stdout.write(
        incrementalDiffFrame(prev, next, { trailingNewline: false }),
      );
      const next2 = next.slice();
      next2[4] = 'SHRUNK-FOLLOW-UP';
      stdout.write(
        incrementalDiffFrame(next, next2, {
          trailingNewline: false,
          returnPrefix: RETURN_PREFIX,
        }),
      );
      stdout.written.length = 0;
      repaint!();
      const replay = stdout.written[0]!;
      expect(replay).toContain('SHRUNK-UPDATE');
      expect(replay).toContain('SHRUNK-FOLLOW-UP');
      expect(replay).not.toContain('line-9-');
    } finally {
      restore();
    }
  });

  it('replays tmux-wrapped (DCS) OSC-8 hyperlink rewrites byte-intact', () => {
    vi.stubEnv('TMUX', '/tmp/tmux-1000/default');
    const stdout = new FakeStdout();
    const { restore, repaint } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
      { virtualViewport: true },
    );
    try {
      const prev = frameLines(20, 10);
      stdout.write(ansiEscapes.eraseLines(10) + prev.join('\n'));
      const tmuxLink = wrapForMultiplexer(
        '\u001B]8;;https://example.com\u0007example\u001B]8;;\u0007',
      );
      const next = prev.slice();
      next[1] = `link ${tmuxLink} line`;
      stdout.write(
        incrementalDiffFrame(prev, next, {
          trailingNewline: false,
          returnPrefix: RETURN_PREFIX,
        }),
      );
      stdout.written.length = 0;
      repaint!();
      const replay = stdout.written[0]!;
      expect(replay).toContain(next[1]!);
    } finally {
      restore();
    }
  });

  it('handles the no-cursorUp cursor suffix at non-zero columns', () => {
    const stdout = new FakeStdout();
    const { restore, repaint } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
      { virtualViewport: true },
    );
    try {
      const prev = frameLines(20, 10);
      stdout.write(ansiEscapes.eraseLines(10) + prev.join('\n'));
      const next = prev.slice();
      next[9] = 'BOTTOM-LINE-COL2';
      // Cursor on the bottom row at a non-zero column: moveUp is 0 and Ink
      // emits cursorTo(x+1) + show.
      const suffix = `${ESC}2G${CURSOR_SHOW}`;
      stdout.write(
        incrementalDiffFrame(prev, next, {
          trailingNewline: false,
          cursorSuffix: suffix,
        }),
      );
      stdout.written.length = 0;
      repaint!();
      const replay = stdout.written[0]!;
      expect(replay).toContain('BOTTOM-LINE-COL2');
      expect(replay.endsWith(suffix)).toBe(true);
    } finally {
      restore();
    }
  });

  it('anchors a reset whose live frame ends in a blank row', () => {
    const stdout = new FakeStdout();
    const { restore, repaint } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
      { virtualViewport: true },
    );
    try {
      const prev = frameLines(20, 10);
      stdout.write(ansiEscapes.eraseLines(10) + prev.join('\n'));
      const transcript = ['committed-a', 'committed-b'];
      const live = frameLines(20, 10).map((line) => `${line}-r6`);
      // The bottom composited row is blank (e.g. a height-constrained dialog
      // padding shorter content). The reset write also carries the synced
      // slot; the anchor trims exactly that slot and keeps this blank row.
      live[9] = '';
      publishResetFullscreen(stdout, false);
      stdout.write(
        ansiEscapes.clearTerminal +
          transcript.join('\n') +
          '\n' +
          live.join('\n') +
          '\n',
      );
      const next = live.slice();
      next[5] = 'POST-RESET-UPDATE';
      stdout.write(
        incrementalDiffFrame(live, next, {
          trailingNewline: true,
          prevTrailingNewline: true,
          returnPrefix: RETURN_PREFIX,
        }),
      );
      stdout.written.length = 0;
      repaint!();
      const replay = stdout.written[0]!;
      expect(replay).toContain('POST-RESET-UPDATE');
      expect(replay).toContain('line-0-');
      expect(replay).not.toContain('committed-');
    } finally {
      restore();
    }
  });

  it('anchors a non-fullscreen reset carrying the synced trailing-newline slot', () => {
    const stdout = new FakeStdout();
    const { restore, repaint } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
      { virtualViewport: true },
    );
    try {
      const prev = frameLines(20, 10);
      stdout.write(ansiEscapes.eraseLines(10) + prev.join('\n'));
      // Production byte shape: patched Ink writes outputToRender =
      // output + '\n' for a non-fullscreen reset, so the payload carries the
      // synced trailing-newline slot. The deferred anchor must trim exactly
      // that slot (keyed on the published non-fullscreen decision) or it
      // slots [row2..rowN, ''] — dropping the first live row and adding a
      // phantom blank one.
      const transcript = ['committed-a', 'committed-b'];
      const live = frameLines(20, 10).map((line) => `${line}-r14`);
      publishResetFullscreen(stdout, false);
      stdout.write(
        ansiEscapes.clearTerminal +
          transcript.join('\n') +
          '\n' +
          live.join('\n') +
          '\n',
      );
      const next = live.slice();
      next[5] = 'POST-RESET-UPDATE';
      stdout.write(
        incrementalDiffFrame(live, next, {
          trailingNewline: true,
          prevTrailingNewline: true,
          returnPrefix: RETURN_PREFIX,
        }),
      );
      stdout.written.length = 0;
      repaint!();
      const replay = stdout.written[0]!;
      expect(replay).toContain('POST-RESET-UPDATE');
      expect(replay).toContain(live[0]!);
      expect(replay).toContain(live[9]!);
      expect(replay).not.toContain('committed-');
    } finally {
      restore();
    }
  });

  it('anchors a marker-less reset carrying the synced trailing-newline slot', () => {
    const stdout = new FakeStdout();
    const { restore, repaint } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
      { virtualViewport: true },
    );
    try {
      const prev = frameLines(20, 10);
      stdout.write(ansiEscapes.eraseLines(10) + prev.join('\n'));
      const transcript = ['committed-a', 'committed-b'];
      const live = frameLines(20, 10).map((line) => `${line}-markerless`);
      stdout.write(
        ansiEscapes.clearTerminal +
          transcript.join('\n') +
          '\n' +
          live.join('\n') +
          '\n',
      );
      const next = live.slice();
      next[5] = 'MARKERLESS-UPDATE';
      stdout.write(
        incrementalDiffFrame(live, next, {
          trailingNewline: true,
          prevTrailingNewline: true,
          returnPrefix: RETURN_PREFIX,
        }),
      );

      stdout.written.length = 0;
      repaint!();
      const replay = stdout.written[0]!;
      expect(replay).toContain('MARKERLESS-UPDATE');
      expect(replay).toContain(live[0]!);
      expect(replay).toContain(live[9]!);
      expect(replay).not.toContain('committed-');
    } finally {
      restore();
    }
  });

  it('routes a reset before an erase prefix through reset anchoring', () => {
    const stdout = new FakeStdout();
    const { restore, repaint } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
      { virtualViewport: true },
    );
    try {
      const boot = frameLines(20, 10).map((line) => `${line}-boot`);
      stdout.write(ansiEscapes.eraseLines(10) + boot.join('\n'));
      const live = frameLines(20, 10).map((line) => `${line}-reset`);
      publishResetFullscreen(stdout, false);
      stdout.write(
        ansiEscapes.clearTerminal +
          ansiEscapes.eraseLines(1) +
          'static-transcript\n' +
          live.join('\n') +
          '\n',
      );

      stdout.written.length = 0;
      repaint!();
      const replay = stdout.written[0]!;
      expect(replay).toContain(boot[0]!);
      expect(replay).not.toContain('static-transcript');
      expect(
        (stdout as unknown as Record<symbol, unknown>)[INK_RESET_FULLSCREEN],
      ).toBeUndefined();
    } finally {
      restore();
    }
  });

  it('anchors a pending reset through an erase-prefixed shrink diff', () => {
    const stdout = new FakeStdout();
    const { restore, repaint } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
      { virtualViewport: true },
    );
    try {
      const prev = frameLines(20, 10);
      stdout.write(ansiEscapes.eraseLines(10) + prev.join('\n'));
      const transcript = ['committed-s'];
      const live = frameLines(20, 10).map((line) => `${line}-rs`);
      publishResetFullscreen(stdout, false);
      stdout.write(
        ansiEscapes.clearTerminal +
          transcript.join('\n') +
          '\n' +
          live.join('\n') +
          '\n',
      );
      const next = live.slice(0, 7);
      next[1] = 'SHRUNK-AFTER-RESET';
      stdout.write(
        incrementalDiffFrame(live, next, {
          trailingNewline: true,
          prevTrailingNewline: true,
        }),
      );
      stdout.written.length = 0;
      repaint!();
      const replay = stdout.written[0]!;
      expect(replay).toContain('SHRUNK-AFTER-RESET');
      expect(replay).toContain(live[0]!);
      expect(replay).not.toContain(live[8]!);
      expect(replay).not.toContain('committed-');
    } finally {
      restore();
    }
  });

  it('drops a pending reset anchor when a clear-only shrink arms a handoff', () => {
    const stdout = new FakeStdout();
    const { restore, repaint } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
      { virtualViewport: true },
    );
    try {
      const prev = frameLines(20, 10);
      stdout.write(ansiEscapes.eraseLines(10) + prev.join('\n'));
      const live = frameLines(12, 5).map((line) => `RESET-MARKER-${line}`);
      publishResetFullscreen(stdout, false);
      stdout.write(ansiEscapes.clearTerminal + live.join('\n') + '\n');

      stdout.columns = 12;
      stdout.emit('resize');
      stdout.write(RETURN_PREFIX + ansiEscapes.eraseLines(10));
      const redraw = frameLines(12, 5).map((line) => `REDRAW-${line}`);
      stdout.write(redraw.join('\n'));
      const firstDiff = redraw.slice();
      firstDiff[1] = 'FIRST-DIFF';
      stdout.write(
        incrementalDiffFrame(redraw, firstDiff, {
          trailingNewline: false,
        }),
      );
      const secondDiff = firstDiff.slice();
      secondDiff[2] = 'SECOND-DIFF';
      stdout.write(
        incrementalDiffFrame(firstDiff, secondDiff, {
          trailingNewline: false,
        }),
      );

      stdout.written.length = 0;
      repaint!();
      expect(stdout.written).toEqual([ansiEscapes.clearViewport]);
    } finally {
      restore();
    }
  });

  it('applies a diff whose return-to-bottom prefix carries no cursorDown', () => {
    const stdout = new FakeStdout();
    const { restore, repaint } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
      { virtualViewport: true },
    );
    try {
      const prev = frameLines(20, 10);
      stdout.write(ansiEscapes.eraseLines(10) + prev.join('\n'));
      const next = prev.slice();
      next[6] = 'NO-DOWN-UPDATE';
      // Cursor already on the bottom row: down = 0, so the prefix is
      // hide + column-0 with no cursorDown.
      stdout.write(
        incrementalDiffFrame(prev, next, {
          trailingNewline: false,
          returnPrefix: `${CURSOR_HIDE}${CURSOR_TO_COL0}`,
        }),
      );
      stdout.written.length = 0;
      repaint!();
      const replay = stdout.written[0]!;
      expect(replay).toContain('NO-DOWN-UPDATE');
    } finally {
      restore();
    }
  });

  it('applies an erase-prefixed shrink diff to a slotted model', () => {
    const stdout = new FakeStdout();
    const { restore, repaint } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
      { virtualViewport: true },
    );
    try {
      const prev = frameLines(20, 10);
      stdout.write(ansiEscapes.eraseLines(10) + prev.join('\n') + '\n');
      const next = prev.slice(0, 7);
      next[2] = 'SLOTTED-SHRINK';
      stdout.write(
        incrementalDiffFrame(prev, next, {
          trailingNewline: true,
          prevTrailingNewline: true,
        }),
      );
      stdout.written.length = 0;
      repaint!();
      const replay = stdout.written[0]!;
      expect(replay).toContain('SLOTTED-SHRINK');
      expect(replay).toContain('line-6-');
      expect(replay).not.toContain('line-9-');
    } finally {
      restore();
    }
  });

  it('anchors a boundary-height reset by the published decision, not the classifier', () => {
    const stdout = new FakeStdout();
    const { restore, repaint } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
      { virtualViewport: true },
    );
    try {
      const prev = frameLines(20, 10);
      stdout.write(ansiEscapes.eraseLines(10) + prev.join('\n'));
      // A frame at exactly viewport height resets fullscreen (slotless), but
      // the one-line-short slotted candidate packs below the viewport, so the
      // wrapped-height classifier accepts it and drops the top frame line.
      const transcript = ['committed-b1', 'committed-b2'];
      const live = frameLines(20, 40);
      publishResetFullscreen(stdout, true);
      stdout.write(
        ansiEscapes.clearTerminal +
          transcript.join('\n') +
          '\n' +
          live.join('\n'),
      );
      const next = live.slice();
      next[5] = 'BOUNDARY-UPDATE';
      stdout.write(
        incrementalDiffFrame(live, next, {
          trailingNewline: false,
          returnPrefix: RETURN_PREFIX,
        }),
      );
      stdout.written.length = 0;
      repaint!();
      const replay = stdout.written[0]!;
      expect(replay).toContain('BOUNDARY-UPDATE');
      expect(replay).toContain('line-0-');
      expect(replay).toContain('line-39-');
      expect(replay).not.toContain('committed-');
    } finally {
      restore();
    }
  });

  it('does not let literal tabs flip a sub-viewport reset to slotless', () => {
    const stdout = new FakeStdout();
    const { restore, repaint } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
      { virtualViewport: true },
    );
    try {
      const prev = frameLines(20, 10);
      stdout.write(ansiEscapes.eraseLines(10) + prev.join('\n'));
      // Tab-indented lines pack into more physical rows than stringWidth
      // sees (tab stops vs width 0), so the classifier calls this 24-line
      // frame fullscreen; Ink's logical height says it is not.
      const transcript = ['committed-c1', 'committed-c2'];
      const live = Array.from(
        { length: 24 },
        (_, i) => `T-line-${i}` + '\t'.repeat(16),
      );
      publishResetFullscreen(stdout, false);
      stdout.write(
        ansiEscapes.clearTerminal +
          transcript.join('\n') +
          '\n' +
          live.join('\n'),
      );
      const next = live.slice();
      next[20] = 'UPDATED-TAB-20';
      stdout.write(
        incrementalDiffFrame(live, next, {
          trailingNewline: true,
          prevTrailingNewline: true,
          returnPrefix: RETURN_PREFIX,
        }),
      );
      stdout.written.length = 0;
      repaint!();
      const replay = stdout.written[0]!;
      expect(replay).toContain('UPDATED-TAB-20');
      expect(replay).toContain('T-line-0');
      expect(replay).toContain('T-line-23');
      expect(replay).not.toContain('committed-');
    } finally {
      restore();
    }
  });

  it('anchors a leaving-fullscreen reset despite width drift before the diff', () => {
    const stdout = new FakeStdout();
    const { restore, repaint } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
      { virtualViewport: true },
    );
    try {
      const prev = frameLines(20, 45);
      stdout.write(ansiEscapes.eraseLines(45) + prev.join('\n'));
      // The new frame is sub-viewport: Ink publishes non-fullscreen and
      // syncs the slot, then the width shrinks before the anchoring diff.
      // Re-wrapping the candidate at the drifted width flips the decision;
      // the published marker must win.
      const reset = frameLines(20, 30).map((line) => `${line}-r3`);
      publishResetFullscreen(stdout, false);
      stdout.write(ansiEscapes.clearTerminal + reset.join('\n'));
      stdout.columns = 8;
      stdout.emit('resize');
      const next = reset.slice();
      next[2] = 'COLLAPSED-UPDATE';
      stdout.write(
        incrementalDiffFrame(reset, next, {
          trailingNewline: true,
          prevTrailingNewline: true,
          returnPrefix: RETURN_PREFIX,
        }),
      );
      stdout.written.length = 0;
      repaint!();
      const replay = stdout.written[0]!;
      expect(replay).toContain('COLLAPSED-UPDATE');
      expect(replay).toContain('line-0-');
      expect(replay).toContain('line-29-');
    } finally {
      restore();
    }
  });

  describe('wake repaint with a real Ink instance', () => {
    it('replays the current frame after incremental diffs, not a bare clear', async () => {
      const stdout = new FakeStdout();
      const { restore, repaint } = installTerminalResizeReflow(
        stdout as unknown as NodeJS.WriteStream,
        { virtualViewport: true },
      );
      let updateLine!: () => void;
      const App = () => {
        const [value, setValue] = useState('original-value');
        updateLine = () => setValue('updated-value');
        return createElement(
          Box,
          { flexDirection: 'column' },
          Array.from({ length: 12 }, (_, i) =>
            createElement(
              Text,
              { key: i },
              i === 5 ? `line-5 ${value}` : `line-${i} content`,
            ),
          ),
        );
      };
      let app: Instance | undefined;
      try {
        await act(async () => {
          app = render(createElement(App), {
            stdout: stdout as unknown as NodeJS.WriteStream,
            interactive: true,
            incrementalRendering: true,
            alternateScreen: true,
            maxFps: 1000,
            patchConsole: false,
          });
        });
        await app!.waitUntilRenderFlush();

        await act(async () => {
          updateLine();
        });
        await app!.waitUntilRenderFlush();

        stdout.written.length = 0;
        repaint!();
        expect(stdout.written.length).toBe(1);
        const replay = stdout.written[0]!;
        expect(replay.startsWith(ansiEscapes.clearViewport)).toBe(true);
        expect(replay).not.toBe(ansiEscapes.clearViewport);
        expect(replay).toContain('line-0 content');
        expect(replay).toContain('line-5 updated-value');
        expect(replay).toContain('line-11 content');
      } finally {
        if (app) {
          await act(async () => {
            app!.unmount();
          });
        }
        restore();
      }
    });

    it('anchors an overflow reset through the marker real Ink publishes', async () => {
      const stdout = new FakeStdout();
      // A 3-row viewport makes the reset boundary reachable: the frame at
      // exactly viewport height is fullscreen (slotless), while the
      // wrapped-height fallback classifier would accept the one-line-short
      // slotted candidate (2 packed rows < 3) and drop the frame's top line.
      stdout.rows = 3;
      const { restore, repaint } = installTerminalResizeReflow(
        stdout as unknown as NodeJS.WriteStream,
        { virtualViewport: true },
      );
      let setLines!: (lines: string[]) => void;
      const App = () => {
        const [lines, setState] = useState(['a-0']);
        setLines = setState;
        return createElement(
          Box,
          { flexDirection: 'column' },
          lines.map((line, i) => createElement(Text, { key: i }, line)),
        );
      };
      let app: Instance | undefined;
      try {
        await act(async () => {
          app = render(createElement(App), {
            stdout: stdout as unknown as NodeJS.WriteStream,
            interactive: true,
            incrementalRendering: true,
            maxFps: 1000,
            patchConsole: false,
          });
        });
        await app!.waitUntilRenderFlush();

        // Overflow the viewport: Ink writes a clearTerminal reset and
        // publishes its fullscreen decision for it.
        await act(async () => {
          setLines(['b-0', 'b-1', 'b-2', 'b-3']);
        });
        await app!.waitUntilRenderFlush();

        // Collapse to exactly the viewport height: a second reset, published
        // fullscreen (slotless). The next diff anchors against this window.
        await act(async () => {
          setLines(['c-0', 'c-1', 'c-2']);
        });
        await app!.waitUntilRenderFlush();

        await act(async () => {
          setLines(['c-0', 'UPDATED-c-1', 'c-2']);
        });
        await app!.waitUntilRenderFlush();

        stdout.written.length = 0;
        repaint!();
        expect(stdout.written.length).toBe(1);
        const replay = stdout.written[0]!;
        expect(replay.startsWith(ansiEscapes.clearViewport)).toBe(true);
        // The top line survives the anchor (the fallback classifier drops
        // it) and the update landed through the anchored model.
        expect(replay).toContain('c-0');
        expect(replay).toContain('UPDATED-c-1');
        expect(replay).toContain('c-2');
        expect(replay).not.toContain('b-');
      } finally {
        if (app) {
          await act(async () => {
            app!.unmount();
          });
        }
        restore();
      }
    });
  });
});

describe('width shrink with a real Ink instance (issue #9970 review)', () => {
  it('repaints the post-shrink update in full instead of passing a raw diff', async () => {
    const stdout = new FakeStdout();
    stdout.columns = 100;
    const { restore } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
      { virtualViewport: true },
    );
    let setValue!: (v: string) => void;
    const App = () => {
      const [value, set] = useState('original-value');
      setValue = set;
      return createElement(Box, { flexDirection: 'column' }, [
        ...Array.from({ length: 12 }, (_, i) =>
          createElement(Text, { key: i }, `line-${i} content`),
        ),
        createElement(Text, { key: 'composer' }, `> ${value}`),
      ]);
    };
    let app: Instance | undefined;
    try {
      await act(async () => {
        app = render(createElement(App), {
          stdout: stdout as unknown as NodeJS.WriteStream,
          interactive: true,
          incrementalRendering: true,
          alternateScreen: true,
          maxFps: 1000,
          patchConsole: false,
        });
      });
      await app!.waitUntilRenderFlush();

      const resizeAt = stdout.written.length;
      stdout.columns = 70;
      stdout.emit('resize');
      await new Promise((resolve) => setTimeout(resolve, 20));

      await act(async () => {
        setValue('updated-value');
      });
      await app!.waitUntilRenderFlush();
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Inside the post-shrink clear window the update frame must reach the
      // terminal as a full viewport repaint — a raw incremental diff there
      // assumes the pre-shrink grid, which the resize invalidated (the
      // width-shrink corruption reported on the #9970 review).
      const updateWrite = stdout.written
        .slice(resizeAt)
        .find((w) => w.includes('updated-value'));
      expect(updateWrite).toBeDefined();
      expect(updateWrite!.startsWith(ansiEscapes.clearViewport)).toBe(true);

      // End to end: replaying every write on a non-reflowing grid that
      // resizes at the same point leaves the full frame visible at the new
      // width, composer included.
      const term = new MiniTerminal(100, 32);
      for (let i = 0; i < resizeAt; i++) term.feed(stdout.written[i]!);
      term.resize(70);
      for (let i = resizeAt; i < stdout.written.length; i++) {
        term.feed(stdout.written[i]!);
      }
      const screen = term.screenText();
      expect(screen).toContain('line-0 content');
      expect(screen).toContain('line-11 content');
      expect(screen).toContain('> updated-value');
    } finally {
      if (app) {
        await act(async () => {
          app!.unmount();
        });
      }
      restore();
    }
  });
});
