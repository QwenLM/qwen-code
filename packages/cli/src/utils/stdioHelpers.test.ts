/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeStderrLine, writeStderrLineSafe } from './stdioHelpers.js';

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
