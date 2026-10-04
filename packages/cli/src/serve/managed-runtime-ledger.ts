/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync, spawnSync } from 'node:child_process';
import {
  type Dirent,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { createDebugLogger } from '@qwen-code/qwen-code-core/utils/debugLogger.js';

const debugLogger = createDebugLogger('MANAGED_RUNTIME_LEDGER');

/**
 * The launch-environment variable that names a session Runtime worker's
 * ledger file. The host sets it per worker incarnation; the worker keeps its
 * own record and every Shell process group it starts in the file, so a crash
 * of the worker, of the Managed child, or of both leaves the groups
 * attributable without relying on either again.
 */
export const MANAGED_RUNTIME_LEDGER_ENV = 'QWEN_MANAGED_RUNTIME_LEDGER';

const LEDGER_FILE_VERSION = 1;
/** How long a settled cancel may wait for its Shell's process group. */
export const GROUP_EXIT_EVIDENCE_TIMEOUT_MS = 10_000;
/** How long one sweep waits for a signalled group to die. */
const SWEEP_PROOF_TIMEOUT_MS = 5_000;
/** The worker closes with at most this much extra time for its own sweep. */
const CLOSE_SWEEP_TIMEOUT_MS = 5_000;
/** How often the worker prunes dead groups and a failed sweep retries. */
const LEDGER_WATCH_INTERVAL_MS = 1_000;
/** How often an exit proof re-checks the group's liveness. */
const POLL_GROUP_EXIT_MS = 50;
/**
 * How much younger than its record a true process may read: the lag from
 * its birth to the record's write plus ps's whole-second truncation. A
 * process whose age exceeds the record's by any amount is one-side provable
 * — it was born first; a substantially younger one answers a recycled id.
 */
const RECORD_LEAD_SKEW_MS = 5_000;
/** A live process table older than this would refuse nothing. */
const PROCESS_QUERY_TIMEOUT_MS = 2_000;
const PROCESS_QUERY_MAX_BUFFER = 8 * 1024 * 1024;
const POSIX_PS = '/bin/ps';
const WINDOWS_TASKKILL = `${process.env['SystemRoot'] || 'C:\\Windows'}\\System32\\taskkill.exe`;

export interface ManagedRuntimeLedgerWorkerRecord {
  readonly pid: number;
  /** The worker's own process group; its pid on Windows, which has none. */
  readonly pgid: number;
  /**
   * The Managed child that launched the worker (`process.ppid`). The startup
   * sweep's orphan premise is sound only while this pid is dead: a live one
   * marks the ledger as belonging to a live sibling child, which its own
   * lifecycle sweeps.
   */
  readonly hostPid?: number;
  readonly incarnation: string;
  readonly startedAt: number;
}

export interface ManagedRuntimeLedgerGroupRecord {
  /** The Shell's process group, led by this pid on POSIX; its pid on Windows. */
  readonly pgid: number;
  readonly callId: string;
  readonly startedAt: number;
}

interface ManagedRuntimeLedgerDocument {
  readonly version: number;
  readonly worker: ManagedRuntimeLedgerWorkerRecord;
  readonly groups: ManagedRuntimeLedgerGroupRecord[];
}

/** Whether a recorded process (group) still runs: gone, alive, or denied to us. */
export type ProcessLiveness = 'alive' | 'gone' | 'denied';

function errnoCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * The liveness of `pgid`'s process group. On Windows, which has no process
 * groups, it answers for the process the id names.
 */
export function processGroupLiveness(pgid: number): ProcessLiveness {
  if (!Number.isSafeInteger(pgid) || pgid <= 1) return 'gone';
  try {
    process.kill(process.platform === 'win32' ? pgid : -pgid, 0);
    return 'alive';
  } catch (error) {
    // A group being torn down can answer EPERM for a few milliseconds: it is
    // not gone yet, and only ESRCH ever proves it gone.
    return errnoCode(error) === 'ESRCH' ? 'gone' : 'denied';
  }
}

/** Sends `signal` to `pgid`'s process group (the process itself on Windows). */
export function signalProcessGroup(
  pgid: number,
  signal: NodeJS.Signals,
): 'sent' | 'gone' | 'failed' {
  if (!Number.isSafeInteger(pgid) || pgid <= 1) return 'gone';
  try {
    if (process.platform === 'win32') {
      if (signal === 'SIGKILL' || signal === 'SIGTERM') {
        const result = spawnSync(
          WINDOWS_TASKKILL,
          ['/f', '/t', '/pid', String(pgid)],
          { encoding: 'utf8', windowsHide: true },
        );
        if (result.error) throw result.error;
        // A non-zero taskkill answers failure even to exit 1: the process
        // may be gone, or the kill may not have reached it.
        return result.status === 0 ? 'sent' : 'failed';
      }
    }
    process.kill(process.platform === 'win32' ? pgid : -pgid, signal);
    return 'sent';
  } catch (error) {
    const code = errnoCode(error);
    if (code === 'ESRCH') return 'gone';
    debugLogger.warn(
      `Failed to send ${signal} to Managed Runtime process group ${pgid}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return 'failed';
  }
}

/** One row of the live process table, for the sweeps' identity checks. */
export interface ProcessTableRow {
  readonly pid: number;
  readonly pgid: number;
  /** Milliseconds the process has been running, from ps's elapsed column. */
  readonly runningMs: number;
  readonly args: string;
}

/** Parses ps's elapsed column, `[[dd-]hh:]mm:ss` on Linux and macOS alike. */
export function parsePsElapsed(value: string): number | undefined {
  const trimmed = value.trim();
  if (!/^(\d+-)?\d{1,2}(:\d{2}){1,2}$/u.test(trimmed)) return undefined;
  const days = trimmed.includes('-') ? Number(trimmed.split('-', 2)[0]) : 0;
  const rest = trimmed.includes('-') ? trimmed.split('-', 2)[1]! : trimmed;
  const parts = rest.split(':').map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) return undefined;
  const [hours, minutes, seconds] =
    parts.length === 3
      ? (parts as [number, number, number])
      : [0, parts[0]!, parts[1]!];
  return ((days * 24 + hours) * 3600 + minutes * 60 + seconds) * 1000;
}

function parseProcessTable(
  stdout: string,
): ReadonlyMap<number, ProcessTableRow> {
  const rows = new Map<number, ProcessTableRow>();
  for (const line of stdout.split('\n')) {
    const match = /^(\d+)\s+(\d+)\s+(\S+)(?:\s+(.*))?$/u.exec(line.trim());
    if (!match) continue;
    const pid = Number.parseInt(match[1]!, 10);
    const pgid = Number.parseInt(match[2]!, 10);
    const runningMs = parsePsElapsed(match[3]!);
    if (
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      !Number.isSafeInteger(pgid) ||
      pgid <= 0 ||
      runningMs === undefined
    ) {
      continue;
    }
    rows.set(pid, { pid, pgid, runningMs, args: match[4] ?? '' });
  }
  return rows;
}

/**
 * The live process table, pid-indexed. Empty on Windows, whose sweeps then
 * fall back to liveness-only checks and never guess at identity.
 */
export function queryProcessTable(): ReadonlyMap<number, ProcessTableRow> {
  if (process.platform === 'win32') return new Map();
  const output = execFileSync(
    POSIX_PS,
    ['-A', '-o', 'pid=,pgid=,etime=,args='],
    {
      encoding: 'utf8',
      maxBuffer: PROCESS_QUERY_MAX_BUFFER,
      timeout: PROCESS_QUERY_TIMEOUT_MS,
      env: { ...process.env, LC_ALL: 'C' },
      windowsHide: true,
    },
  );
  return parseProcessTable(output);
}

/**
 * Whether `row` is the worker `record` names: the worker command and a
 * process at least as old as the record. The command carries no incarnation
 * (the boot document arrives on stdin), and only age excludes a recycled
 * id: the true worker was born first, so an impostor answering after its
 * death is always younger, never older.
 */
function isLedgerWorker(
  row: ProcessTableRow,
  record: ManagedRuntimeLedgerWorkerRecord,
  now: number,
): boolean {
  if (!row.args.includes('managed-runtime-worker')) return false;
  return row.runningMs >= now - record.startedAt - RECORD_LEAD_SKEW_MS;
}

/**
 * Whether some member is at least as old as the record: the recorded group
 * was born before the worker wrote it down, so an id whose every member is
 * younger has been recycled after the recorded group's death.
 */
function groupMatchesRecord(
  members: readonly ProcessTableRow[],
  record: ManagedRuntimeLedgerGroupRecord,
  now: number,
): boolean {
  const recordedAge = now - record.startedAt;
  return members.some(
    (member) => member.runningMs >= recordedAge - RECORD_LEAD_SKEW_MS,
  );
}

/** What the live table can prove about the group a record holds. */
type GroupIdentity = 'gone' | 'ours' | 'recycled' | 'unknown';

/**
 * Judges the group `record` holds against a live table. `gone`: no member
 * left. `ours`: the group's leader, or any member old enough to have been
 * there at the record's write, still runs. `recycled`: the leader's pid
 * answers for a group born after the recorded one — pids are assigned at
 * birth, so a young leader can only follow the recorded group's death and
 * proves it where a bare liveness probe cannot. `unknown`: the leader is
 * gone and every survivor is younger than the record — the id may be
 * recycled, or the group may live on in children backgrounded late enough
 * to hold no datable member, the same shape as the accepted setsid
 * residual; it provokes neither a signal nor a silent drop. undefined
 * without a witness (a failed query): liveness stays the only evidence and
 * nothing is resolved.
 */
function judgeGroupIdentity(
  record: ManagedRuntimeLedgerGroupRecord,
  table: ReadonlyMap<number, ProcessTableRow> | undefined,
  now: number,
): GroupIdentity | undefined {
  if (table === undefined) return undefined;
  const members = [...table.values()].filter((row) => row.pgid === record.pgid);
  if (members.length === 0) return 'gone';
  const leader = members.find((member) => member.pid === record.pgid);
  if (
    leader !== undefined &&
    leader.runningMs < now - record.startedAt - RECORD_LEAD_SKEW_MS
  ) {
    return 'recycled';
  }
  if (groupMatchesRecord(members, record, now)) return 'ours';
  return 'unknown';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function readLedgerDocument(
  workFile: string,
): ManagedRuntimeLedgerDocument | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(workFile, 'utf8'));
  } catch {
    return undefined;
  }
  const document = parsed as ManagedRuntimeLedgerDocument | null;
  const worker = document?.worker;
  if (
    document?.version !== LEDGER_FILE_VERSION ||
    !Number.isSafeInteger(worker?.pid) ||
    !Number.isSafeInteger(worker?.pgid) ||
    (worker?.pid ?? 0) <= 1 ||
    (worker?.pgid ?? 0) <= 1 ||
    (worker?.hostPid !== undefined &&
      (!Number.isSafeInteger(worker?.hostPid) || worker.hostPid <= 1)) ||
    typeof worker?.incarnation !== 'string' ||
    !isFiniteNumber(worker?.startedAt) ||
    !Array.isArray(document?.groups)
  ) {
    return undefined;
  }
  const groups: ManagedRuntimeLedgerGroupRecord[] = [];
  for (const group of document.groups as ManagedRuntimeLedgerGroupRecord[]) {
    if (
      !Number.isSafeInteger(group?.pgid) ||
      group.pgid <= 1 ||
      typeof group?.callId !== 'string' ||
      !isFiniteNumber(group?.startedAt)
    ) {
      return undefined;
    }
    groups.push(group);
  }
  return { version: LEDGER_FILE_VERSION, worker: worker!, groups };
}

function writeLedgerDocument(
  workFile: string,
  worker: ManagedRuntimeLedgerWorkerRecord,
  groups: readonly ManagedRuntimeLedgerGroupRecord[],
): void {
  const temporary = `${workFile}.tmp`;
  writeFileSync(
    temporary,
    JSON.stringify({ version: LEDGER_FILE_VERSION, worker, groups }),
    'utf8',
  );
  renameSync(temporary, workFile);
}

/**
 * The groups a session Runtime worker started: which Shell ran in which
 * process group, durable across a crash of the process that holds the truth.
 * Every write is synchronous and atomic, so no settled step of a tool call
 * can outpace the ledger.
 */
export class ManagedRuntimeLedger {
  private readonly groups = new Map<number, ManagedRuntimeLedgerGroupRecord>();
  private watchdog?: NodeJS.Timeout;

  private constructor(
    readonly workFile: string,
    private readonly worker: ManagedRuntimeLedgerWorkerRecord,
  ) {}

  /**
   * Creates the ledger and writes the worker's own record. Throws when the
   * file cannot be written: a worker without a ledger must not run a Shell.
   */
  static create(options: {
    readonly workFile: string;
    readonly worker: ManagedRuntimeLedgerWorkerRecord;
  }): ManagedRuntimeLedger {
    const ledger = new ManagedRuntimeLedger(options.workFile, options.worker);
    mkdirSync(path.dirname(options.workFile), { recursive: true });
    ledger.rewrite();
    return ledger;
  }

  /** Records a Shell's group before its invocation can settle. */
  addGroup(record: ManagedRuntimeLedgerGroupRecord): void {
    this.groups.set(record.pgid, record);
    this.rewrite();
  }

  /** The groups whose exit is not yet proven. */
  outstandingGroups(): readonly ManagedRuntimeLedgerGroupRecord[] {
    return [...this.groups.values()];
  }

  /**
   * Drops every group provably gone. Liveness alone says the id answers,
   * not who answers: a live id whose leader reads younger than the record
   * proves the recorded group gone the same way and must never be settled
   * against or signalled. A group the table cannot date — leader gone, all
   * survivors young — keeps its entry: that shape cannot be told from work
   * this session itself started. Without a process table (Windows, or an
   * unreadable one) liveness stays the only evidence and a live id keeps
   * its entry too.
   */
  prune(): void {
    let changed = false;
    let table: ReadonlyMap<number, ProcessTableRow> | undefined;
    let tableRead = false;
    for (const record of [...this.groups.values()]) {
      if (processGroupLiveness(record.pgid) === 'gone') {
        this.groups.delete(record.pgid);
        changed = true;
        continue;
      }
      if (process.platform === 'win32') continue;
      if (!tableRead) {
        table = queryTableQuietly();
        tableRead = true;
      }
      const identity = judgeGroupIdentity(record, table, Date.now());
      if (identity === 'gone' || identity === 'recycled') {
        this.groups.delete(record.pgid);
        changed = true;
      }
    }
    if (changed) this.rewrite();
  }

  /**
   * Waits for `pgid`'s group to exit; a proof drops it from the ledger. A
   * recycled id the live table names as a younger group proves the recorded
   * group gone too — that is the exit a bare liveness probe would hide
   * behind the impostor's liveness for the whole evidence budget.
   */
  async waitForGroupExit(
    pgid: number,
    timeoutMs: number,
  ): Promise<ProcessLiveness> {
    const record = this.groups.get(pgid);
    const deadline = Date.now() + timeoutMs;
    let state = processGroupLiveness(pgid);
    let identityCheckedAt = 0;
    for (;;) {
      if (state === 'gone') break;
      if (
        record !== undefined &&
        process.platform !== 'win32' &&
        Date.now() - identityCheckedAt >= LEDGER_WATCH_INTERVAL_MS
      ) {
        identityCheckedAt = Date.now();
        const identity = judgeGroupIdentity(
          record,
          queryTableQuietly(),
          Date.now(),
        );
        if (identity === 'gone' || identity === 'recycled') {
          state = 'gone';
          break;
        }
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(POLL_GROUP_EXIT_MS, remaining)),
      );
      state = processGroupLiveness(pgid);
    }
    if (state === 'gone' && this.groups.delete(pgid)) this.rewrite();
    return state;
  }

  /** Starts pruning dead groups in the background; nothing to await. */
  watch(intervalMs: number = LEDGER_WATCH_INTERVAL_MS): void {
    if (this.watchdog) return;
    this.watchdog = setInterval(() => {
      try {
        this.prune();
      } catch (error) {
        debugLogger.warn(
          `Managed Runtime ledger prune failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }, intervalMs);
    this.watchdog.unref();
  }

  /**
   * SIGKILLs every group still recorded and proves each one gone within
   * `budgetMs` for them all. Returns the groups that stay unproven.
   */
  async killOutstanding(
    budgetMs: number = CLOSE_SWEEP_TIMEOUT_MS,
  ): Promise<readonly ManagedRuntimeLedgerGroupRecord[]> {
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = undefined;
    }
    // Dead groups come out of the ledger before any signal goes out, so a
    // recycled id never gets to look like a survivor worth signalling.
    this.prune();
    const deadline = Date.now() + budgetMs;
    const waiting: Array<Promise<ProcessLiveness>> = [];
    for (const pgid of this.groups.keys()) {
      signalProcessGroup(pgid, 'SIGKILL');
      waiting.push(
        this.waitForGroupExit(pgid, Math.max(0, deadline - Date.now())),
      );
    }
    await Promise.all(waiting);
    return this.outstandingGroups();
  }

  /**
   * Deletes the ledger once every group is proven gone; returns false while
   * an unproven truth must stay on disk for the host's sweeps.
   */
  complete(): boolean {
    try {
      this.prune();
    } catch {
      // A prune failure means an unproven group may exist; keep the file.
    }
    if (this.groups.size > 0) return false;
    rmSync(this.workFile, { force: true });
    return true;
  }

  private rewrite(): void {
    writeLedgerDocument(
      this.workFile,
      this.worker,
      [...this.groups.values()].map((group) => ({ ...group })),
    );
  }
}

/** A stop a sweep could not prove; the ledger stays on disk. */
export class LedgerSweepUnprovenError extends Error {
  constructor(
    readonly workFile: string,
    readonly remaining: readonly number[],
    message: string,
  ) {
    super(message);
  }
}

export interface LedgerSweepOptions {
  readonly now?: () => number;
  readonly table?: ReadonlyMap<number, ProcessTableRow>;
  /** Per-file proof budget after signalling. */
  readonly proofTimeoutMs?: number;
  /**
   * Ledger files the caller owns through another lifecycle and the sweep
   * must not touch: the workers this host itself launched, however they
   * ended.
   */
  readonly skip?: ReadonlySet<string>;
  /**
   * Set when the caller witnessed the worker's exit: everything recorded is
   * the dead worker's, so no identity is checked. Otherwise the sweep proves
   * a recorded process is still the ledger's worker before killing it, and
   * resolves recycled group ids without killing anything.
   */
  readonly exitWitnessed?: boolean;
  /** Test seam over the process primitives and the platform shape. */
  readonly sys?: {
    liveness?: (pgid: number) => ProcessLiveness;
    signal?: (
      pgid: number,
      signal: NodeJS.Signals,
    ) => 'sent' | 'gone' | 'failed';
    /** The live table, or explicit undefined where the query itself failed. */
    table?: () => ReadonlyMap<number, ProcessTableRow> | undefined;
    platform?: NodeJS.Platform;
  };
}

/**
 * Sweeps one worker's ledger: kills the worker itself when it outlived its
 * child, kills every recorded group that can still be the worker's, proves
 * each gone, and removes the file only when nothing is left unproven. With
 * any unproven remainder the file is rewritten with the truth that is left
 * and a {@link LedgerSweepUnprovenError} names the surviving ids.
 */
export async function sweepWorkerLedger(
  workFile: string,
  options: LedgerSweepOptions = {},
): Promise<void> {
  const now = options.now ?? Date.now;
  const platform = options.sys?.platform ?? process.platform;
  const liveness = options.sys?.liveness ?? processGroupLiveness;
  const signal = options.sys?.signal ?? signalProcessGroup;
  const proofTimeoutMs = options.proofTimeoutMs ?? SWEEP_PROOF_TIMEOUT_MS;
  const document = readLedgerDocument(workFile);
  if (!document) {
    let exists = true;
    try {
      readFileSync(workFile);
    } catch (error) {
      if (errnoCode(error) === 'ENOENT') exists = false;
    }
    if (!exists) return;
    throw new LedgerSweepUnprovenError(
      workFile,
      [],
      `The Managed Runtime ledger ${workFile} cannot be read; nothing it held can be proven.`,
    );
  }
  const { worker } = document;
  const remaining = new Map<number, ManagedRuntimeLedgerGroupRecord>(
    document.groups.map((group) => [group.pgid, group]),
  );
  const unproven: number[] = [];
  const deadline = now() + proofTimeoutMs;

  const prove = async (pgid: number): Promise<boolean> => {
    // Only ESRCH (or the caller's idea of 'gone') proves an exit; a transient
    // EPERM during teardown must not end the wait, and a permanent one ends
    // it unproven at the deadline.
    for (;;) {
      if (liveness(pgid) === 'gone') return true;
      const budget = deadline - now();
      if (budget <= 0) return false;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(POLL_GROUP_EXIT_MS, budget)),
      );
    }
  };

  const readTable = (): ReadonlyMap<number, ProcessTableRow> | undefined =>
    options.exitWitnessed === true || platform === 'win32'
      ? undefined
      : options.sys?.table !== undefined
        ? options.sys.table()
        : (options.table ?? queryTableQuietly());

  // The worker itself. An orphaned worker that survived its child still runs
  // its Shells, so it must die too; a pid that answers for another process
  // means the worker is gone and its id recycled. Windows offers no identity
  // here, so a live pid neither dies nor resolves without a witness. The
  // stale-mode snapshot is read AFTER the worker's own proof wait, so no
  // identity it grants can be older than a proof budget.
  let table: ReadonlyMap<number, ProcessTableRow> | undefined;
  let workerProven = liveness(worker.pgid) === 'gone';
  if (!workerProven && options.exitWitnessed === true) {
    signal(worker.pgid, 'SIGKILL');
    workerProven = await prove(worker.pgid);
  } else if (!workerProven && platform !== 'win32') {
    table = readTable();
    if (holdsForLiveHost(worker, table, liveness)) {
      // The ledger's own child still runs an ACP host on its recorded pid:
      // the ledger is that child's to sweep, never a sibling sweep's.
      return;
    }
    const row = table?.get(worker.pid);
    if (row && isLedgerWorker(row, worker, now())) {
      signal(worker.pgid, 'SIGKILL');
      workerProven = await prove(worker.pgid);
    } else if (row !== undefined) {
      // The pid answers for a different process: the worker is gone.
      workerProven = true;
    }
  }
  if (options.exitWitnessed !== true && platform !== 'win32') {
    if (table === undefined) table = readTable();
  }
  if (!workerProven) unproven.push(worker.pgid);

  for (const group of document.groups) {
    if (options.exitWitnessed !== true && table === undefined) {
      // The no-witness rule, on every platform: what cannot be named is
      // never signalled. A live id without identity is held unproven.
      if (liveness(group.pgid) === 'gone') remaining.delete(group.pgid);
      else unproven.push(group.pgid);
      continue;
    }
    if (table !== undefined) {
      const identity = judgeGroupIdentity(group, table, now());
      if (identity === 'gone' || identity === 'recycled') {
        // Empty, or the id provably outlived the group: needs no signal and
        // owns no truth.
        remaining.delete(group.pgid);
        continue;
      }
      if (identity === 'unknown') {
        // No leader to date the group by and no member old enough to be the
        // record's: indistinguishable from work backgrounded late by the
        // session itself. Hold the truth, signal nothing.
        if (liveness(group.pgid) === 'gone') remaining.delete(group.pgid);
        else unproven.push(group.pgid);
        continue;
      }
    }
    if (liveness(group.pgid) !== 'gone') signal(group.pgid, 'SIGKILL');
    if (await prove(group.pgid)) remaining.delete(group.pgid);
    else unproven.push(group.pgid);
  }

  if (unproven.length === 0) {
    rmSync(workFile, { force: true });
    return;
  }
  try {
    writeLedgerDocument(workFile, worker, [...remaining.values()]);
  } catch {
    // The previous truth is at least as good as what failed to be written.
  }
  throw new LedgerSweepUnprovenError(
    workFile,
    unproven,
    `The Managed Runtime ledger ${workFile} names ${
      unproven.length
    } process group(s) that could not be proven stopped: ${unproven.join(', ')}.`,
  );
}

function queryTableQuietly(): ReadonlyMap<number, ProcessTableRow> | undefined {
  try {
    return queryProcessTable();
  } catch (error) {
    debugLogger.warn(
      `Managed Runtime ledger sweep could not read the process table: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return undefined;
  }
}

/**
 * Whether the ledger belongs to a Managed child that provably still runs:
 * its `hostPid` answers a liveness probe AND — whenever the live table is
 * available — its argv holds an ACP host's marker AND the process is old
 * enough to have spawned the worker it is recorded as parenting; any weaker
 * reading holds, because the kill error would land on a live sibling's
 * workers (or sweep a recycled id's host), never on debris nobody owns.
 */
function holdsForLiveHost(
  worker: ManagedRuntimeLedgerWorkerRecord,
  table: ReadonlyMap<number, ProcessTableRow> | undefined,
  liveness: (pgid: number) => ProcessLiveness,
): boolean {
  if (worker.hostPid === undefined) return false;
  const hostLive =
    process.platform === 'win32'
      ? pidAlive(worker.hostPid)
      : liveness(worker.hostPid) === 'alive';
  if (!hostLive) return false;
  if (table === undefined) return true;
  const host = table.get(worker.hostPid);
  if (host === undefined) return false;
  if (
    !host.args.includes('--acp') &&
    !host.args.includes('--experimental-acp')
  ) {
    return false;
  }
  // A process younger than the worker it is named as parenting is an
  // impostor: the recorded child's id was recycled by some other ACP host.
  return host.runningMs >= Date.now() - worker.startedAt - RECORD_LEAD_SKEW_MS;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errnoCode(error) === 'EPERM';
  }
}

/**
 * The once-per-child sweep of a project's ledger directory: every file whose
 * worker-outlived-child identity the live table can judge is swept; corrupt
 * files and survivors collect into one rejection. Missing directories mean
 * nothing was ever recorded.
 */
export async function sweepStaleLedgers(
  directory: string,
  options: LedgerSweepOptions = {},
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return;
    throw error;
  }
  const failures: Error[] = [];
  for (const entry of entries) {
    // Only what writeLedgerDocument could have made: regular files. A
    // foreign entry named like a ledger — a directory, a socket, a device
    // behind a symlink — is skipped rather than judged, where judging it
    // would abort (rmSync EISDIR) or hang (device read) every future sweep
    // for every genuine ledger sorted after it.
    if (!entry.isFile()) continue;
    const workFile = path.join(directory, entry.name);
    if (entry.name.endsWith('.tmp')) {
      // Debris from a crash between write and rename outlives any plausible
      // write stall; a live writer's in-flight staging is milliseconds old
      // and must never be taken for it.
      if (
        !options.skip?.has(workFile.slice(0, -'.tmp'.length)) &&
        isOlderThan(workFile, TMP_DEBRIS_AGE_MS)
      ) {
        rmSync(workFile, { force: true });
      }
      continue;
    }
    if (!entry.name.endsWith('.json') || options.skip?.has(workFile)) continue;
    try {
      // Each file gets its identity snapshot itself, after its own worker's
      // proof wait; a shared one would age by everything before it.
      await sweepWorkerLedger(workFile, options);
    } catch (error) {
      failures.push(error as Error);
    }
  }
  if (failures.length > 0) {
    const detail = failures
      .slice(0, 3)
      .map((failure) => {
        const workFile =
          failure instanceof LedgerSweepUnprovenError ? failure.workFile : '';
        const message = failure.message;
        return workFile ? `${workFile}: ${message}` : message;
      })
      .join(' | ');
    throw new AggregateError(
      failures,
      `The Managed Runtime ledgers under ${directory} could not be fully swept: ${detail}`,
    );
  }
}

/** How old trash from a crashed writer gets to be before it is deleted. */
const TMP_DEBRIS_AGE_MS = 60_000;

function isOlderThan(file: string, ageMs: number): boolean {
  try {
    return Date.now() - statSync(file).mtimeMs > ageMs;
  } catch {
    // Unreadable means not fresh debris we can trust to delete either.
    return false;
  }
}

/**
 * Retries a failed sweep until it proves its remainders gone, then calls
 * `onProven` once. Each retry begins only after the previous one settled: a
 * slow proof never piles retries on top of itself. The timer is unref'd: a
 * dying process is not kept alive by the truth another process's startup
 * sweep owns.
 */
export function startLedgerReaper(
  sweep: () => Promise<void>,
  onProven: () => void,
  intervalMs: number = LEDGER_WATCH_INTERVAL_MS,
): { stop(): void } {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const tick = async () => {
    let proven = false;
    try {
      await sweep();
      proven = true;
    } catch {
      // Retry at the next tick.
    }
    if (stopped) return;
    if (proven) {
      stopped = true;
      onProven();
      return;
    }
    timer = setTimeout(() => void tick(), intervalMs);
    timer.unref();
  };
  timer = setTimeout(() => void tick(), intervalMs);
  timer.unref();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

/**
 * Resolves the worker-side ledger of this process from its environment, when
 * its host named one. A worker that cannot keep the ledger its host will
 * sweep must not start answering calls, so this throws on a write failure.
 */
export function managedRuntimeLedgerFromEnvironment(
  incarnation: string,
): ManagedRuntimeLedger | undefined {
  const workFile = process.env[MANAGED_RUNTIME_LEDGER_ENV];
  if (!workFile) return undefined;
  return ManagedRuntimeLedger.create({
    workFile,
    worker: {
      pid: process.pid,
      pgid: process.pid,
      hostPid: process.ppid,
      incarnation,
      startedAt: Date.now(),
    },
  });
}

/** Test hook: the synchronous ps output parser and table builder. */
export const testInternals = {
  parseProcessTable,
  readLedgerDocument,
  writeLedgerDocument,
} as const;
