/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LockManager, isLockActivelyHeld } from './lock.js';

describe('LockManager', () => {
  let tmpDir: string;
  let lockManager: LockManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'envprep-lock-test-'));
    lockManager = new LockManager(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates lock dir and lock file on acquireLock', () => {
    const handle = lockManager.acquireLock('test-resource');

    const lockFile = path.join(tmpDir, '.locks', 'test-resource.lock');
    expect(fs.existsSync(lockFile)).toBe(true);

    const data = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    expect(data.pid).toBe(process.pid);
    expect(data.ownerId).toBeDefined();
    expect(data.createdAt).toBeDefined();
    expect(data.hostname).toBeDefined();

    handle.release();
  });

  it('removes lock file on release', () => {
    const handle = lockManager.acquireLock('test-resource');
    handle.release();

    expect(
      fs.existsSync(path.join(tmpDir, '.locks', 'test-resource.lock')),
    ).toBe(false);
  });

  it('throws when lock is already held by current process', () => {
    const handle = lockManager.acquireLock('test-resource');

    const anotherManager = new LockManager(tmpDir);
    expect(() => anotherManager.acquireLock('test-resource')).toThrow(
      /Another process/,
    );

    handle.release();
  });

  it('allows acquiring lock after previous holder released', () => {
    lockManager.acquireLock('test-resource').release();

    const handle = lockManager.acquireLock('test-resource');
    handle.release();
  });

  it('treats stale lock with dead PID as acquirable', () => {
    const lockDir = path.join(tmpDir, '.locks');
    fs.mkdirSync(lockDir, { recursive: true });
    const lockFile = path.join(lockDir, 'test-resource.lock');
    fs.writeFileSync(
      lockFile,
      JSON.stringify({
        pid: 999999999,
        ownerId: 'old-owner',
        createdAt: new Date().toISOString(),
        hostname: os.hostname(),
      }),
    );

    const handle = lockManager.acquireLock('test-resource');
    handle.release();
  });

  it('treats lock with old mtime as acquirable', () => {
    const lockDir = path.join(tmpDir, '.locks');
    fs.mkdirSync(lockDir, { recursive: true });
    const lockFile = path.join(lockDir, 'test-resource.lock');
    fs.writeFileSync(
      lockFile,
      JSON.stringify({
        pid: process.pid,
        ownerId: 'old-owner',
        createdAt: new Date().toISOString(),
        hostname: os.hostname(),
      }),
    );
    const old = new Date(Date.now() - 91_000);
    fs.utimesSync(lockFile, old, old);

    const handle = lockManager.acquireLock('test-resource');
    handle.release();
  });

  it('touch updates mtime only when owner matches', () => {
    const handle = lockManager.acquireLock('test-resource');
    const lockFile = path.join(tmpDir, '.locks', 'test-resource.lock');
    const before = new Date(Date.now() - 30_000);
    fs.utimesSync(lockFile, before, before);

    handle.touch();
    expect(fs.statSync(lockFile).mtimeMs).toBeGreaterThan(before.getTime());

    fs.writeFileSync(
      lockFile,
      JSON.stringify({
        pid: process.pid,
        ownerId: 'other-owner',
        createdAt: new Date().toISOString(),
      }),
    );
    const old = new Date(Date.now() - 30_000);
    fs.utimesSync(lockFile, old, old);

    handle.touch();
    expect(fs.statSync(lockFile).mtimeMs).toBeLessThan(Date.now() - 20_000);
  });

  it('release does not delete a lock owned by another owner', () => {
    const handle = lockManager.acquireLock('test-resource');
    const lockFile = path.join(tmpDir, '.locks', 'test-resource.lock');
    fs.writeFileSync(
      lockFile,
      JSON.stringify({
        pid: process.pid,
        ownerId: 'other-owner',
        createdAt: new Date().toISOString(),
      }),
    );

    handle.release();

    expect(fs.existsSync(lockFile)).toBe(true);
  });
});

describe('isLockActivelyHeld', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'envprep-lock-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns false for non-existent file', () => {
    expect(isLockActivelyHeld(path.join(tmpDir, 'nope.lock'))).toBe(false);
  });

  it('returns true for lock held by current process', () => {
    const lockFile = path.join(tmpDir, 'active.lock');
    fs.writeFileSync(
      lockFile,
      JSON.stringify({
        pid: process.pid,
        ownerId: 'owner',
        createdAt: new Date().toISOString(),
      }),
    );
    expect(isLockActivelyHeld(lockFile)).toBe(true);
  });

  it('returns false for lock with dead PID', () => {
    const lockFile = path.join(tmpDir, 'dead.lock');
    fs.writeFileSync(
      lockFile,
      JSON.stringify({
        pid: 999999999,
        ownerId: 'owner',
        createdAt: new Date().toISOString(),
      }),
    );
    expect(isLockActivelyHeld(lockFile)).toBe(false);
  });

  it('returns false for stale mtime', () => {
    const lockFile = path.join(tmpDir, 'old.lock');
    fs.writeFileSync(
      lockFile,
      JSON.stringify({
        pid: process.pid,
        ownerId: 'owner',
        createdAt: new Date().toISOString(),
      }),
    );
    const old = new Date(Date.now() - 91_000);
    fs.utimesSync(lockFile, old, old);

    expect(isLockActivelyHeld(lockFile)).toBe(false);
  });

  it('returns true for malformed JSON while file exists', () => {
    const lockFile = path.join(tmpDir, 'bad.lock');
    fs.writeFileSync(lockFile, 'not-json');
    expect(isLockActivelyHeld(lockFile)).toBe(true);
  });
});
