/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BEGIN_SYNCHRONIZED_UPDATE,
  END_SYNCHRONIZED_UPDATE,
  getSynchronizedOutputStatsSnapshot,
  installSynchronizedOutput,
  resetSynchronizedOutputStats,
  terminalSupportsSynchronizedOutput,
} from './synchronizedOutput.js';
import { installTerminalRedrawOptimizer } from './terminalRedrawOptimizer.js';

const ESC = '\u001B[';
const ERASE_LINE = `${ESC}2K`;
const CURSOR_UP_ONE = `${ESC}1A`;
const CURSOR_DOWN_ONE = `${ESC}1B`;
const CURSOR_LEFT = `${ESC}G`;

function createStdout(write: NodeJS.WriteStream['write']): NodeJS.WriteStream {
  return {
    isTTY: true,
    write,
  } as NodeJS.WriteStream;
}

describe('terminalSupportsSynchronizedOutput', () => {
  it.each([
    [{ TERM_PROGRAM: 'WezTerm' }, true],
    [{ TERM_PROGRAM: 'iTerm.app' }, true],
    [{ TERM: 'xterm-kitty' }, true],
    [{ KITTY_WINDOW_ID: '1' }, true],
    [{ TERM_PROGRAM: 'Apple_Terminal' }, false],
    [{ TERM_PROGRAM: 'JetBrains-JediTerm' }, false],
    [{ TERM_PROGRAM: 'WezTerm', TMUX: '/tmp/tmux' }, false],
    [{ TERM_PROGRAM: 'WezTerm', SSH_TTY: '/dev/pts/1' }, false],
    [{ TERM_PROGRAM: 'WezTerm', SSH_CLIENT: '127.0.0.1 1 2' }, false],
    [{ TERM_PROGRAM: 'WezTerm', QWEN_CODE_SYNCHRONIZED_OUTPUT: '0' }, false],
    [
      {
        TERM_PROGRAM: 'WezTerm',
        QWEN_CODE_DISABLE_SYNCHRONIZED_OUTPUT: '1',
        QWEN_CODE_FORCE_SYNCHRONIZED_OUTPUT: '1',
      },
      false,
    ],
    [
      {
        TERM_PROGRAM: 'Apple_Terminal',
        QWEN_CODE_FORCE_SYNCHRONIZED_OUTPUT: '1',
      },
      true,
    ],
  ])('detects support for %j', (env, expected) => {
    expect(terminalSupportsSynchronizedOutput(env)).toBe(expected);
  });
});

describe('installSynchronizedOutput', () => {
  afterEach(() => {
    resetSynchronizedOutputStats();
  });

  it('does not install for non-TTY stdout', () => {
    const write = vi.fn(() => true) as NodeJS.WriteStream['write'];
    const stdout = {
      isTTY: false,
      write,
    } as NodeJS.WriteStream;

    const restore = installSynchronizedOutput(stdout, {
      TERM_PROGRAM: 'WezTerm',
    });

    expect(stdout.write).toBe(write);
    restore();
  });

  it('wraps one synchronous write burst in balanced BSU and ESU markers', async () => {
    const writes: string[] = [];
    const write = vi.fn((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    }) as NodeJS.WriteStream['write'];
    const stdout = createStdout(write);

    const restore = installSynchronizedOutput(stdout, {
      TERM_PROGRAM: 'WezTerm',
    });

    stdout.write('frame-a');
    stdout.write(Buffer.from('frame-b'));
    await Promise.resolve();

    expect(writes).toEqual([
      BEGIN_SYNCHRONIZED_UPDATE,
      'frame-a',
      'frame-b',
      END_SYNCHRONIZED_UPDATE,
    ]);
    expect(getSynchronizedOutputStatsSnapshot()).toEqual({
      synchronizedOutputFrameCount: 1,
      synchronizedOutputBeginCount: 1,
      synchronizedOutputEndCount: 1,
    });

    restore();
    expect(stdout.write).toBe(write);
  });

  it('preserves write return values and callbacks', async () => {
    const callback = vi.fn();
    const write = vi.fn(
      (
        _chunk: string | Uint8Array,
        encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
      ) => {
        if (typeof encodingOrCallback === 'function') {
          encodingOrCallback();
        }
        return false;
      },
    ) as NodeJS.WriteStream['write'];
    const stdout = createStdout(write);

    const restore = installSynchronizedOutput(stdout, {
      TERM_PROGRAM: 'iTerm.app',
    });

    const result = stdout.write('payload', callback);
    await Promise.resolve();

    expect(result).toBe(false);
    expect(callback).toHaveBeenCalledTimes(1);
    restore();
  });

  it('composes after terminal redraw optimization without losing erase optimization', async () => {
    const writes: string[] = [];
    const write = vi.fn((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    }) as NodeJS.WriteStream['write'];
    const stdout = createStdout(write);
    const restoreRedrawOptimizer = installTerminalRedrawOptimizer(stdout);
    const restoreSynchronizedOutput = installSynchronizedOutput(stdout, {
      TERM_PROGRAM: 'WezTerm',
    });

    stdout.write(
      `${ERASE_LINE}${CURSOR_UP_ONE}${ERASE_LINE}${CURSOR_UP_ONE}${ERASE_LINE}${CURSOR_LEFT}`,
    );
    await Promise.resolve();

    expect(writes).toEqual([
      BEGIN_SYNCHRONIZED_UPDATE,
      `${ESC}2A${ERASE_LINE}${CURSOR_DOWN_ONE}${ERASE_LINE}${CURSOR_DOWN_ONE}${ERASE_LINE}${ESC}2A${CURSOR_LEFT}`,
      END_SYNCHRONIZED_UPDATE,
    ]);

    restoreSynchronizedOutput();
    restoreRedrawOptimizer();
    expect(stdout.write).toBe(write);
  });

  it('closes an open frame before restore', () => {
    const writes: string[] = [];
    const write = vi.fn((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    }) as NodeJS.WriteStream['write'];
    const stdout = createStdout(write);
    const restore = installSynchronizedOutput(stdout, {
      TERM_PROGRAM: 'WezTerm',
    });

    stdout.write('payload');
    restore();

    expect(writes).toEqual([
      BEGIN_SYNCHRONIZED_UPDATE,
      'payload',
      END_SYNCHRONIZED_UPDATE,
    ]);
    expect(stdout.write).toBe(write);
  });
});
