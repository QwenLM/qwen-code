import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import { withChannelPidfileLock } from './pidfile-lock.js';

describe('withChannelPidfileLock', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('acquires and releases the real synchronous proper-lockfile adapter', () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'qwen-channel-pid-lock-'),
    );
    tempDirs.push(tempDir);
    const pidfile = path.join(tempDir, 'channels', 'service.pid');

    expect(withChannelPidfileLock(pidfile, () => 'locked')).toBe('locked');
    expect(fs.existsSync(`${pidfile}.lock`)).toBe(false);
  });

  it('describes exhausted lock contention and its stale recovery window', () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'qwen-channel-pid-lock-'),
    );
    tempDirs.push(tempDir);
    const pidfile = path.join(tempDir, 'channels', 'service.pid');
    fs.mkdirSync(path.dirname(pidfile), { recursive: true });
    const release = lockfile.lockSync(pidfile, {
      realpath: false,
      stale: 10_000,
    });

    try {
      let thrown: NodeJS.ErrnoException | undefined;
      try {
        withChannelPidfileLock(pidfile, () => undefined);
      } catch (error) {
        thrown = error as NodeJS.ErrnoException;
      }

      expect(thrown?.code).toBe('ELOCKED');
      expect(thrown?.message).toContain(pidfile);
      expect(thrown?.message).toContain('10 seconds');
    } finally {
      release();
    }
  });

  it('releases the lock when the protected operation throws', () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'qwen-channel-pid-lock-'),
    );
    tempDirs.push(tempDir);
    const pidfile = path.join(tempDir, 'channels', 'service.pid');

    expect(() =>
      withChannelPidfileLock(pidfile, () => {
        throw new Error('operation failed');
      }),
    ).toThrow('operation failed');
    expect(withChannelPidfileLock(pidfile, () => 'reacquired')).toBe(
      'reacquired',
    );
  });
});
