/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runThrottledOnce } from './throttledOnce.js';

const MS_PER_HOUR = 60 * 60 * 1000;

describe('runThrottledOnce', () => {
  let tempDir: string;
  let markerPath: string;
  let lockPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-throttle-test-'));
    markerPath = path.join(tempDir, '.marker');
    lockPath = path.join(tempDir, '.marker.lock');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('runs task, writes marker, releases lock on first call', async () => {
    const task = vi.fn(async () => {});
    const ran = await runThrottledOnce(
      { name: 'test', markerPath, lockPath },
      task,
    );
    expect(ran).toBe(true);
    expect(task).toHaveBeenCalledOnce();
    expect(fs.existsSync(markerPath)).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('skips immediate second call (mtime gate)', async () => {
    const task1 = vi.fn(async () => {});
    const task2 = vi.fn(async () => {});
    await runThrottledOnce({ name: 'test', markerPath, lockPath }, task1);
    const ran2 = await runThrottledOnce(
      { name: 'test', markerPath, lockPath },
      task2,
    );
    expect(task1).toHaveBeenCalledOnce();
    expect(ran2).toBe(false);
    expect(task2).not.toHaveBeenCalled();
  });

  it('runs again after marker mtime is older than interval', async () => {
    const task1 = vi.fn(async () => {});
    await runThrottledOnce({ name: 'test', markerPath, lockPath }, task1);
    // Backdate marker to 25 hours ago (default interval is 24h).
    const past = new Date(Date.now() - 25 * MS_PER_HOUR);
    fs.utimesSync(markerPath, past, past);

    const task2 = vi.fn(async () => {});
    const ran2 = await runThrottledOnce(
      { name: 'test', markerPath, lockPath },
      task2,
    );
    expect(ran2).toBe(true);
    expect(task2).toHaveBeenCalledOnce();
  });

  it('only one of two concurrent calls runs the task', async () => {
    const task = vi.fn(async (): Promise<void> => {
      await new Promise((r) => setTimeout(r, 50));
    });
    const [a, b] = await Promise.all([
      runThrottledOnce({ name: 'test', markerPath, lockPath }, task),
      runThrottledOnce({ name: 'test', markerPath, lockPath }, task),
    ]);
    expect(task).toHaveBeenCalledOnce();
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it('skips when a fresh lock exists (lock held by another process)', async () => {
    // Simulate another process holding the lock.
    fs.writeFileSync(lockPath, '');
    const task = vi.fn(async () => {});
    const ran = await runThrottledOnce(
      { name: 'test', markerPath, lockPath, staleLockMs: MS_PER_HOUR },
      task,
    );
    expect(ran).toBe(false);
    expect(task).not.toHaveBeenCalled();
    // We did not own the lock, so we must not remove it.
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  it('self-heals when a stale lock exists (older than staleLockMs)', async () => {
    fs.writeFileSync(lockPath, '');
    // Backdate lock to 2 hours ago.
    const past = new Date(Date.now() - 2 * MS_PER_HOUR);
    fs.utimesSync(lockPath, past, past);

    const task = vi.fn(async () => {});
    const ran = await runThrottledOnce(
      { name: 'test', markerPath, lockPath, staleLockMs: MS_PER_HOUR },
      task,
    );
    expect(ran).toBe(true);
    expect(task).toHaveBeenCalledOnce();
    expect(fs.existsSync(markerPath)).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('does not write marker when task throws, but releases lock', async () => {
    const task = vi.fn(async () => {
      throw new Error('boom');
    });
    await expect(
      runThrottledOnce({ name: 'test', markerPath, lockPath }, task),
    ).rejects.toThrow('boom');
    expect(fs.existsSync(markerPath)).toBe(false);
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});
