/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The env keys globalSetup's setup() writes, saved so a case can restore the
// suite-wide values after re-importing the module and running its lifecycle.
const SETUP_ENV_KEYS = [
  'INTEGRATION_TEST_FILE_DIR',
  'QWEN_CODE_INTEGRATION_TEST',
  'TELEMETRY_LOG_FILE',
  'E2E_TEST_FILE_DIR',
  'TEST_CLI_PATH',
  'VERBOSE',
  'KEEP_OUTPUT',
] as const;

describe('globalSetup memory-file save/restore', () => {
  let qwenHome: string;
  let savedEnv: Map<string, string | undefined>;

  beforeEach(async () => {
    qwenHome = await mkdtemp(join(tmpdir(), 'qwen-globalsetup-test-'));
    savedEnv = new Map(
      [...SETUP_ENV_KEYS, 'QWEN_HOME'].map((key) => [key, process.env[key]]),
    );
    process.env['QWEN_HOME'] = qwenHome;
    // Let teardown remove the run directories this case creates.
    process.env['KEEP_OUTPUT'] = 'false';
  });

  afterEach(async () => {
    for (const [key, value] of savedEnv) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    vi.resetModules();
    await rm(qwenHome, { recursive: true, force: true });
  });

  // memoryFilePath is captured at module import time, so point QWEN_HOME at
  // the scratch dir BEFORE a fresh import of the module.
  async function loadGlobalSetup() {
    vi.resetModules();
    return import('./globalSetup.js');
  }

  it('restores the saved memory file after the run', async () => {
    await writeFile(join(qwenHome, 'QWEN.md'), 'original content', 'utf-8');
    const { setup, teardown } = await loadGlobalSetup();
    await setup();
    await writeFile(join(qwenHome, 'QWEN.md'), 'mutated by tests', 'utf-8');

    await expect(teardown()).resolves.toBeUndefined();

    await expect(readFile(join(qwenHome, 'QWEN.md'), 'utf-8')).resolves.toBe(
      'original content',
    );
  });

  it('does not exit an all-green run red when the restore cannot write', async () => {
    // The persistent pool runners can carry a readable-but-unwritable
    // QWEN.md left behind by a privileged job; before #10325 the teardown
    // restore threw on it and exited every all-green E2E run on that host
    // red with no failing test. Swap the file for a directory after setup()
    // read it — the write then fails regardless of privilege, since root
    // bypasses permission bits.
    await writeFile(join(qwenHome, 'QWEN.md'), 'original content', 'utf-8');
    const { setup, teardown } = await loadGlobalSetup();
    await setup();
    await rm(join(qwenHome, 'QWEN.md'), { force: true });
    await mkdir(join(qwenHome, 'QWEN.md'));

    await expect(teardown()).resolves.toBeUndefined();
  });
});

describe('globalSetup hermetic qwen home', () => {
  let tmpRoot: string;
  let savedEnv: Map<string, string | undefined>;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'qwen-globalsetup-tmp-'));
    savedEnv = new Map(
      [...SETUP_ENV_KEYS, 'QWEN_HOME', 'TMPDIR'].map((key) => [
        key,
        process.env[key],
      ]),
    );
    // The scratch home is only created when nothing has pinned QWEN_HOME, and
    // it lands in the OS temp dir — redirect that so the case owns what the
    // module picks. Both are read at import time, so they must be set first.
    delete process.env['QWEN_HOME'];
    process.env['TMPDIR'] = tmpRoot;
    process.env['KEEP_OUTPUT'] = 'false';
  });

  afterEach(async () => {
    for (const [key, value] of savedEnv) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    vi.resetModules();
    await rm(tmpRoot, { recursive: true, force: true });
  });

  async function loadGlobalSetup() {
    vi.resetModules();
    return import('./globalSetup.js');
  }

  it('points the run at its own qwen home', async () => {
    const { setup, teardown } = await loadGlobalSetup();
    await setup();

    const home = process.env['QWEN_HOME'];
    expect(home?.startsWith(tmpRoot)).toBe(true);

    await expect(teardown()).resolves.toBeUndefined();
    expect(existsSync(home!)).toBe(false);
  });

  it('does not exit an all-green run red when the scratch home cannot be removed', async () => {
    // A CLI child that outlives its test keeps writing under `debug/`, so the
    // removal walk reaches a directory that refills before the rmdir and
    // throws ENOTEMPTY. That is how this cleanup first exited an all-green
    // E2E run red, the same way the memory-file restore did in #10325. Stand
    // in for that child with a writer that keeps the directory refilling —
    // unlike a permission trick, it does not depend on not running as root.
    const { setup, teardown } = await loadGlobalSetup();
    await setup();
    const debugDir = join(process.env['QWEN_HOME']!, 'debug');
    await mkdir(debugDir, { recursive: true });

    const writer = spawn(
      process.execPath,
      [
        '-e',
        // A tight loop, not a timer: the removal walk only fails when a file
        // appears between its readdir and its rmdir, and a millisecond timer
        // is far too slow to land inside that window. Self-limiting, so a
        // child that outlives the kill below cannot spin indefinitely.
        `const fs = require('node:fs');
         const dir = ${JSON.stringify(debugDir)};
         const stopAt = Date.now() + 30_000;
         while (Date.now() < stopAt) {
           try {
             fs.mkdirSync(dir, { recursive: true });
             fs.writeFileSync(dir + '/' + process.hrtime.bigint() + '.log', 'x');
           } catch {}
         }`,
      ],
      { stdio: 'ignore' },
    );

    try {
      // Node takes tens of milliseconds to boot, and the removal walk finishes
      // in about one — without waiting for the writer to actually be producing,
      // teardown would clear an idle directory and the case would pass against
      // the very bug it exists to catch.
      const deadline = Date.now() + 10_000;
      while ((await readdir(debugDir)).length < 50) {
        if (Date.now() > deadline) {
          throw new Error('writer never started refilling the debug directory');
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      await expect(teardown()).resolves.toBeUndefined();
    } finally {
      writer.kill('SIGKILL');
    }
  });
});
