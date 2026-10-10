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
import os from 'node:os';
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
export const CLOSE_SWEEP_TIMEOUT_MS = 5_000;
/** The worker's prune cadence, and the interval a failed sweep's reaper starts retrying at before backing off to its cap. */
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
/** How old trash from a crashed writer gets to be before it is deleted. */
const TMP_DEBRIS_AGE_MS = 60_000;
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
   * lifecycle sweeps. Recorded even when it is 1 — a container without an
   * init has the ACP host itself as pid 1, and the hold tells that host
   * from init by the live table's argv, never by dropping the record.
   */
  readonly hostPid?: number;
  readonly incarnation: string;
  readonly startedAt: number;
  /**
   * Boot-clock milliseconds (`os.uptime() * 1000`) at `startedAt`, so
   * identity can be judged against ps's boot-derived elapsed column inside
   * one clock domain. Absent on records written before this field existed;
   * those fall back to the wall clock.
   */
  readonly uptimeMs?: number;
}

export interface ManagedRuntimeLedgerGroupRecord {
  /** The Shell's process group, led by this pid on POSIX; its pid on Windows. */
  readonly pgid: number;
  readonly callId: string;
  readonly startedAt: number;
  /** Boot-clock milliseconds at `startedAt`; see the worker record. */
  readonly uptimeMs?: number;
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
  /**
   * Milliseconds the process has been running, from ps's elapsed column.
   * undefined when ps printed an elapsed value this side cannot date (e.g.
   * procps's negative wraparound): the row still COUNTS as a member — a
   * group whose only row is undatable is not gone — but no age judgement
   * may ever be made from it, so the group can only judge 'unknown' (held
   * unproven), never 'gone' and never 'recycled'.
   */
  readonly runningMs: number | undefined;
  readonly args: string;
}

/** Parses ps's elapsed column, `[[dd-]hh:]mm:ss` on Linux and macOS alike. */
export function parsePsElapsed(value: string): number | undefined {
  const trimmed = value.trim();
  // procps's negative-elapsed wraparound prints astronomically large days,
  // whose row would flip every one-sided age comparison; this spelling has
  // four day digits at most, so anything wider is rejected outright.
  if (!/^(\d{1,4}-)?\d{1,2}(:\d{2}){1,2}$/u.test(trimmed)) return undefined;
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
      pgid <= 0
    ) {
      continue;
    }
    // A row whose elapsed column cannot be dated stays in the table:
    // dropping it would read the group's only member as absent — 'gone',
    // resolved silently, ledger deleted with the live group running.
    rows.set(pid, { pid, pgid, runningMs, args: match[4] ?? '' });
  }
  return rows;
}

/**
 * The live process table, pid-indexed. Empty on Windows, whose sweeps then
 * get no identity: a witnessed sweep still signals leaders through
 * taskkill, but an unwitnessed one holds everything — signals nothing —
 * until a witness closes it or an operator proves it.
 */
export function queryProcessTable(): ReadonlyMap<number, ProcessTableRow> {
  if (process.platform === 'win32') return new Map();
  const output = execFileSync(
    POSIX_PS,
    // -ww: procps truncates every row to the terminal width even into a
    // pipe, and the identity markers are matched at the END of the args
    // column — a narrow inherited COLUMNS would cut them off a live row.
    ['-A', '-ww', '-o', 'pid=,pgid=,etime=,args='],
    {
      encoding: 'utf8',
      maxBuffer: PROCESS_QUERY_MAX_BUFFER,
      timeout: PROCESS_QUERY_TIMEOUT_MS,
      env: { ...process.env, LC_ALL: 'C', COLUMNS: '4096' },
      windowsHide: true,
    },
  );
  return parseProcessTable(output);
}

/**
 * Whether the record's age is judged on the boot clock — the domain
 * recordAgeMs then reads it in: Linux's ps `etime` is boot-derived, so a
 * boot-stamped record and a live row share a clock the wall steps never
 * move.
 */
function judgedOnBootClock(
  record: { readonly uptimeMs?: number },
  platform: NodeJS.Platform,
): boolean {
  return record.uptimeMs !== undefined && platform === 'linux';
}

/**
 * The record's age in the judge's clock domain. ps's `etime` is
 * boot-derived on Linux — it does not move with a wall-clock step (chrony
 * `makestep`, a VM snapshot restore, a container clock correction) — while
 * `now() - startedAt` moves with every one, so a one-sided comparison that
 * mixes the domains misreads a group's own live leader as a recycled
 * impostor after a step forward, and anything as a match after a step
 * backward. Both ages therefore come from the uptime domain on Linux;
 * macOS's realtime-derived `etime` (and Windows, which never reaches
 * process-table judgement) compares on the wall clock. Records without
 * `uptimeMs` keep the wall-clock fallback everywhere.
 */
function recordAgeMs(
  record: { readonly startedAt: number; readonly uptimeMs?: number },
  now: number,
  platform: NodeJS.Platform = process.platform,
): number {
  if (record.uptimeMs !== undefined && platform === 'linux') {
    const bootNow = os.uptime() * 1000;
    // A stamp ahead of this boot belongs to a previous one: the ledger
    // outlived a reboot, and the reboot killed everything it named. Aging
    // it by the wall clock instead could go negative after a backward step
    // (chrony `makestep`, a snapshot restore) and read ANY live process as
    // the record's — the identity guard inverted into an ownership
    // assertion — so such a record matches nothing at all.
    if (record.uptimeMs <= bootNow) return bootNow - record.uptimeMs;
    return Number.POSITIVE_INFINITY;
  }
  return now - record.startedAt;
}

/** What the live table can prove about the pid a worker record names. */
type WorkerIdentity = 'ours' | 'recycled' | 'unknown';

/**
 * Whether `row` is the worker `record` names. 'ours': the worker command
 * and a process at least as old as the record — the command carries no
 * incarnation (the boot document arrives on stdin), and only age excludes a
 * recycled id: the true worker was born first, so an impostor answering
 * after its death is always younger, never older. 'recycled': provably not
 * the record's, so the recorded worker is gone. 'unknown': the record
 * cannot be dated against this clock at all — a wall stamp in the future
 * with no boot stamp to judge by — which is no evidence about the pid
 * either way.
 */
function judgeWorkerIdentity(
  row: ProcessTableRow,
  record: ManagedRuntimeLedgerWorkerRecord,
  now: number,
  platform: NodeJS.Platform = process.platform,
): WorkerIdentity {
  if (!row.args.includes('managed-runtime-worker')) return 'recycled';
  // The pid answers but its age cannot be read: nothing here dates the
  // process AS the record's, and nothing proves it a recycler either.
  if (row.runningMs === undefined) return 'unknown';
  // A record from the future — the wall clock stepped back past its stamp —
  // matches nothing: a negative age would be older than every live process.
  // A boot-stamped record on Linux is immune: its domain never stepped.
  if (now < record.startedAt && !judgedOnBootClock(record, platform)) {
    return 'unknown';
  }
  return row.runningMs >=
    recordAgeMs(record, now, platform) - RECORD_LEAD_SKEW_MS
    ? 'ours'
    : 'recycled';
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
  platform: NodeJS.Platform = process.platform,
): boolean {
  // Same refusal as judgeWorkerIdentity, lapsing the same way: only a
  // record judged on the wall clock is poisoned by a stamp in its future.
  if (now < record.startedAt && !judgedOnBootClock(record, platform)) {
    return false;
  }
  const recordedAge = recordAgeMs(record, now, platform);
  // An undatable member matches nothing: never the record's 'ours', and
  // (via the leader branch below) never the proof a young holder gives.
  return members.some(
    (member) =>
      member.runningMs !== undefined &&
      member.runningMs >= recordedAge - RECORD_LEAD_SKEW_MS,
  );
}

/** What the live table can prove about the group a record holds. */
type GroupIdentity = 'gone' | 'ours' | 'recycled' | 'unknown';

/**
 * Judges the group `record` holds against a live table. `gone`: no member
 * left. `ours`: some member old enough to have been there at the record's
 * write still runs — judged first, so a SIGTERM-ignoring survivor keeps
 * the group accountable even where its dead leader's pid has been recycled
 * to a younger leader. `recycled`: with no old-enough member, a live young
 * leader on the id proves it — pids are assigned at birth, so its holder
 * was born after the recorded group died, where a bare liveness probe
 * cannot tell. `unknown`: the leader is gone and every survivor is younger
 * than the record — the id may be recycled, or the group may live on in
 * children backgrounded late enough to hold no datable member, the same
 * shape as the accepted setsid residual; it provokes neither a signal nor
 * a silent drop. undefined without a witness (a failed query): liveness
 * stays the only evidence and nothing is resolved.
 */
function judgeGroupIdentity(
  record: ManagedRuntimeLedgerGroupRecord,
  table: ReadonlyMap<number, ProcessTableRow> | undefined,
  now: number,
  platform: NodeJS.Platform = process.platform,
): GroupIdentity | undefined {
  if (table === undefined) return undefined;
  const members = [...table.values()].filter((row) => row.pgid === record.pgid);
  if (members.length === 0) return 'gone';
  if (groupMatchesRecord(members, record, now, platform)) return 'ours';
  const leader = members.find((member) => member.pid === record.pgid);
  if (
    leader !== undefined &&
    leader.runningMs !== undefined &&
    leader.runningMs < recordAgeMs(record, now, platform) - RECORD_LEAD_SKEW_MS
  ) {
    return 'recycled';
  }
  return 'unknown';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function readLedgerDocument(
  workFile: string,
): ManagedRuntimeLedgerDocument | undefined {
  let raw: string;
  try {
    raw = readFileSync(workFile, 'utf8');
  } catch {
    return undefined;
  }
  return parseLedgerDocument(raw);
}

/** The parsed ledger, or undefined when the bytes are not one. */
function parseLedgerDocument(
  raw: string,
): ManagedRuntimeLedgerDocument | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
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
      (!Number.isSafeInteger(worker?.hostPid) || worker.hostPid < 1)) ||
    typeof worker?.incarnation !== 'string' ||
    !isFiniteNumber(worker?.startedAt) ||
    (worker?.uptimeMs !== undefined &&
      (!isFiniteNumber(worker?.uptimeMs) || worker.uptimeMs < 0)) ||
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
      !isFiniteNumber(group?.startedAt) ||
      (group?.uptimeMs !== undefined &&
        (!isFiniteNumber(group?.uptimeMs) || group.uptimeMs < 0))
    ) {
      return undefined;
    }
    groups.push(group);
  }
  return { version: LEDGER_FILE_VERSION, worker: worker!, groups };
}

let stagingSerial = 0;

function writeLedgerDocument(
  workFile: string,
  worker: ManagedRuntimeLedgerWorkerRecord,
  groups: readonly ManagedRuntimeLedgerGroupRecord[],
): void {
  // A unique staging name per write: the worker's own rewrite, the host
  // sweep's closing rewrite, and a sibling child's startup sweep may all
  // touch the same ledger, and one shared `.tmp` would let a loser's rename
  // ENOENT escape into the caller or splice one writer's tail into another's
  // document once it outgrows one write call.
  const temporary = `${workFile}.tmp.${process.pid}-${stagingSerial++}`;
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

  /**
   * Records a Shell's group before its invocation can settle. The durable
   * write lands first: a failure escapes with both views holding nothing,
   * never a memory-only group a host sweep would read a stale file past and
   * certify stopped beside.
   */
  addGroup(record: ManagedRuntimeLedgerGroupRecord): void {
    const stamped = {
      ...record,
      // The boot-domain stamp of the caller's own startedAt, so both clocks
      // tell one story even when the caller backdates the record.
      uptimeMs:
        record.uptimeMs ??
        Math.max(0, os.uptime() * 1000 - (Date.now() - record.startedAt)),
    };
    // Written as the view memory will hold after it: the new group's record
    // replaces any record the id had, never stacks beside it.
    const updated = [...this.groups.values()].filter(
      (group) => group.pgid !== record.pgid,
    );
    updated.push(stamped);
    writeLedgerDocument(
      this.workFile,
      this.worker,
      updated.map((group) => ({ ...group })),
    );
    this.groups.set(record.pgid, stamped);
  }

  /** The groups whose exit is not yet proven. */
  outstandingGroups(): readonly ManagedRuntimeLedgerGroupRecord[] {
    return [...this.groups.values()];
  }

  /**
   * A rewrite whose target cannot be written must not unmake the judgement
   * it records: the truth on disk — if any — stays for the host's sweeps,
   * and the failure is named in the log instead of escaping as a settled
   * call, a cancelled close, or a crashed watchdog.
   */
  private safeRewrite(): void {
    try {
      this.rewrite();
    } catch (error) {
      debugLogger.warn(
        `Managed Runtime ledger ${this.workFile} could not be rewritten: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Drops every group provably gone. By default liveness is the only
   * evidence — the cheap shape the 1 Hz watchdog needs, since asking the
   * whole process table every second while any group is outstanding would
   * fork a blocking `ps` past the loop that pumps PTY output and answers
   * status polls. With `identity: true` a live id whose leader reads
   * younger than the record proves the recorded group gone the same way
   * and must never be settled against or signalled; a group the table
   * cannot date keeps its entry. Without a process table (Windows, or an
   * unreadable one) liveness stays the only evidence either way.
   */
  prune(identity: boolean = false): void {
    let changed = false;
    let table: ReadonlyMap<number, ProcessTableRow> | undefined;
    let tableRead = false;
    for (const record of [...this.groups.values()]) {
      if (processGroupLiveness(record.pgid) === 'gone') {
        this.groups.delete(record.pgid);
        changed = true;
        continue;
      }
      if (!identity || process.platform === 'win32') continue;
      if (!tableRead) {
        table = queryTableQuietly();
        tableRead = true;
      }
      const judged = judgeGroupIdentity(record, table, Date.now());
      if (judged === 'gone' || judged === 'recycled') {
        this.groups.delete(record.pgid);
        changed = true;
      }
    }
    if (changed) this.safeRewrite();
  }

  /**
   * Waits for `pgid`'s group to exit; a proof drops it from the ledger. A
   * recycled id the live table names as a younger group proves the recorded
   * group gone too — that is the exit a bare liveness probe would hide
   * behind the impostor's liveness for the whole evidence budget. The last
   * parameter is an amortized table reader a caller fans out over several
   * groups with; a direct caller gets its own consult per interval instead.
   */
  async waitForGroupExit(
    pgid: number,
    timeoutMs: number,
    tableReader?: () => ReadonlyMap<number, ProcessTableRow> | undefined,
  ): Promise<ProcessLiveness> {
    const record = this.groups.get(pgid);
    const deadline = performance.now() + timeoutMs;
    let state = processGroupLiveness(pgid);
    let identityCheckedAt = 0;
    const readTable = tableReader ?? queryTableQuietly;
    for (;;) {
      if (state === 'gone') break;
      if (
        record !== undefined &&
        process.platform !== 'win32' &&
        Date.now() - identityCheckedAt >= LEDGER_WATCH_INTERVAL_MS
      ) {
        identityCheckedAt = Date.now();
        const identity = judgeGroupIdentity(record, readTable(), Date.now());
        if (identity === 'gone' || identity === 'recycled') {
          state = 'gone';
          break;
        }
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0) break;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(POLL_GROUP_EXIT_MS, remaining)),
      );
      state = processGroupLiveness(pgid);
    }
    if (
      state === 'gone' &&
      record !== undefined &&
      this.groups.get(pgid) === record
    ) {
      // Only the record this wait judged is dropped: a group re-recorded on
      // the same id meanwhile is a different truth it proved nothing about.
      this.groups.delete(pgid);
      this.safeRewrite();
    }
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
    this.prune(true);
    const deadline = performance.now() + budgetMs;
    // One identity snapshot serves every waiter in this pass: a poll per
    // second per group would otherwise multiply one blocking ps call by the
    // outstanding count, before the budget's first await.
    let sharedTableReference: {
      table: ReadonlyMap<number, ProcessTableRow> | undefined;
      readAt: number;
    } = { table: undefined, readAt: Number.NEGATIVE_INFINITY };
    const sharedTable = () => {
      if (
        Date.now() - sharedTableReference.readAt >=
        LEDGER_WATCH_INTERVAL_MS
      ) {
        sharedTableReference = {
          table: queryTableQuietly(),
          readAt: Date.now(),
        };
      }
      return sharedTableReference.table;
    };
    const waiting: Array<Promise<ProcessLiveness>> = [];
    for (const pgid of this.groups.keys()) {
      signalProcessGroup(pgid, 'SIGKILL');
      waiting.push(
        this.waitForGroupExit(
          pgid,
          Math.max(0, deadline - performance.now()),
          sharedTable,
        ),
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
      this.prune(true);
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

/** How a ledger sweep ended for the truth it swept. */
export type LedgerSweepVerdict =
  /**
   * Every group the ledger named is proven gone. The file's unlink is
   * best-effort: a failed one is logged, and a lingering file is re-proved
   * by the next sweep rather than read as an unproven stop.
   */
  | 'proven'
  /**
   * Nothing was there to judge — no file, or none this sweep may touch:
   * no proof about what an earlier failure named before it vanished.
   */
  | 'absent'
  /** A live sibling child's ledger: its own lifecycle owns the sweep. */
  | 'held';

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

/**
 * A ledger set aside unreadable past the debris age: nothing it named can
 * ever be proven. A rejection, never a verdict — every production caller
 * acts on a rejection, and a resolved value read as a clean stop.
 */
export class LedgerSweepRetiredError extends Error {
  constructor(
    readonly workFile: string,
    message: string,
  ) {
    super(message);
  }
}

export interface LedgerSweepOptions {
  readonly now?: () => number;
  /** Per-file proof budget after signalling. */
  readonly proofTimeoutMs?: number;
  /**
   * Ledger files the caller owns through another lifecycle and the sweep
   * must not touch: the workers this host itself launched, however they
   * ended.
   */
  readonly skip?: ReadonlySet<string>;
  /**
   * Set when the caller witnessed the worker's exit: the witness stands in
   * for identity where no live table can be read, and groups the table
   * cannot date stay signalled. Where a table exists it is still consulted —
   * the witness is fresh only at the exit it names, so a reaper's retry
   * resolves a provably recycled id instead of signalling its new holder.
   * Without a witness the sweep proves a recorded process is still the
   * ledger's worker before killing it and resolves recycled group ids
   * without killing anything.
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
    /** Single-process probe for the hostPid hold; EPERM counts as alive. */
    alive?: (pid: number) => boolean;
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
): Promise<LedgerSweepVerdict> {
  const now = options.now ?? Date.now;
  const platform = options.sys?.platform ?? process.platform;
  const liveness = options.sys?.liveness ?? processGroupLiveness;
  const signal = options.sys?.signal ?? signalProcessGroup;
  const proofTimeoutMs = options.proofTimeoutMs ?? SWEEP_PROOF_TIMEOUT_MS;
  // The reader and the bytes are judged apart: a read-side failure — fd
  // exhaustion, a failing or networked tmpdir, ENOMEM — is transient and
  // says nothing about the ledger, so the file stays in place, unproven,
  // for the next pass. Only bytes that are not a ledger can retire it.
  let raw: string;
  try {
    raw = readFileSync(workFile, 'utf8');
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return 'absent';
    throw new LedgerSweepUnprovenError(
      workFile,
      [],
      `The Managed Runtime ledger ${workFile} cannot be read right now (${
        errnoCode(error) ?? String(error)
      }); the stop it records stays unproven.`,
    );
  }
  const document = parseLedgerDocument(raw);
  if (!document) {
    // A ledger nobody can read is an operator's evidence, not a retryable
    // stop: a reaper would re-read the same immutable bytes forever and
    // the quarantine could never lift. Once it outlives the debris age —
    // a crash window, never a live write — it is set aside where the
    // directory sweep no longer judges it, and the sweep rejects with the
    // retirement: nothing it named can ever be proven.
    if (isOlderThan(workFile, TMP_DEBRIS_AGE_MS)) {
      const aside = `${workFile.slice(0, -'.json'.length)}.unreadable`;
      let moved = false;
      try {
        renameSync(workFile, aside);
        moved = true;
      } catch {
        // Could not move it either: fall through to the unproven report.
      }
      if (moved) {
        debugLogger.warn(
          `The Managed Runtime ledger ${workFile} cannot be read; moved aside to ${aside}.`,
        );
        throw new LedgerSweepRetiredError(
          workFile,
          `The Managed Runtime ledger ${workFile} cannot be read; set aside to ${aside}. Nothing it named can ever be proven.`,
        );
      }
    }
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
  // Every pgid a ledger read has shown this sweep: a record outside the set
  // belongs to a write newer than the snapshot being swept.
  const seen = new Set(document.groups.map((group) => group.pgid));
  const unproven: number[] = [];

  // One proof budget per process, spent at its own start: a slow exit must
  // not eat the budget owed to everything behind it. The deadline lives on
  // the monotonic clock — a wall step in either direction must not stretch
  // or collapse what a proof gets to wait.
  const prove = async (pgid: number): Promise<boolean> => {
    // Only ESRCH (or the caller's idea of 'gone') proves an exit; a transient
    // EPERM during teardown must not end the wait, and a permanent one ends
    // it unproven at the deadline.
    const deadline = performance.now() + proofTimeoutMs;
    for (;;) {
      if (liveness(pgid) === 'gone') return true;
      const budget = deadline - performance.now();
      if (budget <= 0) return false;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(POLL_GROUP_EXIT_MS, budget)),
      );
    }
  };

  const readTable = (): ReadonlyMap<number, ProcessTableRow> | undefined =>
    platform === 'win32'
      ? undefined
      : options.sys?.table !== undefined
        ? options.sys.table()
        : queryTableQuietly();

  // The worker itself. An orphaned worker that survived its child still runs
  // its Shells, so it must die too; a pid that answers for another process
  // means the worker is gone and its id recycled. Windows offers no identity
  // here, so a live pid neither dies nor resolves without a witness.
  let table: ReadonlyMap<number, ProcessTableRow> | undefined;
  let workerProven = liveness(worker.pgid) === 'gone';
  if (!workerProven && platform !== 'win32') table = readTable();
  // Whether a proof wait has aged the snapshot since it was read: only an
  // aged one is re-bought below, never one microseconds old.
  let proofWaited = false;
  if (!workerProven && options.exitWitnessed === true) {
    // The witness is fresh at the exit it names; a retry hours later is not.
    // A table that shows the pid answering for another process proves the
    // worker gone without a signal; without a table the witness stands.
    const row = table?.get(worker.pid);
    if (
      row !== undefined &&
      judgeWorkerIdentity(row, worker, now(), platform) === 'recycled'
    ) {
      workerProven = true;
    } else {
      signal(worker.pgid, 'SIGKILL');
      proofWaited = true;
      workerProven = await prove(worker.pgid);
    }
  } else if (!workerProven && platform !== 'win32') {
    const alive = options.sys?.alive ?? pidAlive;
    if (holdsForLiveHost(worker, table, now(), alive)) {
      // The ledger's own child still runs an ACP host on its recorded pid:
      // the ledger is that child's to sweep, never a sibling sweep's.
      return 'held';
    }
    const row = table?.get(worker.pid);
    const identity =
      row === undefined
        ? undefined
        : judgeWorkerIdentity(row, worker, now(), platform);
    if (identity === 'ours') {
      signal(worker.pgid, 'SIGKILL');
      proofWaited = true;
      workerProven = await prove(worker.pgid);
    } else if (identity === 'recycled') {
      // The pid answers for a different process: the worker is gone.
      workerProven = true;
    }
    // 'unknown' — a record this clock cannot date — is no evidence about
    // the pid at all: nothing is signalled and the stop stays unproven.
  }
  // A proven-dead worker can no longer rewrite the ledger, so the file now
  // holds its final truth: a group it persisted after this sweep's first
  // read — a Shell that settled while the kill was being proven — is still
  // this sweep's to resolve, and a proven verdict must not unlink it away.
  // A final truth that cannot be read keeps the stop unproven, the rule the
  // first read already follows.
  let groups = document.groups;
  if (workerProven) {
    let finalRaw: string | undefined;
    try {
      finalRaw = readFileSync(workFile, 'utf8');
    } catch (error) {
      // Deleted mid-sweep: the file holds nothing more to learn.
      if (errnoCode(error) !== 'ENOENT') {
        throw new LedgerSweepUnprovenError(
          workFile,
          [],
          `The Managed Runtime ledger ${workFile} cannot be read after its worker was proven stopped; the stop it records stays unproven.`,
        );
      }
    }
    if (finalRaw !== undefined) {
      const finalDocument = parseLedgerDocument(finalRaw);
      if (finalDocument === undefined) {
        throw new LedgerSweepUnprovenError(
          workFile,
          [],
          `The Managed Runtime ledger ${workFile} became unreadable during the sweep; the stop it records stays unproven.`,
        );
      }
      // A pgid is not a record's identity: a worker that stayed alive until
      // its kill was proven may have replaced a group's record under the
      // same pgid (a new call, new stamps) while this sweep held the first
      // snapshot. Only the final document dates what the record now names,
      // so its record displaces the snapshot's — the identity judgement
      // below must never read a replacement's young live group against the
      // stamps of the group its pgid used to name, which would read the
      // live group as 'recycled' and delete the ledger with it still
      // running.
      const finalByPgid = new Map(
        finalDocument.groups.map((group) => [group.pgid, group]),
      );
      groups = groups.map((group) => finalByPgid.get(group.pgid) ?? group);
      for (const [pgid, group] of finalByPgid) {
        remaining.set(pgid, group);
        if (!seen.has(pgid)) {
          groups = [...groups, group];
          seen.add(pgid);
        }
      }
    }
  }
  if (
    platform !== 'win32' &&
    groups.length > 0 &&
    (table === undefined || proofWaited)
  ) {
    // The identity a group is judged with is never older than the proof
    // waits it may have outlasted: re-read the snapshot after them. No
    // groups, no table to read. A re-read that fails keeps the snapshot
    // already paid for rather than folding a transient ps error into the
    // no-identity branch.
    table = readTable() ?? table;
  }
  if (!workerProven) unproven.push(worker.pgid);

  const kills: Array<{
    readonly group: ManagedRuntimeLedgerGroupRecord;
    readonly proven: Promise<boolean>;
  }> = [];
  for (const group of groups) {
    if (options.exitWitnessed !== true && table === undefined) {
      // The no-witness rule, on every platform: what cannot be named is
      // never signalled. A live id without identity is held unproven.
      if (liveness(group.pgid) === 'gone') remaining.delete(group.pgid);
      else unproven.push(group.pgid);
      continue;
    }
    if (table !== undefined) {
      const identity = judgeGroupIdentity(group, table, now(), platform);
      if (identity === 'gone' || identity === 'recycled') {
        // Empty, or the id provably outlived the group: needs no signal and
        // owns no truth.
        remaining.delete(group.pgid);
        continue;
      }
      if (identity === 'unknown' && options.exitWitnessed !== true) {
        // No leader to date the group by and no member old enough to be the
        // record's: indistinguishable from work backgrounded late by the
        // session itself. Hold the truth, signal nothing. A witnessed sweep
        // signals it: the witness names the group the dead worker's.
        if (liveness(group.pgid) === 'gone') remaining.delete(group.pgid);
        else unproven.push(group.pgid);
        continue;
      }
    }
    if (liveness(group.pgid) !== 'gone') signal(group.pgid, 'SIGKILL');
    kills.push({ group, proven: prove(group.pgid) });
  }
  // The signalled groups prove concurrently and each spends its own budget:
  // a slow exit no longer consumes the budget owed to everything behind it.
  for (const { group, proven } of kills) {
    if (await proven) remaining.delete(group.pgid);
    else unproven.push(group.pgid);
  }

  if (unproven.length === 0) {
    // The stop is proven; the bookkeeping unlink is not what proves it. A
    // failed one is logged and left for the next sweep's retry rather than
    // escalated into an unprovable stop that quarantines the engine.
    try {
      rmSync(workFile, { force: true });
    } catch (error) {
      debugLogger.warn(
        `Managed Runtime ledger ${workFile} could not be removed after a proven stop: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return 'proven';
  }
  // The ledger of a worker this sweep could not prove stopped is never
  // written: any read the sweep merges from is already stale when the
  // worker's next durable addGroup lands, and the sweep's write would lose
  // that record (the group would then exit unsignalled and unswept). A live
  // worker owns its own file — its writes are the truth and the next sweep
  // re-judges the records this one left. Only a proven-stopped writer's
  // file is rewritten: nobody is left to race.
  if (workerProven) {
    try {
      writeLedgerDocument(workFile, worker, [...remaining.values()]);
    } catch {
      // The previous truth is at least as good as what failed to be written.
    }
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
 * its `hostPid` answers a process liveness probe AND — whenever the live
 * table is available — its argv holds an ACP host's marker AND the process
 * is old enough to have spawned the worker it is recorded as parenting;
 * any weaker reading holds, because the kill error would land on a live
 * sibling's workers (or sweep a recycled id's host), never on debris
 * nobody owns. Two exceptions: a ledger this process itself parented is
 * its own to sweep — the hold stops a sibling's sweep, never the owner's —
 * and a `hostPid` of 1 holds only with the table's argv to tell an ACP
 * host from init, which is always alive and carries no marker.
 */
function holdsForLiveHost(
  worker: ManagedRuntimeLedgerWorkerRecord,
  table: ReadonlyMap<number, ProcessTableRow> | undefined,
  now: number,
  alive: (pid: number) => boolean,
): boolean {
  if (worker.hostPid === undefined || worker.hostPid === process.pid) {
    return false;
  }
  // A process probe on the pid itself: the child may lead no group, and an
  // EPERM answer is another uid's process — both are "not ours to judge",
  // never "dead", since only ESRCH ever proves an exit.
  if (!alive(worker.hostPid)) return false;
  if (table === undefined) return worker.hostPid !== 1;
  const host = table.get(worker.hostPid);
  if (host === undefined) return false;
  if (
    !host.args.includes('--acp') &&
    !host.args.includes('--experimental-acp')
  ) {
    return false;
  }
  // Genesis needs a date: an undatable host row cannot disprove it spawned
  // the worker — hold rather than touch a possible live sibling.
  if (host.runningMs === undefined) return true;
  // A process younger than the worker it is named as parenting is an
  // impostor: the recorded child's id was recycled by some other ACP host.
  return host.runningMs >= recordAgeMs(worker, now) - RECORD_LEAD_SKEW_MS;
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
 * files and survivors collect into one rejection. A missing directory reads
 * 'absent' — nothing was ever recorded, and nothing was judged either.
 * `onFileJudged` hears about every file this pass itself judged clean, so a
 * caller can pin its own proof to the files it means rather than to anything
 * the directory happened to hold.
 */
export async function sweepStaleLedgers(
  directory: string,
  options: LedgerSweepOptions = {},
  onFileJudged?: (workFile: string) => void,
): Promise<LedgerSweepVerdict> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return 'absent';
    throw error;
  }
  const failures: Error[] = [];
  // Only a file this pass itself judged clean lets the verdict read
  // 'proven': a directory that held nothing to judge proves nothing about
  // the groups an earlier failure named before its file vanished.
  let judgedClean = 0;
  for (const entry of entries) {
    // Only what writeLedgerDocument could have made: regular files. A
    // foreign entry named like a ledger — a directory, a socket, a device
    // behind a symlink — is skipped rather than judged, where judging it
    // would abort (rmSync EISDIR) or hang (device read) every future sweep
    // for every genuine ledger sorted after it.
    if (!entry.isFile()) continue;
    const workFile = path.join(directory, entry.name);
    const temporaryName = /\.tmp(?:\..+)?$/.test(entry.name);
    if (temporaryName) {
      // Debris from a crash between write and rename outlives any plausible
      // write stall; a live writer's in-flight staging is milliseconds old
      // and must never be taken for it.
      const ledgerBase = workFile.replace(/\.tmp(?:\..+)?$/, '');
      if (
        !options.skip?.has(ledgerBase) &&
        isOlderThan(workFile, TMP_DEBRIS_AGE_MS)
      ) {
        // Debris that will not delete names no process: a failed unlink is
        // logged, never escalated into an unprovable stop that would
        // quarantine the engine over bookkeeping.
        try {
          rmSync(workFile, { force: true });
        } catch (error) {
          debugLogger.warn(
            `Managed Runtime ledger debris ${workFile} could not be removed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      continue;
    }
    if (!entry.name.endsWith('.json') || options.skip?.has(workFile)) continue;
    try {
      // Each file gets its identity snapshot itself, after its own worker's
      // proof wait; a shared one would age by everything before it.
      if ((await sweepWorkerLedger(workFile, options)) === 'proven') {
        judgedClean += 1;
        onFileJudged?.(workFile);
      }
    } catch (error) {
      failures.push(error as Error);
    }
  }
  if (failures.length > 0) {
    const detail = failures
      .slice(0, 3)
      .map((failure) => {
        const workFile =
          failure instanceof LedgerSweepUnprovenError ||
          failure instanceof LedgerSweepRetiredError
            ? failure.workFile
            : '';
        const message = failure.message;
        return workFile ? `${workFile}: ${message}` : message;
      })
      .join(' | ');
    throw new AggregateError(
      failures,
      `The Managed Runtime ledgers under ${directory} could not be fully swept: ${detail}`,
    );
  }
  return judgedClean > 0 ? 'proven' : 'absent';
}

function isOlderThan(file: string, ageMs: number): boolean {
  try {
    return Date.now() - statSync(file).mtimeMs > ageMs;
  } catch {
    // Unreadable means not fresh debris we can trust to delete either.
    return false;
  }
}

/** What one reaper sweep proved about its target. */
export type LedgerReaperVerdict =
  /** The remainders are gone: `onProven` fires and the reaper stops. */
  | 'proven'
  /** Still outstanding (a rejection reads the same): retry on the backoff. */
  | 'unproven'
  /**
   * Never provable — a ledger nobody could read was set aside, so nothing
   * it named can be proven: the reaper stops WITHOUT `onProven`, and the
   * quarantine it armed stands until the child restarts.
   */
  | 'terminal';

/**
 * Retries a failed sweep until it proves its remainders gone, then calls
 * `onProven` once. Each retry begins only after the previous one settled: a
 * slow proof never piles retries on top of itself, and a remainder that
 * keeps answering the same way backs off to a bounded cadence — retries
 * that cannot change anything must not cost a `ps` and a signal every
 * second for the lifetime of a quarantine. A sweep that resolves without
 * proving its remainders — a ledger file gone or set aside — is no proof:
 * only the sweep's own verdict lifts. The timer is unref'd: a dying
 * process is not kept alive by the truth another process's startup sweep
 * owns.
 */
export function startLedgerReaper(
  sweep: () => Promise<LedgerReaperVerdict>,
  onProven: () => void,
  intervalMs: number = LEDGER_WATCH_INTERVAL_MS,
  maxIntervalMs: number = 30_000,
): { stop(): void } {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let interval = intervalMs;
  const tick = async () => {
    let verdict: LedgerReaperVerdict;
    try {
      verdict = await sweep();
    } catch {
      verdict = 'unproven';
    }
    if (stopped) return;
    if (verdict === 'proven') {
      stopped = true;
      onProven();
      return;
    }
    if (verdict === 'terminal') {
      stopped = true;
      return;
    }
    // Retry at the next tick, doubling the wait up to the cap: a resolved
    // 'unproven' backs off exactly like a thrown one.
    interval = Math.min(interval * 2, maxIntervalMs);
    timer = setTimeout(() => void tick(), interval);
    timer.unref();
  };
  timer = setTimeout(() => void tick(), interval);
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
  // The path is for the worker alone: no Shell command it spawns gets to
  // read the name of the file that accounts for it.
  delete process.env[MANAGED_RUNTIME_LEDGER_ENV];
  return ManagedRuntimeLedger.create({
    workFile,
    worker: {
      pid: process.pid,
      pgid: process.pid,
      // The host's pid as-is, 1 included: a container without an init has
      // the ACP host itself as pid 1, and the sweep's hold tells that host
      // from init by the live table's argv — a dropped record could not.
      hostPid: process.ppid,
      incarnation,
      startedAt: Date.now(),
      uptimeMs: os.uptime() * 1000,
    },
  });
}

/** Test hook: the synchronous ps output parser and table builder. */
export const testInternals = {
  parseProcessTable,
  readLedgerDocument,
  writeLedgerDocument,
} as const;
