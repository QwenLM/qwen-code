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
 * Wall-clock budget for each individual `pgrep` / `Get-CimInstance` call.
 * Bounded so a hung process-table walk can't stall pool shutdown.
 */
const QUERY_TIMEOUT_MS = 2_000;

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
 * §6.4. F2 (#4175) uses this from `PoolEntry.shutdown()` to SIGTERM
 * wrapped server processes (`npx @modelcontextprotocol/server-X`,
 * `uvx ...`, `pnpm dlx ...`) that would otherwise leak when the
 * pool entry's primary child is killed.
 *
 * Behavior:
 *   - Linux/macOS: `pgrep -P <pid>` walked recursively, BFS order
 *   - Windows: PowerShell `Get-CimInstance Win32_Process` filtered
 *     by `ParentProcessId`, walked recursively
 *   - Either platform: graceful degradation if the tool is missing
 *     or the query times out — returns whatever was collected so far
 *     and logs a warning. Pool shutdown still proceeds; orphan
 *     processes will be reaped by the OS eventually (Linux init,
 *     Windows job objects).
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
      const script =
        `Get-CimInstance -ClassName Win32_Process -Filter "ParentProcessId=${pid}" ` +
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
 * Send SIGTERM (or `taskkill /F` on Windows) to a list of pids,
 * tolerating per-pid failures (already exited, permission denied,
 * etc.). Returns the count of pids that were successfully signaled.
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
