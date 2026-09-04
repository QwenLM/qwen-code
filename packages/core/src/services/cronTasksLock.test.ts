import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getLockFilePath,
  releaseLock,
  tryAcquireLock,
} from './cronTasksLock.js';
import { Storage } from '../config/storage.js';
import { getProjectHash } from '../utils/paths.js';

// Hook for the takeover-race test: runs just before the implementation
// renames the lock file aside, so a test can interleave a competing
// takeover between the stale inspection and the rename. Pass-through
// while null.
const renameHook = vi.hoisted(() => ({
  current: null as ((src: string) => Promise<void>) | null,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: (async (
      src: Parameters<typeof actual.rename>[0],
      dst: Parameters<typeof actual.rename>[1],
    ) => {
      if (renameHook.current) await renameHook.current(String(src));
      return actual.rename(src, dst);
    }) as typeof actual.rename,
  };
});

describe('cronTasksLock', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lock-test-'));
    // Lock lives under the user runtime dir, not the working tree; redirect
    // that base into the test temp dir.
    Storage.setRuntimeBaseDir(tmpDir);
  });

  afterEach(async () => {
    renameHook.current = null;
    Storage.setRuntimeBaseDir(null);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('getLockFilePath', () => {
    it('resolves to the per-project runtime dir, not the working tree', () => {
      const lock = getLockFilePath('/project');
      expect(lock).toBe(
        path.join(
          Storage.getGlobalTempDir(),
          getProjectHash('/project'),
          'scheduled_tasks.lock',
        ),
      );
      expect(lock.startsWith('/project')).toBe(false);
    });
  });

  describe('lockId fencing', () => {
    it('does not treat a different lockId as an idempotent re-acquire', async () => {
      expect(await tryAcquireLock(tmpDir, 'session-1', 'lock-a')).toBe(true);
      // Session-reload scenario from the file header: a fresh scheduler
      // shares our pid and sessionId but carries a new lockId. The old
      // holder's pid is alive (it is ours), so this must not adopt.
      expect(await tryAcquireLock(tmpDir, 'session-1', 'lock-b')).toBe(false);
      const content = JSON.parse(
        await fs.readFile(getLockFilePath(tmpDir), 'utf-8'),
      );
      expect(content.lockId).toBe('lock-a');
    });

    it('re-acquires idempotently when the lockId matches', async () => {
      expect(await tryAcquireLock(tmpDir, 'session-1', 'lock-a')).toBe(true);
      expect(await tryAcquireLock(tmpDir, 'session-1', 'lock-a')).toBe(true);
    });

    it('releaseLock with a different lockId leaves the lock in place', async () => {
      expect(await tryAcquireLock(tmpDir, 'session-1', 'lock-a')).toBe(true);
      await releaseLock(tmpDir, 'session-1', 'lock-b');
      await expect(fs.access(getLockFilePath(tmpDir))).resolves.toBeUndefined();
      // The matching lockId still releases it.
      await releaseLock(tmpDir, 'session-1', 'lock-a');
      await expect(fs.access(getLockFilePath(tmpDir))).rejects.toThrow();
    });
  });

  describe('tryAcquireLock', () => {
    it('acquires when no lock file exists', async () => {
      expect(await tryAcquireLock(tmpDir, 'session-1')).toBe(true);
      const raw = await fs.readFile(getLockFilePath(tmpDir), 'utf-8');
      const content = JSON.parse(raw);
      expect(content.pid).toBe(process.pid);
      expect(content.sessionId).toBe('session-1');
    });

    it('re-acquires own lock (idempotent)', async () => {
      await tryAcquireLock(tmpDir, 'session-1');
      expect(await tryAcquireLock(tmpDir, 'session-1')).toBe(true);
    });

    it('fails when another live process holds the lock', async () => {
      // Own pid: alive on every platform (PID 1 doesn't exist on
      // Windows, so it would read as a stale lock there). The foreign
      // sessionId keeps it from counting as this session's own lock.
      const lockPath = getLockFilePath(tmpDir);
      await fs.mkdir(path.dirname(lockPath), { recursive: true });
      await fs.writeFile(
        lockPath,
        JSON.stringify({ pid: process.pid, sessionId: 'other' }),
      );
      expect(await tryAcquireLock(tmpDir, 'session-1')).toBe(false);
    });

    it('takes over when lock owner PID is dead', async () => {
      const lockPath = getLockFilePath(tmpDir);
      await fs.mkdir(path.dirname(lockPath), { recursive: true });
      // Use an absurdly high PID that's almost certainly not running
      await fs.writeFile(
        lockPath,
        JSON.stringify({ pid: 2147483647, sessionId: 'dead' }),
      );
      expect(await tryAcquireLock(tmpDir, 'session-1')).toBe(true);
      const raw = await fs.readFile(lockPath, 'utf-8');
      const content = JSON.parse(raw);
      expect(content.pid).toBe(process.pid);
    });

    it('takes over malformed lock file', async () => {
      const lockPath = getLockFilePath(tmpDir);
      await fs.mkdir(path.dirname(lockPath), { recursive: true });
      await fs.writeFile(lockPath, 'NOT JSON{{{');
      expect(await tryAcquireLock(tmpDir, 'session-1')).toBe(true);
    });

    it('grants only one of two concurrent acquisitions', async () => {
      const results = await Promise.all([
        tryAcquireLock(tmpDir, 'session-1'),
        tryAcquireLock(tmpDir, 'session-2'),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it('grants only one concurrent takeover of a dead lock', async () => {
      const lockPath = getLockFilePath(tmpDir);
      await fs.mkdir(path.dirname(lockPath), { recursive: true });
      await fs.writeFile(
        lockPath,
        JSON.stringify({ pid: 2147483647, sessionId: 'dead' }),
      );
      const results = await Promise.all([
        tryAcquireLock(tmpDir, 'session-1'),
        tryAcquireLock(tmpDir, 'session-2'),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it('does not displace a fresh lock created after the stale inspection', async () => {
      const lockPath = getLockFilePath(tmpDir);
      await fs.mkdir(path.dirname(lockPath), { recursive: true });
      await fs.writeFile(
        lockPath,
        JSON.stringify({ pid: 2147483647, sessionId: 'dead' }),
      );

      // Between inspecting the stale lock and renaming it aside, a
      // competing session completes its own takeover: the stale file is
      // replaced by a fresh, live lock.
      renameHook.current = async (src) => {
        if (src !== lockPath) return;
        renameHook.current = null;
        await fs.rm(lockPath, { force: true });
        await fs.writeFile(
          lockPath,
          JSON.stringify({ pid: process.pid, sessionId: 'winner' }),
        );
      };

      expect(await tryAcquireLock(tmpDir, 'loser')).toBe(false);
      // The competing session's lock must survive the failed takeover.
      const surviving = JSON.parse(await fs.readFile(lockPath, 'utf-8'));
      expect(surviving.sessionId).toBe('winner');
    });
  });

  describe('releaseLock', () => {
    it('deletes lock file when we own it', async () => {
      await tryAcquireLock(tmpDir, 'session-1');
      await releaseLock(tmpDir, 'session-1');
      await expect(fs.access(getLockFilePath(tmpDir))).rejects.toThrow();
    });

    it('does not delete lock owned by another session', async () => {
      const lockPath = getLockFilePath(tmpDir);
      await fs.mkdir(path.dirname(lockPath), { recursive: true });
      await fs.writeFile(
        lockPath,
        JSON.stringify({ pid: 1, sessionId: 'other' }),
      );
      await releaseLock(tmpDir, 'session-1');
      // File should still exist
      const raw = await fs.readFile(lockPath, 'utf-8');
      expect(JSON.parse(raw).sessionId).toBe('other');
    });

    it('is a no-op when lock file does not exist', async () => {
      // Should not throw
      await releaseLock(tmpDir, 'session-1');
    });
  });
});
