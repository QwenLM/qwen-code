import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureScheduleDaemonRunning } from './ensure-daemon.js';
import { getDaemonLockPath } from './daemon-lock.js';

describe('schedule/ensure-daemon', () => {
  let tmpDir: string;
  let prevHome: string | undefined;
  let prevNoAutostart: string | undefined;
  let prevDev: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'schedule-ensure-'));
    prevHome = process.env['QWEN_HOME'];
    process.env['QWEN_HOME'] = tmpDir;
    prevNoAutostart = process.env['QWEN_SCHEDULE_NO_AUTOSTART'];
    delete process.env['QWEN_SCHEDULE_NO_AUTOSTART'];
    prevDev = process.env['DEV'];
    delete process.env['DEV'];
  });

  afterEach(async () => {
    if (prevHome === undefined) delete process.env['QWEN_HOME'];
    else process.env['QWEN_HOME'] = prevHome;
    if (prevNoAutostart === undefined)
      delete process.env['QWEN_SCHEDULE_NO_AUTOSTART'];
    else process.env['QWEN_SCHEDULE_NO_AUTOSTART'] = prevNoAutostart;
    if (prevDev === undefined) delete process.env['DEV'];
    else process.env['DEV'] = prevDev;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns "disabled" when auto-start is opted out', async () => {
    process.env['QWEN_SCHEDULE_NO_AUTOSTART'] = '1';
    expect(await ensureScheduleDaemonRunning()).toBe('disabled');
  });

  it('returns "dev-manual" in dev mode instead of spawning a doomed daemon', async () => {
    process.env['DEV'] = 'true';
    expect(await ensureScheduleDaemonRunning()).toBe('dev-manual');
  });

  it('returns "already-running" when a live daemon holds the lock', async () => {
    // A lock owned by this (alive) process reads as a running daemon, so no
    // spawn is attempted.
    await fs.mkdir(path.dirname(getDaemonLockPath()), { recursive: true });
    await fs.writeFile(
      getDaemonLockPath(),
      JSON.stringify({ pid: process.pid, lockId: 'x' }),
    );
    expect(await ensureScheduleDaemonRunning()).toBe('already-running');
  });
});
