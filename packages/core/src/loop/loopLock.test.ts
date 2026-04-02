/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  acquireLock,
  releaseLock,
  renewHeartbeat,
  isLockHeld,
} from './loopLock.js';

describe('loopLock', () => {
  let qwenDir: string;

  beforeEach(async () => {
    const base = await mkdtemp(join(tmpdir(), 'lock-test-'));
    qwenDir = join(base, '.qwen');
  });

  afterEach(async () => {
    await rm(join(qwenDir, '..'), { recursive: true, force: true });
  });

  // -- acquireLock ----------------------------------------------------------

  it('acquires lock when no lock file exists', async () => {
    const result = await acquireLock(qwenDir, 'session-1');
    expect(result).toBe(true);

    const held = await isLockHeld(qwenDir);
    expect(held.held).toBe(true);
    expect(held.sessionId).toBe('session-1');
  });

  it('creates .qwen directory if it does not exist', async () => {
    await acquireLock(qwenDir, 'session-1');
    const data = await readFile(join(qwenDir, 'loop-lock.json'), 'utf-8');
    expect(JSON.parse(data).sessionId).toBe('session-1');
  });

  it('renews lock if already owned by same session', async () => {
    await acquireLock(qwenDir, 'session-1');
    const result = await acquireLock(qwenDir, 'session-1');
    expect(result).toBe(true);
  });

  it('blocks lock if held by another live session', async () => {
    // Write a lock with the current PID (so isPidAlive returns true)
    await mkdir(qwenDir, { recursive: true });
    await writeFile(
      join(qwenDir, 'loop-lock.json'),
      JSON.stringify({
        sessionId: 'other-session',
        pid: process.pid, // current process — alive
        acquiredAt: Date.now(),
        heartbeatAt: Date.now(),
      }),
    );

    const result = await acquireLock(qwenDir, 'my-session');
    expect(result).toBe(false);
  });

  it('takes over stale lock (dead PID + old heartbeat)', async () => {
    await mkdir(qwenDir, { recursive: true });
    await writeFile(
      join(qwenDir, 'loop-lock.json'),
      JSON.stringify({
        sessionId: 'dead-session',
        pid: 999999, // very likely not a real PID
        acquiredAt: 0,
        heartbeatAt: 0, // very old
      }),
    );

    const result = await acquireLock(qwenDir, 'my-session');
    expect(result).toBe(true);

    const held = await isLockHeld(qwenDir);
    expect(held.sessionId).toBe('my-session');
  });

  it('does NOT take over when PID is alive even if heartbeat is old', async () => {
    await mkdir(qwenDir, { recursive: true });
    await writeFile(
      join(qwenDir, 'loop-lock.json'),
      JSON.stringify({
        sessionId: 'other',
        pid: process.pid, // alive
        acquiredAt: 0,
        heartbeatAt: 0, // old, but PID alive → not stale
      }),
    );

    const result = await acquireLock(qwenDir, 'my-session');
    expect(result).toBe(false);
  });

  // -- releaseLock ----------------------------------------------------------

  it('releases own lock', async () => {
    await acquireLock(qwenDir, 'session-1');
    await releaseLock(qwenDir, 'session-1');
    expect((await isLockHeld(qwenDir)).held).toBe(false);
  });

  it('does not release another session lock', async () => {
    await acquireLock(qwenDir, 'session-1');
    await releaseLock(qwenDir, 'session-2');
    expect((await isLockHeld(qwenDir)).held).toBe(true);
  });

  // -- renewHeartbeat -------------------------------------------------------

  it('renews heartbeat for owned lock', async () => {
    await acquireLock(qwenDir, 'session-1');
    const before = JSON.parse(
      await readFile(join(qwenDir, 'loop-lock.json'), 'utf-8'),
    ).heartbeatAt;

    // Small delay to ensure timestamp differs
    await new Promise((r) => setTimeout(r, 10));
    await renewHeartbeat(qwenDir, 'session-1');

    const after = JSON.parse(
      await readFile(join(qwenDir, 'loop-lock.json'), 'utf-8'),
    ).heartbeatAt;
    expect(after).toBeGreaterThanOrEqual(before);
  });

  it('does not renew heartbeat for non-owned lock', async () => {
    await acquireLock(qwenDir, 'session-1');
    await renewHeartbeat(qwenDir, 'session-2');

    const data = JSON.parse(
      await readFile(join(qwenDir, 'loop-lock.json'), 'utf-8'),
    );
    expect(data.sessionId).toBe('session-1');
  });

  // -- isLockHeld -----------------------------------------------------------

  it('returns not held when no lock file', async () => {
    const held = await isLockHeld(qwenDir);
    expect(held.held).toBe(false);
  });

  it('returns not held for corrupted lock file', async () => {
    await mkdir(qwenDir, { recursive: true });
    await writeFile(join(qwenDir, 'loop-lock.json'), 'not json');
    expect((await isLockHeld(qwenDir)).held).toBe(false);
  });
});
