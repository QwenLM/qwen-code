/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  handleUncaughtException,
  isExpectedPtyRaceError,
} from './uncaught-exception-handler.js';

/**
 * The shape node hands us when a pty write fails after the master side went
 * away (terminal closed or detached). Reproduced against a real pty and seen in
 * the debug logs of #11783:
 *
 *   Error: write EIO
 *       at afterWriteDispatched (node:internal/stream_base_commons:159:15)
 *       at Socket._write (node:net:1183:8)
 *       at Writable.write (node:internal/streams/writable:508:10)
 *       at Ink.throttledLog.throttle.leading (chunk-O4KNCAX4.js:18137:29)
 */
const writeEio = (): Error =>
  Object.assign(new Error('write EIO'), {
    code: 'EIO',
    errno: -5,
    syscall: 'write',
  });

describe('isExpectedPtyRaceError', () => {
  it('treats a write-side EIO as a benign PTY teardown race', () => {
    expect(isExpectedPtyRaceError(writeEio())).toBe(true);
  });

  it('still tolerates every read-side race it tolerated before', () => {
    expect(
      isExpectedPtyRaceError(
        Object.assign(new Error('read EIO'), {
          code: 'EIO',
        }),
      ),
    ).toBe(true);
    expect(isExpectedPtyRaceError(new Error('read EIO'))).toBe(true);
    expect(
      isExpectedPtyRaceError(
        Object.assign(new Error('read EAGAIN'), {
          code: 'EAGAIN',
        }),
      ),
    ).toBe(true);
    expect(isExpectedPtyRaceError(new Error('read EAGAIN'))).toBe(true);
    expect(isExpectedPtyRaceError(new Error('ioctl(2) failed, EBADF'))).toBe(
      true,
    );
    expect(
      isExpectedPtyRaceError(
        new Error('Cannot resize a pty that has already exited'),
      ),
    ).toBe(true);
  });

  it.each([
    ['a plain error', new Error('other failure')],
    ['a TypeError', new TypeError('cannot read property of undefined')],
    [
      'an unrelated errno',
      Object.assign(new Error('open EACCES'), { code: 'EACCES' }),
    ],
    [
      'a write failure with a real errno',
      Object.assign(new Error('write EACCES'), { code: 'EACCES' }),
    ],
    // EIO from something other than a pty read/write must not be swept up just
    // because the errno matches.
    [
      'an EIO with neither read nor write in the message',
      Object.assign(new Error('device not available'), { code: 'EIO' }),
    ],
    ['a non-Error throw', 'write EIO'],
    ['null', null],
  ])('stays fatal for %s', (_label, error) => {
    expect(isExpectedPtyRaceError(error)).toBe(false);
  });
});

describe('handleUncaughtException', () => {
  let stderr: string[];

  beforeEach(() => {
    stderr = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation(((code) => {
      throw new Error(`process.exit:${String(code)}`);
    }) as typeof process.exit);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('suppresses a write-side EIO without reporting or exiting', () => {
    handleUncaughtException(writeEio());

    expect(process.exit).not.toHaveBeenCalled();
    expect(stderr.join('')).toBe('');
  });

  it('still reports a real error to stderr and exits 1', () => {
    expect(() => handleUncaughtException(new TypeError('boom'))).toThrow(
      'process.exit:1',
    );

    expect(process.exit).toHaveBeenCalledWith(1);
    expect(stderr.join('')).toContain('boom');
  });

  it('still reports an EIO that is not a pty race and exits 1', () => {
    const error = Object.assign(new Error('device not available'), {
      code: 'EIO',
    });

    expect(() => handleUncaughtException(error)).toThrow('process.exit:1');

    expect(process.exit).toHaveBeenCalledWith(1);
    expect(stderr.join('')).toContain('device not available');
  });

  it('still reports a non-Error throw and exits 1', () => {
    expect(() => handleUncaughtException('string failure')).toThrow(
      'process.exit:1',
    );

    expect(process.exit).toHaveBeenCalledWith(1);
    expect(stderr.join('')).toContain('string failure');
  });
});
