import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  acquireDaemonLock,
  getDaemonLockPath,
  isDaemonRunning,
  releaseDaemonLock,
} from './daemon-lock.js';

describe('schedule/daemon-lock', () => {
  let tmpDir: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'schedule-lock-'));
    prevHome = process.env['QWEN_HOME'];
    process.env['QWEN_HOME'] = tmpDir;
  });

  afterEach(async () => {
    if (prevHome === undefined) delete process.env['QWEN_HOME'];
    else process.env['QWEN_HOME'] = prevHome;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('acquires and releases the lock', async () => {
    const handle = await acquireDaemonLock();
    expect(handle).not.toBeNull();
    expect(handle!.pid).toBe(process.pid);
    await expect(fs.readFile(getDaemonLockPath(), 'utf8')).resolves.toContain(
      String(process.pid),
    );

    await releaseDaemonLock(handle!);
    await expect(fs.access(getDaemonLockPath())).rejects.toThrow();
  });

  it('refuses to acquire when a live foreign process holds the lock', async () => {
    await fs.mkdir(path.dirname(getDaemonLockPath()), { recursive: true });
    // pid 1 (init) is always alive and is never our own pid.
    await fs.writeFile(getDaemonLockPath(), JSON.stringify({ pid: 1 }));
    expect(await acquireDaemonLock()).toBeNull();
  });

  it('steals a lock held by a dead process', async () => {
    await fs.mkdir(path.dirname(getDaemonLockPath()), { recursive: true });
    await fs.writeFile(getDaemonLockPath(), JSON.stringify({ pid: 2 ** 30 }));
    const handle = await acquireDaemonLock();
    expect(handle).not.toBeNull();
    expect(handle!.pid).toBe(process.pid);
  });

  it('steals a malformed lock', async () => {
    await fs.mkdir(path.dirname(getDaemonLockPath()), { recursive: true });
    await fs.writeFile(getDaemonLockPath(), 'not json');
    const handle = await acquireDaemonLock();
    expect(handle).not.toBeNull();
  });

  it('isDaemonRunning reflects a live vs dead holder', async () => {
    expect(await isDaemonRunning()).toBe(false); // no lock
    await fs.mkdir(path.dirname(getDaemonLockPath()), { recursive: true });
    await fs.writeFile(getDaemonLockPath(), JSON.stringify({ pid: 1 }));
    expect(await isDaemonRunning()).toBe(true); // pid 1 is alive
    await fs.writeFile(getDaemonLockPath(), JSON.stringify({ pid: 2 ** 30 }));
    expect(await isDaemonRunning()).toBe(false); // dead holder
  });

  it('release is a no-op when another process now owns the lock', async () => {
    const handle = await acquireDaemonLock();
    // Someone else replaced the lock.
    await fs.writeFile(getDaemonLockPath(), JSON.stringify({ pid: 1 }));
    await releaseDaemonLock(handle!);
    // The foreign lock is left intact.
    await expect(fs.readFile(getDaemonLockPath(), 'utf8')).resolves.toContain(
      '"pid":1',
    );
  });
});
