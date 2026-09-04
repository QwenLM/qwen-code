/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('PidDescendants');
const execFileAsync = promisify(execFile);

/**
 * Wall-clock budget for each individual snapshot / per-pid query call.
 * Bounded so a hung process-table walk can't stall pool shutdown.
 */
const QUERY_TIMEOUT_MS = 2_000;

/**
 * cap
 * for `execFile`'s internal stdout buffer on the snapshot path. Default
 * is 1MB, which is enough for ~30k-process hosts (~30 bytes/line) but
 * an 8MB cap covers >250k-process pathological cases without forcing
 * the truncation-or-fallback branch on real machines. The cap applies
 * only to the snapshot family of calls; the per-pid `pgrep -P` fallback
 * has a tiny output (just the children of one pid) and uses the default.
 */
const SNAPSHOT_MAXBUFFER_BYTES = 8 * 1024 * 1024;

/**
 * Hard cap on recursion depth + total descendants returned. Defense
 * against runaway process trees (forkbomb-style) or pathological
 * containers with thousands of children — pool shutdown should not
 * spend more than ~10s on pid enumeration regardless.
 */
const MAX_DESCENDANTS = 256;
const MAX_DEPTH = 8;

/**
 * Return all descendant PIDs (children, grandchildren, …) of `rootPid`.
 *
 * Cross-platform implementation per `docs/design/f2-mcp-transport-pool.md`
 * Uses this from `PoolEntry.shutdown()` to SIGTERM
 * wrapped server processes (`npx @modelcontextprotocol/server-X`,
 * `uvx ...`, `pnpm dlx ...`) that would otherwise leak when the
 * pool entry's primary child is killed.
 *
 *
 * the implementation switched from per-pid `pgrep -P <pid>` BFS
 * (Linux/macOS) / per-pid `Get-CimInstance -Filter "ParentProcessId=$p"`
 * BFS (Windows) — which forked one subprocess per node visited — to
 * a single process-table snapshot followed by an in-memory tree walk.
 * Two motivations: (1) ~B^D fork count → 1 fork per call, on the
 * hot pool-shutdown path; (2) snapshot consistency — pre-fix BFS
 * could miss descendants that forked between adjacent BFS levels.
 *
 * Behavior:
 *   - Linux/macOS: `ps -A -o pid=,ppid=` snapshot, in-memory BFS walk
 *     over the parsed `Map<ppid, pid[]>`.
 *   - Windows: PowerShell `Get-CimInstance Win32_Process` →
 *     `ConvertTo-Csv` snapshot of all `(ProcessId, ParentProcessId)`
 *     rows, in-memory walk.
 *   - Either platform: graceful degradation if the snapshot tool is
 *     missing / blocked / times out — falls back to per-pid BFS
 *     (preserves the pre-fix code path so BusyBox `ps` <v1.28 without
 *     `-o` support, distroless containers without `ps`, etc. still
 *     behave at-least-as-well as before). If BOTH the snapshot AND
 *     the fallback fail, returns empty so the caller's SIGTERM step
 *     skips and the OS reaps orphans (Linux init, Windows job objects).
 *
 * Returns descendants in **breadth-first order** — children before
 * grandchildren. Caller typically iterates back-to-front so deepest
 * processes get SIGTERM first.
 */
export async function listDescendantPids(rootPid: number): Promise<number[]> {
  if (!Number.isInteger(rootPid) || rootPid <= 0) return [];
  try {
    if (process.platform === 'win32') {
      return await listDescendantPidsWin(rootPid);
    }
    return await listDescendantPidsUnix(rootPid);
  } catch (err) {
    debugLogger.warn(
      `listDescendantPids(${rootPid}) failed: ${String(
        err instanceof Error ? err.message : err,
      )}. Returning empty — orphans will be OS-reaped.`,
    );
    return [];
  }
}

async function listDescendantPidsUnix(root: number): Promise<number[]> {
  let tree: Map<number, number[]> | undefined;
  try {
    tree = await snapshotProcessTreeUnix();
  } catch (err) {
    debugLogger.warn(
      `Unix snapshot via 'ps -A' failed (${
        err instanceof Error ? err.message : String(err)
      }); falling back to per-pid pgrep BFS`,
    );
  }
  if (tree) {
    return walkDescendants(tree, root);
  }
  return await listDescendantPidsUnixPgrepFallback(root);
}

async function snapshotProcessTreeUnix(): Promise<Map<number, number[]>> {
  // `ps -A -o pid=,ppid=`
  //   -A: all processes (POSIX, equivalent to -e; -A is unambiguous
  //       across BSD/SysV — BSD historically used -e for env display).
  //   -o pid=,ppid=: pid + ppid columns; trailing `=` suppresses each
  //       column header (POSIX standard).
  // Output is "<pid> <ppid>" per line, no header.
  const { stdout } = await execFileAsync('ps', ['-A', '-o', 'pid=,ppid='], {
    timeout: QUERY_TIMEOUT_MS,
    maxBuffer: SNAPSHOT_MAXBUFFER_BYTES,
  });
  const childrenByPpid = new Map<number, number[]>();
  let parsedRows = 0;
  for (const line of stdout.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!m) continue;
    const pid = Number.parseInt(m[1], 10);
    const ppid = Number.parseInt(m[2], 10);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    if (!Number.isFinite(ppid) || ppid < 0) continue;
    parsedRows += 1;
    const arr = childrenByPpid.get(ppid);
    if (arr) arr.push(pid);
    else childrenByPpid.set(ppid, [pid]);
  }
  if (parsedRows === 0) {
    // Snapshot tool ran but produced no parseable lines (e.g. BusyBox
    // `ps` without `-o` support echoing usage). Treat as failure so
    // the caller's catch falls back to per-pid pgrep.
    throw new Error(
      `'ps -A -o pid=,ppid=' returned no parseable rows (stdout length=${stdout.length})`,
    );
  }
  return childrenByPpid;
}

async function listDescendantPidsUnixPgrepFallback(
  root: number,
): Promise<number[]> {
  const all: number[] = [];
  const queue: Array<{ pid: number; depth: number }> = [
    { pid: root, depth: 0 },
  ];
  while (queue.length && all.length < MAX_DESCENDANTS) {
    const { pid, depth } = queue.shift()!;
    if (depth >= MAX_DEPTH) continue;
    let children: number[] = [];
    try {
      const { stdout } = await execFileAsync('pgrep', ['-P', String(pid)], {
        timeout: QUERY_TIMEOUT_MS,
      });
      children = stdout
        .split('\n')
        .map((s) => Number.parseInt(s.trim(), 10))
        .filter((n) => Number.isFinite(n) && n > 0);
    } catch (err) {
      // `pgrep` exits with code 1 when no children — execFile rejects
      // on non-zero exit. Treat that as the common case (no children),
      // not an error.
      if (
        err &&
        typeof err === 'object' &&
        'code' in err &&
        (err as { code: number }).code === 1
      ) {
        continue;
      }
      throw err;
    }
    for (const child of children) {
      if (all.length >= MAX_DESCENDANTS) break;
      all.push(child);
      queue.push({ pid: child, depth: depth + 1 });
    }
  }
  return all;
}

async function listDescendantPidsWin(root: number): Promise<number[]> {
  let tree: Map<number, number[]> | undefined;
  try {
    tree = await snapshotProcessTreeWin();
  } catch (err) {
    debugLogger.warn(
      `Windows snapshot via Get-CimInstance failed (${
        err instanceof Error ? err.message : String(err)
      }); falling back to per-pid filter BFS`,
    );
  }
  if (tree) {
    return walkDescendants(tree, root);
  }
  return await listDescendantPidsWinPerPidFallback(root);
}

async function snapshotProcessTreeWin(): Promise<Map<number, number[]>> {
  // Single-shot CIM query for ALL processes' (ProcessId,
  // ParentProcessId), CSV-formatted for stable parsing.
  // no integer
  // interpolation into the script; this query takes no parameters
  // (we filter in-memory after the snapshot returns).
  //
  // explicit
  // `-Delimiter ","` on `ConvertTo-Csv`. Pre-fix PowerShell 5.1
  // honored the system locale's list separator (semicolon on
  // German / French / Dutch / etc.), so the regex
  // `^"(\d+)","(\d+)"$` below never matched on those locales →
  // snapshot threw → fell back to the slower per-pid CIM path
  // (~0.5-1s extra PowerShell startup latency per descendant on
  // every shutdown). Forcing comma normalizes the output across
  // locales / PS versions.
  const script =
    'Get-CimInstance -ClassName Win32_Process ' +
    '| Select-Object ProcessId,ParentProcessId ' +
    '| ConvertTo-Csv -NoTypeInformation -Delimiter ","';
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { timeout: QUERY_TIMEOUT_MS, maxBuffer: SNAPSHOT_MAXBUFFER_BYTES },
  );
  const childrenByPpid = new Map<number, number[]>();
  let parsedRows = 0;
  // CSV: first line is header `"ProcessId","ParentProcessId"`,
  // subsequent lines are `"<pid>","<ppid>"`.
  const lines = stdout.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const m = lines[i].match(/^"(\d+)","(\d+)"$/);
    if (!m) continue;
    const pid = Number.parseInt(m[1], 10);
    const ppid = Number.parseInt(m[2], 10);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    if (!Number.isFinite(ppid) || ppid < 0) continue;
    parsedRows += 1;
    const arr = childrenByPpid.get(ppid);
    if (arr) arr.push(pid);
    else childrenByPpid.set(ppid, [pid]);
  }
  if (parsedRows === 0) {
    throw new Error(
      `Get-CimInstance snapshot returned no parseable rows (stdout length=${stdout.length})`,
    );
  }
  return childrenByPpid;
}

async function listDescendantPidsWinPerPidFallback(
  root: number,
): Promise<number[]> {
  const all: number[] = [];
  const queue: Array<{ pid: number; depth: number }> = [
    { pid: root, depth: 0 },
  ];
  while (queue.length && all.length < MAX_DESCENDANTS) {
    const { pid, depth } = queue.shift()!;
    if (depth >= MAX_DEPTH) continue;
    let children: number[] = [];
    try {
      // CIM is the modern replacement for `wmic` (deprecated in
      // Win10 21H1+). Single-line script so we can pass via -Command.
      //
      // bind the pid to
      // a PowerShell `$p` variable instead of interpolating the
      // integer directly into the `-Filter` string. The entry-point
      // guard (`Number.isInteger(rootPid) && rootPid > 0`) plus
      // `parseInt` filtering already make injection impossible
      // today, but a future relaxation of either guard would turn an
      // interpolated `${pid}` into a command-injection vector. The
      // `$p` binding is parsed by PowerShell as a numeric variable,
      // so even a contrived non-integer would be rejected by the
      // `-Filter` parser rather than executed as PowerShell.
      const script =
        `$p = ${pid}; ` +
        `Get-CimInstance -ClassName Win32_Process -Filter "ParentProcessId=$p" ` +
        `| Select-Object -ExpandProperty ProcessId`;
      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { timeout: QUERY_TIMEOUT_MS },
      );
      children = stdout
        .split(/\r?\n/)
        .map((s) => Number.parseInt(s.trim(), 10))
        .filter((n) => Number.isFinite(n) && n > 0);
    } catch (err) {
      // PowerShell may be missing (very rare on modern Windows) or
      // blocked by AppLocker. Log + degrade.
      debugLogger.warn(
        `Windows pid descendant query failed for ${pid}: ${String(
          err instanceof Error ? err.message : err,
        )}`,
      );
      continue;
    }
    for (const child of children) {
      if (all.length >= MAX_DESCENDANTS) break;
      all.push(child);
      queue.push({ pid: child, depth: depth + 1 });
    }
  }
  return all;
}

/**
 *
 * shared in-memory BFS over a snapshot tree. Replaces both
 * platforms' per-node subprocess forks once the snapshot has been
 * obtained. Same MAX_DESCENDANTS / MAX_DEPTH caps as the legacy
 * fallback path. Returns BFS order — children before grandchildren.
 *
 * `visited`
 * set prevents BFS revisits when the snapshot captures a PID-reuse
 * cycle (rare but possible on busy hosts with rapid pid churn
 * between snapshot start and parse — Linux pid wraparound can make
 * `ps -A` show a freed pid in a different parent's children list,
 * producing an A→B / B→A cycle). Pre-fix the cycle would fill the
 * MAX_DESCENDANTS=256 quota with duplicate entries and starve
 * legitimate descendants. The per-pid `pgrep` BFS fallback had the
 * same theoretical issue but was less exposed because each
 * `pgrep -P pid` call only returns DIRECT children; the snapshot
 * captures the whole tree at once. `root` is seeded into `visited`
 * so a malformed snapshot listing root as a descendant of one of
 * its own children doesn't re-enqueue root.
 */
function walkDescendants(tree: Map<number, number[]>, root: number): number[] {
  const all: number[] = [];
  const visited = new Set<number>([root]);
  const queue: Array<{ pid: number; depth: number }> = [
    { pid: root, depth: 0 },
  ];
  while (queue.length && all.length < MAX_DESCENDANTS) {
    const { pid, depth } = queue.shift()!;
    if (depth >= MAX_DEPTH) continue;
    const children = tree.get(pid);
    if (!children) continue;
    for (const child of children) {
      if (visited.has(child)) continue;
      visited.add(child);
      if (all.length >= MAX_DESCENDANTS) break;
      all.push(child);
      queue.push({ pid: child, depth: depth + 1 });
    }
  }
  return all;
}

/**
 * Send SIGTERM to a list of pids, tolerating per-pid failures
 * (already exited, permission denied, etc.). On Windows, Node's
 * `process.kill(pid, 'SIGTERM')` polyfills to `TerminateProcess`
 * (similar to `taskkill /F`) — so the same call works cross-platform
 * and we don't shell out to taskkill. Returns the count of pids
 * that were successfully signaled.
 *
 * Pre-fix docstring claimed a Windows-specific
 * `taskkill /F` branch that didn't exist in the implementation.
 *
 * Caller's responsibility to handle the root pid separately (which
 * is typically already being shutdown via `client.disconnect()` →
 * `transport.close()` in `McpClient`).
 */
export function sigtermPids(pids: readonly number[]): number {
  let signaled = 0;
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
      signaled += 1;
    } catch (err) {
      // ESRCH (no such process) is the expected case for already-
      // exited descendants; log everything else at debug.
      if (
        err &&
        typeof err === 'object' &&
        'code' in err &&
        (err as { code: string }).code !== 'ESRCH'
      ) {
        debugLogger.debug(
          `SIGTERM ${pid} failed: ${String(
            err instanceof Error ? err.message : err,
          )}`,
        );
      }
    }
  }
  return signaled;
}
