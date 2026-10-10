/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync, utimesSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os, { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LedgerSweepRetiredError,
  LedgerSweepUnprovenError,
  MANAGED_RUNTIME_LEDGER_ENV,
  ManagedRuntimeLedger,
  managedRuntimeLedgerFromEnvironment,
  parsePsElapsed,
  processGroupLiveness,
  queryProcessTable,
  signalProcessGroup,
  startLedgerReaper,
  sweepStaleLedgers,
  sweepWorkerLedger,
  testInternals,
} from './managed-runtime-ledger.js';

/**
 * A controllable rmSync for the unlink-failure paths: enrolled paths throw
 * EACCES, everything else passes through. A read-only directory would be
 * the alternative, but root ignores the mode bits and some runners are
 * root.
 */
const rmSyncControl = vi.hoisted(() => ({ failing: new Set<string>() }));
// A controllable readFileSync for the transient read-failure paths: enrolled
// paths throw EMFILE, everything else passes through.
const readFileSyncControl = vi.hoisted(() => ({ failing: new Set<string>() }));
// A controllable writeFileSync for the write-failure paths: enrolled path
// prefixes throw EACCES, everything else passes through — the failure is
// enforced in code, so it also fails for runners whose uid ignores mode
// bits (root).
const writeFileSyncControl = vi.hoisted(() => ({
  failingPrefix: new Set<string>(),
}));
// A count of the blocking ps consults the module under test issues:
// every process-table read goes through one execFileSync, so a fanout that
// should share one consult shows up as a count here. Transparent: every
// call passes through.
const psExecCount = vi.hoisted(() => ({ count: 0 }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: ((...args: unknown[]) => {
      psExecCount.count += 1;
      return (actual.execFileSync as (...a: unknown[]) => unknown)(...args);
    }) as unknown as typeof actual.execFileSync,
  };
});
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeFileSync: ((target: unknown, ...rest: unknown[]): unknown => {
      if (
        typeof target === 'string' &&
        [...writeFileSyncControl.failingPrefix].some((prefix) =>
          target.startsWith(prefix),
        )
      ) {
        throw Object.assign(new Error(`EACCES: cannot write ${target}`), {
          code: 'EACCES',
        });
      }
      return (actual.writeFileSync as (...args: unknown[]) => unknown)(
        target,
        ...rest,
      );
    }) as typeof actual.writeFileSync,
    rmSync: (
      target: Parameters<typeof actual.rmSync>[0],
      options?: Parameters<typeof actual.rmSync>[1],
    ) => {
      if (typeof target === 'string' && rmSyncControl.failing.has(target)) {
        throw Object.assign(new Error(`EACCES: cannot remove ${target}`), {
          code: 'EACCES',
        });
      }
      return actual.rmSync(target, options);
    },
    readFileSync: ((target: unknown, ...rest: unknown[]): unknown => {
      if (
        typeof target === 'string' &&
        readFileSyncControl.failing.has(target)
      ) {
        throw Object.assign(new Error(`EMFILE: too many open files`), {
          code: 'EMFILE',
        });
      }
      return (actual.readFileSync as (...args: unknown[]) => unknown)(
        target,
        ...rest,
      );
    }) as typeof actual.readFileSync,
  };
});

const POSIX = process.platform !== 'win32';

function makeLedgerFile(
  file: string,
  worker: { pid: number; pgid?: number; startedAt?: number },
  groups: Array<{ pgid: number; startedAt: number; callId?: string }> = [],
): void {
  testInternals.writeLedgerDocument(
    file,
    {
      pid: worker.pid,
      pgid: worker.pgid ?? worker.pid,
      incarnation: 'incarnation-1',
      startedAt: worker.startedAt ?? Date.now(),
    },
    groups.map((group, index) => ({
      pgid: group.pgid,
      startedAt: group.startedAt,
      callId: group.callId ?? `call-${index}`,
    })),
  );
}

/**
 * A real process group led by its own pid, holding a plain sleeper. The
 * ChildProcess is kept — with an exit listener — so the host reaps the
 * zombie at once instead of leaving it for the group liveness probes.
 */
function spawnGroupLeader(command = 'sleep', args: string[] = ['300']) {
  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  child.on('exit', () => undefined);
  if (!child.pid) throw new Error('spawn failed');
  return child;
}

async function settledGroupTable(pgid: number): Promise<void> {
  // A fresh pgid can collide with a leaderless stranger group still dying on
  // a busy host; an old stranger member would read the young leader's record
  // as 'ours'. Wait until the table shows this group alone before an age
  // judgement runs against it.
  await waitFor(() => {
    const members = [...queryProcessTable().values()].filter(
      (row) => row.pgid === pgid,
    );
    return members.length === 1 && members[0]!.pid === pgid ? true : undefined;
  });
}

function killGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // gone already
    }
  }
}

async function waitFor<T>(
  probe: () => T | undefined,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error('Timed out waiting.');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('Managed Runtime ledger', () => {
  let root: string;
  const strays = new Set<ReturnType<typeof spawnGroupLeader>>();

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'qwen-m5c-ledger-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const child of strays) {
      if (child.pid) killGroup(child.pid);
    }
    strays.clear();
    await rm(root, { recursive: true, force: true });
  });

  describe('worker-side document', () => {
    it('writes the worker record at creation and persists groups synchronously', async () => {
      const workFile = path.join(root, 'nested', 'ledger.json');
      const ledger = ManagedRuntimeLedger.create({
        workFile,
        worker: {
          pid: process.pid,
          pgid: process.pid,
          incarnation: 'inc',
          startedAt: Date.now(),
        },
      });
      const written = JSON.parse(await readFile(workFile, 'utf8')) as {
        version: number;
        worker: { pid: number; incarnation: string };
        groups: unknown[];
      };
      expect(written.version).toBe(1);
      expect(written.worker.pid).toBe(process.pid);
      expect(written.worker.incarnation).toBe('inc');
      expect(written.groups).toEqual([]);

      ledger.addGroup({ pgid: 4242, callId: 'c1', startedAt: 123 });
      // A synchronous write: the truth is on disk before the next step runs.
      const updated = JSON.parse(await readFile(workFile, 'utf8')) as {
        groups: Array<{
          pgid: number;
          callId: string;
          startedAt: number;
          uptimeMs: number;
        }>;
      };
      expect(updated.groups).toEqual([
        {
          pgid: 4242,
          callId: 'c1',
          startedAt: 123,
          uptimeMs: expect.any(Number),
        },
      ]);
      expect(ledger.outstandingGroups()).toHaveLength(1);
    });

    it.skipIf(!POSIX)(
      'addGroup records durably first, so a write failure leaves both views holding nothing',
      async () => {
        const workFile = path.join(root, 'ledger.json');
        testInternals.writeLedgerDocument(
          workFile,
          {
            pid: process.pid,
            pgid: process.pid,
            incarnation: 'inc',
            startedAt: Date.now(),
          },
          [],
        );
        const ledger = ManagedRuntimeLedger.create({
          workFile,
          worker: {
            pid: process.pid,
            pgid: process.pid,
            incarnation: 'inc',
            startedAt: Date.now(),
          },
        });
        // Every write from here fails: the tmp staging cannot be created.
        // Enforced in code (mock), not by mode bits — root runners fail it
        // exactly like everyone else.
        writeFileSyncControl.failingPrefix.add(`${workFile}.tmp`);
        const proc = spawnGroupLeader();
        strays.add(proc);
        try {
          expect(() =>
            ledger.addGroup({
              pgid: proc.pid!,
              callId: 'c1',
              startedAt: Date.now(),
            }),
          ).toThrow();
          expect(ledger.outstandingGroups()).toHaveLength(0);
          const onDisk = testInternals.readLedgerDocument(workFile);
          expect(onDisk?.groups).toEqual([]);
        } finally {
          writeFileSyncControl.failingPrefix.clear();
          killGroup(proc.pid!);
          strays.delete(proc);
        }
      },
    );

    it.skipIf(!POSIX)(
      'prunes only groups that are gone and rewrites on change',
      async () => {
        const workFile = path.join(root, 'ledger.json');
        const ledger = ManagedRuntimeLedger.create({
          workFile,
          worker: {
            pid: process.pid,
            pgid: process.pid,
            incarnation: 'inc',
            startedAt: Date.now(),
          },
        });
        const proc = spawnGroupLeader();
        strays.add(proc);
        const live = proc.pid!;
        ledger.addGroup({ pgid: live, callId: 'c1', startedAt: Date.now() });
        ledger.prune();
        expect(ledger.outstandingGroups()).toHaveLength(1);
        killGroup(live);
        strays.delete(proc);
        await waitFor(() =>
          processGroupLiveness(live) === 'gone' ? true : undefined,
        );
        ledger.prune();
        expect(ledger.outstandingGroups()).toHaveLength(0);
        const written = JSON.parse(await readFile(workFile, 'utf8')) as {
          groups: unknown[];
        };
        expect(written.groups).toEqual([]);
      },
    );

    it.skipIf(!POSIX)(
      'killOutstanding consults the process table once for the whole fanout, not once per group',
      async () => {
        // Three outstanding groups judged at once must cost ONE blocking ps
        // consult (plus the prune's own): a poll per waiter would fork the
        // same ps three times ahead of the budget's first await. The counts
        // are exact because the pass settles inside one liveness interval:
        // the prune consults once, the fanout's shared reader once more —
        // never a per-group refresh.
        const workFile = path.join(root, 'ledger.json');
        const ledger = ManagedRuntimeLedger.create({
          workFile,
          worker: {
            pid: process.pid,
            pgid: process.pid,
            incarnation: 'inc',
            startedAt: Date.now(),
          },
        });
        const procs = [
          spawnGroupLeader(),
          spawnGroupLeader(),
          spawnGroupLeader(),
        ];
        for (const proc of procs) {
          strays.add(proc);
          ledger.addGroup({
            pgid: proc.pid!,
            callId: `c-${proc.pid}`,
            startedAt: Date.now(),
          });
        }
        try {
          const before = psExecCount.count;
          await ledger.killOutstanding(600);
          expect(ledger.outstandingGroups()).toEqual([]);
          expect(psExecCount.count - before).toBe(2);
        } finally {
          for (const proc of procs) {
            killGroup(proc.pid!);
            strays.delete(proc);
          }
        }
      },
    );

    it.skipIf(!POSIX)(
      'waitForGroupExit drops a group whose exit is proven',
      async () => {
        const workFile = path.join(root, 'ledger.json');
        const ledger = ManagedRuntimeLedger.create({
          workFile,
          worker: {
            pid: process.pid,
            pgid: process.pid,
            incarnation: 'inc',
            startedAt: Date.now(),
          },
        });
        const proc = spawnGroupLeader();
        strays.add(proc);
        const live = proc.pid!;
        ledger.addGroup({ pgid: live, callId: 'c1', startedAt: Date.now() });
        killGroup(live);
        strays.delete(proc);
        await ledger.waitForGroupExit(live, 5_000);
        expect(ledger.outstandingGroups()).toHaveLength(0);
      },
    );

    it.skipIf(!POSIX)(
      'killOutstanding SIGKILLs every recorded group and a complete ledger deletes itself',
      async () => {
        const workFile = path.join(root, 'ledger.json');
        const ledger = ManagedRuntimeLedger.create({
          workFile,
          worker: {
            pid: process.pid,
            pgid: process.pid,
            incarnation: 'inc',
            startedAt: Date.now(),
          },
        });
        const proc = spawnGroupLeader();
        strays.add(proc);
        const live = proc.pid!;
        ledger.addGroup({ pgid: live, callId: 'c1', startedAt: Date.now() });
        const remaining = await ledger.killOutstanding(5_000);
        strays.delete(proc);
        expect(remaining).toEqual([]);
        expect(ledger.complete()).toBe(true);
        expect(existsSync(workFile)).toBe(false);
      },
    );

    it.skipIf(!POSIX)(
      'killOutstanding prunes the provably-dead instead of signalling them',
      async () => {
        // A pgid recycled after its owner's death can look like a survivor;
        // the close sweep answers only for groups that still need a signal.
        const killSpy = vi.spyOn(process, 'kill');
        const workFile = path.join(root, 'ledger.json');
        const ledger = ManagedRuntimeLedger.create({
          workFile,
          worker: {
            pid: process.pid,
            pgid: process.pid,
            incarnation: 'inc',
            startedAt: Date.now(),
          },
        });
        const deadPgid = 42424242;
        ledger.addGroup({ pgid: deadPgid, callId: 'c1', startedAt: 1 });
        const remaining = await ledger.killOutstanding(5_000);
        expect(remaining).toEqual([]);
        expect(killSpy).not.toHaveBeenCalledWith(-deadPgid, 'SIGKILL');
        expect(ledger.complete()).toBe(true);
      },
    );

    it.skipIf(!POSIX)(
      'resolves a recycled group id instead of settling or signalling it',
      async () => {
        // The record is an hour old; the group answering on the id is
        // milliseconds old. The pid was recycled after the recorded group
        // died: the worker must neither settle the call against the
        // impostor's liveness nor SIGKILL its group at close.
        const workFile = path.join(root, 'ledger.json');
        const ledger = ManagedRuntimeLedger.create({
          workFile,
          worker: {
            pid: process.pid,
            pgid: process.pid,
            incarnation: 'inc',
            startedAt: Date.now(),
          },
        });
        const proc = spawnGroupLeader();
        strays.add(proc);
        const younger = proc.pid!;
        await settledGroupTable(younger);
        ledger.addGroup({
          pgid: younger,
          callId: 'c1',
          startedAt: Date.now() - 3_600_000,
        });
        await expect(ledger.waitForGroupExit(younger, 2_000)).resolves.toBe(
          'gone',
        );
        expect(processGroupLiveness(younger)).toBe('alive');
        expect(ledger.outstandingGroups()).toHaveLength(0);

        ledger.addGroup({
          pgid: younger,
          callId: 'c2',
          startedAt: Date.now() - 3_600_000,
        });
        const killSpy = vi.spyOn(process, 'kill');
        const remaining = await ledger.killOutstanding(1_000);
        expect(remaining).toEqual([]);
        expect(killSpy).not.toHaveBeenCalledWith(-younger, 'SIGKILL');
        expect(processGroupLiveness(younger)).toBe('alive');
        expect(ledger.complete()).toBe(true);
      },
    );

    it.skipIf(!POSIX)(
      'waitForGroupExit drops only the record it judged, never a re-recorded one',
      async () => {
        // The group outlives the wait's first judgement; the id is then
        // re-recorded for new work. The waiter's proof was about the old
        // record: the new one stays.
        const workFile = path.join(root, 'ledger.json');
        const ledger = ManagedRuntimeLedger.create({
          workFile,
          worker: {
            pid: process.pid,
            pgid: process.pid,
            incarnation: 'inc',
            startedAt: Date.now(),
          },
        });
        const proc = spawnGroupLeader();
        strays.add(proc);
        const live = proc.pid!;
        ledger.addGroup({ pgid: live, callId: 'c1', startedAt: Date.now() });
        const waiter = ledger.waitForGroupExit(live, 2_000);
        // Land the re-record while the waiter is parked between polls.
        await new Promise((resolve) => setTimeout(resolve, 10));
        ledger.addGroup({ pgid: live, callId: 'c2', startedAt: Date.now() });
        killGroup(live);
        strays.delete(proc);
        await expect(waiter).resolves.toBe('gone');
        expect(ledger.outstandingGroups().map((group) => group.callId)).toEqual(
          ['c2'],
        );
        const written = JSON.parse(await readFile(workFile, 'utf8')) as {
          groups: Array<{ callId: string }>;
        };
        expect(written.groups.map((group) => group.callId)).toEqual(['c2']);
      },
    );

    it.skipIf(!POSIX)(
      'waitForGroupExit does not settle while a SIGTERM-ignoring member outlives the leader',
      async () => {
        // The M5a witness shape in front of a present ledger: the leader is
        // gone, but a member that ignores SIGTERM keeps the id alive — a
        // leader-only probe would mis-read the group as 'gone'.
        const workFile = path.join(root, 'ledger.json');
        const ledger = ManagedRuntimeLedger.create({
          workFile,
          worker: {
            pid: process.pid,
            pgid: process.pid,
            incarnation: 'inc',
            startedAt: Date.now(),
          },
        });
        const memberReady = path.join(root, 'member-ready');
        const child = spawn(
          'bash',
          [
            '-c',
            `"${process.execPath}" -e 'process.on("SIGTERM",()=>{});require("node:fs").writeFileSync(process.env.MEMBER_READY,"ready");setInterval(()=>{},500)' & wait`,
          ],
          {
            detached: true,
            stdio: 'ignore',
            env: { ...process.env, MEMBER_READY: memberReady },
          },
        );
        child.unref();
        child.on('exit', () => undefined);
        if (!child.pid) throw new Error('spawn failed');
        strays.add(child);
        const pgid = child.pid;
        ledger.addGroup({ pgid, callId: 'c1', startedAt: Date.now() });

        // TERM only once the member's handler is armed — its own sentinel,
        // written after the handler registers: a process-table row (even the
        // leader's own, whose command line carries the same string) would
        // answer before the handler exists and make the probe racy.
        await waitFor(() => (existsSync(memberReady) ? true : undefined));
        // TERM the group: the bash leader dies, the member ignores it.
        process.kill(-pgid, 'SIGTERM');
        await expect(ledger.waitForGroupExit(pgid, 800)).resolves.toBe('alive');
        expect(ledger.outstandingGroups().map((group) => group.pgid)).toContain(
          pgid,
        );

        process.kill(-pgid, 'SIGKILL');
        strays.delete(child);
        await expect(ledger.waitForGroupExit(pgid, 5_000)).resolves.toBe(
          'gone',
        );
        expect(ledger.outstandingGroups()).toHaveLength(0);
      },
    );

    it('complete() keeps the file while a group stays unproven', async () => {
      const workFile = path.join(root, 'ledger.json');
      const ledger = ManagedRuntimeLedger.create({
        workFile,
        worker: {
          pid: process.pid,
          pgid: process.pid,
          incarnation: 'inc',
          startedAt: Date.now(),
        },
      });
      const proc = POSIX ? spawnGroupLeader() : undefined;
      if (proc !== undefined) strays.add(proc);
      ledger.addGroup({
        pgid: proc?.pid ?? 42424242,
        callId: 'c1',
        startedAt: Date.now(),
      });
      vi.spyOn(
        // Force the proof to fail: prune cannot see the group die.
        ledger as unknown as { prune(): void },
        'prune',
      ).mockImplementation(() => undefined);
      expect(ledger.complete()).toBe(false);
      expect(existsSync(workFile)).toBe(true);
    });
  });

  describe('ps table parsing', () => {
    it('parses the elapsed column in every ps spelling', () => {
      expect(parsePsElapsed('00:07')).toBe(7_000);
      expect(parsePsElapsed('12:34')).toBe(12 * 60_000 + 34_000);
      expect(parsePsElapsed('01:02:03')).toBe(3_723_000);
      expect(parsePsElapsed('2-03:04:05')).toBe(
        ((2 * 24 + 3) * 3600 + 4 * 60 + 5) * 1000,
      );
      expect(parsePsElapsed('nonsense')).toBeUndefined();
      expect(parsePsElapsed('1:2:3:4')).toBeUndefined();
      // procps's negative-elapsed wraparound: astronomically large days —
      // rejected outright, so its row can never flip a one-sided age test.
      expect(parsePsElapsed('441077234-00:18:40')).toBeUndefined();
      expect(parsePsElapsed('99999-23:59:59')).toBeUndefined();
      // Four day digits is the accepted ceiling.
      expect(parsePsElapsed('9999-23:59:59')).toBe(
        (9999 * 24 * 3600 + 23 * 3600 + 59 * 60 + 59) * 1000,
      );
    });

    it('parses table rows, skips the unparseable, and keeps the undatable', () => {
      const rows = testInternals.parseProcessTable(
        [
          '  123   100 00:05 node worker.js managed-runtime-worker',
          '  456   100 01:02:03 sleep 300',
          'garbage line',
          '  789   100 not-a-time whatever',
          '  790   100 441077234-00:18:40 node wrapped.js',
        ].join('\n'),
      );
      expect(rows.get(123)).toMatchObject({
        pgid: 100,
        runningMs: 5_000,
        args: 'node worker.js managed-runtime-worker',
      });
      expect(rows.get(456)?.args).toBe('sleep 300');
      // A real row whose elapsed column cannot be dated stays in the table
      // as an undatable member — dropping it would read its group as empty.
      expect(rows.get(789)).toMatchObject({ pgid: 100, runningMs: undefined });
      expect(rows.get(790)).toMatchObject({
        pgid: 100,
        runningMs: undefined,
        args: 'node wrapped.js',
      });
    });

    it.skipIf(!POSIX)(
      'queries the live table on POSIX and finds this process',
      () => {
        const table = queryProcessTable();
        const row = table.get(process.pid);
        expect(row).toBeDefined();
        expect(row!.args.length).toBeGreaterThan(0);
        expect(row!.runningMs).toBeGreaterThanOrEqual(0);
      },
    );

    it.skipIf(!POSIX)(
      'reads full command lines however narrow the inherited COLUMNS is',
      async () => {
        // procps truncates every row to COLUMNS even into a pipe, and the
        // identity markers are matched at the END of the args column: a
        // narrow inherited width would cut the marker off a live row and
        // read the process as someone else's.
        const marker = `managed-runtime-worker-${'x'.repeat(200)}-end`;
        const child = spawn(
          process.execPath,
          ['-e', 'setTimeout(() => {}, 10_000)', marker],
          { detached: true, stdio: 'ignore' },
        );
        child.unref();
        child.on('exit', () => undefined);
        if (!child.pid) throw new Error('spawn failed');
        strays.add(child);
        const previous = process.env['COLUMNS'];
        process.env['COLUMNS'] = '40';
        try {
          const row = await waitFor(() => queryProcessTable().get(child.pid!));
          expect(row.args).toContain(marker);
        } finally {
          if (previous === undefined) {
            delete process.env['COLUMNS'];
          } else {
            process.env['COLUMNS'] = previous;
          }
          killGroup(child.pid);
          strays.delete(child);
        }
      },
    );
  });

  describe('process-group primitives', () => {
    it('refuses ids that are not safe group leaders', () => {
      expect(processGroupLiveness(1)).toBe('gone');
      expect(signalProcessGroup(1, 'SIGKILL')).toBe('gone');
      expect(signalProcessGroup(0, 'SIGKILL')).toBe('gone');
    });

    it.skipIf(!POSIX)(
      'signals a real group and reports it gone afterwards',
      async () => {
        const proc = spawnGroupLeader();
        strays.add(proc);
        const live = proc.pid!;
        expect(processGroupLiveness(live)).toBe('alive');
        expect(signalProcessGroup(live, 'SIGKILL')).toBe('sent');
        await waitFor(() =>
          processGroupLiveness(live) === 'gone' ? true : undefined,
        );
        strays.delete(proc);
        expect(signalProcessGroup(live, 'SIGKILL')).toBe('gone');
      },
    );
  });

  describe('sweepWorkerLedger', () => {
    it('answers absent for a missing file, having proven nothing', async () => {
      await expect(
        sweepWorkerLedger(path.join(root, 'absent.json')),
      ).resolves.toBe('absent');
    });

    it('refuses an unreadable file and kills nothing', async () => {
      const workFile = path.join(root, 'corrupt.json');
      await writeFile(workFile, 'not json at all', 'utf8');
      const signal = vi.fn();
      await expect(
        sweepWorkerLedger(workFile, {
          exitWitnessed: true,
          sys: { signal, liveness: () => 'alive' },
        }),
      ).rejects.toBeInstanceOf(LedgerSweepUnprovenError);
      expect(signal).not.toHaveBeenCalled();
    });

    it('a momentarily unreadable ledger is retired by no sweep', async () => {
      // A read-side failure — EMFILE under fd pressure, EIO on a failing
      // tmpdir — is transient and says nothing about the bytes: even past
      // the debris age the ledger stays in place, rejected unproven rather
      // than retired, so the next pass reads it again.
      const workFile = path.join(root, 'blocked.json');
      makeLedgerFile(workFile, { pid: 42424246 });
      const aged = new Date(Date.now() - 120_000);
      utimesSync(workFile, aged, aged);
      readFileSyncControl.failing.add(workFile);
      await expect(sweepWorkerLedger(workFile)).rejects.toBeInstanceOf(
        LedgerSweepUnprovenError,
      );
      expect(existsSync(workFile)).toBe(true);
      expect(existsSync(path.join(root, 'blocked.unreadable'))).toBe(false);

      // The transient failure past, the retry reads the same bytes clean.
      readFileSyncControl.failing.delete(workFile);
      await expect(sweepWorkerLedger(workFile)).resolves.toBe('proven');
      expect(existsSync(workFile)).toBe(false);
    });

    it.skipIf(!POSIX)(
      'reaps every recorded group of a worker whose exit was witnessed',
      async () => {
        const workFile = path.join(root, 'ledger.json');
        const proc = spawnGroupLeader();
        strays.add(proc);
        const shell = proc.pid!;
        makeLedgerFile(workFile, { pid: 42424242 }, [
          { pgid: shell, startedAt: Date.now() },
        ]);
        await sweepWorkerLedger(workFile, { exitWitnessed: true });
        strays.delete(proc);
        expect(processGroupLiveness(shell)).toBe('gone');
        expect(existsSync(workFile)).toBe(false);
      },
    );

    it.skipIf(!POSIX)(
      'kills an orphaned worker that is provably still alive, but never a recycled pid',
      async () => {
        // "Ours": a live process whose command line carries the worker marker
        // and whose start time matches the record.
        const fixture = path.join(root, 'managed-runtime-worker-fixture.js');
        await writeFile(fixture, 'setInterval(() => {}, 1000);', 'utf8');
        const ours = spawn(process.execPath, [fixture], {
          detached: true,
          stdio: 'ignore',
        });
        ours.unref();
        ours.on('exit', () => undefined);
        if (!ours.pid) throw new Error('spawn failed');
        strays.add(ours);
        const oursPid = ours.pid;
        const ourFile = path.join(root, 'ours.json');
        makeLedgerFile(ourFile, { pid: oursPid });
        await sweepWorkerLedger(ourFile, {});
        strays.delete(ours);
        expect(processGroupLiveness(oursPid)).toBe('gone');
        expect(existsSync(ourFile)).toBe(false);

        // "Not ours": a live process GROUP leader this sweep did not start —
        // alive, leading its own group, but its command line names no
        // Runtime worker. The identity branch must decide this, not the
        // first liveness probe: a pid that leads no group would be 'gone'
        // there and the branch never runs (a vitest fork leads no group).
        const foreignScript = path.join(root, 'someone-else-fixture.js');
        await writeFile(foreignScript, 'setInterval(() => {}, 1000);', 'utf8');
        const foreign = spawn(process.execPath, [foreignScript], {
          detached: true,
          stdio: 'ignore',
        });
        foreign.unref();
        foreign.on('exit', () => undefined);
        if (!foreign.pid) throw new Error('spawn failed');
        strays.add(foreign);
        const foreignPid = foreign.pid;
        const foreignFile = path.join(root, 'foreign.json');
        makeLedgerFile(foreignFile, { pid: foreignPid });
        await sweepWorkerLedger(foreignFile, {});
        expect(() => process.kill(foreignPid, 0)).not.toThrow();
        expect(existsSync(foreignFile)).toBe(false);
      },
    );

    it.skipIf(!POSIX)(
      'resolves a recycled group id without killing the younger group',
      async () => {
        const workFile = path.join(root, 'ledger.json');
        const proc = spawnGroupLeader();
        strays.add(proc);
        const young = proc.pid!;
        await settledGroupTable(young);
        // The recorded group started an hour ago; the process answering now
        // is provably younger, so the id was recycled after the crash.
        makeLedgerFile(workFile, { pid: 42424242 }, [
          { pgid: young, startedAt: Date.now() - 3_600_000 },
        ]);
        await sweepWorkerLedger(workFile, {});
        expect(processGroupLiveness(young)).toBe('alive');
        expect(existsSync(workFile)).toBe(false);
        killGroup(young);
        strays.delete(proc);
      },
    );

    it.skipIf(!POSIX)(
      "holds a live sibling child's ledger rather than sweeping its worker",
      async () => {
        // A live worker whose ledger's host still answers for an ACP child:
        // its own lifecycle sweeps it; a sibling sweep never pre-empts.
        const hostScript = path.join(root, 'qwen--acp-host-fixture.js');
        await writeFile(hostScript, 'setInterval(()=>{},100);', 'utf8');
        const host = spawn(process.execPath, [hostScript], {
          detached: true,
          stdio: 'ignore',
        });
        host.unref();
        host.on('exit', () => undefined);
        if (!host.pid) throw new Error('spawn failed');
        strays.add(host);
        const fixture = path.join(root, 'managed-runtime-worker-fixture.js');
        await writeFile(fixture, 'setInterval(() => {}, 1000);', 'utf8');
        const worker = spawn(process.execPath, [fixture], {
          detached: true,
          stdio: 'ignore',
        });
        worker.unref();
        worker.on('exit', () => undefined);
        if (!worker.pid) throw new Error('spawn failed');
        strays.add(worker);
        const sleeper = spawnGroupLeader();
        strays.add(sleeper);

        const workFile = path.join(root, 'ledger.json');
        testInternals.writeLedgerDocument(
          workFile,
          {
            pid: worker.pid,
            pgid: worker.pid,
            hostPid: host.pid,
            incarnation: 'incarnation-1',
            startedAt: Date.now(),
          },
          [{ pgid: sleeper.pid!, callId: 'call-1', startedAt: Date.now() }],
        );

        await sweepWorkerLedger(workFile, {});

        // Nothing died and the truth stayed with its owner.
        expect(() => process.kill(host.pid!, 0)).not.toThrow();
        expect(processGroupLiveness(worker.pid!)).toBe('alive');
        expect(processGroupLiveness(sleeper.pid!)).toBe('alive');
        expect(existsSync(workFile)).toBe(true);
      },
    );

    it.skipIf(!POSIX)(
      'sweeps the orphan when the ledger names a host whose pid is dead',
      async () => {
        const fixture = path.join(root, 'managed-runtime-worker-fixture.js');
        await writeFile(fixture, 'setInterval(() => {}, 1000);', 'utf8');
        const worker = spawn(process.execPath, [fixture], {
          detached: true,
          stdio: 'ignore',
        });
        worker.unref();
        worker.on('exit', () => undefined);
        if (!worker.pid) throw new Error('spawn failed');
        strays.add(worker);
        const workFile = path.join(root, 'ledger.json');
        testInternals.writeLedgerDocument(
          workFile,
          {
            pid: worker.pid,
            pgid: worker.pid,
            hostPid: 42424245,
            incarnation: 'incarnation-1',
            startedAt: Date.now(),
          },
          [],
        );
        await sweepWorkerLedger(workFile, {});
        expect(processGroupLiveness(worker.pid)).toBe('gone');
        strays.delete(worker);
        expect(existsSync(workFile)).toBe(false);
      },
    );

    it('keeps the file and reports the survivors when a proof stays out', async () => {
      const workFile = path.join(root, 'ledger.json');
      makeLedgerFile(workFile, { pid: 101 }, [
        { pgid: 202, startedAt: Date.now() },
        { pgid: 303, startedAt: Date.now() },
      ]);
      const signal = vi.fn(() => 'sent' as const);
      await expect(
        sweepWorkerLedger(workFile, {
          exitWitnessed: true,
          proofTimeoutMs: 300,
          sys: { signal, liveness: () => 'alive', table: () => undefined },
        }),
      ).rejects.toMatchObject({ remaining: [101, 202, 303] });
      expect(signal).toHaveBeenCalled();
      // The unproven truth stays on disk for the next sweep.
      expect(existsSync(workFile)).toBe(true);
      const kept = testInternals.readLedgerDocument(workFile);
      expect(kept?.groups.map((group) => group.pgid).sort()).toEqual([
        202, 303,
      ]);
    });

    it('sweeps a group the worker persisted after the sweep first read its ledger', async () => {
      // The orphan worker finishes one more Shell — and durably records its
      // group — after this sweep's read but before the sweep's SIGKILL lands.
      // A verdict earned from the stale snapshot would unlink the only record
      // of that group with the group still alive.
      const workFile = path.join(root, 'ledger.json');
      const worker = {
        pid: 101,
        pgid: 101,
        incarnation: 'incarnation-1',
        startedAt: Date.now(),
      };
      testInternals.writeLedgerDocument(workFile, worker, []);
      const alive = new Set([101, 202]);
      const signal = vi.fn((pgid: number) => {
        if (pgid === 101) {
          // The worker's last write, landing while the sweep proves the kill.
          testInternals.writeLedgerDocument(workFile, worker, [
            { pgid: 202, callId: 'call-1', startedAt: Date.now() },
          ]);
          alive.delete(101);
        }
        return 'sent' as const;
      });
      const table = () =>
        new Map([
          [
            101,
            {
              pid: 101,
              pgid: 101,
              runningMs: 5_000,
              args: 'node dist/cli.js managed-runtime-worker',
            },
          ],
          [
            202,
            {
              pid: 202,
              pgid: 202,
              runningMs: 5_000,
              args: 'node our-shell.js',
            },
          ],
        ]);
      await expect(
        sweepWorkerLedger(workFile, {
          proofTimeoutMs: 300,
          sys: {
            platform: 'linux',
            liveness: (id) => (alive.has(id) ? 'alive' : 'gone'),
            signal,
            table,
          },
        }),
      ).rejects.toMatchObject({ remaining: [202] });
      expect(signal).toHaveBeenCalledWith(101, 'SIGKILL');
      expect(signal).toHaveBeenCalledWith(202, 'SIGKILL');
      expect(existsSync(workFile)).toBe(true);
      const kept = testInternals.readLedgerDocument(workFile);
      expect(kept?.groups.map((group) => group.pgid)).toEqual([202]);
    });

    it('adopts a same-pgid record the final read carries over the swept snapshot', async () => {
      // The orphan worker replaces group 202's record — new call, new
      // stamps — after this sweep's first read: a pgid is not a record's
      // identity. The final read's record must displace the snapshot's, or
      // the identity judgement reads the young replacement group against
      // the stamps of the group its pgid used to name, calls it
      // 'recycled', and deletes the ledger with the group still running.
      const workFile = path.join(root, 'ledger.json');
      const worker = {
        pid: 101,
        pgid: 101,
        incarnation: 'incarnation-1',
        startedAt: Date.now() - 90_000,
      };
      testInternals.writeLedgerDocument(workFile, worker, [
        { pgid: 202, callId: 'call-old', startedAt: Date.now() - 60_000 },
      ]);
      const alive = new Set([101, 202]);
      const signal = vi.fn((pgid: number) => {
        alive.delete(pgid);
        if (pgid === 101) {
          // The replacement publish, landing while the sweep proves the kill.
          testInternals.writeLedgerDocument(workFile, worker, [
            { pgid: 202, callId: 'call-new', startedAt: Date.now() },
          ]);
        }
        return 'sent' as const;
      });
      const table = () =>
        new Map([
          [
            101,
            {
              pid: 101,
              pgid: 101,
              runningMs: 90_000,
              args: 'node dist/cli.js managed-runtime-worker',
            },
          ],
          [
            202,
            {
              pid: 202,
              pgid: 202,
              runningMs: 1_000,
              args: 'node our-shell.js',
            },
          ],
        ]);
      await expect(
        sweepWorkerLedger(workFile, {
          proofTimeoutMs: 300,
          sys: {
            platform: 'linux',
            liveness: (id) => (alive.has(id) ? 'alive' : 'gone'),
            signal,
            table,
          },
        }),
      ).resolves.toBe('proven');
      // 'recycled' would have left the young group unsignalled and alive.
      expect(signal).toHaveBeenCalledWith(202, 'SIGKILL');
      expect(existsSync(workFile)).toBe(false);
    });

    it('holds a group whose only live member carries an undatable age', async () => {
      // procps's negative-elapsed wraparound makes a real row undatable;
      // the row still counts as a member, so the group must judge
      // 'unknown' — held unproven, never silently resolved 'gone' while the
      // group keeps running with its ledger deleted.
      const workFile = path.join(root, 'ledger.json');
      makeLedgerFile(workFile, { pid: 101 }, [
        { pgid: 202, startedAt: Date.now() },
      ]);
      const alive = new Set([202]);
      const signal = vi.fn(() => 'sent' as const);
      const table = () =>
        new Map([
          [
            202,
            {
              pid: 202,
              pgid: 202,
              // The wrapped etime: present and running, but undatable.
              runningMs: undefined,
              args: 'node wrapped.js',
            },
          ],
        ]);
      await expect(
        sweepWorkerLedger(workFile, {
          proofTimeoutMs: 300,
          sys: {
            platform: 'linux',
            liveness: (id) => (alive.has(id) ? 'alive' : 'gone'),
            signal,
            table,
          },
        }),
      ).rejects.toMatchObject({ remaining: [202] });
      expect(signal).not.toHaveBeenCalled();
      const kept = testInternals.readLedgerDocument(workFile);
      expect(kept?.groups.map((group) => group.pgid)).toEqual([202]);
    });

    it('a witnessed sweep signals a group whose member age is undatable', async () => {
      // The witness names the group the dead worker's; the undatable age
      // only bars the silent-resolve paths, never the witnessed stop.
      const workFile = path.join(root, 'ledger.json');
      makeLedgerFile(workFile, { pid: 101 }, [
        { pgid: 202, startedAt: Date.now() },
      ]);
      const alive = new Set([202]);
      const signal = vi.fn((pgid: number) => {
        alive.delete(pgid);
        return 'sent' as const;
      });
      const table = () =>
        new Map([
          [
            202,
            {
              pid: 202,
              pgid: 202,
              runningMs: undefined,
              args: 'node wrapped.js',
            },
          ],
        ]);
      await expect(
        sweepWorkerLedger(workFile, {
          exitWitnessed: true,
          proofTimeoutMs: 300,
          sys: {
            platform: 'linux',
            liveness: (id) => (alive.has(id) ? 'alive' : 'gone'),
            signal,
            table,
          },
        }),
      ).resolves.toBe('proven');
      expect(signal).toHaveBeenCalledWith(202, 'SIGKILL');
    });

    it('keeps a live worker late write out of the sweep rewrite', async () => {
      // The worker cannot be proven stopped, so the sweep never writes its
      // file at all: a record the worker persists anywhere in the pass is
      // still there when the sweep throws its unproven truth.
      const workFile = path.join(root, 'ledger.json');
      const worker = {
        pid: 101,
        pgid: 101,
        incarnation: 'incarnation-1',
        startedAt: Date.now(),
      };
      testInternals.writeLedgerDocument(workFile, worker, []);
      const signal = vi.fn((pgid: number) => {
        if (pgid === 101) {
          testInternals.writeLedgerDocument(workFile, worker, [
            { pgid: 202, callId: 'call-1', startedAt: Date.now() },
          ]);
        }
        return 'sent' as const;
      });
      await expect(
        sweepWorkerLedger(workFile, {
          proofTimeoutMs: 300,
          sys: {
            platform: 'linux',
            liveness: () => 'alive',
            signal,
            table: () =>
              new Map([
                [
                  101,
                  {
                    pid: 101,
                    pgid: 101,
                    runningMs: 5_000,
                    args: 'node dist/cli.js managed-runtime-worker',
                  },
                ],
              ]),
          },
        }),
      ).rejects.toMatchObject({ remaining: [101] });
      expect(existsSync(workFile)).toBe(true);
      const kept = testInternals.readLedgerDocument(workFile);
      expect(kept?.groups.map((group) => group.pgid)).toEqual([202]);
    });

    it.skipIf(!POSIX)(
      'never writes over the ledger of a worker it cannot prove stopped',
      async () => {
        // Every read a sweep merges from is already stale against a live
        // writer: the worker's next durable addGroup lands after the read,
        // and the sweep's stale write drops the record — the new group then
        // exits unsignalled and unswept. The file's inode is the tell: the
        // old rewrite landed through tmp+rename even when the content came
        // out unchanged.
        const workFile = path.join(root, 'ledger.json');
        const worker = {
          pid: 101,
          pgid: 101,
          incarnation: 'incarnation-1',
          startedAt: Date.now(),
        };
        testInternals.writeLedgerDocument(workFile, worker, [
          { pgid: 202, callId: 'call-1', startedAt: Date.now() },
        ]);
        const inode = statSync(workFile).ino;
        const bytes = readFileSync(workFile, 'utf8');
        const alive = new Set([101, 202]);
        await expect(
          sweepWorkerLedger(workFile, {
            proofTimeoutMs: 300,
            sys: {
              platform: 'linux',
              // No table at all: no identity to judge by, so nothing is
              // signalled and the writer stays unproven.
              table: () => undefined,
              liveness: (id) => (alive.has(id) ? 'alive' : 'gone'),
              signal: vi.fn(),
            },
          }),
        ).rejects.toMatchObject({ remaining: [101, 202] });
        expect(statSync(workFile).ino).toBe(inode);
        expect(readFileSync(workFile, 'utf8')).toBe(bytes);
      },
    );

    it('rides the proof deadline on the monotonic clock, so a backward wall step cannot stretch it', async () => {
      // A wall-clock deadline would quietly extend for every second the
      // clock just stepped back; the proof owes the group's death its
      // budget — 600 ms here — in whichever direction the host's time
      // happens to run. The step lands inside the first poll the proof
      // takes, and the measured wall wait must stay at the budget's
      // magnitude.
      const workFile = path.join(root, 'ledger.json');
      makeLedgerFile(workFile, { pid: 101 }, [
        { pgid: 202, startedAt: Date.now() },
      ]);
      const alive = new Set([202]);
      const realNow = Date.now.bind(Date);
      let stepped = false;
      const nowSpy = vi
        .spyOn(Date, 'now')
        .mockImplementation(() => (stepped ? realNow() - 10_000 : realNow()));
      let probesOn202 = 0;
      const liveness = vi.fn((id: number) => {
        if (id === 202) {
          probesOn202 += 1;
          // The second probe is the first poll inside the proof.
          if (probesOn202 === 2) stepped = true;
        }
        return alive.has(id) ? 'alive' : 'gone';
      });
      try {
        const t0 = performance.now();
        await expect(
          sweepWorkerLedger(workFile, {
            exitWitnessed: true,
            proofTimeoutMs: 600,
            sys: {
              platform: 'linux',
              liveness,
              signal: vi.fn(() => 'sent' as const),
              table: () => undefined,
            },
          }),
        ).rejects.toMatchObject({ remaining: [202] });
        // A wall-clock deadline would have waited ~10.6 s here.
        expect(performance.now() - t0).toBeLessThan(4_000);
      } finally {
        nowSpy.mockRestore();
      }
    });

    it('resolves a group whose live member is provably younger than its record', async () => {
      // A ±120 s window would match |90 s − 150 s| and SIGKILL this group;
      // the one-sided start-time proof knows no member of the recorded
      // group can be younger than the record and resolves the id recycled.
      const workFile = path.join(root, 'ledger.json');
      makeLedgerFile(workFile, { pid: 42424246 }, [
        { pgid: 202, startedAt: Date.now() - 150_000 },
      ]);
      const signal = vi.fn(() => 'sent' as const);
      await sweepWorkerLedger(workFile, {
        sys: {
          platform: 'linux',
          liveness: (id) => (id === 202 ? 'alive' : 'gone'),
          signal,
          table: () =>
            new Map([
              [
                202,
                {
                  pid: 202,
                  pgid: 202,
                  runningMs: 90_000,
                  args: 'node someone-else.js',
                },
              ],
            ]),
        },
      });
      expect(signal).not.toHaveBeenCalledWith(202, 'SIGKILL');
      expect(existsSync(workFile)).toBe(false);
    });

    it('holds a leaderless group whose survivors are all younger than the record', async () => {
      // No live leader to date the group by and no survivor old enough to
      // be the record's: the shape cannot be told from work backgrounded
      // late by the session itself, so the truth is held unproven and
      // nothing is signalled.
      const workFile = path.join(root, 'ledger.json');
      makeLedgerFile(workFile, { pid: 42424246 }, [
        { pgid: 202, startedAt: Date.now() - 150_000 },
      ]);
      const signal = vi.fn(() => 'sent' as const);
      await expect(
        sweepWorkerLedger(workFile, {
          proofTimeoutMs: 300,
          sys: {
            platform: 'linux',
            liveness: (id) => (id === 202 ? 'alive' : 'gone'),
            signal,
            table: () =>
              new Map([
                [
                  303,
                  {
                    // A survivor, not the leader: pid !== pgid.
                    pid: 303,
                    pgid: 202,
                    runningMs: 90_000,
                    args: 'xterm',
                  },
                ],
              ]),
          },
        }),
      ).rejects.toMatchObject({ remaining: [202] });
      expect(signal).not.toHaveBeenCalledWith(202, 'SIGKILL');
      expect(existsSync(workFile)).toBe(true);
      const kept = testInternals.readLedgerDocument(workFile);
      expect(kept?.groups.map((group) => group.pgid)).toEqual([202]);
    });

    it('keeps an old-enough survivor accountable when the leader is a young impostor', async () => {
      // The leader died, its pid went to a new group leader — but a SIGTERM-
      // ignoring survivor of the recorded group still runs: the group is
      // still the recorded one, resolved by kill-and-prove, never silently
      // dropped as recycled.
      const workFile = path.join(root, 'ledger.json');
      makeLedgerFile(workFile, { pid: 42424246 }, [
        { pgid: 202, startedAt: Date.now() - 150_000 },
      ]);
      const signal = vi.fn(() => 'sent' as const);
      await expect(
        sweepWorkerLedger(workFile, {
          proofTimeoutMs: 300,
          sys: {
            platform: 'linux',
            liveness: (id) => (id === 202 ? 'alive' : 'gone'),
            signal,
            table: () =>
              new Map([
                [
                  // The impostor leader: born under the record.
                  202,
                  {
                    pid: 202,
                    pgid: 202,
                    runningMs: 90_000,
                    args: 'node someone-else.js',
                  },
                ],
                [
                  // The survivor: old enough to have been there at the write.
                  303,
                  {
                    pid: 303,
                    pgid: 202,
                    runningMs: 147_000,
                    args: 'node our-shell-child.js',
                  },
                ],
              ]),
          },
        }),
      ).rejects.toMatchObject({ remaining: [202] });
      expect(signal).toHaveBeenCalledWith(202, 'SIGKILL');
      expect(existsSync(workFile)).toBe(true);
    });

    it('judges uptime-stamped records in the boot clock, immune to wall steps', async () => {
      // A fresh record beside a fresh group; the sweep's clock then steps
      // sixty seconds forward. Wall-domain age misreads the group's own
      // leader as a recycled impostor; the boot-domain age keeps them.
      const workFile = path.join(root, 'ledger.json');
      testInternals.writeLedgerDocument(
        workFile,
        {
          pid: 42424246,
          pgid: 42424246,
          incarnation: 'incarnation-1',
          startedAt: Date.now(),
        },
        [
          {
            pgid: 202,
            callId: 'call-1',
            startedAt: Date.now(),
            uptimeMs: os.uptime() * 1000,
          },
        ],
      );
      const signal = vi.fn(() => 'sent' as const);
      await expect(
        sweepWorkerLedger(workFile, {
          now: () => Date.now() + 60_000,
          proofTimeoutMs: 300,
          sys: {
            platform: 'linux',
            liveness: (id) => (id === 202 ? 'alive' : 'gone'),
            signal,
            table: () =>
              new Map([
                [
                  202,
                  {
                    pid: 202,
                    pgid: 202,
                    runningMs: 5_000,
                    args: 'node our-shell.js',
                  },
                ],
              ]),
          },
        }),
      ).rejects.toMatchObject({ remaining: [202] });
      expect(signal).toHaveBeenCalledWith(202, 'SIGKILL');
    });

    it('a witnessed sweep resolves a provably recycled group id without signalling it', async () => {
      // The witness names only the exit the host saw; a reaper's retry hours
      // later must not turn it into a licence to kill the id's new holder.
      const workFile = path.join(root, 'ledger.json');
      makeLedgerFile(workFile, { pid: 42424246 }, [
        { pgid: 202, startedAt: Date.now() - 3_600_000 },
      ]);
      const signal = vi.fn(() => 'sent' as const);
      const verdict = await sweepWorkerLedger(workFile, {
        exitWitnessed: true,
        sys: {
          platform: 'linux',
          liveness: (id) => (id === 202 ? 'alive' : 'gone'),
          signal,
          table: () =>
            new Map([
              [
                202,
                {
                  pid: 202,
                  pgid: 202,
                  runningMs: 90_000,
                  args: 'node someone-else.js',
                },
              ],
            ]),
        },
      });
      expect(verdict).toBe('proven');
      expect(signal).not.toHaveBeenCalled();
      expect(existsSync(workFile)).toBe(false);
    });

    it('a witnessed sweep resolves a worker pid that answers for another process', async () => {
      // The recorded worker is an hour old; its pid now leads a foreign
      // group. The witnessed retry must not SIGKILL the impostor.
      const workFile = path.join(root, 'ledger.json');
      makeLedgerFile(
        workFile,
        { pid: 101, startedAt: Date.now() - 3_600_000 },
        [],
      );
      const signal = vi.fn(() => 'sent' as const);
      const verdict = await sweepWorkerLedger(workFile, {
        exitWitnessed: true,
        sys: {
          platform: 'linux',
          liveness: (id) => (id === 101 ? 'alive' : 'gone'),
          signal,
          table: () =>
            new Map([
              [
                101,
                {
                  pid: 101,
                  pgid: 101,
                  runningMs: 90_000,
                  args: 'bash -c sleep 300',
                },
              ],
            ]),
        },
      });
      expect(verdict).toBe('proven');
      expect(signal).not.toHaveBeenCalled();
      expect(existsSync(workFile)).toBe(false);
    });

    it('a witnessed sweep still kills a genuine survivor the table can date', async () => {
      // The witness stands for the group the dead worker owned: a member
      // old enough to be the record's keeps it accountable, exactly as the
      // blind witness would have.
      const workFile = path.join(root, 'ledger.json');
      makeLedgerFile(workFile, { pid: 42424246 }, [
        { pgid: 202, startedAt: Date.now() - 150_000 },
      ]);
      const signal = vi.fn(() => 'sent' as const);
      await expect(
        sweepWorkerLedger(workFile, {
          exitWitnessed: true,
          proofTimeoutMs: 300,
          sys: {
            platform: 'linux',
            liveness: (id) => (id === 202 ? 'alive' : 'gone'),
            signal,
            table: () =>
              new Map([
                [
                  303,
                  {
                    pid: 303,
                    pgid: 202,
                    runningMs: 146_000,
                    args: 'node our-shell-child.js',
                  },
                ],
              ]),
          },
        }),
      ).rejects.toMatchObject({ remaining: [202] });
      expect(signal).toHaveBeenCalledWith(202, 'SIGKILL');
      expect(existsSync(workFile)).toBe(true);
    });

    it('a witnessed sweep still signals a group the table cannot date', async () => {
      // A leaderless group whose survivors are all younger than the record
      // is held by an unwitnessed sweep; the witnessed one knows the group
      // is the dead worker's and signals it.
      const workFile = path.join(root, 'ledger.json');
      makeLedgerFile(workFile, { pid: 42424246 }, [
        { pgid: 202, startedAt: Date.now() - 150_000 },
      ]);
      const signal = vi.fn(() => 'sent' as const);
      await expect(
        sweepWorkerLedger(workFile, {
          exitWitnessed: true,
          proofTimeoutMs: 300,
          sys: {
            platform: 'linux',
            liveness: (id) => (id === 202 ? 'alive' : 'gone'),
            signal,
            table: () =>
              new Map([
                [
                  303,
                  {
                    pid: 303,
                    pgid: 202,
                    runningMs: 90_000,
                    args: 'xterm',
                  },
                ],
              ]),
          },
        }),
      ).rejects.toMatchObject({ remaining: [202] });
      expect(signal).toHaveBeenCalledWith(202, 'SIGKILL');
    });

    it('reads a record stamped before this boot on the wall clock', async () => {
      // A ledger that outlived a reboot carries an uptime stamp ahead of
      // this boot: the boot clock cannot age it, and a negative age must
      // never invert the identity guard into an ownership assertion.
      const workFile = path.join(root, 'ledger.json');
      testInternals.writeLedgerDocument(
        workFile,
        {
          pid: 42424246,
          pgid: 42424246,
          incarnation: 'incarnation-1',
          startedAt: Date.now(),
        },
        [
          {
            pgid: 202,
            callId: 'call-1',
            startedAt: Date.now() - 3_600_000,
            uptimeMs: os.uptime() * 1000 + 3_600_000,
          },
        ],
      );
      const signal = vi.fn(() => 'sent' as const);
      const verdict = await sweepWorkerLedger(workFile, {
        sys: {
          platform: 'linux',
          liveness: (id) => (id === 202 ? 'alive' : 'gone'),
          signal,
          table: () =>
            new Map([
              [
                202,
                {
                  pid: 202,
                  pgid: 202,
                  runningMs: 5_000,
                  args: 'node someone-else.js',
                },
              ],
            ]),
        },
      });
      expect(verdict).toBe('proven');
      expect(signal).not.toHaveBeenCalled();
      expect(existsSync(workFile)).toBe(false);
    });

    it('never matches a previous-boot record whose wall stamp stepped back', async () => {
      // The ledger outlived a reboot AND the wall clock stepped backwards
      // across it (chrony makestep, a snapshot restore): the wall age of
      // such a record is negative, and a negative age matches every live
      // process — the identity guard inverted into an ownership assertion.
      // The boot stamp alone must judge it: a reboot killed everything the
      // record named, so the holder of its recycled id is never signalled.
      const workFile = path.join(root, 'ledger.json');
      testInternals.writeLedgerDocument(
        workFile,
        {
          pid: 42424246,
          pgid: 42424246,
          incarnation: 'incarnation-1',
          startedAt: Date.now() + 3_600_000,
        },
        [
          {
            pgid: 202,
            callId: 'call-1',
            startedAt: Date.now() + 3_600_000,
            uptimeMs: os.uptime() * 1000 + 3_600_000,
          },
        ],
      );
      const signal = vi.fn(() => 'sent' as const);
      const verdict = await sweepWorkerLedger(workFile, {
        sys: {
          platform: 'linux',
          liveness: (id) => (id === 202 ? 'alive' : 'gone'),
          signal,
          table: () =>
            new Map([
              [
                202,
                {
                  pid: 202,
                  pgid: 202,
                  runningMs: 5_000,
                  args: 'node someone-else.js',
                },
              ],
            ]),
        },
      });
      expect(verdict).toBe('proven');
      expect(signal).not.toHaveBeenCalled();
      expect(existsSync(workFile)).toBe(false);
    });

    it('never matches a record whose wall stamp is in the future', async () => {
      // Without a boot stamp — a record from before uptimeMs existed, or
      // macOS's wall-clock domain — a backward clock step still must not
      // invert the guard: the group is held unproven and nothing is
      // signalled until the clock re-passes the stamp.
      const workFile = path.join(root, 'ledger.json');
      testInternals.writeLedgerDocument(
        workFile,
        {
          pid: 42424246,
          pgid: 42424246,
          incarnation: 'incarnation-1',
          startedAt: Date.now(),
        },
        [
          {
            pgid: 202,
            callId: 'call-1',
            startedAt: Date.now() + 3_600_000,
          },
        ],
      );
      const signal = vi.fn(() => 'sent' as const);
      await expect(
        sweepWorkerLedger(workFile, {
          proofTimeoutMs: 300,
          sys: {
            platform: 'linux',
            liveness: () => 'alive',
            signal,
            table: () =>
              new Map([
                [
                  202,
                  {
                    pid: 202,
                    pgid: 202,
                    runningMs: 5_000,
                    args: 'node someone-else.js',
                  },
                ],
              ]),
          },
        }),
      ).rejects.toMatchObject({ remaining: [42424246, 202] });
      expect(signal).not.toHaveBeenCalled();
      expect(existsSync(workFile)).toBe(true);
    });

    it('on macOS an uptime-stamped record is judged on the wall clock', async () => {
      // macOS's etime is realtime-derived while os.uptime() is not: the
      // record's stamps disagree by the sleep time, and the wall domain is
      // the one that matches ps there.
      const workFile = path.join(root, 'ledger.json');
      testInternals.writeLedgerDocument(
        workFile,
        {
          pid: 42424246,
          pgid: 42424246,
          incarnation: 'incarnation-1',
          startedAt: Date.now(),
        },
        [
          {
            pgid: 202,
            callId: 'call-1',
            startedAt: Date.now(),
            // Stamped up to an hour of suspend ago: the boot-domain age
            // reads long, the wall age ~0 — only the wall age matches the
            // realtime-derived etime there.
            uptimeMs: Math.max(0, os.uptime() * 1000 - 3_600_000),
          },
        ],
      );
      const signal = vi.fn(() => 'sent' as const);
      await expect(
        sweepWorkerLedger(workFile, {
          proofTimeoutMs: 300,
          sys: {
            platform: 'darwin',
            liveness: (id) => (id === 202 ? 'alive' : 'gone'),
            signal,
            table: () =>
              new Map([
                [
                  202,
                  {
                    pid: 202,
                    pgid: 202,
                    runningMs: 5_000,
                    args: 'node our-shell.js',
                  },
                ],
              ]),
          },
        }),
      ).rejects.toMatchObject({ remaining: [202] });
      // The wall-domain age keeps the group's own leader accountable.
      expect(signal).toHaveBeenCalledWith(202, 'SIGKILL');
    });

    it('identifies the orphaned worker across a stepped wall clock', async () => {
      // The witness for the worker-side stamp: the wall clock steps ten
      // minutes forward between the record's write and the sweep, and only
      // the boot-domain stamp keeps the orphaned worker identifiable.
      const workFile = path.join(root, 'ledger.json');
      testInternals.writeLedgerDocument(
        workFile,
        {
          pid: 101,
          pgid: 101,
          incarnation: 'incarnation-1',
          startedAt: Date.now(),
          uptimeMs: os.uptime() * 1000,
        },
        [],
      );
      const alive = new Set([101]);
      const signal = vi.fn((pgid: number) => {
        alive.delete(pgid);
        return 'sent' as const;
      });
      const verdict = await sweepWorkerLedger(workFile, {
        now: () => Date.now() + 600_000,
        sys: {
          platform: 'linux',
          liveness: (id) => (alive.has(id) ? 'alive' : 'gone'),
          signal,
          table: () =>
            new Map([
              [
                101,
                {
                  pid: 101,
                  pgid: 101,
                  runningMs: 5_000,
                  args: 'node dist/cli.js managed-runtime-worker',
                },
              ],
            ]),
        },
      });
      expect(verdict).toBe('proven');
      expect(signal).toHaveBeenCalledWith(101, 'SIGKILL');
      expect(existsSync(workFile)).toBe(false);
    });

    it('judges a boot-stamped worker in its own clock domain across a backward wall step', async () => {
      // The wall clock stepped back past the record's stamp (chrony makestep,
      // a snapshot restore) while the boot stamp stayed exact: the record
      // must still name its worker. Reading the wall step as recycling
      // evidence would leave the live orphan running over a deleted ledger.
      const workFile = path.join(root, 'ledger.json');
      testInternals.writeLedgerDocument(
        workFile,
        {
          pid: 101,
          pgid: 101,
          incarnation: 'incarnation-1',
          startedAt: Date.now(),
          uptimeMs: os.uptime() * 1000,
        },
        [],
      );
      const alive = new Set([101]);
      const signal = vi.fn((pgid: number) => {
        alive.delete(pgid);
        return 'sent' as const;
      });
      const verdict = await sweepWorkerLedger(workFile, {
        now: () => Date.now() - 60_000,
        sys: {
          platform: 'linux',
          liveness: (id) => (alive.has(id) ? 'alive' : 'gone'),
          signal,
          table: () =>
            new Map([
              [
                101,
                {
                  pid: 101,
                  pgid: 101,
                  runningMs: 5_000,
                  args: 'node dist/cli.js managed-runtime-worker',
                },
              ],
            ]),
        },
      });
      expect(signal).toHaveBeenCalledWith(101, 'SIGKILL');
      expect(verdict).toBe('proven');
      expect(existsSync(workFile)).toBe(false);
    });

    it('holds a worker whose wall stamp stepped back with no boot stamp to judge by', async () => {
      // A record from before uptimeMs existed, or macOS's wall-clock domain:
      // a stamp in the future makes the record undatable, and undatable is
      // not recycling evidence — the stop stays unproven, nothing signalled.
      const workFile = path.join(root, 'ledger.json');
      testInternals.writeLedgerDocument(
        workFile,
        {
          pid: 101,
          pgid: 101,
          incarnation: 'incarnation-1',
          startedAt: Date.now() + 3_600_000,
        },
        [],
      );
      const signal = vi.fn(() => 'sent' as const);
      await expect(
        sweepWorkerLedger(workFile, {
          sys: {
            platform: 'linux',
            liveness: (id) => (id === 101 ? 'alive' : 'gone'),
            signal,
            table: () =>
              new Map([
                [
                  101,
                  {
                    pid: 101,
                    pgid: 101,
                    runningMs: 5_000,
                    args: 'node dist/cli.js managed-runtime-worker',
                  },
                ],
              ]),
          },
        }),
      ).rejects.toMatchObject({ remaining: [101] });
      expect(signal).not.toHaveBeenCalled();
      expect(existsSync(workFile)).toBe(true);
    });

    it('judges a boot-stamped group in its own clock domain across a backward wall step', async () => {
      // The same backward step must not refuse the group identity check
      // either: the group's own live leader still dates it, so the sweep
      // signals it rather than holding it until the wall clock re-passes.
      const workFile = path.join(root, 'ledger.json');
      testInternals.writeLedgerDocument(
        workFile,
        {
          pid: 42424246,
          pgid: 42424246,
          incarnation: 'incarnation-1',
          startedAt: Date.now(),
        },
        [
          {
            pgid: 202,
            callId: 'call-1',
            startedAt: Date.now(),
            uptimeMs: os.uptime() * 1000,
          },
        ],
      );
      const signal = vi.fn(() => 'sent' as const);
      await expect(
        sweepWorkerLedger(workFile, {
          now: () => Date.now() - 60_000,
          proofTimeoutMs: 300,
          sys: {
            platform: 'linux',
            liveness: (id) => (id === 202 ? 'alive' : 'gone'),
            signal,
            table: () =>
              new Map([
                [
                  202,
                  {
                    pid: 202,
                    pgid: 202,
                    runningMs: 5_000,
                    args: 'node our-shell.js',
                  },
                ],
              ]),
          },
        }),
      ).rejects.toMatchObject({ remaining: [202] });
      expect(signal).toHaveBeenCalledWith(202, 'SIGKILL');
      expect(existsSync(workFile)).toBe(true);
    });

    it('proves a slow exit within the budget', async () => {
      const workFile = path.join(root, 'ledger.json');
      makeLedgerFile(workFile, { pid: 101 }, [
        { pgid: 202, startedAt: Date.now() },
      ]);
      let probes = 0;
      await sweepWorkerLedger(workFile, {
        exitWitnessed: true,
        proofTimeoutMs: 5_000,
        sys: {
          liveness: () => {
            probes += 1;
            return probes > 2 ? 'gone' : 'alive';
          },
          signal: () => 'sent',
          table: () => undefined,
        },
      });
      expect(existsSync(workFile)).toBe(false);
    });

    it('reads a young marker-bearing process on the worker pid as a recycled id', async () => {
      // The record is an hour old; the process answering on its pid carries
      // the worker marker but is seconds old — a fresh worker on a recycled
      // id. Only the record-age check keeps the sweep from SIGKILLing it:
      // the recorded worker is gone and is resolved without a signal.
      const workFile = path.join(root, 'ledger.json');
      makeLedgerFile(workFile, { pid: 101, startedAt: Date.now() - 3_600_000 });
      const signal = vi.fn(() => 'sent' as const);
      const verdict = await sweepWorkerLedger(workFile, {
        proofTimeoutMs: 100,
        sys: {
          platform: 'linux',
          liveness: (id) => (id === 101 ? 'alive' : 'gone'),
          signal,
          table: () =>
            new Map([
              [
                101,
                {
                  pid: 101,
                  pgid: 101,
                  runningMs: 5_000,
                  args: 'node dist/cli.js managed-runtime-worker',
                },
              ],
            ]),
        },
      });
      expect(verdict).toBe('proven');
      expect(signal).not.toHaveBeenCalled();
      expect(existsSync(workFile)).toBe(false);
    });

    it('pays for one table read when no proof wait aged the first', async () => {
      // The worker's pid answers for nobody and no proof wait intervenes:
      // the group judgement reuses the snapshot the sweep already bought
      // instead of forking a second blocking ps microseconds later.
      const workFile = path.join(root, 'ledger.json');
      makeLedgerFile(workFile, { pid: 101 }, [
        { pgid: 202, startedAt: Date.now() - 60_000 },
      ]);
      let reads = 0;
      await expect(
        sweepWorkerLedger(workFile, {
          proofTimeoutMs: 100,
          sys: {
            platform: 'linux',
            liveness: (id) => (id === 101 || id === 202 ? 'alive' : 'gone'),
            signal: () => 'sent',
            table: () => {
              reads += 1;
              return new Map([
                [
                  // A survivor too young to date the group by, and no leader.
                  999,
                  { pid: 999, pgid: 202, runningMs: 5_000, args: 'xterm' },
                ],
              ]);
            },
          },
        }),
      ).rejects.toMatchObject({ remaining: [101, 202] });
      expect(reads).toBe(1);
    });

    it('judges groups from the paid-for snapshot when its re-read fails', async () => {
      // The first table was read before the worker's proof wait; the
      // re-read after it fails transiently. The sweep must judge identity
      // from the snapshot it has, not fold the failed re-read into the
      // no-identity branch that holds everything.
      const workFile = path.join(root, 'ledger.json');
      makeLedgerFile(workFile, { pid: 101 }, [
        { pgid: 202, startedAt: Date.now() },
        { pgid: 303, startedAt: Date.now() },
      ]);
      let reads = 0;
      let workerProbes = 0;
      const verdict = await sweepWorkerLedger(workFile, {
        proofTimeoutMs: 100,
        sys: {
          platform: 'linux',
          liveness: (id) => {
            if (id === 101) {
              workerProbes += 1;
              return workerProbes === 1 ? 'alive' : 'gone';
            }
            return 'alive';
          },
          signal: () => 'sent',
          table: () => {
            reads += 1;
            return reads === 1
              ? new Map([
                  [
                    101,
                    {
                      pid: 101,
                      pgid: 101,
                      runningMs: 3_600_000,
                      args: 'node dist/cli.js managed-runtime-worker',
                    },
                  ],
                ])
              : undefined;
          },
        },
      });
      expect(verdict).toBe('proven');
      expect(reads).toBe(2);
      expect(existsSync(workFile)).toBe(false);
    });

    it('resolves proven when the unlink of a proven ledger fails', async () => {
      // The stop was proven — the bookkeeping unlink is not what proves it:
      // a failed one is logged, and the file that lingers is re-proved by
      // the next sweep rather than escalated into an unprovable stop.
      const workFile = path.join(root, 'ledger.json');
      makeLedgerFile(workFile, { pid: 42424250 }, [
        { pgid: 202, startedAt: Date.now() },
      ]);
      rmSyncControl.failing.add(workFile);
      try {
        await expect(
          sweepWorkerLedger(workFile, {
            sys: {
              platform: 'linux',
              liveness: () => 'gone',
              signal: () => 'gone',
              table: () => undefined,
            },
          }),
        ).resolves.toBe('proven');
        expect(existsSync(workFile)).toBe(true);
      } finally {
        rmSyncControl.failing.delete(workFile);
      }
    });

    it('signals nothing when no process table can judge a stale sweep', async () => {
      // POSIX, identity-owed, no table: the sweep cannot tell a stale group
      // from a recycled id, so it holds everything and keeps the truth.
      const workFile = path.join(root, 'ledger.json');
      makeLedgerFile(workFile, { pid: 101 }, [
        { pgid: 202, startedAt: Date.now() },
        { pgid: 303, startedAt: Date.now() },
      ]);
      const alive = new Set([101, 202, 303]);
      const signal = vi.fn(() => 'sent' as const);
      await expect(
        sweepWorkerLedger(workFile, {
          proofTimeoutMs: 300,
          sys: {
            platform: 'linux',
            liveness: (id) => (alive.has(id) ? 'alive' : 'gone'),
            signal,
            table: () => undefined,
          },
        }),
      ).rejects.toMatchObject({ remaining: [101, 202, 303] });
      expect(signal).not.toHaveBeenCalled();
      expect(existsSync(workFile)).toBe(true);
    });

    it('holds a stale group whose liveness is denied, proof or not', async () => {
      // 'denied' is only ever "not proven gone": a sweep must never turn it
      // into 'gone', whether the group needs a witness or was just
      // signalled.
      const workFile = path.join(root, 'ledger.json');
      makeLedgerFile(workFile, { pid: 101 }, [
        { pgid: 202, startedAt: Date.now() },
      ]);
      const signal = vi.fn(() => 'sent' as const);
      await expect(
        sweepWorkerLedger(workFile, {
          proofTimeoutMs: 200,
          sys: {
            platform: 'linux',
            liveness: () => 'denied',
            signal,
            table: () => undefined,
          },
        }),
      ).rejects.toMatchObject({ remaining: [101, 202] });
      expect(signal).not.toHaveBeenCalled();
      expect(existsSync(workFile)).toBe(true);
    });

    it('keeps the truth when a witnessed kill cannot be proven (denied)', async () => {
      const workFile = path.join(root, 'ledger.json');
      makeLedgerFile(workFile, { pid: 101 }, [
        { pgid: 202, startedAt: Date.now() },
      ]);
      const signal = vi.fn(() => 'sent' as const);
      await expect(
        sweepWorkerLedger(workFile, {
          exitWitnessed: true,
          proofTimeoutMs: 200,
          sys: { liveness: () => 'denied', signal, table: () => undefined },
        }),
      ).rejects.toMatchObject({ remaining: [101, 202] });
      expect(signal).toHaveBeenCalledTimes(2);
      expect(existsSync(workFile)).toBe(true);
    });

    it('on Windows kills a witnessed worker by its pid, group math aside', async () => {
      // Windows has no process groups: the ledger names leaders and the
      // sweep's taskkill reaches the tree through the leader's pid alone.
      const workFile = path.join(root, 'ledger.json');
      makeLedgerFile(workFile, { pid: 301 }, [
        { pgid: 401, startedAt: Date.now() },
      ]);
      const alive = new Set([301, 401]);
      const signalled: number[] = [];
      await sweepWorkerLedger(workFile, {
        exitWitnessed: true,
        sys: {
          platform: 'win32',
          liveness: (id) => (alive.has(id) ? 'alive' : 'gone'),
          signal: (pgid) => {
            signalled.push(pgid);
            alive.delete(pgid);
            return 'sent';
          },
        },
      });
      expect(signalled.sort()).toEqual([301, 401]);
      expect(existsSync(workFile)).toBe(false);
    });

    it('on Windows a live pid without a witness stays unproven and unkilled', async () => {
      // With no identity to check, the sweep never guesses: a pid that
      // answers could be anyone's, so it kills nothing and keeps the truth.
      const workFile = path.join(root, 'ledger.json');
      makeLedgerFile(workFile, { pid: 301 }, [
        { pgid: 401, startedAt: Date.now() },
      ]);
      const signal = vi.fn(() => 'sent' as const);
      await expect(
        sweepWorkerLedger(workFile, {
          sys: {
            platform: 'win32',
            liveness: (id) => (id === 301 ? 'alive' : 'gone'),
            signal,
          },
        }),
      ).rejects.toMatchObject({ remaining: [301] });
      expect(signal).not.toHaveBeenCalledWith(301, expect.anything());
      expect(existsSync(workFile)).toBe(true);
    });

    it('on Windows a live recorded group without a witness is never signalled', async () => {
      // A Windows pid space is denser than any identity check there: a live
      // recorded id without a witness could be anyone; it is held unproven.
      const workFile = path.join(root, 'ledger.json');
      makeLedgerFile(workFile, { pid: 301 }, [
        { pgid: 401, startedAt: Date.now() },
        { pgid: 402, startedAt: Date.now() },
      ]);
      const alive = new Set([301, 401]);
      const signal = vi.fn(() => 'sent' as const);
      await expect(
        sweepWorkerLedger(workFile, {
          proofTimeoutMs: 300,
          sys: {
            platform: 'win32',
            liveness: (id) => (alive.has(id) ? 'alive' : 'gone'),
            signal,
          },
        }),
      ).rejects.toMatchObject({ remaining: [301, 401] });
      expect(signal).not.toHaveBeenCalled();
      // An unproven writer's file is never rewritten: both records stay on
      // disk and the next sweep re-judges them — a dead group's liveness
      // answer is cheap to re-earn, a lost record is not recoverable.
      const kept = testInternals.readLedgerDocument(workFile);
      expect(kept?.groups.map((group) => group.pgid)).toEqual([401, 402]);
    });

    it('holds a live sibling whose ACP host uses the deprecated alias', async () => {
      // The hold must see '--experimental-acp' as an ACP host marker too,
      // or it would SIGKILL a live sibling child's workers.
      const workFile = path.join(root, 'ledger.json');
      testInternals.writeLedgerDocument(
        workFile,
        {
          pid: 101,
          pgid: 101,
          hostPid: 202,
          incarnation: 'i',
          startedAt: Date.now(),
        },
        [{ pgid: 105, callId: 'c1', startedAt: Date.now() }],
      );
      const signal = vi.fn(() => 'sent' as const);
      await sweepWorkerLedger(workFile, {
        sys: {
          platform: 'linux',
          liveness: (id) =>
            id === 202 || id === 101 || id === 105 ? 'alive' : 'gone',
          alive: (id) => id === 202,
          signal,
          table: () =>
            new Map([
              [
                202,
                {
                  pid: 202,
                  pgid: 202,
                  runningMs: 3_000,
                  args: 'node cli.js --experimental-acp',
                },
              ],
            ]),
        },
      });
      expect(signal).not.toHaveBeenCalled();
      expect(existsSync(workFile)).toBe(true);
    });

    it('does not hold a ledger whose named host is younger than the worker', async () => {
      // A process younger than the worker it is named as parenting is an
      // impostor on a recycled pid: the orphaned worker belongs to the sweep.
      const workFile = path.join(root, 'ledger.json');
      testInternals.writeLedgerDocument(
        workFile,
        {
          pid: 101,
          pgid: 101,
          hostPid: 202,
          incarnation: 'i',
          startedAt: Date.now() - 3_600_000,
        },
        [],
      );
      const signal = vi.fn(() => 'sent' as const);
      await sweepWorkerLedger(workFile, {
        proofTimeoutMs: 300,
        sys: {
          platform: 'linux',
          liveness: (id) =>
            id === 101 ? 'alive' : id === 202 ? 'alive' : 'gone',
          alive: (id) => id === 202,
          signal,
          table: () =>
            new Map([
              [
                101,
                {
                  pid: 101,
                  pgid: 101,
                  runningMs: 3_605_000,
                  args: 'node managed-runtime-worker',
                },
              ],
              [
                202,
                {
                  pid: 202,
                  pgid: 202,
                  runningMs: 5_000,
                  args: 'node cli.js --acp-execution-engine managed',
                },
              ],
            ]),
        },
      }).catch(() => undefined);
      // The hold does not apply: the orphan is signalled.
      expect(signal).toHaveBeenCalledWith(101, 'SIGKILL');
    });

    it('holds a live worker whose host is pid 1 carrying the ACP marker', async () => {
      // A container without an init has the ACP host itself as pid 1: the
      // record carries hostPid 1, and the hold tells it from init by the
      // table's argv — a sibling sweep must leave the worker to its host.
      const workFile = path.join(root, 'ledger.json');
      testInternals.writeLedgerDocument(
        workFile,
        {
          pid: 101,
          pgid: 101,
          hostPid: 1,
          incarnation: 'i',
          startedAt: Date.now(),
        },
        [{ pgid: 105, callId: 'c1', startedAt: Date.now() }],
      );
      const signal = vi.fn(() => 'sent' as const);
      const verdict = await sweepWorkerLedger(workFile, {
        sys: {
          platform: 'linux',
          liveness: () => 'alive',
          alive: () => true,
          signal,
          table: () =>
            new Map([
              [
                1,
                {
                  pid: 1,
                  pgid: 1,
                  runningMs: 3_600_000,
                  args: 'node /app/dist/cli.js --experimental-acp',
                },
              ],
            ]),
        },
      });
      expect(verdict).toBe('held');
      expect(signal).not.toHaveBeenCalled();
      expect(existsSync(workFile)).toBe(true);
    });

    it('sweeps an orphan whose pid-1 parent is init, not an ACP host', async () => {
      // A reparented orphan reads the same on paper — hostPid 1 — but pid 1
      // carries no ACP marker: init is not the ledger's owner and holds
      // nothing, so the orphaned worker belongs to the sweep.
      const workFile = path.join(root, 'ledger.json');
      testInternals.writeLedgerDocument(
        workFile,
        {
          pid: 101,
          pgid: 101,
          hostPid: 1,
          incarnation: 'i',
          startedAt: Date.now(),
        },
        [],
      );
      let workerAlive = true;
      const signal = vi.fn(() => {
        workerAlive = false;
        return 'sent' as const;
      });
      const verdict = await sweepWorkerLedger(workFile, {
        proofTimeoutMs: 100,
        sys: {
          platform: 'linux',
          liveness: (id) => (id === 101 && workerAlive ? 'alive' : 'gone'),
          alive: () => true,
          signal,
          table: () =>
            new Map([
              [
                1,
                { pid: 1, pgid: 1, runningMs: 3_600_000, args: '/sbin/init' },
              ],
              [
                101,
                {
                  pid: 101,
                  pgid: 101,
                  runningMs: 3_600_000,
                  args: 'node dist/cli.js managed-runtime-worker',
                },
              ],
            ]),
        },
      });
      expect(verdict).toBe('proven');
      expect(signal).toHaveBeenCalledWith(101, 'SIGKILL');
      expect(existsSync(workFile)).toBe(false);
    });

    it('does not hold a pid-1 host on liveness alone, without a table', async () => {
      // Pid 1 is always alive, host or init: with no table to read its
      // argv, the id carries no information and the ledger is judged, not
      // held — the no-identity rule signals nothing either way.
      const workFile = path.join(root, 'ledger.json');
      testInternals.writeLedgerDocument(
        workFile,
        {
          pid: 101,
          pgid: 101,
          hostPid: 1,
          incarnation: 'i',
          startedAt: Date.now(),
        },
        [{ pgid: 202, callId: 'c1', startedAt: Date.now() }],
      );
      const signal = vi.fn(() => 'sent' as const);
      await expect(
        sweepWorkerLedger(workFile, {
          proofTimeoutMs: 100,
          sys: {
            platform: 'linux',
            liveness: () => 'alive' as const,
            alive: () => true,
            signal,
            table: () => undefined,
          },
        }),
      ).rejects.toMatchObject({ remaining: [101, 202] });
      expect(signal).not.toHaveBeenCalled();
      expect(existsSync(workFile)).toBe(true);
    });

    it('never holds a ledger this process itself parented', async () => {
      // The hold stops a sibling's sweep: this process's own reaper retries
      // a ledger its own pid is recorded as hosting, and must not read
      // itself as the live sibling that owns the truth.
      const workFile = path.join(root, 'ledger.json');
      testInternals.writeLedgerDocument(
        workFile,
        {
          pid: 101,
          pgid: 101,
          hostPid: process.pid,
          incarnation: 'i',
          startedAt: Date.now(),
        },
        [{ pgid: 202, callId: 'c1', startedAt: Date.now() }],
      );
      const signal = vi.fn(() => 'sent' as const);
      await expect(
        sweepWorkerLedger(workFile, {
          proofTimeoutMs: 100,
          sys: {
            platform: 'linux',
            liveness: () => 'alive' as const,
            alive: () => true,
            signal,
            table: () =>
              new Map([
                [
                  process.pid,
                  {
                    pid: process.pid,
                    pgid: process.pid,
                    runningMs: 3_600_000,
                    args: 'node dist/cli.js --experimental-acp',
                  },
                ],
              ]),
          },
        }),
      ).rejects.toMatchObject({ remaining: [101] });
      expect(signal).not.toHaveBeenCalled();
      expect(existsSync(workFile)).toBe(true);
    });
  });

  describe('sweepStaleLedgers', () => {
    it('answers absent, having judged nothing, when the directory never existed', async () => {
      // 'proven' would tell a reaper the groups its failure named are gone;
      // a directory that was never there judged none of them.
      await expect(sweepStaleLedgers(path.join(root, 'nowhere'))).resolves.toBe(
        'absent',
      );
    });

    it('removes only aged .tmp debris and keeps a live write in flight', async () => {
      const directory = path.join(root, 'managed-runtime');
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, 'fresh.json.tmp'), 'x', 'utf8');
      const aged = path.join(directory, 'aged.json.tmp');
      await writeFile(aged, 'x', 'utf8');
      utimesSync(
        aged,
        new Date(Date.now() - 120_000),
        new Date(Date.now() - 120_000),
      );

      await sweepStaleLedgers(directory);
      expect(existsSync(path.join(directory, 'fresh.json.tmp'))).toBe(true);
      expect(existsSync(aged)).toBe(false);
    });

    it.skipIf(!POSIX)(
      'sweeps every file, removes write debris, and aggregates the failures',
      async () => {
        const directory = path.join(root, 'managed-runtime');
        await mkdir(directory, { recursive: true });
        const proc = spawnGroupLeader();
        strays.add(proc);
        const shell = proc.pid!;
        makeLedgerFile(path.join(directory, 'good.json'), { pid: 42424241 }, [
          { pgid: shell, startedAt: Date.now() },
        ]);
        await writeFile(path.join(directory, 'corrupt.json'), 'xx', 'utf8');
        // Old debris a crashed writer left between write and rename.
        const debris = path.join(directory, 'debris.tmp');
        await writeFile(debris, 'x', 'utf8');
        utimesSync(
          debris,
          new Date(Date.now() - 120_000),
          new Date(Date.now() - 120_000),
        );
        await expect(sweepStaleLedgers(directory)).rejects.toMatchObject({
          message: expect.stringContaining('could not be fully swept'),
        });
        strays.delete(proc);
        expect(processGroupLiveness(shell)).toBe('gone');
        // The good one was swept despite the corrupt sibling, and the write
        // debris of a crashed writer is gone.
        expect(existsSync(path.join(directory, 'good.json'))).toBe(false);
        expect(existsSync(path.join(directory, 'debris.tmp'))).toBe(false);
        expect(existsSync(path.join(directory, 'corrupt.json'))).toBe(true);
      },
    );

    it.skipIf(!POSIX)(
      'skips non-regular entries and still sweeps the orphaned ledger',
      async () => {
        const directory = path.join(root, 'managed-runtime');
        await mkdir(directory, { recursive: true });
        // Foreign shapes no writer of ours makes: a directory named like
        // crash debris and one named like a ledger. Judging either would
        // abort every future sweep (rmSync EISDIR / device read); a genuine
        // orphan sorted with them must still be reaped.
        const debrisDir = path.join(directory, 'debris.tmp');
        await mkdir(debrisDir);
        utimesSync(
          debrisDir,
          new Date(Date.now() - 120_000),
          new Date(Date.now() - 120_000),
        );
        await mkdir(path.join(directory, 'ghost.json'));
        const proc = spawnGroupLeader();
        strays.add(proc);
        const shell = proc.pid!;
        makeLedgerFile(
          path.join(directory, 'remaining.json'),
          { pid: 42424242 },
          [{ pgid: shell, startedAt: Date.now() }],
        );

        await sweepStaleLedgers(directory);

        strays.delete(proc);
        expect(processGroupLiveness(shell)).toBe('gone');
        expect(existsSync(path.join(directory, 'remaining.json'))).toBe(false);
        expect(existsSync(debrisDir)).toBe(true);
        expect(existsSync(path.join(directory, 'ghost.json'))).toBe(true);
      },
    );

    it('retires an aged unreadable ledger aside and rejects with the retirement', async () => {
      // The debris-aged unreadable file is set aside, and the retirement
      // rides the rejection: a resolved verdict is read by every production
      // caller as a clean stop, so the terminal fact must travel in the
      // throw. A later sweep no longer judges the aside.
      const directory = path.join(root, 'managed-runtime');
      await mkdir(directory, { recursive: true });
      const corrupt = path.join(directory, 'broken-corrupt.json');
      await writeFile(corrupt, '{not json', 'utf8');
      utimesSync(
        corrupt,
        new Date(Date.now() - 120_000),
        new Date(Date.now() - 120_000),
      );
      const error = await sweepStaleLedgers(directory).catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(AggregateError);
      expect(
        (error as AggregateError).errors.some(
          (member) =>
            member instanceof LedgerSweepRetiredError &&
            member.workFile === corrupt,
        ),
      ).toBe(true);
      expect(existsSync(corrupt)).toBe(false);
      expect(
        existsSync(path.join(directory, 'broken-corrupt.unreadable')),
      ).toBe(true);
      await expect(sweepStaleLedgers(directory)).resolves.toBe('absent');
    });

    it('carries the retirement through the rejection when a sibling file fails too', async () => {
      // The retirement is one-shot — the aside is judged by no later pass —
      // so it must reach the caller inside the same rejection that reports
      // the sibling's unproven groups, or a later clean pass reads as proof
      // over groups that can never be proven.
      const directory = path.join(root, 'managed-runtime');
      await mkdir(directory, { recursive: true });
      const retiredFile = path.join(directory, 'a.json');
      await writeFile(retiredFile, '{not a ledger', 'utf8');
      utimesSync(
        retiredFile,
        new Date(Date.now() - 120_000),
        new Date(Date.now() - 120_000),
      );
      const staleFile = path.join(directory, 'b.json');
      makeLedgerFile(staleFile, { pid: 42424249 }, [
        { pgid: 202, startedAt: Date.now() },
      ]);
      const error = await sweepStaleLedgers(directory, {
        proofTimeoutMs: 100,
        sys: {
          platform: 'linux',
          liveness: () => 'alive',
          signal: () => 'failed',
          table: () => undefined,
        },
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AggregateError);
      const members = (error as AggregateError).errors;
      expect(
        members.some(
          (member) =>
            member instanceof LedgerSweepRetiredError &&
            member.workFile === retiredFile,
        ),
      ).toBe(true);
      expect(
        members.some(
          (member) =>
            member instanceof LedgerSweepUnprovenError &&
            member.workFile === staleFile,
        ),
      ).toBe(true);
      expect(existsSync(path.join(directory, 'a.unreadable'))).toBe(true);
      expect(existsSync(staleFile)).toBe(true);
    });

    it('never reads undeletable debris as an unproven stop', async () => {
      // Aged debris whose unlink fails — root-owned in a bind mount, an
      // EROFS mount, an open handle on Windows — names no process group:
      // the sweep logs it and moves on instead of quarantining the engine
      // over bookkeeping.
      const directory = path.join(root, 'managed-runtime');
      await mkdir(directory, { recursive: true });
      const debris = path.join(directory, 'debris.tmp');
      await writeFile(debris, 'x', 'utf8');
      utimesSync(
        debris,
        new Date(Date.now() - 120_000),
        new Date(Date.now() - 120_000),
      );
      rmSyncControl.failing.add(debris);
      try {
        await expect(sweepStaleLedgers(directory)).resolves.toBe('absent');
        // Left where it is for an operator, not thrown over.
        expect(existsSync(debris)).toBe(true);
      } finally {
        rmSyncControl.failing.delete(debris);
      }
    });

    it('names the unreadable ledgers in the aggregate rejection', async () => {
      const directory = path.join(root, 'managed-runtime');
      await mkdir(directory, { recursive: true });
      const corrupt = path.join(directory, 'broken-corrupt.json');
      await writeFile(corrupt, '{not json', 'utf8');
      await expect(sweepStaleLedgers(directory)).rejects.toThrow(
        /broken-corrupt\.json/,
      );
    });

    it.skipIf(!POSIX)(
      'leaves ledgers this host launched to their own sweeps',
      async () => {
        const directory = path.join(root, 'managed-runtime');
        await mkdir(directory, { recursive: true });
        const proc = spawnGroupLeader();
        strays.add(proc);
        const live = proc.pid!;
        const workFile = path.join(directory, 'own.json');
        makeLedgerFile(workFile, { pid: 42424244 }, [
          { pgid: live, startedAt: Date.now() },
        ]);
        // Their writer crashed between write and rename; only their own
        // lifecycle may clean either — even debris old enough to sweep.
        const ownDebris = path.join(directory, 'own.json.tmp');
        await writeFile(ownDebris, 'x', 'utf8');
        utimesSync(
          ownDebris,
          new Date(Date.now() - 120_000),
          new Date(Date.now() - 120_000),
        );
        await sweepStaleLedgers(directory, { skip: new Set([workFile]) });
        expect(processGroupLiveness(live)).toBe('alive');
        expect(existsSync(workFile)).toBe(true);
        expect(existsSync(ownDebris)).toBe(true);
        // Without the skip entry the same aged debris is swept out.
        await sweepStaleLedgers(directory);
        expect(existsSync(ownDebris)).toBe(false);
        killGroup(live);
        strays.delete(proc);
      },
    );
  });

  describe('startLedgerReaper', () => {
    it('retries until the sweep proves its remainders gone', async () => {
      let attempts = 0;
      const onProven = vi.fn();
      const reaper = startLedgerReaper(
        async () => {
          attempts += 1;
          if (attempts < 3) throw new Error('still unproven');
          return 'proven' as const;
        },
        onProven,
        10,
      );
      await waitFor(() => (onProven.mock.calls.length > 0 ? true : undefined));
      expect(onProven).toHaveBeenCalledTimes(1);
      reaper.stop();
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(onProven).toHaveBeenCalledTimes(1);
    });

    it('never lifts over a ledger retired unreadable', async () => {
      // A ledger nobody can read is set aside once it outlives the debris
      // age — but nothing it named was proven, so the reaper stops without
      // firing onProven: the quarantine stands. The mapping is the
      // production one: only the sweep's own proof lifts, and a retirement
      // — which arrives as a rejection — stops the reaper without one.
      const workFile = path.join(root, 'corrupt.json');
      await writeFile(workFile, '{not a ledger', 'utf8');
      utimesSync(
        workFile,
        new Date(Date.now() - 120_000),
        new Date(Date.now() - 120_000),
      );
      let sweeps = 0;
      const onProven = vi.fn();
      const reaper = startLedgerReaper(
        async () => {
          sweeps += 1;
          try {
            return (await sweepWorkerLedger(workFile, {
              exitWitnessed: true,
            })) === 'proven'
              ? ('proven' as const)
              : ('unproven' as const);
          } catch (error) {
            return error instanceof LedgerSweepRetiredError
              ? ('terminal' as const)
              : ('unproven' as const);
          }
        },
        onProven,
        10,
      );
      await waitFor(() =>
        existsSync(path.join(root, 'corrupt.unreadable')) ? true : undefined,
      );
      const settledSweeps = sweeps;
      // Several tick-intervals past the retirement: no lift ever came, and
      // the reaper stopped — a 'terminal' verdict ends the retries, it does
      // not just withhold the lift.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(onProven).not.toHaveBeenCalled();
      expect(sweeps).toBe(settledSweeps);
      reaper.stop();
    });

    it('lifts only once the groups a deleted ledger named are gone', async () => {
      // A sweep that finds the file gone proved nothing about the groups
      // the last failure named: the reaper re-probes them, and lifts only
      // when the last one is dead.
      const workFile = path.join(root, 'ledger.json');
      makeLedgerFile(workFile, { pid: 42424247 }, [
        { pgid: 202, startedAt: Date.now() },
      ]);
      const alive = new Set([202]);
      const liveness = (id: number): 'alive' | 'gone' =>
        alive.has(id) ? 'alive' : 'gone';
      let lastNamed: readonly number[] = [];
      try {
        await sweepWorkerLedger(workFile, {
          exitWitnessed: true,
          proofTimeoutMs: 100,
          sys: { liveness, signal: () => 'failed', table: () => undefined },
        });
        throw new Error('the arming sweep should not have proven');
      } catch (error) {
        expect(error).toBeInstanceOf(LedgerSweepUnprovenError);
        lastNamed = (error as LedgerSweepUnprovenError).remaining;
      }
      expect(lastNamed).toEqual([202]);
      const onProven = vi.fn();
      const reaper = startLedgerReaper(
        async () => {
          const verdict = await sweepWorkerLedger(workFile, {
            exitWitnessed: true,
            sys: { liveness, signal: () => 'failed', table: () => undefined },
          });
          if (verdict === 'proven') return 'proven' as const;
          return lastNamed.every((pgid) => liveness(pgid) === 'gone')
            ? ('proven' as const)
            : ('unproven' as const);
        },
        onProven,
        10,
      );
      // The file vanishes underneath the reaper: the group it named still
      // runs, so the quarantine must not lift.
      await rm(workFile);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(onProven).not.toHaveBeenCalled();
      // Once the named group dies, the reaper proves it and lifts.
      alive.delete(202);
      await waitFor(() => (onProven.mock.calls.length > 0 ? true : undefined));
      reaper.stop();
    });

    it('backs off exponentially up to the interval cap while a sweep stays unproven', async () => {
      vi.useFakeTimers();
      try {
        let attempts = 0;
        const reaper = startLedgerReaper(
          async () => {
            attempts += 1;
            throw new Error('still unproven');
          },
          () => undefined,
          10,
          40,
        );
        // The cadence: 10, +20, +40, then clamped at 40 — the attempts land
        // at 10, 30, 70, 110, 150, each read off the fake clock by count.
        await vi.advanceTimersByTimeAsync(10);
        expect(attempts).toBe(1);
        await vi.advanceTimersByTimeAsync(19);
        expect(attempts).toBe(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(attempts).toBe(2);
        await vi.advanceTimersByTimeAsync(39);
        expect(attempts).toBe(2);
        await vi.advanceTimersByTimeAsync(1);
        expect(attempts).toBe(3);
        await vi.advanceTimersByTimeAsync(80);
        expect(attempts).toBe(5);
        reaper.stop();
      } finally {
        vi.useRealTimers();
      }
    });

    it('backs off the same way when the sweep resolves unproven', async () => {
      // A sweep that RESOLVES 'unproven' — a remainder that keeps answering
      // the same way — must back off exactly like a thrown one, or it costs
      // a process-table read and signals every second for the quarantine's
      // lifetime.
      vi.useFakeTimers();
      try {
        let attempts = 0;
        const reaper = startLedgerReaper(
          async () => {
            attempts += 1;
            return 'unproven' as const;
          },
          () => undefined,
          10,
          40,
        );
        // The same cadence as a throwing sweep: 10, +20, +40, clamped at 40.
        await vi.advanceTimersByTimeAsync(10);
        expect(attempts).toBe(1);
        await vi.advanceTimersByTimeAsync(19);
        expect(attempts).toBe(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(attempts).toBe(2);
        await vi.advanceTimersByTimeAsync(39);
        expect(attempts).toBe(2);
        await vi.advanceTimersByTimeAsync(1);
        expect(attempts).toBe(3);
        await vi.advanceTimersByTimeAsync(80);
        expect(attempts).toBe(5);
        reaper.stop();
      } finally {
        vi.useRealTimers();
      }
    });

    it('never runs two reaper sweeps over one target concurrently', async () => {
      let inFlight = 0;
      let maxInFlight = 0;
      let calls = 0;
      await new Promise<void>((resolve) => {
        const reaper = startLedgerReaper(
          async () => {
            calls += 1;
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await new Promise((r) => setTimeout(r, 25));
            inFlight -= 1;
            if (calls >= 4) {
              resolve();
              reaper.stop();
              return 'proven' as const;
            }
            throw new Error('still unproven');
          },
          () => resolve(),
          5,
        );
      });
      expect(maxInFlight).toBe(1);
    });
  });

  describe('managedRuntimeLedgerFromEnvironment', () => {
    it('creates the ledger the environment names, or none', async () => {
      const previous = process.env[MANAGED_RUNTIME_LEDGER_ENV];
      try {
        delete process.env[MANAGED_RUNTIME_LEDGER_ENV];
        expect(managedRuntimeLedgerFromEnvironment('inc')).toBeUndefined();

        const workFile = path.join(root, 'env-ledger.json');
        process.env[MANAGED_RUNTIME_LEDGER_ENV] = workFile;
        const ledger = managedRuntimeLedgerFromEnvironment('inc-2');
        expect(ledger).toBeDefined();
        const written = JSON.parse(await readFile(workFile, 'utf8')) as {
          worker: {
            pid: number;
            incarnation: string;
            hostPid?: number;
            uptimeMs?: number;
          };
        };
        expect(written.worker.pid).toBe(process.pid);
        expect(written.worker.incarnation).toBe('inc-2');
        // The boot-domain stamp the sweeps judge identity with, and the
        // host the ledger belongs to.
        expect(written.worker.hostPid).toBe(process.ppid);
        expect(written.worker.uptimeMs).toBeGreaterThan(0);
        expect(written.worker.uptimeMs!).toBeLessThanOrEqual(
          os.uptime() * 1000,
        );
      } finally {
        if (previous === undefined) {
          delete process.env[MANAGED_RUNTIME_LEDGER_ENV];
        } else {
          process.env[MANAGED_RUNTIME_LEDGER_ENV] = previous;
        }
      }
    });

    it('records a pid-1 host as itself, keeping the ledger readable', async () => {
      // A container without an init has the ACP host itself as pid 1: the
      // record must still name it — a dropped hostPid is what let a
      // sibling's sweep SIGKILL a live PID-1-hosted worker.
      const previous = process.env[MANAGED_RUNTIME_LEDGER_ENV];
      const descriptor = Object.getOwnPropertyDescriptor(process, 'ppid');
      Object.defineProperty(process, 'ppid', {
        get: () => 1,
        configurable: true,
      });
      try {
        const workFile = path.join(root, 'orphan-ledger.json');
        process.env[MANAGED_RUNTIME_LEDGER_ENV] = workFile;
        const ledger = managedRuntimeLedgerFromEnvironment('inc-orphan');
        expect(ledger).toBeDefined();
        const written = JSON.parse(await readFile(workFile, 'utf8')) as {
          worker: { pid: number; hostPid?: number };
        };
        expect(written.worker.hostPid).toBe(1);
        // The record reads back, and a witnessed sweep can close it out.
        expect(testInternals.readLedgerDocument(workFile)).toBeDefined();
        // The ledger's worker is this process itself, so the sweep gets a
        // sys seam that cannot reach the runner: un-seamed, the witnessed
        // branch on win32 ends in taskkill against the test's own pid.
        const signal = vi.fn(() => 'sent' as const);
        await expect(
          sweepWorkerLedger(workFile, {
            exitWitnessed: true,
            sys: { liveness: () => 'gone', signal, table: () => undefined },
          }),
        ).resolves.toBe('proven');
        expect(signal).not.toHaveBeenCalled();
        expect(existsSync(workFile)).toBe(false);
      } finally {
        if (descriptor !== undefined) {
          Object.defineProperty(process, 'ppid', descriptor);
        }
        if (previous === undefined) {
          delete process.env[MANAGED_RUNTIME_LEDGER_ENV];
        } else {
          process.env[MANAGED_RUNTIME_LEDGER_ENV] = previous;
        }
      }
    });

    it('fails the worker boot when the ledger cannot be written', async () => {
      const previous = process.env[MANAGED_RUNTIME_LEDGER_ENV];
      try {
        const notADirectory = path.join(root, 'not-a-directory');
        await writeFile(notADirectory, 'x', 'utf8');
        process.env[MANAGED_RUNTIME_LEDGER_ENV] = path.join(
          notADirectory,
          'ledger.json',
        );
        expect(() => managedRuntimeLedgerFromEnvironment('inc-3')).toThrow();
      } finally {
        if (previous === undefined) {
          delete process.env[MANAGED_RUNTIME_LEDGER_ENV];
        } else {
          process.env[MANAGED_RUNTIME_LEDGER_ENV] = previous;
        }
      }
    });
  });
});
