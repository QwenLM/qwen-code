/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment node

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type { FileHandle } from 'node:fs/promises';
import { runThrottledOnce } from './throttledOnce.js';

vi.mock('node:fs/promises', { spy: true });

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
    vi.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('runs task, writes marker, releases lock on first call', async () => {
    const task = vi.fn(async () => {});
    const ran = await runThrottledOnce(
      { name: 'test', markerPath, lockPath },
      task,
    );
    expect(ran).toEqual({ status: 'completed' });
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
    expect(ran2.status).toBe('fresh');
    if (ran2.status === 'fresh') {
      expect(ran2.retryAfterMs).toBeGreaterThan(23 * MS_PER_HOUR);
      expect(ran2.retryAfterMs).toBeLessThanOrEqual(24 * MS_PER_HOUR + 1000);
    }
    expect(task2).not.toHaveBeenCalled();
  });

  it('reports only the remaining freshness interval for an old marker', async () => {
    fs.writeFileSync(markerPath, '');
    const past = new Date(Date.now() - 23 * MS_PER_HOUR);
    fs.utimesSync(markerPath, past, past);
    const task = vi.fn(async () => {});

    const result = await runThrottledOnce(
      { name: 'test', markerPath, lockPath },
      task,
    );

    expect(result.status).toBe('fresh');
    if (result.status === 'fresh') {
      expect(result.retryAfterMs).toBeGreaterThan(59 * 60 * 1000);
      expect(result.retryAfterMs).toBeLessThanOrEqual(60 * 60 * 1000);
    }
    expect(task).not.toHaveBeenCalled();
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
    expect(ran2).toEqual({ status: 'completed' });
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
    expect([a.status, b.status].sort()).toEqual(['completed', 'locked']);
  });

  it('rechecks marker freshness after acquiring the lock', async () => {
    vi.mocked(fsPromises.open).mockImplementationOnce(async () => {
      fs.writeFileSync(markerPath, 'completed elsewhere');
      return {
        close: vi.fn(async () => {}),
      } as unknown as FileHandle;
    });
    const task = vi.fn(async () => {});

    const result = await runThrottledOnce(
      { name: 'test', markerPath, lockPath },
      task,
    );

    expect(result.status).toBe('fresh');
    expect(task).not.toHaveBeenCalled();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('skips when a fresh lock exists (lock held by another process)', async () => {
    // Simulate another process holding the lock.
    fs.writeFileSync(lockPath, '');
    const task = vi.fn(async () => {});
    const ran = await runThrottledOnce(
      { name: 'test', markerPath, lockPath, staleLockMs: MS_PER_HOUR },
      task,
    );
    expect(ran).toEqual({ status: 'locked' });
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
    expect(ran).toEqual({ status: 'completed' });
    expect(task).toHaveBeenCalledOnce();
    expect(fs.existsSync(markerPath)).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('does not write marker when task reports incomplete, but releases lock', async () => {
    const task = vi.fn(async () => false as const);
    const result = await runThrottledOnce(
      { name: 'test', markerPath, lockPath },
      task,
    );

    expect(result).toEqual({ status: 'incomplete' });
    expect(fs.existsSync(markerPath)).toBe(false);
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

  it('treats marker write failure as benign and still releases lock', async () => {
    const task = vi.fn(async () => {
      fs.mkdirSync(markerPath);
    });

    const result = await runThrottledOnce(
      { name: 'test', markerPath, lockPath },
      task,
    );

    expect(result).toEqual({ status: 'completed' });
    expect(task).toHaveBeenCalledOnce();
    expect(fs.statSync(markerPath).isDirectory()).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});
