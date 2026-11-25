/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, readFile, rm, writeFile, mkdir, utimes } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';

// ---------------------------------------------------------------------------
// Mocks — must be declared before any module that imports them
// ---------------------------------------------------------------------------

vi.mock('@qwen-code/core', () => ({
  BRAND_FIXED_CLI_BIN: 'qwen',
  runLogger: {
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  },
  GLOBAL_CONFIG_DIR: '.qwen',
}));

// Mock child_process.execSync so that isCliProcess() sees the CLI bin name in the
// output for the current test process. Without this, the vitest runner is not
// recognized as a CLI process and locks are treated as stale.
vi.mock('node:child_process', () => ({
  execSync: vi.fn((_cmd: string) => 'qwen --version\n'),
}));

let tmpDir: string;
let LOCK_PATH: string;

const origHome = process.env['HOME'];

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'lock-test-'));
  await mkdir(join(tmpDir, '.qwen'), { recursive: true });
  LOCK_PATH = join(tmpDir, '.qwen', 'update.lock');
  // Override HOME so the lock module uses our temp dir
  process.env['HOME'] = tmpDir;
});

afterEach(async () => {
  process.env['HOME'] = origHome;
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('updateLock', () => {
  // We need fresh imports each time since the module caches homedir()
  // at module load time. Use dynamic import with resetModules.

  beforeEach(() => {
    vi.resetModules();
  });

  it('should acquire and release lock successfully', async () => {
    const { acquireLock, releaseLock } = await import('../updateLock.js');

    const handle = await acquireLock();
    expect(handle).toBeDefined();

    // Verify lock file exists
    expect(existsSync(LOCK_PATH)).toBe(true);

    // Verify lock content
    const content = await readFile(LOCK_PATH, 'utf-8');
    const lockInfo = JSON.parse(content);
    expect(lockInfo.pid).toBe(process.pid);
    expect(lockInfo.hostname).toBe(hostname());
    expect(lockInfo.timestamp).toBeDefined();

    // Release
    await releaseLock(handle);

    // Lock file should be removed
    expect(existsSync(LOCK_PATH)).toBe(false);
  });

  it('should fail to acquire lock when already held', async () => {
    const { acquireLock, releaseLock } = await import('../updateLock.js');

    const handle = await acquireLock();

    // Second acquire should fail because the lock is held by a "CLI process"
    await expect(acquireLock()).rejects.toThrow(
      'Another update process is running',
    );

    await releaseLock(handle);
  });

  it('should clean up stale lock and re-acquire', async () => {
    const { acquireLock, releaseLock } = await import('../updateLock.js');

    // Write a stale lock with a dead PID
    const staleLock = {
      pid: 99999,
      timestamp: new Date(Date.now() - 120_000).toISOString(), // 2 minutes ago
      hostname: 'old-host',
    };
    await mkdir(join(tmpDir, '.qwen'), { recursive: true });
    await writeFile(LOCK_PATH, JSON.stringify(staleLock));

    // Should succeed by cleaning up the stale lock
    const handle = await acquireLock();
    expect(handle).toBeDefined();

    // Verify new lock has current PID
    const content = await readFile(LOCK_PATH, 'utf-8');
    const lockInfo = JSON.parse(content);
    expect(lockInfo.pid).toBe(process.pid);

    await releaseLock(handle);
  });

  it('isLocked should return true for active lock', async () => {
    const { acquireLock, releaseLock, isLocked } = await import(
      '../updateLock.js'
    );

    expect(await isLocked()).toBe(false);

    const handle = await acquireLock();
    expect(await isLocked()).toBe(true);

    await releaseLock(handle);
    expect(await isLocked()).toBe(false);
  });

  it('isLocked should return false for stale lock', async () => {
    const { isLocked } = await import('../updateLock.js');

    // Write a stale lock with a dead PID
    const staleLock = {
      pid: 99999,
      timestamp: new Date(Date.now() - 120_000).toISOString(),
      hostname: 'old-host',
    };
    await writeFile(LOCK_PATH, JSON.stringify(staleLock));

    expect(await isLocked()).toBe(false);
  });

  it('isLocked should return false when no lock file', async () => {
    const { isLocked } = await import('../updateLock.js');
    expect(await isLocked()).toBe(false);
  });

  it('isLocked should return true for empty lock file', async () => {
    const { isLocked } = await import('../updateLock.js');

    await mkdir(join(tmpDir, '.qwen'), { recursive: true });
    await writeFile(LOCK_PATH, '');

    expect(await isLocked()).toBe(true);
  });

  it('isLocked should return true for corrupt lock file', async () => {
    const { isLocked } = await import('../updateLock.js');

    await mkdir(join(tmpDir, '.qwen'), { recursive: true });
    await writeFile(LOCK_PATH, '{invalid json');

    expect(await isLocked()).toBe(true);
  });

  it('should not treat recent empty lock file as stale', async () => {
    const { acquireLock } = await import('../updateLock.js');

    // Write an empty lock file (simulates concurrent create+write race)
    await mkdir(join(tmpDir, '.qwen'), { recursive: true });
    await writeFile(LOCK_PATH, '');

    // acquireLock should fail because the empty file is recent (mtime < 30s)
    await expect(acquireLock()).rejects.toThrow(
      'Another update process is running',
    );
  });

  it('should treat old empty lock file as stale and re-acquire', async () => {
    const { acquireLock, releaseLock } = await import('../updateLock.js');

    // Write an empty lock file and backdate its mtime by 60 seconds
    await mkdir(join(tmpDir, '.qwen'), { recursive: true });
    await writeFile(LOCK_PATH, '');
    const pastTime = new Date(Date.now() - 60_000);
    await utimes(LOCK_PATH, pastTime, pastTime);

    // acquireLock should succeed by cleaning up the stale empty lock
    const handle = await acquireLock();
    expect(handle).toBeDefined();

    const content = await readFile(LOCK_PATH, 'utf-8');
    const lockInfo = JSON.parse(content);
    expect(lockInfo.pid).toBe(process.pid);

    await releaseLock(handle);
  });
});
