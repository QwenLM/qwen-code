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

  it('accepts a live pid recorded without a token only where the platform has none', () => {
    // On Linux a live PID always reads back a token, so a record that
    // carries none was not written by this code — trusting it would let
    // any planted record opt out of the token check simply by omitting
    // the field. Everywhere else the absence is honest and liveness is
    // all there is to go on.
    const expected = process.platform !== 'linux';
    expect(isSameProcess(process.pid, null)).toBe(expected);
    expect(isSameProcess(process.pid, undefined)).toBe(expected);
  });

  it('accepts a token-less record for a pid whose token cannot be read', () => {
    // The honest case the branch above exists for, reachable on Linux
    // too: a PID that is alive but whose `/proc/<pid>/stat` this process
    // may not read produces no current token, so the record's silence is
    // uncontradicted and liveness has to win.
    const spy = vi.spyOn(process, 'kill').mockReturnValue(true);
    try {
      expect(isSameProcess(DEAD_PID, null)).toBe(true);
    } finally {
      spy.mockRestore();
    }
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
