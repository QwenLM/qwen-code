/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  writeStderrLine,
  writeStderrLineBestEffort,
  writeStderrLineSafe,
  writeStdoutLineBestEffort,
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

describe('writeStdoutLineBestEffort', () => {
  it('writes with a trailing newline when stdout is healthy', () => {
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    writeStdoutLineBestEffort('hello');

    expect(write).toHaveBeenCalledWith('hello\n');
  });

  it('swallows a synchronous EPIPE like writeStdoutLineSafe', () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => {
      throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    });

    expect(() => writeStdoutLineBestEffort('boom')).not.toThrow();
  });

  it('survives the ASYNC stdout error event a plain safe write cannot', () => {
    // The class try/catch cannot reach: a redirected stdout target failing
    // makes Node emit 'error' on the stream ASYNCHRONOUSLY, terminating a
    // process with no listener past any surrounding try/catch. The
    // best-effort sink installs a no-op guard while nothing else listens
    // (R11-13).
    writeStdoutLineBestEffort('install the guard');
    expect(process.stdout.listenerCount('error')).toBeGreaterThanOrEqual(1);

    // With the guard present the emitted stream error is absorbed instead
    // of surfacing as an unhandled 'error' event. Without the guard this
    // emit itself throws 'Unhandled error event'.
    expect(() =>
      process.stdout.emit('error', new Error('write EPIPE')),
    ).not.toThrow();

    // The guard is a single no-op listener: repeated best-effort writes
    // must not stack listeners on the shared stream.
    const count = process.stdout.listenerCount('error');
    writeStdoutLineBestEffort('again');
    expect(process.stdout.listenerCount('error')).toBe(count);
  });
});

describe('writeStderrLineBestEffort', () => {
  // Mirror of the stdout twin's three pins (R14): the stderr sink guards the
  // SAME async-crash class on process.stderr — a reserved-channel-name
  // warning emitted on every launch of a long-lived supervisor path
  // crash-loops the worker when the stderr target fails, the exact hazard
  // the helper exists to prevent. Without direct pins, aliasing the
  // export to writeStderrLineSafe or installing the guard on the wrong
  // stream ships green (the only other test touching it spies it out).
  it('writes with a trailing newline when stderr is healthy', () => {
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    writeStderrLineBestEffort('hello');

    expect(write).toHaveBeenCalledWith('hello\n');
  });

  it('swallows a synchronous EPIPE like writeStderrLineSafe', () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => {
      throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    });

    expect(() => writeStderrLineBestEffort('boom')).not.toThrow();
  });

  it('survives the ASYNC stderr error event a plain safe write cannot', () => {
    writeStderrLineBestEffort('install the guard');
    expect(process.stderr.listenerCount('error')).toBeGreaterThanOrEqual(1);

    // With the guard present the emitted stream error is absorbed instead
    // of surfacing as an unhandled 'error' event. Without the guard this
    // emit itself throws 'Unhandled error event'.
    expect(() =>
      process.stderr.emit('error', new Error('write EPIPE')),
    ).not.toThrow();

    // The guard is a single no-op listener: repeated best-effort writes
    // must not stack listeners on the shared stream.
    const count = process.stderr.listenerCount('error');
    writeStderrLineBestEffort('again');
    expect(process.stderr.listenerCount('error')).toBe(count);
  });
});
