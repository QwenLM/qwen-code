/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import {
  isPidAlive,
  isSameProcess,
  readProcStartToken,
} from './process-liveness.js';

/** A PID that is essentially certain not to be running. */
const DEAD_PID = 0x7ffffffe;

describe('isPidAlive', () => {
  it('reports the current process as alive', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it('reports an unused pid as dead', () => {
    expect(isPidAlive(DEAD_PID)).toBe(false);
  });

  it('rejects nonsense pids without throwing', () => {
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    expect(isPidAlive(1.5)).toBe(false);
    expect(isPidAlive(NaN)).toBe(false);
  });

  // Neither errno is reachable from a test that probes a real PID: EPERM
  // needs a process owned by another user, EACCES needs an elevated
  // Windows process and a non-elevated prober. Stub the probe instead —
  // the branch decides whether a sweep deletes a live session's record,
  // so leaving it to the platform means never testing it at all.
  it.each([
    ['EPERM', 'another user owns it (POSIX)'],
    ['EACCES', 'Mandatory Integrity Control denied OpenProcess (Windows)'],
    ['EINVAL', 'an errno this code has not anticipated'],
  ])('treats %s as alive — %s', (code) => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      const error: NodeJS.ErrnoException = new Error(`probe failed: ${code}`);
      error.code = code;
      throw error;
    });
    try {
      expect(isPidAlive(DEAD_PID)).toBe(true);
    } finally {
      kill.mockRestore();
    }
  });

  it('treats ESRCH as dead, the one errno that proves it', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      const error: NodeJS.ErrnoException = new Error('no such process');
      error.code = 'ESRCH';
      throw error;
    });
    try {
      expect(isPidAlive(process.pid)).toBe(false);
    } finally {
      kill.mockRestore();
    }
  });
});

describe('readProcStartToken', () => {
  it('returns a numeric token for a live process on Linux', () => {
    const token = readProcStartToken(process.pid);
    if (process.platform !== 'linux') {
      expect(token).toBeNull();
      return;
    }
    expect(token).toMatch(/^\d+$/);
  });

  it('is stable across calls', () => {
    expect(readProcStartToken(process.pid)).toBe(
      readProcStartToken(process.pid),
    );
  });

  it('returns null for a dead pid', () => {
    expect(readProcStartToken(DEAD_PID)).toBeNull();
  });
});

describe('isSameProcess', () => {
  it('is false for a dead pid regardless of token', () => {
    expect(isSameProcess(DEAD_PID, null)).toBe(false);
    expect(isSameProcess(DEAD_PID, '123')).toBe(false);
  });

  it('accepts a live pid recorded without a token', () => {
    expect(isSameProcess(process.pid, null)).toBe(true);
    expect(isSameProcess(process.pid, undefined)).toBe(true);
  });

  it('accepts a live pid whose token still matches', () => {
    const token = readProcStartToken(process.pid);
    expect(isSameProcess(process.pid, token)).toBe(true);
  });

  it('rejects a live pid whose token has changed', () => {
    if (process.platform !== 'linux') return;
    expect(isSameProcess(process.pid, 'definitely-not-the-token')).toBe(false);
  });
});
