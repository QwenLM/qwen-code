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

  it('passes a shrink diff through an armed clear window unmodified', () => {
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
      // An incremental shrink diff must bypass that rewrite — the swap would
      // blank its kept tail (no op is emitted for a kept last line).
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
      expect(stdout.written).toEqual([diff]);
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
          reset.join('\n'),
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
      // the frame WITHOUT the trailing '\n' it hands to log.sync(), so the
      // next same-height diff carries cursorUp(lines), not cursorUp(lines-1).
      // The new frame is sub-viewport, so Ink publishes non-fullscreen and
      // syncs the slot.
      const reset = frameLines(20, 30).map((line) => `${line}-r3`);
      publishResetFullscreen(stdout, false);
      stdout.write(ansiEscapes.clearTerminal + reset.join('\n'));
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
      // padding shorter content); a reset write carries no slot to pop it.
      live[9] = '';
      publishResetFullscreen(stdout, false);
      stdout.write(
        ansiEscapes.clearTerminal +
          transcript.join('\n') +
          '\n' +
          live.join('\n'),
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
          live.join('\n'),
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
