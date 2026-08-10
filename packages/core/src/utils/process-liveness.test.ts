/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
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
  it('identifies the current process with a platform-prefixed token', async () => {
    const token = await readProcStartToken(process.pid);
    if (process.platform === 'linux') {
      // Boot ID plus start ticks: ticks alone reset on reboot, so a
      // record surviving a reboot could otherwise match a later process
      // with the same PID and tick count.
      expect(token).toMatch(/^linux:[0-9a-f-]+:\d+$/);
    } else if (process.platform === 'darwin') {
      expect(token).toMatch(/^darwin:/);
    } else if (process.platform === 'win32') {
      expect(token).toMatch(/^win32:\d+$/);
    } else {
      expect(token).toBeNull();
    }
  });

  it('is stable across calls', async () => {
    expect(await readProcStartToken(process.pid)).toBe(
      await readProcStartToken(process.pid),
    );
  });

  it('returns null for a dead pid', async () => {
    expect(await readProcStartToken(DEAD_PID)).toBeNull();
  });

  it('returns null for nonsense pids without throwing', async () => {
    expect(await readProcStartToken(0)).toBeNull();
    expect(await readProcStartToken(-1)).toBeNull();
    expect(await readProcStartToken(1.5)).toBeNull();
  });
});

describe('isSameProcess', () => {
  it('is false for a dead pid regardless of token', async () => {
    expect(await isSameProcess(DEAD_PID, null)).toBe(false);
    expect(await isSameProcess(DEAD_PID, 'linux:boot:123')).toBe(false);
  });

  it('accepts a live pid recorded without a token', async () => {
    expect(await isSameProcess(process.pid, null)).toBe(true);
    expect(await isSameProcess(process.pid, undefined)).toBe(true);
  });

  it('accepts a live pid whose token still matches', async () => {
    const token = await readProcStartToken(process.pid);
    expect(await isSameProcess(process.pid, token)).toBe(true);
  });

  it.skipIf(process.platform !== 'linux')(
    'rejects a live pid whose token has changed',
    async () => {
      // A plausible-looking identity that cannot belong to this boot: the
      // boot id is all zeros. A recycled PID carrying the old owner's
      // token must not pass as the same process.
      expect(
        await isSameProcess(
          process.pid,
          'linux:00000000-0000-0000-0000-000000000000:1',
        ),
      ).toBe(false);
    },
  );
});
