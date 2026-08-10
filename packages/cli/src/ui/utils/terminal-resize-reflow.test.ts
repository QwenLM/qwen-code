/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { installTerminalResizeReflow } from './terminal-resize-reflow.js';

const ESC = '\u001B[';

function eraseLines(count: number): string {
  let clear = '';
  for (let i = 0; i < count; i++) {
    clear += `${ESC}2K` + (i < count - 1 ? `${ESC}1A` : '');
  }
  if (count) clear += `${ESC}G`;
  return clear;
}

function frame(width: number, rows: number): string {
  return Array.from({ length: rows }, () => 'x'.repeat(width)).join('\n');
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
    const restore = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
    );
    try {
      // A frame that reaches the terminal shapes the model (10 rows x 60).
      stdout.write(eraseLines(10) + frame(60, 10));
      stdout.columns = 30; // 60-wide rows reflow to 2 rows each
      stdout.emit('resize');
      stdout.write(eraseLines(10) + frame(30, 20));
      expect(stdout.written.at(-1)).toBe(eraseLines(20) + frame(30, 20));
    } finally {
      restore();
    }
  });

  it('VP mode replaces the stale clear with a viewport clear', () => {
    const stdout = new FakeStdout();
    const restore = installTerminalResizeReflow(
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

  it('leaves grows and pre-shrink writes untouched', () => {
    const stdout = new FakeStdout();
    const restore = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
    );
    try {
      stdout.write(eraseLines(10) + frame(60, 10));
      stdout.columns = 200;
      stdout.emit('resize');
      stdout.write(eraseLines(10) + frame(60, 10));
      expect(stdout.written.at(-1)).toBe(eraseLines(10) + frame(60, 10));
    } finally {
      restore();
    }
  });

  it('does not amplify Static-style appends (no erase prefix)', () => {
    const stdout = new FakeStdout();
    const restore = installTerminalResizeReflow(
      stdout as unknown as NodeJS.WriteStream,
    );
    try {
      stdout.write(eraseLines(10) + frame(60, 10));
      stdout.columns = 30;
      stdout.emit('resize');
      stdout.write(frame(60, 10) + '\nappended history line');
      expect(stdout.written.at(-1)).toBe(
        frame(60, 10) + '\nappended history line',
      );
    } finally {
      restore();
    }
  });

  it('passes writes through untouched after restore', () => {
    const stdout = new FakeStdout();
    const restore = installTerminalResizeReflow(
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
