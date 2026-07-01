import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ScheduleDaemon } from '@qwen-code/qwen-code-core';

import { startScheduleDaemon } from './start-daemon.js';

describe('schedule/start-daemon', () => {
  let tmpDir: string;
  let prevHome: string | undefined;
  const started: ScheduleDaemon[] = [];

  async function start() {
    const d = await startScheduleDaemon({
      fire: () => {}, // never spawn a real child in tests
      tickIntervalMs: 60_000,
      reloadIntervalMs: 60_000,
    });
    started.push(d);
    return d;
  }

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'schedule-start-'));
    prevHome = process.env['QWEN_HOME'];
    process.env['QWEN_HOME'] = tmpDir;
  });

  afterEach(async () => {
    await Promise.all(started.map((d) => d.stop().catch(() => {})));
    started.length = 0;
    if (prevHome === undefined) delete process.env['QWEN_HOME'];
    else process.env['QWEN_HOME'] = prevHome;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('starts a daemon holding the single-owner lock', async () => {
    const daemon = await start();
    expect(daemon.size).toBe(0);
  });

  it('refuses to start a second daemon while one is running', async () => {
    await start();
    await expect(start()).rejects.toThrow(/already running/i);
  });

  it('allows a new daemon after the first stops', async () => {
    const first = await start();
    await first.stop();
    // Should re-acquire the freed lock without throwing.
    const second = await start();
    expect(second.size).toBe(0);
  });
});
