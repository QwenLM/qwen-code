/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  execFile,
  spawnSync,
  type ChildProcess,
  type ExecFileOptionsWithStringEncoding,
} from 'node:child_process';
import type { AcpChannelExitInfo } from './channel.js';

const TERM_GRACE_MS = 5_000;
const EXIT_DEADLINE_MS = 10_000;
const PROCESS_QUERY_TIMEOUT_MS = 2_000;
const PROCESS_QUERY_MAX_BUFFER = 8 * 1024 * 1024;
const PROCESS_POLL_MS = 50;
const PROCESS_STATE_POLL_MS = 250;
const MAX_OWNED_PROCESSES = 256;
const MAX_OWNERSHIP_DEPTH = 8;
const POSIX_PS = '/bin/ps';
const WINDOWS_TASKKILL = `${process.env['SystemRoot'] || 'C:\\Windows'}\\System32\\taskkill.exe`;
const STRING_EXEC_OPTIONS: ExecFileOptionsWithStringEncoding = {
  encoding: 'utf8',
  maxBuffer: PROCESS_QUERY_MAX_BUFFER,
  timeout: PROCESS_QUERY_TIMEOUT_MS,
  windowsHide: true,
};

export interface ProcessAttachmentOptions {
  /**
   * The caller owns the complete process tree rooted at this child. POSIX
   * callers must spawn the child as an isolated process-group leader.
   */
  ownsProcessTree?: boolean;
}

export interface TrackedChildProcess {
  readonly exited: Promise<AcpChannelExitInfo | undefined>;
  terminate(): Promise<void>;
  killSync(): void;
}

export interface ProcessReservation {
  attach(
    child: ChildProcess,
    options?: ProcessAttachmentOptions,
  ): TrackedChildProcess;
  cancel(): void;
}

interface ProcessRow {
  pgid: number;
  terminal: boolean;
}

interface ProcessTable {
  childrenByParent: Map<number, number[]>;
  rowsByPid: Map<number, ProcessRow>;
}

interface OwnershipSnapshot {
  groups: Set<number>;
  rootIsGroupLeader: boolean;
  rootSeen: boolean;
  truncated: boolean;
}

export class ProcessRegistry {
  private readonly reservations = new Set<symbol>();
  private readonly children = new Set<TrackedChild>();
  private draining = false;
  private shutdownPromise: Promise<void> | undefined;

  reserve(): ProcessReservation {
    if (this.draining) {
      throw new Error('ACP process registry is draining');
    }
    const token = Symbol('acp-child');
    this.reservations.add(token);
    let settled = false;
    return {
      attach: (child, options) => {
        if (settled || !this.reservations.delete(token)) {
          throw new Error('ACP process reservation is no longer active');
        }
        settled = true;
        const tracked = new TrackedChild(
          child,
          options?.ownsProcessTree === true,
          () => {
            this.children.delete(tracked);
          },
        );
        this.children.add(tracked);
        if (this.draining) void tracked.terminate().catch(() => {});
        return tracked;
      },
      cancel: () => {
        if (settled) return;
        settled = true;
        this.reservations.delete(token);
      },
    };
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.draining = true;
    this.shutdownPromise = Promise.allSettled(
      [...this.children].map((child) => child.terminate()),
    ).then((results) => {
      const failures = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      );
      if (failures.length > 0) {
        throw new AggregateError(failures, 'ACP child process shutdown failed');
      }
    });
    return this.shutdownPromise;
  }

  killAllSync(): void {
    this.draining = true;
    let processTable: ProcessTable | null | undefined;
    if (
      process.platform !== 'win32' &&
      [...this.children].some((child) => child.needsProcessTreeSnapshot)
    ) {
      try {
        processTable = parseProcessTable(queryProcessTableSync());
      } catch {
        processTable = null;
      }
    }
    for (const child of this.children) child.killSync(processTable);
  }

  get activeProcessCount(): number {
    return this.children.size;
  }

  /**
   * Children this registry has committed to: attached ones plus reservations
   * that have not attached yet. Larger than {@link activeProcessCount}, and
   * the right figure for admission — `reserve()` inserts its token
   * synchronously before `spawn()`, so two racing spawns each see the other
   * here, while neither is visible in `activeProcessCount` until its child is
   * attached.
   *
   * A direct child leaves this count when its root exits. A tree-owned child
   * under explicit teardown remains committed until its known tree is gone,
   * so a channel swap includes memory still held by descendants.
   */
  get committedProcessCount(): number {
    return this.children.size + this.reservations.size;
  }
}

class TrackedChild implements TrackedChildProcess {
  readonly exited: Promise<AcpChannelExitInfo | undefined>;
  private readonly knownGroups = new Set<number>();
  private cleanupProofError: Error | undefined;
  private exitInfo: AcpChannelExitInfo | undefined;
  private exitedSettled = false;
  private forceKillRequested = false;
  private released = false;
  private releasePollTimer: NodeJS.Timeout | undefined;
  private releaseStateCheckInFlight = false;
  private spawnConfirmed = false;
  private terminatePromise: Promise<void> | undefined;
  private terminating = false;
  private terminationSettled = false;

  constructor(
    private readonly child: ChildProcess,
    private readonly ownsProcessTree: boolean,
    private readonly onRelease: () => void,
  ) {
    this.rememberRoot();
    this.exited = new Promise((resolve) => {
      const finish = (info?: AcpChannelExitInfo) => {
        if (this.exitedSettled) return;
        this.exitedSettled = true;
        this.exitInfo = info;
        resolve(info);
        this.handleRootExit();
      };
      child.once('exit', (exitCode, signalCode) => {
        finish({ exitCode, signalCode });
      });
      child.once('spawn', () => {
        this.spawnConfirmed = true;
        this.rememberRoot();
      });
      child.once('error', () => {
        if (!this.spawnConfirmed) finish(undefined);
      });
    });
  }

  terminate(): Promise<void> {
    if (this.terminatePromise) return this.terminatePromise;
    this.terminating = true;
    if (this.releasePollTimer) {
      clearTimeout(this.releasePollTimer);
      this.releasePollTimer = undefined;
    }
    const termination = this.ownsProcessTree
      ? this.terminateTree()
      : this.terminateDirectChild();
    this.terminatePromise = termination.finally(() => {
      this.terminationSettled = true;
      if (this.ownsProcessTree && this.exitedSettled && !this.released) {
        this.releaseWhenGroupsExit();
      }
    });
    return this.terminatePromise;
  }

  get needsProcessTreeSnapshot(): boolean {
    return (
      this.ownsProcessTree &&
      !this.forceKillRequested &&
      !this.rootHasExited &&
      !this.released
    );
  }

  killSync(processTable?: ProcessTable | null): void {
    if (!this.ownsProcessTree) {
      this.killDirectChildSync();
      return;
    }
    if (this.released) return;
    const firstForceKill = !this.forceKillRequested;
    this.forceKillRequested = true;
    const rootPid = this.rootPid;
    if (!rootPid) {
      this.killDirectChildSync();
      return;
    }
    if (process.platform === 'win32') {
      if (!firstForceKill) return;
      if (!taskkillSync(rootPid)) this.killDirectChildSync();
      return;
    }
    if (firstForceKill && !this.rootHasExited) {
      if (processTable === undefined) this.mergeSynchronousSnapshot();
      else if (processTable !== null) {
        this.mergeSnapshot(collectOwnership(processTable, rootPid));
      }
    }
    const rootSignalled = this.signalKnownGroups('SIGKILL');
    this.signalDirectRootIfNeeded('SIGKILL', rootSignalled);
    if (this.exitedSettled && this.survivingGroups().length === 0) {
      this.release();
    }
  }

  private get rootPid(): number | undefined {
    const pid = this.child.pid;
    return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0
      ? pid
      : undefined;
  }

  private get rootHasExited(): boolean {
    return (
      this.exitedSettled ||
      this.child.exitCode !== null ||
      this.child.signalCode !== null
    );
  }

  private rememberRoot(): void {
    if (!this.ownsProcessTree) return;
    const rootPid = this.rootPid;
    if (!rootPid) return;
    if (process.platform !== 'win32') this.knownGroups.add(rootPid);
  }

  private handleRootExit(): void {
    if (!this.ownsProcessTree) {
      this.release();
      return;
    }
    if (this.terminating && !this.terminationSettled) return;
    if (process.platform !== 'win32') {
      this.forceKillRequested = true;
      this.signalKnownGroups('SIGKILL');
      this.releaseWhenGroupsExit();
      return;
    }
    this.release();
  }

  private release(): void {
    if (this.released) return;
    this.released = true;
    if (this.releasePollTimer) clearTimeout(this.releasePollTimer);
    this.onRelease();
  }

  private killDirectChildSync(): void {
    if (this.exitedSettled) return;
    try {
      this.child.kill('SIGKILL');
    } catch {
      // A concurrent exit will settle the tracked process.
    }
  }

  private signalDirectRootIfNeeded(
    signal: NodeJS.Signals,
    rootGroupSignalled: boolean,
  ): void {
    const rootPid = this.rootPid;
    if (!rootPid || this.exitedSettled || rootGroupSignalled) return;
    try {
      this.child.kill(signal);
    } catch {
      // The root may have exited after the group liveness check.
    }
  }

  private async terminateDirectChild(): Promise<void> {
    if (this.exitedSettled) return;
    try {
      this.child.kill('SIGTERM');
    } catch {
      if (this.exitedSettled) return;
    }

    let hardKillTimer: NodeJS.Timeout | undefined;
    let deadlineTimer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      hardKillTimer = setTimeout(
        () => this.killDirectChildSync(),
        TERM_GRACE_MS,
      );
      hardKillTimer.unref();
      deadlineTimer = setTimeout(() => {
        reject(
          new Error(
            `ACP child pid=${this.child.pid ?? 'unknown'} did not exit within ${EXIT_DEADLINE_MS}ms`,
          ),
        );
      }, EXIT_DEADLINE_MS);
      deadlineTimer.unref();
    });
    try {
      const exitInfo = await Promise.race([this.exited, deadline]);
      this.throwForUncleanExit(exitInfo);
    } finally {
      if (hardKillTimer) clearTimeout(hardKillTimer);
      if (deadlineTimer) clearTimeout(deadlineTimer);
    }
  }

  private async terminateTree(): Promise<void> {
    if (this.exitedSettled && (process.platform === 'win32' || this.released)) {
      return;
    }
    const rootPid = this.rootPid;
    if (!rootPid) {
      await this.terminateDirectChild();
      return;
    }
    if (process.platform === 'win32') {
      await this.terminateWindowsTree(rootPid);
      return;
    }
    await this.terminatePosixTree(rootPid);
  }

  private async terminatePosixTree(rootPid: number): Promise<void> {
    const startedAt = Date.now();
    if (!this.rootHasExited) {
      await this.mergeAsynchronousSnapshot(rootPid, true);
    }
    let escalated = this.forceKillRequested;
    let rootSignalled = this.signalKnownGroups(
      escalated ? 'SIGKILL' : 'SIGTERM',
    );
    this.signalDirectRootIfNeeded(
      escalated ? 'SIGKILL' : 'SIGTERM',
      rootSignalled,
    );
    const graceDeadline = Math.min(
      startedAt + EXIT_DEADLINE_MS,
      Date.now() + TERM_GRACE_MS,
    );
    const exitDeadline = startedAt + EXIT_DEADLINE_MS;
    let nextStateCheckAt = 0;

    while (true) {
      let survivingGroups = this.survivingGroups();
      let now = Date.now();
      if (
        this.exitedSettled &&
        escalated &&
        survivingGroups.length > 0 &&
        now < exitDeadline &&
        now >= nextStateCheckAt
      ) {
        await this.pruneTerminalGroups(survivingGroups, exitDeadline - now);
        nextStateCheckAt = Date.now() + PROCESS_STATE_POLL_MS;
        survivingGroups = this.survivingGroups();
        now = Date.now();
      }
      if (this.exitedSettled && survivingGroups.length === 0) {
        this.release();
        if (this.cleanupProofError) throw this.cleanupProofError;
        this.throwForUncleanExit(this.exitInfo);
        return;
      }

      if (!escalated && (this.forceKillRequested || now >= graceDeadline)) {
        if (!this.rootHasExited && this.knownGroups.has(rootPid)) {
          await this.mergeAsynchronousSnapshot(rootPid, false);
        }
        escalated = true;
        rootSignalled = this.signalKnownGroups('SIGKILL');
        this.signalDirectRootIfNeeded('SIGKILL', rootSignalled);
        continue;
      }
      if (now >= exitDeadline) {
        const groups = survivingGroups.join(',') || 'none';
        const proof = this.cleanupProofError
          ? `; ${this.cleanupProofError.message}`
          : '';
        throw new Error(
          `ACP child pid=${rootPid} did not exit with its owned process groups ` +
            `within ${EXIT_DEADLINE_MS}ms (surviving pgids=${groups})${proof}`,
        );
      }
      await delay(
        Math.min(
          PROCESS_POLL_MS,
          (escalated ? exitDeadline : graceDeadline) - now,
        ),
      );
      if (this.forceKillRequested) escalated = true;
    }
  }

  private async terminateWindowsTree(rootPid: number): Promise<void> {
    const startedAt = Date.now();
    let treeKillError: Error | undefined;
    try {
      await taskkill(rootPid);
    } catch (error) {
      treeKillError = toError(error);
      this.killDirectChildSync();
    }

    const remainingMs = Math.max(
      1,
      EXIT_DEADLINE_MS - (Date.now() - startedAt),
    );
    const exitInfo = await waitForPromise(this.exited, remainingMs).catch(
      () => {
        throw new Error(
          `ACP child pid=${rootPid} did not exit within ${EXIT_DEADLINE_MS}ms` +
            (treeKillError ? `; ${treeKillError.message}` : ''),
        );
      },
    );
    this.release();
    if (treeKillError) {
      throw new Error(
        `ACP child pid=${rootPid} process-tree cleanup failed: ${treeKillError.message}`,
      );
    }
    this.throwForUncleanExit(exitInfo);
  }

  private async mergeAsynchronousSnapshot(
    rootPid: number,
    initial: boolean,
  ): Promise<void> {
    try {
      const table = parseProcessTable(await queryProcessTable());
      if (this.rootHasExited) {
        if (initial && !this.forceKillRequested) {
          this.recordCleanupProofError(
            `ACP child pid=${rootPid} exited before its initial process-tree snapshot completed`,
          );
        }
        return;
      }
      const snapshot = collectOwnership(table, rootPid);
      this.mergeSnapshot(snapshot);
      if (snapshot.truncated) {
        this.recordCleanupProofError(
          `ACP child pid=${rootPid} process-tree snapshot exceeded ` +
            `${MAX_OWNED_PROCESSES} processes or depth ${MAX_OWNERSHIP_DEPTH}`,
        );
      }
      if (initial && !snapshot.rootSeen) {
        this.recordCleanupProofError(
          `ACP child pid=${rootPid} was absent from the initial process-tree snapshot`,
        );
      } else if (initial && !snapshot.rootIsGroupLeader) {
        this.recordCleanupProofError(
          `ACP child pid=${rootPid} was not an isolated process-group leader`,
        );
      }
    } catch (error) {
      this.recordCleanupProofError(
        `ACP child pid=${rootPid} process-tree snapshot failed: ${toError(error).message}`,
      );
    }
  }

  private mergeSynchronousSnapshot(): void {
    const rootPid = this.rootPid;
    if (!rootPid || process.platform === 'win32' || this.rootHasExited) return;
    try {
      const table = parseProcessTable(queryProcessTableSync());
      this.mergeSnapshot(collectOwnership(table, rootPid));
    } catch {
      // The isolated root group remains a safe synchronous fallback.
    }
  }

  private mergeSnapshot(snapshot: OwnershipSnapshot): void {
    if (!snapshot.rootIsGroupLeader) {
      const rootPid = this.rootPid;
      if (snapshot.rootSeen && rootPid) this.knownGroups.delete(rootPid);
      return;
    }
    for (const group of snapshot.groups) this.knownGroups.add(group);
  }

  private signalKnownGroups(signal: NodeJS.Signals): boolean {
    const rootPid = this.rootPid;
    let rootSignalled = false;
    const groups = [...this.knownGroups].sort((left, right) => {
      if (left === rootPid) return 1;
      if (right === rootPid) return -1;
      return right - left;
    });
    for (const group of groups) {
      try {
        process.kill(-group, signal);
        if (group === rootPid) rootSignalled = true;
      } catch (error) {
        if (isErrno(error, 'ESRCH')) {
          this.knownGroups.delete(group);
          continue;
        }
        this.recordCleanupProofError(
          `ACP child pid=${rootPid ?? 'unknown'} could not send ${signal} ` +
            `to pgid=${group}: ${toError(error).message}`,
        );
      }
    }
    return rootSignalled;
  }

  private survivingGroups(): number[] {
    const surviving: number[] = [];
    for (const group of this.knownGroups) {
      try {
        process.kill(-group, 0);
        surviving.push(group);
      } catch (error) {
        if (isErrno(error, 'ESRCH')) {
          this.knownGroups.delete(group);
          continue;
        }
        surviving.push(group);
        if (!isErrno(error, 'EPERM')) {
          this.recordCleanupProofError(
            `ACP child pid=${this.rootPid ?? 'unknown'} could not inspect ` +
              `pgid=${group}: ${toError(error).message}`,
          );
        }
      }
    }
    return surviving;
  }

  private recordCleanupProofError(message: string): void {
    this.cleanupProofError ??= new Error(message);
  }

  private async pruneTerminalGroups(
    groups: readonly number[],
    timeoutMs = PROCESS_QUERY_TIMEOUT_MS,
  ): Promise<void> {
    try {
      const table = parseProcessTable(await queryProcessTable(timeoutMs));
      const targets = new Set(groups);
      const terminalGroups = new Set<number>();
      const liveGroups = new Set<number>();
      for (const row of table.rowsByPid.values()) {
        if (!targets.has(row.pgid)) continue;
        if (row.terminal) terminalGroups.add(row.pgid);
        else liveGroups.add(row.pgid);
      }
      for (const group of terminalGroups) {
        if (!liveGroups.has(group)) this.knownGroups.delete(group);
      }
    } catch {
      // Keep treating the group as live when process state cannot be verified.
    }
  }

  private releaseWhenGroupsExit(): void {
    if (
      this.released ||
      this.releasePollTimer ||
      this.releaseStateCheckInFlight ||
      (this.terminating && !this.terminationSettled)
    ) {
      return;
    }
    const survivingGroups = this.survivingGroups();
    if (survivingGroups.length === 0) {
      this.release();
      return;
    }
    this.releaseStateCheckInFlight = true;
    void this.pruneTerminalGroups(survivingGroups).finally(() => {
      this.releaseStateCheckInFlight = false;
      if (this.released) return;
      if (this.terminating && !this.terminationSettled) return;
      if (this.survivingGroups().length === 0) {
        this.release();
        return;
      }
      this.releasePollTimer = setTimeout(() => {
        this.releasePollTimer = undefined;
        this.releaseWhenGroupsExit();
      }, PROCESS_STATE_POLL_MS);
      this.releasePollTimer.unref();
    });
  }

  private throwForUncleanExit(exitInfo: AcpChannelExitInfo | undefined): void {
    if (exitInfo && (exitInfo.exitCode !== 0 || exitInfo.signalCode !== null)) {
      throw new Error(
        `ACP child pid=${this.child.pid ?? 'unknown'} exited uncleanly during shutdown ` +
          `(code=${exitInfo.exitCode ?? 'none'}, signal=${exitInfo.signalCode ?? 'none'})`,
      );
    }
  }
}

function parseProcessTable(stdout: string): ProcessTable {
  const rowsByPid = new Map<number, ProcessRow>();
  const childrenByParent = new Map<number, number[]>();
  for (const line of stdout.split('\n')) {
    const match = line
      .trim()
      .match(/^(\d+)\s+(\d+)\s+(\d+)(?:\s+(\S+)(?:\s+(\d+))?)?$/u);
    if (!match) continue;
    const pid = Number.parseInt(match[1], 10);
    const ppid = Number.parseInt(match[2], 10);
    const pgid = Number.parseInt(match[3], 10);
    const state = match[4];
    const threadCount = match[5] ? Number.parseInt(match[5], 10) : undefined;
    if (
      !Number.isSafeInteger(pid) ||
      !Number.isSafeInteger(ppid) ||
      !Number.isSafeInteger(pgid) ||
      pid <= 0 ||
      ppid < 0 ||
      pgid <= 0
    ) {
      continue;
    }
    const terminal =
      state?.startsWith('X') === true ||
      (state?.startsWith('Z') === true &&
        (process.platform !== 'linux' || threadCount === 1));
    rowsByPid.set(pid, { pgid, terminal });
    const children = childrenByParent.get(ppid);
    if (children) children.push(pid);
    else childrenByParent.set(ppid, [pid]);
  }
  if (rowsByPid.size === 0) {
    throw new Error('process-table query returned no parseable rows');
  }
  return { childrenByParent, rowsByPid };
}

function collectOwnership(
  table: ProcessTable,
  rootPid: number,
): OwnershipSnapshot {
  const groups = new Set<number>();
  const visited = new Set<number>();
  const queue = [{ depth: 0, pid: rootPid }];
  let truncated = false;
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current.pid)) continue;
    if (visited.size >= MAX_OWNED_PROCESSES) {
      truncated = true;
      break;
    }
    visited.add(current.pid);
    const row = table.rowsByPid.get(current.pid);
    if (row) groups.add(row.pgid);
    const children = table.childrenByParent.get(current.pid) ?? [];
    if (current.depth >= MAX_OWNERSHIP_DEPTH) {
      if (children.length > 0) truncated = true;
      continue;
    }
    for (const pid of children) {
      queue.push({ depth: current.depth + 1, pid });
    }
  }
  const root = table.rowsByPid.get(rootPid);
  return {
    groups,
    rootIsGroupLeader: root?.pgid === rootPid,
    rootSeen: root !== undefined,
    truncated,
  };
}

function queryProcessTable(
  timeoutMs = PROCESS_QUERY_TIMEOUT_MS,
): Promise<string> {
  return runExecFile(POSIX_PS, posixPsArgs(), {
    ...STRING_EXEC_OPTIONS,
    timeout: Math.max(1, Math.min(PROCESS_QUERY_TIMEOUT_MS, timeoutMs)),
  });
}

function queryProcessTableSync(): string {
  const result = spawnSync(POSIX_PS, posixPsArgs(), STRING_EXEC_OPTIONS);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`ps exited with status ${result.status ?? 'unknown'}`);
  }
  return result.stdout;
}

function posixPsArgs(): string[] {
  const columns =
    process.platform === 'linux'
      ? 'pid=,ppid=,pgid=,state=,nlwp='
      : 'pid=,ppid=,pgid=,state=';
  return ['-A', '-o', columns];
}

function taskkill(rootPid: number): Promise<string> {
  return runExecFile(
    WINDOWS_TASKKILL,
    ['/f', '/t', '/pid', String(rootPid)],
    STRING_EXEC_OPTIONS,
  );
}

function taskkillSync(rootPid: number): boolean {
  try {
    const result = spawnSync(
      WINDOWS_TASKKILL,
      ['/f', '/t', '/pid', String(rootPid)],
      STRING_EXEC_OPTIONS,
    );
    return !result.error && result.status === 0;
  } catch {
    return false;
  }
}

function runExecFile(
  file: string,
  args: string[],
  options: ExecFileOptionsWithStringEncoding,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

function waitForPromise<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('deadline exceeded')), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(1, ms)));
}

function isErrno(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === code
  );
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
