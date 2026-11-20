/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Verifies the OpenTUI screen-reader policy reproduces the original ink
 * behavior flag by flag: plain text, no virtual viewport, no mouse,
 * append-only output, and no redraw/sync wrappers.
 */

import { describe, it, expect } from 'vitest';
import {
  applyScreenReaderPolicy,
  eraseLines,
  hardWrap,
  isScreenReaderEnabled,
  resolveScreenReaderPolicy,
  screenReaderRendererOptions,
  ScreenReaderOutputWriter,
} from './a11y-screen-reader.js';

describe('isScreenReaderEnabled', () => {
  it('defaults to false when unset (config resolution parity)', () => {
    expect(isScreenReaderEnabled(undefined)).toBe(false);
    expect(isScreenReaderEnabled(false)).toBe(false);
    expect(isScreenReaderEnabled(true)).toBe(true);
  });
});

describe('resolveScreenReaderPolicy', () => {
  it('enables plain text + append-only and disables mouse/VP/sync in SR mode', () => {
    const policy = resolveScreenReaderPolicy({
      screenReader: true,
      useTerminalBuffer: true,
      isTTY: true,
      env: {},
    });
    expect(policy).toEqual({
      enabled: true,
      plainText: true,
      appendOnly: true,
      virtualViewport: false,
      mouse: false,
      synchronizedOutput: false,
      redrawOptimizer: false,
    });
  });

  it('keeps the normal interactive mode when SR is off', () => {
    const policy = resolveScreenReaderPolicy({
      screenReader: false,
      useTerminalBuffer: true,
      isTTY: true,
      env: {},
    });
    expect(policy).toEqual({
      enabled: false,
      plainText: false,
      appendOnly: false,
      virtualViewport: true,
      mouse: true,
      synchronizedOutput: true,
      redrawOptimizer: true,
    });
  });

  it('disables VP on non-TTY stdout even with SR off', () => {
    const policy = resolveScreenReaderPolicy({
      screenReader: undefined,
      isTTY: false,
      env: {},
    });
    expect(policy.virtualViewport).toBe(false);
    expect(policy.synchronizedOutput).toBe(false);
    expect(policy.redrawOptimizer).toBe(false);
    expect(policy.mouse).toBe(true);
  });

  it('honors useTerminalBuffer=false like the ink setting', () => {
    const policy = resolveScreenReaderPolicy({
      screenReader: false,
      useTerminalBuffer: false,
      isTTY: true,
      env: {},
    });
    expect(policy.virtualViewport).toBe(false);
  });

  it('treats CI environments as non-interactive (isInteractiveTerminal parity)', () => {
    const policy = resolveScreenReaderPolicy({
      screenReader: false,
      useTerminalBuffer: true,
      isTTY: true,
      env: { CI: 'true' },
    });
    expect(policy.virtualViewport).toBe(false);
  });

  it('defaults ConEmu/Cmder to the append-only path', () => {
    const policy = resolveScreenReaderPolicy({
      screenReader: false,
      isTTY: true,
      env: { ConEmuPID: '12345' },
    });
    expect(policy.virtualViewport).toBe(false);

    const optedIn = resolveScreenReaderPolicy({
      screenReader: false,
      useTerminalBuffer: true,
      isTTY: true,
      env: { CMDER_SHELL: 'cmd' },
    });
    expect(optedIn.virtualViewport).toBe(true);
  });
});

describe('screenReaderRendererOptions', () => {
  it('keeps the main screen and disables mouse in SR mode', () => {
    const policy = resolveScreenReaderPolicy({
      screenReader: true,
      isTTY: true,
      env: {},
    });
    expect(screenReaderRendererOptions(policy)).toEqual({
      useMouse: false,
      screenMode: 'main-screen',
    });
  });

  it('preserves the opentui alternate-screen default otherwise', () => {
    const policy = resolveScreenReaderPolicy({
      screenReader: false,
      isTTY: true,
      env: {},
    });
    expect(screenReaderRendererOptions(policy)).toEqual({
      useMouse: true,
      screenMode: 'alternate-screen',
    });
  });
});

describe('applyScreenReaderPolicy', () => {
  it('toggles the renderer mouse switch live', () => {
    const renderer = { useMouse: true };
    applyScreenReaderPolicy(
      renderer,
      resolveScreenReaderPolicy({ screenReader: true, isTTY: true, env: {} }),
    );
    expect(renderer.useMouse).toBe(false);
    applyScreenReaderPolicy(
      renderer,
      resolveScreenReaderPolicy({ screenReader: false, isTTY: true, env: {} }),
    );
    expect(renderer.useMouse).toBe(true);
  });
});

describe('eraseLines', () => {
  it('emits nothing for zero lines', () => {
    expect(eraseLines(0)).toBe('');
    expect(eraseLines(-3)).toBe('');
  });

  it('erases line by line walking up and resets the cursor column (ink eraseLines parity)', () => {
    expect(eraseLines(1)).toBe('\x1b[2K\x1b[G');
    expect(eraseLines(3)).toBe('\x1b[2K\x1b[1A\x1b[2K\x1b[1A\x1b[2K\x1b[G');
  });
});

describe('hardWrap', () => {
  it('splits long lines at the width boundary', () => {
    expect(hardWrap('abcdef', 2)).toBe('ab\ncd\nef');
    expect(hardWrap('abcde', 2)).toBe('ab\ncd\ne');
  });

  it('keeps short lines and handles multi-line input', () => {
    expect(hardWrap('ab\ncdef', 2)).toBe('ab\ncd\nef');
  });

  it('disables wrapping for non-positive widths', () => {
    expect(hardWrap('abcdef', 0)).toBe('abcdef');
  });

  it('measures display columns, not UTF-16 units (CJK glyphs are 2 columns)', () => {
    // wrapAnsi(..., { hard: true }) parity: 3 CJK glyphs are 6 columns wide,
    // so width 4 wraps after the second glyph — a UTF-16 counter would not
    // wrap at all (3 code units).
    expect(hardWrap('你好吗', 4)).toBe('你好\n吗');
  });

  it('keeps a glyph wider than the width on its own line', () => {
    // wrap-ansi's exact output for a 2-column glyph at width 1 keeps a
    // leading empty line — byte parity with ink's screen-reader path.
    expect(hardWrap('你好', 1)).toBe('\n你\n好');
  });

  it('wraps at word boundaries like ink (R2-41)', () => {
    expect(hardWrap('aa bb cc dd', 5)).toBe('aa bb\n cc \ndd');
  });
});

describe('ScreenReaderOutputWriter (ink append-only parity)', () => {
  it('writes static content exactly once with a trailing newline', () => {
    const writes: string[] = [];
    const writer = new ScreenReaderOutputWriter((chunk) => writes.push(chunk));
    writer.appendStatic('User: hello');
    writer.appendStatic('Model: hi');
    expect(writes).toEqual(['User: hello\n', 'Model: hi\n']);
  });

  it('does not rewrite an unchanged dynamic block', () => {
    const writes: string[] = [];
    const writer = new ScreenReaderOutputWriter((chunk) => writes.push(chunk));
    writer.updateDynamic('streaming…');
    writer.updateDynamic('streaming…');
    expect(writes).toEqual(['streaming…']);
  });

  it('erases the previous dynamic block before writing a new one', () => {
    const writes: string[] = [];
    const writer = new ScreenReaderOutputWriter((chunk) => writes.push(chunk));
    writer.updateDynamic('a\nb');
    writer.updateDynamic('c');
    expect(writes).toEqual(['a\nb', '\x1b[2K\x1b[1A\x1b[2K\x1b[Gc']);
  });

  it('erases the pending dynamic block when appending static output', () => {
    const writes: string[] = [];
    const writer = new ScreenReaderOutputWriter((chunk) => writes.push(chunk));
    writer.updateDynamic('spinner');
    writer.appendStatic('User: next');
    // The static append resets the height: the next dynamic write has no erase.
    writer.updateDynamic('busy');
    expect(writes).toEqual([
      'spinner',
      '\x1b[2K\x1b[G',
      'User: next\n',
      'busy',
    ]);
  });

  it('ignores empty static appends (ink hasStaticOutput guard)', () => {
    const writes: string[] = [];
    const writer = new ScreenReaderOutputWriter((chunk) => writes.push(chunk));
    writer.updateDynamic('spinner');
    writer.appendStatic('');
    expect(writes).toEqual(['spinner']);
  });

  it('hard-wraps dynamic output at the writer column width', () => {
    const writes: string[] = [];
    const writer = new ScreenReaderOutputWriter(
      (chunk) => writes.push(chunk),
      () => 4,
    );
    writer.updateDynamic('abcdefgh');
    expect(writes).toEqual(['abcd\nefgh']);
  });

  it('clearDynamic erases the last block and resets state', () => {
    const writes: string[] = [];
    const writer = new ScreenReaderOutputWriter((chunk) => writes.push(chunk));
    writer.updateDynamic('x\ny');
    writer.clearDynamic();
    writer.updateDynamic('z');
    expect(writes).toEqual(['x\ny', '\x1b[2K\x1b[1A\x1b[2K\x1b[G', 'z']);
  });

  it('strips ANSI and bare control bytes from written content', () => {
    const writes: string[] = [];
    const writer = new ScreenReaderOutputWriter((chunk) => writes.push(chunk));
    // A model/tool result smuggling an OSC 52 clipboard write must reach
    // the terminal as plain text only.
    writer.appendStatic('\x1b]52;c;AAAA\x07copied\x1b[31mred\x1b[0m\x07bell');
    expect(writes).toEqual(['copiedredbell\n']);
  });

  it('keeps newlines (the writer appends its own) while dropping other C0 controls', () => {
    const writes: string[] = [];
    const writer = new ScreenReaderOutputWriter((chunk) => writes.push(chunk));
    writer.updateDynamic('a\x00b\x0bc\x7fd\ne');
    expect(writes).toEqual(['abcd\ne']);
  });

  it('hard-wraps static output at the writer column width', () => {
    const writes: string[] = [];
    const writer = new ScreenReaderOutputWriter(
      (chunk) => writes.push(chunk),
      () => 4,
    );
    writer.appendStatic('abcdefgh');
    expect(writes).toEqual(['abcd\nefgh\n']);
  });

  it('keeps TAB word separation in tool/model output (R3-6)', () => {
    const writes: string[] = [];
    const writer = new ScreenReaderOutputWriter((chunk) => writes.push(chunk));
    writer.appendStatic('NAME\tSIZE\nfoo\t10');
    // Both lanes hard-wrap via wrap-ansi (ink wraps its whole screen-reader
    // output), which expands tabs to the next tab stop. Word separation is
    // the point: deleting TAB outright fuses adjacent tokens.
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatch(/^NAME {2,}SIZE\nfoo {2,}10\n$/);
    const dynamicWrites: string[] = [];
    const dynamicWriter = new ScreenReaderOutputWriter((chunk) =>
      dynamicWrites.push(chunk),
    );
    dynamicWriter.updateDynamic('a\tb');
    expect(dynamicWrites[0]).toMatch(/^a {2,}b$/);
  });
});

describe('ScreenReaderOutputWriter C1 boundary', () => {
  const payloads = [
    ['OSC clipboard', '\u009d52;c;QUFBQQ==\u009c'],
    ['OSC title', '\u009d0;untrusted-title\u009c'],
    ['DCS', '\u0090untrusted-body\u009c'],
    ['APC', '\u009funtrusted-body\u009c'],
    ['PM', '\u009euntrusted-body\u009c'],
    ['SOS', '\u0098untrusted-body\u009c'],
    ['standalone ST', 'left\u009cright'],
    [
      'every C1 code point',
      String.fromCodePoint(
        ...Array.from({ length: 32 }, (_, index) => 0x80 + index),
      ),
    ],
  ] as const;

  describe.each(['static', 'dynamic'] as const)('%s output', (mode) => {
    it.each(payloads)(
      'does not forward C1 controls from %s content',
      (_name, payload) => {
        const chunks: string[] = [];
        const writer = new ScreenReaderOutputWriter((chunk) => {
          chunks.push(chunk);
        });
        if (mode === 'static') writer.appendStatic(payload);
        else writer.updateDynamic(payload);
        const forwardedControls = Array.from(
          chunks.join(''),
          (character) => character.codePointAt(0)!,
        ).filter((codePoint) => codePoint >= 0x80 && codePoint <= 0x9f);
        expect(forwardedControls).toEqual([]);
      },
    );
  });
});
