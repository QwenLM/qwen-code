/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The helper's queue lives under $HOME, so every case gets a private HOME.
// flock itself is stubbed on PATH: the production command line is unchanged,
// and the stub answers --nonblock from a fixture flag file so a test can hold
// or release the imaginary lock mid-run without a privileged filesystem. The
// shell flags mirror a GitHub Actions step (`-eo pipefail`): an early-closing
// consumer or a failed `[[ ]] &&` list would only surface under them.
const script = '.github/scripts/sdk-java-lock.sh';
const queueDir = (home) =>
  join(home, '.cache/qwen-code-ci/sdk-java-tests.lock.queue');

const flockStub = (behavior) => {
  const stubDir = mkdtempSync(join(tmpdir(), 'flock-stub-'));
  writeFileSync(join(stubDir, 'flock'), behavior, { mode: 0o755 });
  return stubDir;
};
const freeFlock = '#!/bin/sh\nexit 0';
const heldFlock = (held) => `#!/bin/sh\n[ -f "${held}" ] && exit 1\nexit 0`;

const acquire = (home, wait, stubDir, extra = '') =>
  new Promise((resolve) => {
    const child = spawn(
      'bash',
      [
        '--noprofile',
        '--norc',
        '-eo',
        'pipefail',
        '-c',
        `source "${script}" && sdk_java_lock_acquire ${wait} && echo "acquired"${extra ? ` && ${extra}` : ''}`,
      ],
      {
        env: {
          ...process.env,
          HOME: home,
          PATH: `${stubDir}:${process.env.PATH}`,
        },
      },
    );
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ code, out }));
  });

describe.skipIf(process.platform === 'win32')('sdk-java-lock.sh', () => {
  it(
    'grants the lock to the head of the queue before a later ticket',
    { timeout: 30000 },
    async () => {
      const home = mkdtempSync(join(tmpdir(), 'lock-fifo-'));
      const held = join(home, 'held');
      writeFileSync(held, '');
      const stub = flockStub(heldFlock(held));
      const a = acquire(home, 30, stub, 'sleep 1');
      await new Promise((r) => setTimeout(r, 800));
      const b = acquire(home, 30, stub);
      await new Promise((r) => setTimeout(r, 2500));
      rmSync(held);
      const [first, second] = await Promise.all([a, b]);
      // A took ticket 1 and woke the moment the lock freed; B behind it had
      // to wait for A's step-end cleanup before its own head turn.
      expect(first.code).toBe(0);
      expect(first.out).toContain('acquired');
      expect(second.code).toBe(0);
      expect(second.out).toContain('acquired');
      expect(second.out).toContain('queue ticket 2');
    },
  );

  it(
    'reaps a ticket whose owner process is gone',
    { timeout: 30000 },
    async () => {
      const home = mkdtempSync(join(tmpdir(), 'lock-reap-'));
      const queue = queueDir(home);
      mkdirSync(queue, { recursive: true });
      const stale = join(queue, '0000000001.99999999.ticket');
      writeFileSync(stale, '');
      // Predate the reaping age-out; 99999999 outlives no PID namespace.
      const past = new Date(Date.now() - 30000);
      utimesSync(stale, past, past);
      const stub = flockStub(freeFlock);
      const result = await acquire(home, 15, stub);
      expect(result.code).toBe(0);
      expect(result.out).toContain('acquired');
      expect(existsSync(stale)).toBe(false);
    },
  );

  it(
    'times out with the pinned infrastructure signature and drops its ticket',
    { timeout: 30000 },
    async () => {
      const home = mkdtempSync(join(tmpdir(), 'lock-timeout-'));
      const held = join(home, 'held');
      writeFileSync(held, '');
      const stub = flockStub(heldFlock(held));
      const result = await acquire(home, 5, stub);
      expect(result.code).toBe(1);
      expect(result.out).toContain('lock not acquired within');
      expect(
        readdirSync(queueDir(home)).filter((f) => f.endsWith('.ticket')),
      ).toEqual([]);
    },
  );
});
