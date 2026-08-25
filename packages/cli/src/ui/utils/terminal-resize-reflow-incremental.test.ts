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

function eraseLines(count: number): string {
  let clear = '';
  for (let i = 0; i < count; i++) {
    clear += `${ESC}2K` + (i < count - 1 ? `${ESC}1A` : '');
  }
  if (count) clear += `${ESC}G`;
  return clear;
}

function frameLines(width: number, rows: number): string[] {
  return Array.from(
    { length: rows },
    (_, i) => `line-${i}-` + 'x'.repeat(width),
  );
}

/**
 * Builds an incremental diff frame exactly like the patched Ink
 * log-update createIncremental renderer: height branch, per-line ops,
 * optional trailing cursor suffix.
 */
function incrementalDiffFrame(
  prev: string[],
  next: string[],
  opts: {
    trailingNewline: boolean;
    prevTrailingNewline?: boolean;
    cursorSuffix?: string;
  },
): string {
  const prevTrailingNewline = opts.prevTrailingNewline ?? false;
  let out = '';
  if (next.length < prev.length) {
    const extraSlot = prevTrailingNewline ? 1 : 0;
    out +=
      eraseLines(prev.length - next.length + extraSlot) +
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
      stdout.write(eraseLines(10) + prev.join('\n'));
      const next = prev.slice();
      next[2] = 'CHANGED-LINE';
      stdout.write(
        incrementalDiffFrame(prev, next, { trailingNewline: false }),
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
      stdout.write(eraseLines(10) + prev.join('\n'));
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
      stdout.write(eraseLines(10) + prev.join('\n'));
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
      stdout.write(eraseLines(10) + prev.join('\n'));
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
      stdout.write(eraseLines(10) + prev.join('\n'));
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
      stdout.write(eraseLines(10) + prev.join('\n'));
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
      stdout.write(eraseLines(10) + prev.join('\n'));
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

  it('anchors the overflow full-reset frame (clearTerminal + full frame)', () => {
    const stdout = new FakeStdout();
    const { restore, repaint } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
      { virtualViewport: true },
    );
    try {
      const prev = frameLines(20, 10);
      stdout.write(eraseLines(10) + prev.join('\n'));
      const reset = frameLines(60, 30);
      stdout.write(ansiEscapes.clearTerminal + reset.join('\n'));
      // The next diff is against the reset frame; this one updates row 29.
      const next = reset.slice();
      next[29] = 'AFTER-RESET';
      stdout.write(
        incrementalDiffFrame(reset, next, { trailingNewline: false }),
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
