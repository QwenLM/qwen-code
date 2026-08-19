/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ansiEscapes from 'ansi-escapes';
import {
  buildWakeRepaint,
  installTerminalResizeReflow,
} from './terminal-resize-reflow.js';
import { installTerminalRedrawOptimizer } from './terminalRedrawOptimizer.js';
import { installSynchronizedOutput } from './synchronizedOutput.js';

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
  // The PR's legacy escape hatches short-circuit the wrappers; keep the
  // suite deterministic when a developer runs it with a hatch exported.
  beforeEach(() => {
    vi.stubEnv('QWEN_CODE_LEGACY_RESIZE_ERASE', '');
    vi.stubEnv('QWEN_CODE_LEGACY_ERASE_LINES', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

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

  it('erase-prefixed printable writes authoritatively re-model small frames', () => {
    const stdout = new FakeStdout();
    const { restore } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
    );
    try {
      stdout.write(eraseLines(10) + frame(60, 10));
      // Ink replacing its live region with a <8-row render is authoritative;
      // rejecting it would freeze the target on the stale 10-row frame.
      stdout.write(eraseLines(3) + frame(60, 3));
      stdout.columns = 30;
      stdout.emit('resize');
      stdout.write(eraseLines(3));
      expect(stdout.written.at(-1)).toBe(eraseLines(6));
    } finally {
      restore();
    }
  });

  it('bare console-style bursts below MIN_FRAME_LINES do not clobber the model', () => {
    const stdout = new FakeStdout();
    const { restore } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
    );
    try {
      stdout.write(eraseLines(10) + frame(60, 10));
      stdout.write('short console noise');
      stdout.columns = 30;
      stdout.emit('resize');
      stdout.write(eraseLines(10));
      expect(stdout.written.at(-1)).toBe(eraseLines(20));
    } finally {
      restore();
    }
  });

  it('short console noise captured mid-handoff does not become the model', () => {
    const stdout = new FakeStdout();
    const { restore } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
    );
    try {
      stdout.write(eraseLines(10) + frame(60, 10));
      stdout.write(eraseLines(10)); // clear-only: arms the handoff
      stdout.write('short console noise'); // <8 rows: MIN gate rejects
      stdout.columns = 30;
      stdout.emit('resize');
      stdout.write(eraseLines(10));
      // Amplification still targets the real frame; with the MIN gate
      // removed the noise (1 row) would become the model and no amplification
      // would fire.
      expect(stdout.written.at(-1)).toBe(eraseLines(20));
    } finally {
      restore();
    }
  });

  it('stray bare writes after the live frame cannot clobber the model', () => {
    const stdout = new FakeStdout();
    const { restore } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
    );
    try {
      stdout.write(eraseLines(10) + frame(60, 10));
      stdout.write(eraseLines(10)); // arms the handoff
      stdout.write(frame(60, 12)); // static append
      stdout.write(frame(30, 20)); // live frame: consumed, handoff disarms
      stdout.write('\x07'); // notification bell during idle: ignored
      stdout.columns = 15;
      stdout.emit('resize');
      stdout.write(eraseLines(6));
      expect(stdout.written.at(-1)).toBe(eraseLines(40));
    } finally {
      restore();
    }
  });

  it('bare writes arriving after the handoff window are ignored', () => {
    vi.useFakeTimers();
    try {
      const stdout = new FakeStdout();
      const { restore } = installTerminalResizeReflow(
        stdout as unknown as NodeJS.WriteStream,
      );
      stdout.write(eraseLines(10) + frame(60, 10));
      stdout.write(eraseLines(10)); // arms the handoff
      vi.advanceTimersByTime(60); // past HANDOFF_WINDOW_MS
      stdout.write('\x07'); // stray bell: disarms, not modeled
      stdout.write(frame(20, 10)); // late bare write: also ignored
      stdout.columns = 15;
      stdout.emit('resize');
      stdout.write(eraseLines(6));
      // Model is still the original frame (40 rows at 15 cols); a wrongly
      // modeled late write would target 20.
      expect(stdout.written.at(-1)).toBe(eraseLines(40));
      restore();
    } finally {
      vi.useRealTimers();
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
      repaint!();
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
      repaint!();
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
      repaint!();
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
      // No repaint: the VP wake path stays write-free (static remount bump
      // only) — a bare viewport clear would blank the screen.
      expect(handle.repaint).toBeUndefined();
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

  it('models widths from ANSI-stripped content (SGR bytes are not cells)', () => {
    const stdout = new FakeStdout();
    const { restore } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
    );
    try {
      const styled = Array.from(
        { length: 10 },
        () => `\x1b[31m${'x'.repeat(60)}\x1b[39m`,
      ).join('\n');
      stdout.write(eraseLines(10) + styled);
      stdout.columns = 30;
      stdout.emit('resize');
      stdout.write(eraseLines(10));
      expect(stdout.written.at(-1)).toBe(eraseLines(20));
    } finally {
      restore();
    }
  });

  it('cursor-suffixed frames pack to visible rows plus the cursor-below line', () => {
    const stdout = new FakeStdout();
    const { restore } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
    );
    try {
      stdout.write(eraseLines(11) + frame(20, 10) + '\n' + '\x1b[?25l');
      stdout.columns = 10;
      stdout.emit('resize');
      stdout.write(eraseLines(11));
      expect(stdout.written.at(-1)).toBe(eraseLines(21));
    } finally {
      restore();
    }
  });

  it('expands tabs to 8-column stops when packing', () => {
    const stdout = new FakeStdout();
    const { restore } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
    );
    try {
      const tabbed = Array.from(
        { length: 10 },
        () => '\t'.repeat(3) + 'x'.repeat(70),
      ).join('\n');
      stdout.write(eraseLines(10) + tabbed);
      stdout.columns = 80; // 24 tab cells + 70 = 94 -> 2 rows per line
      stdout.emit('resize');
      stdout.write(eraseLines(10));
      expect(stdout.written.at(-1)).toBe(eraseLines(20));
    } finally {
      restore();
    }
  });

  it('packs grapheme clusters as one block (ZWJ emoji)', () => {
    const stdout = new FakeStdout();
    const { restore } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
    );
    try {
      const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
      const emoji = Array.from({ length: 10 }, () => family.repeat(6)).join(
        '\n',
      );
      stdout.write(eraseLines(10) + emoji);
      stdout.columns = 30; // 12 cells per line -> 1 row; per-code-point gives 2
      stdout.emit('resize');
      stdout.write(eraseLines(10));
      expect(stdout.written.at(-1)).toBe(eraseLines(10));
    } finally {
      restore();
    }
  });

  it('overflow full-reset redraws reset the model instead of poisoning it', () => {
    const stdout = new FakeStdout();
    const { restore } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
    );
    try {
      stdout.write(eraseLines(10) + frame(60, 10));
      stdout.columns = 30;
      stdout.emit('resize');
      stdout.write(eraseLines(10)); // amplified, arms the handoff
      // Ink's overflow path: clearTerminal + full static history + live
      // frame as one bare write. Must not become the frame model.
      stdout.write(ansiEscapes.clearTerminal + frame(60, 30));
      stdout.columns = 15;
      stdout.emit('resize');
      stdout.write(eraseLines(5));
      expect(stdout.written.at(-1)).toBe(eraseLines(5));
    } finally {
      restore();
    }
  });

  it('drops the model on unarmed full-reset writes (the common state)', () => {
    const stdout = new FakeStdout();
    const { restore } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
    );
    try {
      stdout.write(eraseLines(10) + frame(60, 10));
      // Ink's shouldClearTerminal path writes clearTerminal + full static +
      // live frame with NO preceding log.clear(), i.e. while unarmed.
      stdout.write(ansiEscapes.clearTerminal + frame(60, 30));
      stdout.columns = 15;
      stdout.emit('resize');
      stdout.write(eraseLines(5));
      expect(stdout.written.at(-1)).toBe(eraseLines(5));
    } finally {
      restore();
    }
  });

  it('the live frame replaces a static append even below MIN_FRAME_LINES', () => {
    const stdout = new FakeStdout();
    const { restore } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
    );
    try {
      stdout.write(eraseLines(10) + frame(60, 10));
      stdout.columns = 30;
      stdout.emit('resize');
      stdout.write(eraseLines(10)); // arms the handoff
      stdout.write(frame(60, 25)); // static append models first
      stdout.write(frame(30, 6)); // <8-row live frame still wins
      stdout.columns = 15;
      stdout.emit('resize');
      stdout.write(eraseLines(6));
      expect(stdout.written.at(-1)).toBe(eraseLines(12));
    } finally {
      restore();
    }
  });

  it('adjusts the return-to-bottom prefix when amplifying', () => {
    const stdout = new FakeStdout();
    const { restore } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
    );
    try {
      stdout.write(eraseLines(10) + frame(60, 10));
      stdout.columns = 30;
      stdout.emit('resize');
      // The prefix cursorDown was computed pre-reflow; the screen grew by
      // delta = target - count rows, so the amplified write must advance the
      // cursor by count+delta or the erase window shifts into scrollback.
      const prefix = '\x1b[?25l\x1b[2B\x1b[0G';
      stdout.write(prefix + eraseLines(10));
      expect(stdout.written.at(-1)).toBe(
        '\x1b[?25l\x1b[12B\x1b[0G' + eraseLines(20),
      );
    } finally {
      restore();
    }
  });

  it('return-prefixed renders still match and re-model', () => {
    const stdout = new FakeStdout();
    const { restore } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
    );
    try {
      stdout.write(eraseLines(10) + frame(60, 10));
      stdout.columns = 30;
      stdout.emit('resize');
      const prefix = '\x1b[?25l\x1b[2B\x1b[0G';
      stdout.write(prefix + eraseLines(10) + frame(30, 20));
      stdout.columns = 15;
      stdout.emit('resize');
      stdout.write(eraseLines(20));
      expect(stdout.written.at(-1)).toBe(eraseLines(40));
    } finally {
      restore();
    }
  });

  it('consecutive shrinks without a redraw between them stay exact', () => {
    const stdout = new FakeStdout();
    const { restore } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
    );
    try {
      stdout.write(eraseLines(10) + frame(60, 10));
      stdout.columns = 50;
      stdout.emit('resize');
      stdout.columns = 30;
      stdout.emit('resize');
      stdout.write(eraseLines(10));
      expect(stdout.written.at(-1)).toBe(eraseLines(20));
    } finally {
      restore();
    }
  });

  it('the model survives a grow and re-amplifies the next shrink', () => {
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
      stdout.columns = 30;
      stdout.emit('resize');
      stdout.write(eraseLines(10));
      expect(stdout.written.at(-1)).toBe(eraseLines(20));
    } finally {
      restore();
    }
  });

  it('amplification is one-shot per shrink', () => {
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
      stdout.write(eraseLines(10));
      expect(stdout.written.at(-1)).toBe(eraseLines(10));
    } finally {
      restore();
    }
  });

  it('VP replaces erase-only post-shrink clears inside the window', () => {
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
      stdout.write(eraseLines(10));
      expect(stdout.written.at(-1)).toBe(`${ESC}2J${ESC}H`);
      restore();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never clamps an erase that already exceeds the target', () => {
    const stdout = new FakeStdout();
    const { restore } = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
    );
    try {
      stdout.write(eraseLines(10) + frame(5, 10));
      stdout.columns = 30;
      stdout.emit('resize');
      stdout.write(eraseLines(12));
      expect(stdout.written.at(-1)).toBe(eraseLines(12));
    } finally {
      restore();
    }
  });

  it('amplifies end-to-end when stacked inside the redraw optimizer', () => {
    const stdout = new FakeStdout();
    // Production install order: optimizer innermost, reflow outermost.
    const optimizer = installTerminalRedrawOptimizer(
      stdout as unknown as NodeJS.WriteStream,
    );
    const reflow = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
    );
    try {
      stdout.write(eraseLines(10) + frame(60, 10));
      stdout.columns = 30;
      stdout.emit('resize');
      stdout.write(eraseLines(10) + frame(30, 20));
      // Reflow amplified to 20 before the optimizer compressed the prefix.
      expect(stdout.written.at(-1)).toContain(`${ESC}19A`);
      expect(stdout.written.at(-1)).toContain(frame(30, 20));
    } finally {
      reflow.restore();
      optimizer();
    }
  });

  it('wrapper restores unwind in LIFO order only', () => {
    const stdout = new FakeStdout();
    const original = stdout.write;
    const optimizer = installTerminalRedrawOptimizer(
      stdout as unknown as NodeJS.WriteStream,
    );
    // Force the sync wrapper on regardless of the host terminal's
    // TERM_PROGRAM so the LIFO contract is tested identically in CI.
    const sync = installSynchronizedOutput(
      stdout as unknown as NodeJS.WriteStream,
      { QWEN_CODE_FORCE_SYNCHRONIZED_OUTPUT: '1' },
    );
    const reflow = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
    );
    reflow.restore();
    sync();
    optimizer();
    expect(stdout.write).toBe(original);

    // Out-of-order restore leaks wrappers silently (identity guards no-op).
    const stdout2 = new FakeStdout();
    const original2 = stdout2.write;
    const optimizer2 = installTerminalRedrawOptimizer(
      stdout2 as unknown as NodeJS.WriteStream,
    );
    const sync2 = installSynchronizedOutput(
      stdout2 as unknown as NodeJS.WriteStream,
      { QWEN_CODE_FORCE_SYNCHRONIZED_OUTPUT: '1' },
    );
    const reflow2 = installTerminalResizeReflow(
      stdout2 as unknown as NodeJS.WriteStream,
    );
    sync2(); // wrong order: middle layer restored before the outer one
    reflow2.restore(); // re-installs syncWrapper as "original"
    optimizer2();
    expect(stdout2.write).not.toBe(original2);
  });
});

describe('buildWakeRepaint', () => {
  const deps = () => ({
    isVP: true,
    repaintViewport: vi.fn(),
    refreshStatic: vi.fn(),
    remountStaticHistory: vi.fn(),
  });

  it('VP with prop: calls it and bumps the static remount key', () => {
    const d = deps();
    buildWakeRepaint(d)();
    expect(d.repaintViewport).toHaveBeenCalledTimes(1);
    expect(d.remountStaticHistory).toHaveBeenCalledTimes(1);
    expect(d.refreshStatic).not.toHaveBeenCalled();
  });

  it('VP without prop (legacy hatch): write-free, bump only', () => {
    const d = deps();
    buildWakeRepaint({ ...d, repaintViewport: undefined })();
    // A bare viewport clear would blank the screen (Ink writes zero bytes
    // for unchanged output); pre-PR behavior was stale-but-visible.
    expect(d.remountStaticHistory).toHaveBeenCalledTimes(1);
    expect(d.refreshStatic).not.toHaveBeenCalled();
  });

  it('static mode: uses refreshStatic (which clears and bumps)', () => {
    const d = deps();
    buildWakeRepaint({ ...d, isVP: false })();
    expect(d.refreshStatic).toHaveBeenCalledTimes(1);
    expect(d.repaintViewport).not.toHaveBeenCalled();
    expect(d.remountStaticHistory).not.toHaveBeenCalled();
  });
});
