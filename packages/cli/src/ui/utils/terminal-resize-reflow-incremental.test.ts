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
          trailingNewline: false,
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
      const reset = frameLines(20, 30).map((line) => `${line}-r3`);
      stdout.write(ansiEscapes.clearTerminal + reset.join('\n'));
      const next = reset.slice();
      next[2] = 'COLLAPSED-UPDATE';
      stdout.write(
        incrementalDiffFrame(reset, next, {
          trailingNewline: false,
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
          trailingNewline: false,
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
  });
});
