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

  it('erases line by line walking up (ink eraseLines parity)', () => {
    expect(eraseLines(1)).toBe('\x1b[2K');
    expect(eraseLines(3)).toBe('\x1b[2K\x1b[1A\x1b[2K\x1b[1A\x1b[2K');
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
    expect(writes).toEqual(['a\nb', '\x1b[2K\x1b[1A\x1b[2Kc']);
  });

  it('erases the pending dynamic block when appending static output', () => {
    const writes: string[] = [];
    const writer = new ScreenReaderOutputWriter((chunk) => writes.push(chunk));
    writer.updateDynamic('spinner');
    writer.appendStatic('User: next');
    // The static append resets the height: the next dynamic write has no erase.
    writer.updateDynamic('busy');
    expect(writes).toEqual(['spinner', '\x1b[2K', 'User: next\n', 'busy']);
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
    expect(writes).toEqual(['x\ny', '\x1b[2K\x1b[1A\x1b[2K', 'z']);
  });
});
