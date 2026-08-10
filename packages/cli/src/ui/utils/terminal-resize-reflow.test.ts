/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  buildWakeRepaint,
  installTerminalResizeReflow,
} from './terminal-resize-reflow.js';

const ESC = '\u001B[';
const BSU = `${ESC}?2026h`;

function eraseLines(count: number): string {
  let clear = '';
  for (let i = 0; i < count; i++) {
    clear += `${ESC}2K` + (i < count - 1 ? `${ESC}1A` : '');
  }
  if (count) clear += `${ESC}G`;
  return clear;
}

function frame(width: number, rows: number, trailingNewline = false): string {
  const s = Array.from({ length: rows }, () => 'x'.repeat(width)).join('\n');
  return trailingNewline ? s + '\n' : s;
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

describe('installTerminalResizeReflow', () => {
  it('amplifies the post-shrink erase to the reflowed frame height', () => {
    const stdout = new FakeStdout();
    const { restore } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
    );
    try {
      stdout.write(eraseLines(10) + frame(60, 10));
      stdout.columns = 30;
      stdout.emit('resize');
      stdout.write(eraseLines(10));
      expect(stdout.written.at(-1)).toBe(eraseLines(20));
    } finally {
      restore();
    }
  });

  it('VP mode replaces the stale clear with a viewport clear', () => {
    const stdout = new FakeStdout();
    const { restore } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
      { virtualViewport: true },
    );
    try {
      stdout.write(eraseLines(10) + frame(60, 10));
      stdout.columns = 30;
      stdout.emit('resize');
      stdout.write(eraseLines(10) + frame(30, 20));
      expect(stdout.written.at(-1)).toBe(`${ESC}2J${ESC}H` + frame(30, 20));
    } finally {
      restore();
    }
  });

  it('a grow before the next erase resets a pending amplification', () => {
    const stdout = new FakeStdout();
    const { restore } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
    );
    try {
      stdout.write(eraseLines(10) + frame(60, 10));
      stdout.columns = 30;
      stdout.emit('resize');
      stdout.columns = 120;
      stdout.emit('resize');
      stdout.write(eraseLines(10) + frame(60, 10));
      expect(stdout.written.at(-1)).toBe(eraseLines(10) + frame(60, 10));
    } finally {
      restore();
    }
  });

  it('models the bare post-shrink redraw (divergent geometry)', () => {
    const stdout = new FakeStdout();
    const { restore } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
    );
    try {
      stdout.write(eraseLines(10) + frame(60, 10));
      stdout.columns = 30;
      stdout.emit('resize');
      stdout.write(eraseLines(10)); // clear, amplified 10 -> 20
      expect(stdout.written.at(-1)).toBe(eraseLines(20));
      // Bare redraw re-models with a row count the width model did not
      // predict; deleting the expectFrame branch would keep the stale 20-row
      // model and amplify to 40 instead of 44 below.
      stdout.write(frame(30, 22));
      stdout.columns = 15;
      stdout.emit('resize');
      stdout.write(eraseLines(22));
      expect(stdout.written.at(-1)).toBe(eraseLines(44));
    } finally {
      restore();
    }
  });

  it('ignores standalone synchronized-output writes between clear and frame', () => {
    const stdout = new FakeStdout();
    const { restore } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
    );
    try {
      stdout.write(eraseLines(10) + frame(60, 10));
      stdout.columns = 30;
      stdout.emit('resize');
      stdout.write(eraseLines(10)); // clear arms the handoff
      stdout.write(BSU); // control write must not consume it
      stdout.write(frame(30, 22)); // live frame models (last wins)
      stdout.columns = 15;
      stdout.emit('resize');
      stdout.write(eraseLines(22));
      expect(stdout.written.at(-1)).toBe(eraseLines(44));
    } finally {
      restore();
    }
  });

  it('static-commit sequences model the live frame, not the transcript', () => {
    const stdout = new FakeStdout();
    const { restore } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
    );
    try {
      stdout.write(eraseLines(10) + frame(60, 10));
      stdout.columns = 30;
      stdout.emit('resize');
      stdout.write(eraseLines(10)); // clear arms the handoff
      stdout.write(frame(60, 12)); // static append (>= 8 rows) models first...
      stdout.write(frame(30, 20)); // ...live frame wins (last bare write)
      stdout.columns = 15;
      stdout.emit('resize');
      stdout.write(eraseLines(20));
      // From the 20-row live frame (30-wide rows -> 2 rows each at 15).
      expect(stdout.written.at(-1)).toBe(eraseLines(40));
    } finally {
      restore();
    }
  });

  it('includes Ink cursor-below line for frames ending with a newline', () => {
    const stdout = new FakeStdout();
    const { restore } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
    );
    try {
      stdout.write(eraseLines(11) + frame(60, 10, true));
      stdout.columns = 30;
      stdout.emit('resize');
      stdout.write(eraseLines(11));
      expect(stdout.written.at(-1)).toBe(eraseLines(21));
    } finally {
      restore();
    }
  });

  it('greedy-packs wide characters like the terminal reflow', () => {
    const stdout = new FakeStdout();
    const { restore } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
    );
    try {
      const cjk = Array.from({ length: 10 }, () => '中'.repeat(3)).join('\n');
      stdout.write(eraseLines(10) + cjk); // 3 wide chars (6 cells) per row
      stdout.columns = 3; // greedy: one wide char per row -> 3 rows each
      stdout.emit('resize');
      stdout.write(eraseLines(10));
      expect(stdout.written.at(-1)).toBe(eraseLines(30));
    } finally {
      restore();
    }
  });

  it('short erase-prefixed bursts do not clobber the frame model', () => {
    const stdout = new FakeStdout();
    const { restore } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
    );
    try {
      stdout.write(eraseLines(10) + frame(60, 10));
      stdout.write(eraseLines(3) + frame(60, 3));
      stdout.columns = 30;
      stdout.emit('resize');
      stdout.write(eraseLines(10));
      expect(stdout.written.at(-1)).toBe(eraseLines(20));
    } finally {
      restore();
    }
  });

  it('the VP clear window expires', () => {
    vi.useFakeTimers();
    try {
      const stdout = new FakeStdout();
      const { restore } = installTerminalResizeReflow(
        stdout as unknown as NodeJS.WriteStream,
        { virtualViewport: true },
      );
      stdout.write(eraseLines(10) + frame(60, 10));
      stdout.columns = 30;
      stdout.emit('resize');
      stdout.write(eraseLines(10) + frame(30, 20));
      expect(stdout.written.at(-1)).toBe(`${ESC}2J${ESC}H` + frame(30, 20));
      vi.advanceTimersByTime(601);
      stdout.write(eraseLines(20) + frame(30, 20));
      expect(stdout.written.at(-1)).toBe(eraseLines(20) + frame(30, 20));
      restore();
    } finally {
      vi.useRealTimers();
    }
  });

  it('repaint replays the last frame over a clean viewport', () => {
    const stdout = new FakeStdout();
    const { restore, repaint } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
      { virtualViewport: true },
    );
    try {
      stdout.write(eraseLines(10) + frame(60, 10));
      stdout.written.length = 0;
      repaint();
      expect(stdout.written).toEqual([`${ESC}2J${ESC}H` + frame(60, 10)]);
    } finally {
      restore();
    }
  });

  it('repaint falls back to a bare clear when the width changed', () => {
    const stdout = new FakeStdout();
    const { restore, repaint } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
      { virtualViewport: true },
    );
    try {
      stdout.write(eraseLines(10) + frame(60, 10));
      stdout.columns = 80;
      stdout.written.length = 0;
      repaint();
      expect(stdout.written).toEqual([`${ESC}2J${ESC}H`]);
    } finally {
      restore();
    }
  });

  it('repaint before any frame is a bare clear', () => {
    const stdout = new FakeStdout();
    const { restore, repaint } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
      { virtualViewport: true },
    );
    try {
      repaint();
      expect(stdout.written).toEqual([`${ESC}2J${ESC}H`]);
    } finally {
      restore();
    }
  });

  it('QWEN_CODE_LEGACY_RESIZE_ERASE disables the wrapper', () => {
    vi.stubEnv('QWEN_CODE_LEGACY_RESIZE_ERASE', '1');
    try {
      const stdout = new FakeStdout();
      const handle = installTerminalResizeReflow(
        stdout as unknown as NodeJS.WriteStream,
      );
      stdout.write(eraseLines(10) + frame(60, 10));
      stdout.columns = 30;
      stdout.emit('resize');
      stdout.write(eraseLines(10));
      expect(stdout.written.at(-1)).toBe(eraseLines(10));
      handle.repaint();
      expect(stdout.written).toHaveLength(2); // repaint is a no-op
      handle.restore();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('passes writes through untouched after restore', () => {
    const stdout = new FakeStdout();
    const { restore } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
    );
    restore();
    stdout.write(eraseLines(10) + frame(60, 10));
    stdout.columns = 30;
    stdout.emit('resize');
    stdout.write(eraseLines(10) + frame(30, 20));
    expect(stdout.written.at(-1)).toBe(eraseLines(10) + frame(30, 20));
  });
});

describe('buildWakeRepaint', () => {
  const deps = () => ({
    isVP: true,
    repaintViewport: vi.fn(),
    clearViewportFallback: vi.fn(),
    refreshStatic: vi.fn(),
    remountStaticHistory: vi.fn(),
  });

  it('VP with prop: calls it and bumps the static remount key', () => {
    const d = deps();
    buildWakeRepaint(d)();
    expect(d.repaintViewport).toHaveBeenCalledTimes(1);
    expect(d.remountStaticHistory).toHaveBeenCalledTimes(1);
    expect(d.clearViewportFallback).not.toHaveBeenCalled();
    expect(d.refreshStatic).not.toHaveBeenCalled();
  });

  it('VP without prop: falls back to the viewport clear and bumps', () => {
    const d = deps();
    buildWakeRepaint({ ...d, repaintViewport: undefined })();
    expect(d.clearViewportFallback).toHaveBeenCalledTimes(1);
    expect(d.remountStaticHistory).toHaveBeenCalledTimes(1);
  });

  it('static mode: uses refreshStatic (which clears and bumps)', () => {
    const d = deps();
    buildWakeRepaint({ ...d, isVP: false })();
    expect(d.refreshStatic).toHaveBeenCalledTimes(1);
    expect(d.repaintViewport).not.toHaveBeenCalled();
    expect(d.remountStaticHistory).not.toHaveBeenCalled();
  });
});
