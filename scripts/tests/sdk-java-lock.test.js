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
  readFileSync,
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
// and the stub answers --wait from a fixture flag file (held => brief sleep,
// then timeout, like a busy holder) so a test can hold or release the
// imaginary lock mid-run without a privileged filesystem. The shell flags
// mirror a GitHub Actions step (`-eo pipefail`): an early-closing consumer
// or a failed `[[ ]] &&` list would only surface under them.
const script = '.github/scripts/sdk-java-lock.sh';
const queueDir = (home) =>
  join(home, '.cache/qwen-code-ci/sdk-java-tests.lock.queue');

const flockStub = (behavior) => {
  const stubDir = mkdtempSync(join(tmpdir(), 'flock-stub-'));
  writeFileSync(join(stubDir, 'flock'), behavior, { mode: 0o755 });
  return stubDir;
};
const freeFlock = '#!/bin/sh\nexit 0';
// fd 8 is the counter lock and must always succeed; fd 9 is the host lock
// under test. A stub that failed both would abort at the counter, which an
// errexit-suspending harness could not see.
const heldFlock = (held, order) => `#!/bin/sh
case "$*" in
  *" 9")
    if [ -f "${held}" ]; then
      sleep 0.2
      exit 1
    fi
    echo "$LOCK_LABEL" >> "${order}"
    exit 0
    ;;
  *) exit 0 ;;
esac
`;

// A held lock behaves like a real sibling hold: the non-blocking probe fails
// at once, the blocking wait stays parked until the test kills the child.
const blockingFlock = `#!/bin/sh
case "$*" in
  *"--wait"*) sleep 5; exit 1 ;;
  *" 9") exit 1 ;;
  *) exit 0 ;;
esac
`;

const startAcquire = (
  home,
  wait,
  stubDir,
  extra = '',
  priority = '',
  label = '',
  env = {},
) => {
  const child = spawn(
    'bash',
    [
      '--noprofile',
      '--norc',
      '-eo',
      'pipefail',
      '-c',
      [
        `source "${script}"`,
        `sdk_java_lock_acquire ${wait}${priority ? ` ${priority}` : ''}`,
        'echo "acquired"',
        ...(extra ? [extra] : []),
      ].join('\n'),
    ],
    {
      env: {
        ...process.env,
        HOME: home,
        PATH: `${stubDir}:${process.env.PATH}`,
        LOCK_LABEL: label,
        ...env,
      },
    },
  );
  const state = { out: '' };
  child.stdout.on('data', (d) => (state.out += d));
  child.stderr.on('data', (d) => (state.out += d));
  const done = new Promise((resolve) =>
    child.on('close', (code) => resolve({ code, out: state.out })),
  );
  return { child, state, done };
};

const acquire = (...args) => startAcquire(...args).done;

const order = (home) => {
  const file = join(home, 'order');
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n') : [];
};

// Field 22 of /proc/<pid>/stat is the process start time; the tail fields
// begin at field 3, so it is index 19. This mirrors the helper's sed/awk.
const procStart = (pid) =>
  readFileSync(`/proc/${pid}/stat`, 'utf8')
    .replace(/.*\) /, '')
    .trim()
    .split(/\s+/)[19];

const ticketName = /^\d-\d{10}-\d+$/;
const waitForTicket = async (home, pattern) => {
  const deadline = Date.now() + 10000;
  while (
    !(
      existsSync(queueDir(home)) &&
      readdirSync(queueDir(home)).some((f) => pattern.test(f))
    )
  ) {
    if (Date.now() > deadline) throw new Error('no ticket published');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe.skipIf(process.platform === 'win32')('sdk-java-lock.sh', () => {
  it(
    'grants the lock to the head of the queue before a later ticket',
    { timeout: 30000 },
    async () => {
      const home = mkdtempSync(join(tmpdir(), 'lock-fifo-'));
      const held = join(home, 'held');
      const orderFile = join(home, 'order');
      writeFileSync(held, '');
      const stub = flockStub(heldFlock(held, orderFile));
      const a = acquire(home, 30, stub, 'sleep 1', '', 'A');
      // Wait for A's published ticket instead of a fixed sleep: on a loaded
      // runner 800 ms can run out and B then takes sequence 1.
      await waitForTicket(home, ticketName);
      const b = acquire(home, 30, stub, '', '', 'B');
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
      // The observable ordering, not just the ticket number: the stub
      // records who actually reached the lock first.
      expect(order(home)).toEqual(['A', 'B']);
    },
  );

  it(
    'names its ticket before it blocks on a held lock',
    { timeout: 30000 },
    async () => {
      const home = mkdtempSync(join(tmpdir(), 'lock-announce-'));
      // The wait line used to be emitted only after `flock` returned, so a
      // head parked behind a sibling hold printed nothing for the whole
      // budget — the exact state the cancelled pool run left in its log.
      const stub = flockStub(blockingFlock);
      const { child, state, done } = startAcquire(home, 60, stub);
      await new Promise((r) => setTimeout(r, 1500));
      const announced = state.out.includes(
        'Waiting for the sdk-java host lock as queue ticket 1',
      );
      child.kill('SIGKILL');
      await done;
      expect(announced).toBe(true);
    },
  );

  it(
    'ranks an arriving fast ticket ahead of an older normal ticket',
    { timeout: 30000 },
    async () => {
      const home = mkdtempSync(join(tmpdir(), 'lock-fast-'));
      const held = join(home, 'held');
      const orderFile = join(home, 'order');
      writeFileSync(held, '');
      const stub = flockStub(heldFlock(held, orderFile));
      const normal = acquire(home, 30, stub, '', 'full', 'normal');
      await waitForTicket(home, /^1-/);
      const fast = acquire(home, 30, stub, '', 'fast', 'fast');
      // Let the normal head complete a loop that sees the fast ticket first,
      // so releasing the lock cannot hand it the acquisition in between.
      await waitForTicket(home, /^0-0000000002-/);
      await new Promise((r) => setTimeout(r, 2500));
      rmSync(held);
      const [normalResult, fastResult] = await Promise.all([normal, fast]);
      expect(normalResult.code).toBe(0);
      expect(fastResult.code).toBe(0);
      expect(order(home)).toEqual(['fast', 'normal']);
    },
  );

  it(
    'promotes a normal ticket into the fast class so full-tier work cannot starve',
    { timeout: 30000 },
    async () => {
      const home = mkdtempSync(join(tmpdir(), 'lock-promote-'));
      const held = join(home, 'held');
      const orderFile = join(home, 'order');
      writeFileSync(held, '');
      const stub = flockStub(heldFlock(held, orderFile));
      const normal = acquire(home, 30, stub, '', 'full', 'normal', {
        SDK_JAVA_LOCK_PROMOTE_AFTER: '1',
      });
      await waitForTicket(home, /^1-/);
      await new Promise((r) => setTimeout(r, 2500));
      const fast = acquire(home, 30, stub, '', 'fast', 'fast');
      await waitForTicket(home, /^0-0000000002-/);
      await new Promise((r) => setTimeout(r, 2500));
      rmSync(held);
      const [normalResult, fastResult] = await Promise.all([normal, fast]);
      expect(normalResult.code).toBe(0);
      expect(fastResult.code).toBe(0);
      expect(normalResult.out).toContain(
        'Promoted sdk-java host lock queue ticket 1 to the fast class',
      );
      // The promoted ticket keeps its older sequence, so it still precedes
      // the fast ticket that arrived after it.
      expect(order(home)).toEqual(['normal', 'fast']);
    },
  );

  it(
    'reaps a ticket whose owner process is gone',
    { timeout: 30000 },
    async () => {
      const home = mkdtempSync(join(tmpdir(), 'lock-reap-'));
      const queue = queueDir(home);
      mkdirSync(queue, { recursive: true });
      const stale = join(queue, '0000000001-99999999');
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
    'reaps a stale head ticket whose recorded PID is still alive',
    { timeout: 30000 },
    async () => {
      const home = mkdtempSync(join(tmpdir(), 'lock-livepid-'));
      const queue = queueDir(home);
      mkdirSync(queue, { recursive: true });
      // A SIGKILLed owner leaves its ticket behind and its PID gets recycled,
      // so `kill -0` still answers; only the mtime arm can clear it. Without
      // that arm the orphan stays head and an idle lock is unreachable.
      const orphan = join(queue, `0000000001-${process.pid}`);
      writeFileSync(orphan, '');
      const past = new Date(Date.now() - 2 * 60 * 60 * 1000);
      utimesSync(orphan, past, past);
      const stub = flockStub(freeFlock);
      const result = await acquire(home, 15, stub);
      expect(result.code).toBe(0);
      expect(result.out).toContain('acquired');
      expect(existsSync(orphan)).toBe(false);
    },
  );

  it.skipIf(process.platform !== 'linux')(
    'reaps a ticket whose PID was recycled while it waited',
    { timeout: 30000 },
    async () => {
      const home = mkdtempSync(join(tmpdir(), 'lock-recycled-'));
      const queue = queueDir(home);
      mkdirSync(queue, { recursive: true });
      // The PID is alive (it is this test process) but its start time cannot
      // match ticket 1, so the owner died and the PID was reused.
      const orphan = join(queue, `0-0000000001-${process.pid}`);
      writeFileSync(orphan, '1\n');
      const past = new Date(Date.now() - 30000);
      utimesSync(orphan, past, past);
      const stub = flockStub(freeFlock);
      const result = await acquire(home, 5, stub);
      expect(result.code).toBe(0);
      expect(result.out).toContain('acquired');
      expect(existsSync(orphan)).toBe(false);
    },
  );

  it.skipIf(process.platform !== 'linux')(
    'records its owner start time in the published ticket',
    { timeout: 30000 },
    async () => {
      const home = mkdtempSync(join(tmpdir(), 'lock-starttime-'));
      const { child, done } = startAcquire(home, 60, flockStub(blockingFlock));
      const ticket = join(queueDir(home), `1-0000000001-${child.pid}`);
      await waitForTicket(home, ticketName);
      // The file appears before its body is written, so poll briefly instead
      // of failing on an empty first read.
      let body = '';
      const deadline = Date.now() + 2000;
      while (!body && Date.now() < deadline) {
        body = readFileSync(ticket, 'utf8').trim();
        if (!body) await new Promise((r) => setTimeout(r, 20));
      }
      const starttime = procStart(child.pid);
      child.kill('SIGKILL');
      await done;
      expect(body).toBe(starttime);
    },
  );

  it.skipIf(process.platform !== 'linux')(
    'keeps a live ticket with a matching start time past the age backstop',
    { timeout: 30000 },
    async () => {
      const home = mkdtempSync(join(tmpdir(), 'lock-age-'));
      const queue = queueDir(home);
      mkdirSync(queue, { recursive: true });
      // A live owner whose recorded start time still matches keeps the head
      // place even after the 1800-second backstop: that arm only applies to
      // tickets without a start time (pre-upgrade files or hosts without
      // /proc), where `kill -0` cannot tell a recycled PID apart.
      writeFileSync(join(queue, '.seq'), '1\n');
      const live = join(queue, `1-0000000001-${process.pid}`);
      writeFileSync(live, `${procStart(process.pid)}\n`);
      const past = new Date(Date.now() - 1801 * 1000);
      utimesSync(live, past, past);
      const result = await acquire(home, 3, flockStub(freeFlock));
      expect(result.code).toBe(1);
      expect(result.out).toContain(
        `head of queue is 1-0000000001-${process.pid}`,
      );
      expect(existsSync(live)).toBe(true);
    },
  );

  it(
    'leaves no ticket behind after a successful acquisition',
    { timeout: 30000 },
    async () => {
      const home = mkdtempSync(join(tmpdir(), 'lock-success-'));
      const stub = flockStub(freeFlock);
      const result = await acquire(home, 15, stub);
      expect(result.code).toBe(0);
      expect(result.out).toContain('acquired');
      // The holder leaves the queue at acquisition, so a normal run cannot
      // plant an orphan head ticket for the next job on the host.
      expect(readdirSync(queueDir(home))).toEqual(['.seq']);
    },
  );

  it(
    'times out with the pinned infrastructure signature and drops its ticket',
    { timeout: 30000 },
    async () => {
      const home = mkdtempSync(join(tmpdir(), 'lock-timeout-'));
      const held = join(home, 'held');
      writeFileSync(held, '');
      const stub = flockStub(heldFlock(held, join(home, 'order')));
      const result = await acquire(home, 5, stub);
      expect(result.code).toBe(1);
      // The `::error::` prefix is what the infra classifier matches: a bare
      // echo would leave the check-run unannotated and the auto-rerun cold.
      expect(result.out).toContain(
        '::error::sdk-java host lock not acquired within',
      );
      expect(readdirSync(queueDir(home)).filter((f) => f !== '.seq')).toEqual(
        [],
      );
    },
  );

  it(
    'names the blocking head ticket when it times out behind one',
    { timeout: 30000 },
    async () => {
      const home = mkdtempSync(join(tmpdir(), 'lock-blocked-'));
      const queue = queueDir(home);
      mkdirSync(queue, { recursive: true });
      // A live owner with a fresh mtime is not reapable, so the lock stays out
      // of reach and the timeout has to name what blocked it.
      const name = `0000000001-${process.pid}`;
      writeFileSync(join(queue, name), '');
      const stub = flockStub(freeFlock);
      const result = await acquire(home, 3, stub);
      expect(result.code).toBe(1);
      expect(result.out).toContain(`head of queue is ${name}`);
      expect(readdirSync(queue).filter((f) => f !== '.seq')).toEqual([name]);
    },
  );
});
