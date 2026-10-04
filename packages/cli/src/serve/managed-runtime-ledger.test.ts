/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import { existsSync, utimesSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
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
        groups: Array<{ pgid: number; callId: string; startedAt: number }>;
      };
      expect(updated.groups).toEqual([
        { pgid: 4242, callId: 'c1', startedAt: 123 },
      ]);
      expect(ledger.outstandingGroups()).toHaveLength(1);
    });

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
    });

    it('parses table rows and skips malformed ones', () => {
      const rows = testInternals.parseProcessTable(
        [
          '  123   100 00:05 node worker.js managed-runtime-worker',
          '  456   100 01:02:03 sleep 300',
          'garbage line',
          '  789   100 not-a-time whatever',
        ].join('\n'),
      );
      expect(rows.get(123)).toMatchObject({
        pgid: 100,
        runningMs: 5_000,
        args: 'node worker.js managed-runtime-worker',
      });
      expect(rows.get(456)?.args).toBe('sleep 300');
      expect(rows.has(789)).toBe(false);
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
    it('resolves a missing file quietly', async () => {
      await expect(
        sweepWorkerLedger(path.join(root, 'absent.json')),
      ).resolves.toBeUndefined();
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

        // "Not ours": this very test process — alive, but its command line
        // names no Runtime worker. It stays untouched and the file resolves.
        const foreignFile = path.join(root, 'foreign.json');
        makeLedgerFile(foreignFile, { pid: process.pid });
        await sweepWorkerLedger(foreignFile, {});
        // The group probe above is meaningless for a pid that leads no group;
        // the assertion is that the pid itself was never signalled.
        expect(() => process.kill(process.pid, 0)).not.toThrow();
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
          sys: { signal, liveness: () => 'alive' },
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
        },
      });
      expect(existsSync(workFile)).toBe(false);
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
            liveness: (id) => (alive.has(id) ? 'alive' : 'gone'),
            signal,
            table: () => undefined,
          },
        }),
      ).rejects.toMatchObject({ remaining: [101, 202, 303] });
      expect(signal).not.toHaveBeenCalled();
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
      // The group's truth survives for the next sweep; the dead one resolved.
      const kept = testInternals.readLedgerDocument(workFile);
      expect(kept?.groups.map((group) => group.pgid)).toEqual([401]);
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
          liveness: (id) =>
            id === 202 || id === 101 || id === 105 ? 'alive' : 'gone',
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
          liveness: (id) =>
            id === 101 ? 'alive' : id === 202 ? 'alive' : 'gone',
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
  });

  describe('sweepStaleLedgers', () => {
    it('resolves quietly when the directory never existed', async () => {
      await expect(
        sweepStaleLedgers(path.join(root, 'nowhere')),
      ).resolves.toBeUndefined();
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
        // lifecycle may clean either.
        await writeFile(path.join(directory, 'own.json.tmp'), 'x', 'utf8');
        await sweepStaleLedgers(directory, { skip: new Set([workFile]) });
        expect(processGroupLiveness(live)).toBe('alive');
        expect(existsSync(workFile)).toBe(true);
        expect(existsSync(path.join(directory, 'own.json.tmp'))).toBe(true);
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
              return;
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
          worker: { pid: number; incarnation: string };
        };
        expect(written.worker.pid).toBe(process.pid);
        expect(written.worker.incarnation).toBe('inc-2');
      } finally {
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
