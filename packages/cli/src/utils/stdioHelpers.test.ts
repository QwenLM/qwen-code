/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ignoreBrokenPipe,
  ignoreBrokenStderr,
  writeStderrLine,
  writeStderrLineSafe,
  writeStdoutLineSafe,
} from './stdioHelpers.js';

afterEach(() => vi.restoreAllMocks());

describe('writeStderrLine', () => {
  it('appends a newline, but not a second one', () => {
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    writeStderrLine('plain');
    writeStderrLine('already\n');

    expect(write).toHaveBeenNthCalledWith(1, 'plain\n');
    expect(write).toHaveBeenNthCalledWith(2, 'already\n');
  });

  it('propagates a write failure', () => {
    // The default on purpose: most of the CLI wants a broken stderr to be loud.
    vi.spyOn(process.stderr, 'write').mockImplementation(() => {
      throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    });

    expect(() => writeStderrLine('boom')).toThrow('write EPIPE');
  });
});

describe('writeStderrLineSafe', () => {
  it('writes exactly like writeStderrLine when stderr is healthy', () => {
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    writeStderrLineSafe('hello');

    expect(write).toHaveBeenCalledWith('hello\n');
  });

  it('swallows EPIPE instead of taking the caller down with it', () => {
    // `qwen … | head`, or a daemon whose stderr reader went away. Callers use
    // this where the write is incidental and a throw would destroy real work —
    // abandoning a transcript replay over a failed diagnostic, say.
    vi.spyOn(process.stderr, 'write').mockImplementation(() => {
      throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    });

    expect(() => writeStderrLineSafe('boom')).not.toThrow();
  });
});

describe('writeStdoutLineSafe', () => {
  it('writes with a trailing newline when stdout is healthy', () => {
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    writeStdoutLineSafe('hello');

    expect(write).toHaveBeenCalledWith('hello\n');
  });

  it('swallows EPIPE instead of taking the caller down with it', () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => {
      throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    });

    expect(() => writeStdoutLineSafe('boom')).not.toThrow();
  });
});

describe('ignoreBrokenStderr', () => {
  it('destroys stderr once on async EPIPE and ignores repeat calls', () => {
    const beforeListeners = new Set(process.stderr.listeners('error'));
    const destroySpy = vi
      .spyOn(process.stderr, 'destroy')
      .mockReturnValue(process.stderr);

    try {
      ignoreBrokenStderr();
      ignoreBrokenStderr();

      const addedListeners = process.stderr
        .listeners('error')
        .filter((listener) => !beforeListeners.has(listener));
      expect(addedListeners).toHaveLength(1);

      process.stderr.emit(
        'error',
        Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }),
      );
      expect(destroySpy).toHaveBeenCalledTimes(1);
    } finally {
      for (const listener of process.stderr.listeners('error')) {
        if (!beforeListeners.has(listener)) {
          process.stderr.removeListener(
            'error',
            listener as (...args: unknown[]) => void,
          );
        }
      }
    }
  });
});

describe('ignoreBrokenPipe', () => {
  it('destroys stdout and stderr once on async EPIPE and ignores repeat calls', () => {
    const beforeStdout = new Set(process.stdout.listeners('error'));
    const beforeStderr = new Set(process.stderr.listeners('error'));
    const stdoutDestroySpy = vi
      .spyOn(process.stdout, 'destroy')
      .mockReturnValue(process.stdout);
    const stderrDestroySpy = vi
      .spyOn(process.stderr, 'destroy')
      .mockReturnValue(process.stderr);

    try {
      ignoreBrokenPipe();
      ignoreBrokenPipe();

      const addedStdout = process.stdout
        .listeners('error')
        .filter((listener) => !beforeStdout.has(listener));
      const addedStderr = process.stderr
        .listeners('error')
        .filter((listener) => !beforeStderr.has(listener));
      expect(addedStdout).toHaveLength(1);
      expect(addedStderr).toHaveLength(1);

      const epipe = Object.assign(new Error('write EPIPE'), {
        code: 'EPIPE',
      });
      process.stdout.emit('error', epipe);
      process.stderr.emit('error', epipe);
      expect(stdoutDestroySpy).toHaveBeenCalledTimes(1);
      expect(stderrDestroySpy).toHaveBeenCalledTimes(1);
    } finally {
      for (const listener of process.stdout.listeners('error')) {
        if (!beforeStdout.has(listener)) {
          process.stdout.removeListener(
            'error',
            listener as (...args: unknown[]) => void,
          );
        }
      }
      for (const listener of process.stderr.listeners('error')) {
        if (!beforeStderr.has(listener)) {
          process.stderr.removeListener(
            'error',
            listener as (...args: unknown[]) => void,
          );
        }
      }
    }
  });
});
