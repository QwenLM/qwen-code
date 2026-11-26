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
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
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

// Tests decide the promotion window themselves. A value exported by the
// invoking shell would silently re-order cases that never asked to vary it
// (with 0 the waiting normal ticket of the fast-ordering case promotes and is
// served first), so the base env is captured without it; a case that wants a
// window passes it through `env`, which stays the last spread in the child.
const baseEnv = { ...process.env };
delete baseEnv.SDK_JAVA_LOCK_PROMOTE_AFTER;

const flockStub = (behavior) => {
  const stubDir = mkdtempSync(join(tmpdir(), 'flock-stub-'));
  writeFileSync(join(stubDir, 'flock'), behavior, { mode: 0o755 });
  return stubDir;
};
const freeFlock = '#!/bin/sh\nexit 0';

// A held lock behaves like a real sibling hold: the non-blocking probe fails
// at once, the blocking wait stays parked until the test kills the child.
const blockingFlock = `#!/bin/sh
case "$*" in
  *"--wait"*) echo 'STUB_FLOCK_WAIT_ENTERED'; sleep 5; exit 1 ;;
  *" 9") exit 1 ;;
  *) exit 0 ;;
esac
`;

// A held lock parks the blocking wait the way the kernel does: it returns
// only when the test releases the lock or the wait runs out, so a head that
// entered `flock --wait` never loops again before it is served. Release is
// not exclusive, so only the order of tickets still waiting is meaningful.
const parkedFlock = (held, order, parks = '') => `#!/bin/sh
case "$*" in
  *"--wait "*" 9")
    [ -n "${parks}" ] && echo "$LOCK_LABEL park" >> "${parks}"
    n=$(($2 * 10))
    while [ -f "${held}" ]; do
      [ "$n" -le 0 ] && exit 1
      n=$((n - 1))
      sleep 0.1
    done
    ;;
  *" 9") [ -f "${held}" ] && exit 1 ;;
  *) exit 0 ;;
esac
echo "$LOCK_LABEL" >> "${order}"
`;

const waitFor = async (what, check) => {
  const deadline = Date.now() + 10000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(what);
    await new Promise((r) => setTimeout(r, 20));
  }
};
const hasTicket = (home, pattern) =>
  existsSync(queueDir(home)) &&
  readdirSync(queueDir(home)).some((f) => pattern.test(f));
const headTicket = (home) =>
  join(
    queueDir(home),
    readdirSync(queueDir(home))
      .filter((f) => f !== '.seq')
      .sort()[0],
  );

// Linux only: whether a process has an open fd on `path`, and the processes
// under `root` outside any `flock` subtree (the stub's own children inherit
// the lock fd legitimately).
const holdsFd = (pid, path) => {
  try {
    return readdirSync(`/proc/${pid}/fd`).some((fd) => {
      try {
        return readlinkSync(`/proc/${pid}/fd/${fd}`) === path;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
};
const descendantsOutsideFlock = (root) => {
  const children = new Map();
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
      const comm = readFileSync(`/proc/${entry}/comm`, 'utf8').trim();
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      if (comm === 'flock') continue;
      children.set(ppid, [...(children.get(ppid) ?? []), Number(entry)]);
    } catch {
      // The process exited while the table was read.
    }
  }
  const found = [];
  const walk = (pid) =>
    (children.get(pid) ?? []).forEach((child) => {
      found.push(child);
      walk(child);
    });
  walk(root);
  return found;
};

const startAcquire = (
  home,
  wait,
  stubDir,
  extra = '',
  label = '',
  env = {},
  priority = '',
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
        ...baseEnv,
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

describe.skipIf(process.platform === 'win32')('sdk-java-lock.sh', () => {
  it(
    'grants the lock to the head of the queue before a later ticket',
    { timeout: 30000 },
    async () => {
      const home = mkdtempSync(join(tmpdir(), 'lock-fifo-'));
      const held = join(home, 'held');
      const order = join(home, 'order');
      writeFileSync(held, '');
      const stub = flockStub(parkedFlock(held, order));
      const a = acquire(home, 30, stub, 'sleep 1', 'A');
      // Wait for A's published ticket instead of a fixed sleep: on a loaded
      // runner 800 ms can run out and B then takes sequence 1.
      await waitFor('A took no ticket', () =>
        hasTicket(home, /^\d-\d{10}-\d+$/),
      );
      const b = acquire(home, 30, stub, '', 'B');
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
      expect(readFileSync(order, 'utf8').trim().split('\n')).toEqual([
        'A',
        'B',
      ]);
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
      await waitFor('the blocking flock was not reached', () =>
        state.out.includes('STUB_FLOCK_WAIT_ENTERED'),
      );
      const announced = state.out
        .split('STUB_FLOCK_WAIT_ENTERED')[0]
        .includes('Waiting for the sdk-java host lock as queue ticket 1');
      const ticket = headTicket(home);
      const before = statSync(ticket).mtimeMs;
      child.kill('SIGKILL');
      await done;
      // The keepalive's owner-death guard must stop it within one 2 s cycle;
      // without it the orphan keeps refreshing a dead owner's ticket.
      await new Promise((r) => setTimeout(r, 4500));
      expect(statSync(ticket).mtimeMs - before).toBeLessThan(1000);
      expect(announced).toBe(true);
    },
  );

  it(
    'names the ticket that displaced a parked head when it times out',
    { timeout: 30000 },
    async () => {
      const home = mkdtempSync(join(tmpdir(), 'lock-stale-head-'));
      const held = join(home, 'held');
      const order = join(home, 'order');
      writeFileSync(held, '');
      const stub = flockStub(parkedFlock(held, order));
      const head = startAcquire(home, 5, stub, '', 'head', {}, 'full');
      await waitFor('head did not park', () =>
        head.state.out.includes('queue ticket 1'),
      );
      const fast = startAcquire(home, 30, stub, '', 'fast', {}, 'fast');
      await waitFor('fast took no ticket', () =>
        hasTicket(home, /^0-0000000002-/),
      );
      // The head parked on its own name; the fast ticket is the lexical
      // minimum at timeout. The error must name the queue as it is then.
      const result = await head.done;
      expect(result.code).toBe(1);
      expect(result.out).toContain('as queue ticket 1 (normal)');
      expect(result.out).toContain('head of queue is 0-0000000002-');
      expect(result.out).not.toContain('head of queue is 1-0000000001-');
      rmSync(held);
      const fastResult = await fast.done;
      expect(fastResult.code).toBe(0);
      // The fast ticket became head by name while the full-tier head was
      // parked in front of it: routine queue order, not a starved head, and
      // the warning has to say so.
      expect(fastResult.out).toContain(
        '::warning::head of the queue as ticket 2 (fast) but the lock is held, and any ticket already parked in flock still goes first',
      );
    },
  );

  it(
    'reaps the keepalive at acquisition while the owner shell lives',
    { timeout: 30000 },
    async () => {
      const home = mkdtempSync(join(tmpdir(), 'lock-teardown-'));
      const held = join(home, 'held');
      const order = join(home, 'order');
      writeFileSync(held, '');
      const stub = flockStub(parkedFlock(held, order));
      // Keep the owner alive after acquisition the way the Maven step is:
      // otherwise the keepalive's own owner check masks a missing teardown.
      const head = startAcquire(home, 30, stub, 'sleep 5', 'head', {}, 'fast');
      await waitFor('head did not park', () =>
        head.state.out.includes('queue ticket 1'),
      );
      const ticket = headTicket(home);
      rmSync(held);
      await waitFor('head did not acquire', () => !existsSync(ticket));
      // Recreate the removed ticket: a leaked keepalive's `touch -c` would
      // refresh this path, a reaped one cannot.
      const sentinel = new Date(Date.now() - 60 * 1000);
      writeFileSync(ticket, '');
      utimesSync(ticket, sentinel, sentinel);
      await new Promise((r) => setTimeout(r, 2500));
      expect(statSync(ticket).mtimeMs).toBeLessThan(Date.now() - 30000);
      const result = await head.done;
      expect(result.code).toBe(0);
      rmSync(ticket, { force: true });
    },
  );

  it(
    'serves a fast ticket ahead of a normal ticket still waiting its turn',
    { timeout: 30000 },
    async () => {
      const home = mkdtempSync(join(tmpdir(), 'lock-fast-'));
      const held = join(home, 'held');
      const order = join(home, 'order');
      const parks = join(home, 'parks');
      writeFileSync(held, '');
      const stub = flockStub(parkedFlock(held, order, parks));
      // The production shape: the oldest normal ticket is already parked in
      // `flock --wait` as head, a second normal ticket sleeps behind it, and
      // only then does the fast ticket arrive.
      const head = startAcquire(home, 30, stub, '', 'head', {}, 'full');
      await waitFor('head did not park', () =>
        head.state.out.includes('queue ticket 1'),
      );
      const normal = acquire(home, 30, stub, '', 'normal', {}, 'full');
      await waitFor('normal took no ticket', () =>
        hasTicket(home, /^\d-0000000002-/),
      );
      const fast = acquire(home, 30, stub, '', 'fast', {}, 'fast');
      await waitFor('fast took no ticket', () =>
        hasTicket(home, /^\d-0000000003-/),
      );
      // Let both waiters complete a loop with the fast ticket queued, and
      // leave room for a second blocking entry, so the release cannot hand
      // the turn to the normal ticket by timing.
      await new Promise((r) => setTimeout(r, 4500));
      rmSync(held);
      const results = await Promise.all([head.done, normal, fast]);
      expect(results.map((r) => r.code)).toEqual([0, 0, 0]);
      // The stub records who actually reached the lock. The parked head is
      // not overtaken, so only the fast-before-normal order is the claim.
      const served = readFileSync(order, 'utf8').trim().split('\n');
      expect(served.indexOf('fast')).toBeLessThan(served.indexOf('normal'));
      // A full-tier caller is the normal class, and the log names the class
      // the ticket actually has, not the raw workflow tier.
      expect(results[1].out).toContain('(normal,');
      // Each ticket enters the blocking wait once while the hold lasts: the
      // parked head keeps its kernel position and the fast ticket behind it
      // parks once as the new minimum. Re-entering every few seconds would
      // lose that position.
      const parkLog = readFileSync(parks, 'utf8').trim().split('\n');
      expect(parkLog.filter((line) => line === 'head park')).toHaveLength(1);
      expect(parkLog.filter((line) => line === 'fast park')).toHaveLength(1);
      expect(parkLog).not.toContain('normal park');
    },
  );

  it(
    'promotes a waiting normal ticket ahead of a later fast ticket',
    { timeout: 30000 },
    async () => {
      const home = mkdtempSync(join(tmpdir(), 'lock-promote-'));
      const held = join(home, 'held');
      const order = join(home, 'order');
      writeFileSync(held, '');
      const stub = flockStub(parkedFlock(held, order));
      // Promotion is for a ticket that is not head yet: the head is parked
      // in `flock --wait` and is next whatever its class.
      const head = startAcquire(home, 30, stub, '', 'head', {}, 'full');
      await waitFor('head did not park', () =>
        head.state.out.includes('queue ticket 1'),
      );
      const normal = acquire(
        home,
        30,
        stub,
        '',
        'normal',
        { SDK_JAVA_LOCK_PROMOTE_AFTER: '1' },
        'full',
      );
      await waitFor('normal was not promoted', () =>
        hasTicket(home, /^0-0000000002-/),
      );
      const fast = acquire(home, 30, stub, '', 'fast', {}, 'fast');
      await waitFor('fast took no ticket', () =>
        hasTicket(home, /^\d-0000000003-/),
      );
      await new Promise((r) => setTimeout(r, 2500));
      rmSync(held);
      const results = await Promise.all([head.done, normal, fast]);
      expect(results.map((r) => r.code)).toEqual([0, 0, 0]);
      expect(results[1].out).toContain(
        'Promoted sdk-java host lock queue ticket 2 to the fast class',
      );
      // The promoted ticket keeps its older sequence, so it still precedes
      // the fast ticket that arrived after it.
      const served = readFileSync(order, 'utf8').trim().split('\n');
      expect(served.indexOf('normal')).toBeLessThan(served.indexOf('fast'));
    },
  );

  it(
    'reports the fast class for a promoted ticket that times out',
    { timeout: 30000 },
    async () => {
      const home = mkdtempSync(join(tmpdir(), 'lock-promoted-timeout-'));
      const held = join(home, 'held');
      writeFileSync(held, '');
      const stub = flockStub(parkedFlock(held, join(home, 'order')));
      const head = startAcquire(home, 30, stub, '', 'head', {}, 'full');
      await waitFor('head did not park', () =>
        head.state.out.includes('queue ticket 1'),
      );
      const result = await acquire(
        home,
        4,
        stub,
        '',
        'normal',
        { SDK_JAVA_LOCK_PROMOTE_AFTER: '1' },
        'full',
      );
      expect(result.code).toBe(1);
      expect(result.out).toContain(
        'Promoted sdk-java host lock queue ticket 2 to the fast class',
      );
      // Whether promotion fired is the first question a timeout raises, so
      // the annotation names the class the ticket had when it gave up.
      expect(result.out).toContain(
        'as queue ticket 2 (fast); head of queue is 1-0000000001-',
      );
      rmSync(held);
      expect((await head.done).code).toBe(0);
    },
  );

  it(
    'keeps a parked head ticket fresh so a later waiter cannot reap it',
    { timeout: 30000 },
    async () => {
      const home = mkdtempSync(join(tmpdir(), 'lock-keepalive-'));
      const held = join(home, 'held');
      const order = join(home, 'order');
      writeFileSync(held, '');
      const stub = flockStub(parkedFlock(held, order));
      const head = startAcquire(home, 30, stub, '', 'head', {}, 'fast');
      await waitFor('head did not park', () =>
        head.state.out.includes('queue ticket 1'),
      );
      const ticket = headTicket(home);
      // Age the parked head past the 1800s arm, as a hold longer than that
      // would: the mtime arm reaps any ticket nobody refreshes.
      const past = new Date(Date.now() - 2 * 60 * 60 * 1000);
      utimesSync(ticket, past, past);
      await waitFor(
        'parked head ticket was not refreshed',
        () => statSync(ticket).mtimeMs > Date.now() - 60000,
      );
      const waiter = acquire(home, 30, stub, '', 'waiter', {}, 'fast');
      await waitFor('waiter took no ticket', () =>
        hasTicket(home, /^\d-0000000002-/),
      );
      // Two of the waiter's loops, each running the reaper over the head.
      await new Promise((r) => setTimeout(r, 4500));
      expect(existsSync(ticket)).toBe(true);
      rmSync(held);
      const results = await Promise.all([head.done, waiter]);
      expect(results.map((r) => r.code)).toEqual([0, 0]);
      expect(readFileSync(order, 'utf8').trim().split('\n')[0]).toBe('head');
      // The keepalive stops with the wait and `touch -c` cannot recreate a
      // removed ticket, so nothing is left for the next job on the host.
      await new Promise((r) => setTimeout(r, 2500));
      expect(readdirSync(queueDir(home))).toEqual(['.seq']);
    },
  );

  it.skipIf(!existsSync('/proc/self/fd'))(
    'keeps the lock fd out of a parked head keepalive',
    { timeout: 30000 },
    async () => {
      const home = mkdtempSync(join(tmpdir(), 'lock-keepalive-fd-'));
      const held = join(home, 'held');
      const parks = join(home, 'parks');
      writeFileSync(held, '');
      const stub = flockStub(parkedFlock(held, join(home, 'order'), parks));
      const head = startAcquire(home, 30, stub, '', 'head', {}, 'fast');
      await waitFor('head did not park', () => existsSync(parks));
      const lock = realpathSync(
        join(home, '.cache/qwen-code-ci/sdk-java-tests.lock'),
      );
      // The owner shell holds the lock fd, which proves the probe sees it.
      expect(holdsFd(head.child.pid, lock)).toBe(true);
      await waitFor(
        'no keepalive started',
        () => descendantsOutsideFlock(head.child.pid).length > 0,
      );
      // flock(2) locks belong to the open file description, so a keepalive
      // still holding fd 9 would keep the lock held after the owner dies.
      await waitFor('the keepalive holds the lock fd', () =>
        descendantsOutsideFlock(head.child.pid).every(
          (pid) => !holdsFd(pid, lock),
        ),
      );
      rmSync(held);
      expect((await head.done).code).toBe(0);
    },
  );

  it(
    'reaps a ticket whose owner process is gone',
    { timeout: 30000 },
    async () => {
      const home = mkdtempSync(join(tmpdir(), 'lock-reap-'));
      const queue = queueDir(home);
      mkdirSync(queue, { recursive: true });
      writeFileSync(join(queue, '.seq'), '1\n');
      const stale = join(queue, '1-0000000001-99999999');
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
      writeFileSync(join(queue, '.seq'), '1\n');
      // A SIGKILLed owner leaves its ticket behind and its PID gets recycled,
      // so `kill -0` still answers; only the mtime arm can clear it. Without
      // that arm the orphan stays head and an idle lock is unreachable.
      const orphan = join(queue, `1-0000000001-${process.pid}`);
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
      const stub = flockStub(parkedFlock(held, join(home, 'order')));
      const result = await acquire(home, 5, stub);
      expect(result.code).toBe(1);
      // The `::error::` prefix is what the infra classifier matches: a bare
      // echo would leave the check-run unannotated and the auto-rerun cold.
      // The call site merges both streams into its `sed` rewrite, so the
      // signature is demoted whichever stream carries it.
      expect(result.out).toContain(
        '::error::sdk-java host lock not acquired within',
      );
      // A lone waiter's own ticket is gone by then; the empty glob must not
      // leak into the annotation as `*`.
      expect(result.out).toContain('head of queue is (no other ticket queued)');
      expect(result.out).not.toContain('head of queue is *');
      expect(readdirSync(queueDir(home)).filter((f) => f !== '.seq')).toEqual(
        [],
      );
    },
  );

  it(
    'returns a timeout so the caller can demote it',
    { timeout: 30000 },
    async () => {
      const home = mkdtempSync(join(tmpdir(), 'lock-demote-'));
      const held = join(home, 'held');
      writeFileSync(held, '');
      const stub = flockStub(parkedFlock(held, join(home, 'order')));
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
            'if ! sdk_java_lock_acquire 3; then echo "demoted"; fi',
            'echo "reached-end"',
          ].join('\n'),
        ],
        {
          env: {
            ...baseEnv,
            HOME: home,
            PATH: `${stub}:${process.env.PATH}`,
          },
        },
      );
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (out += d));
      const code = await new Promise((resolve) => child.on('close', resolve));
      // A `return 1` reaches the caller's demotion arm; an `exit 1` in the
      // helper would end the step there, so the demotion could never run.
      expect(code).toBe(0);
      expect(out).toContain('demoted');
      expect(out).toContain('reached-end');
    },
  );

  it(
    'names the blocking head ticket when it times out behind one',
    { timeout: 30000 },
    async () => {
      const home = mkdtempSync(join(tmpdir(), 'lock-blocked-'));
      const queue = queueDir(home);
      mkdirSync(queue, { recursive: true });
      writeFileSync(join(queue, '.seq'), '1\n');
      // A live owner with a fresh mtime is not reapable, so the lock stays out
      // of reach and the timeout has to name what blocked it.
      const name = `1-0000000001-${process.pid}`;
      writeFileSync(join(queue, name), '');
      // A real publisher advances the counter with its ticket. Without it,
      // both tickets get sequence 1 and PID sorting can move the waiter ahead.
      writeFileSync(join(queue, '.seq'), '1\n');
      const stub = flockStub(freeFlock);
      const result = await acquire(home, 3, stub);
      expect(result.code).toBe(1);
      expect(result.out).toContain('as queue ticket 2');
      expect(result.out).toContain(`head of queue is ${name}`);
      expect(readdirSync(queue).filter((f) => f !== '.seq')).toEqual([name]);
    },
  );
});
