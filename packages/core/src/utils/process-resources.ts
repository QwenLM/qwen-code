/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';

/**
 * Resident-set sampling for a process tree, used by the daemon's shell-task
 * detail surface.
 *
 * Two deliberate compromises:
 * - RSS overcounts shared pages (dynamic libraries, shared memory are counted
 *   once per process) and undercounts swapped-out pages. It answers "roughly
 *   how much is this task holding", not "what does the system charge it".
 * - The pid is sampled only while the registry still says `running`. A process
 *   that exits between the status read and the sample can have its pid reused
 *   before `ps` runs; the window is small, and a stale number is preferable to
 *   blocking the read path on a start-time probe.
 */

const SAMPLE_TIMEOUT_MS = 2_000;
const SAMPLE_MAX_BUFFER = 4 * 1024 * 1024;
/** `ps` reports RSS in 1024-byte units on both macOS and Linux. */
const PS_RSS_UNIT_BYTES = 1024;
/** `Win32_Process.WorkingSetSize` is already in bytes. */
const WINDOWS_RSS_UNIT_BYTES = 1;

export interface ProcessTableRow {
  pid: number;
  ppid: number;
  /** Resident set size in the unit the platform reports. */
  rss: number;
}

/** Parses `pid ppid rss` triplets, one per line, ignoring anything else. */
export function parseProcessTable(output: string): ProcessTableRow[] {
  const rows: ProcessTableRow[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rss: Number(match[3]),
    });
  }
  return rows;
}

/**
 * Sums RSS over the tree rooted at `rootPid` (the root included).
 * Returns `undefined` when the root is absent, which is the truthful answer
 * for a process that already exited.
 */
export function sumProcessTreeRssBytes(
  rows: readonly ProcessTableRow[],
  rootPid: number,
  rssUnitBytes: number,
): number | undefined {
  if (!Number.isInteger(rootPid) || rootPid <= 0) return undefined;

  const rssByPid = new Map<number, number>();
  const childrenByPid = new Map<number, number[]>();
  for (const row of rows) {
    rssByPid.set(row.pid, row.rss);
    const siblings = childrenByPid.get(row.ppid);
    if (siblings) siblings.push(row.pid);
    else childrenByPid.set(row.ppid, [row.pid]);
  }
  if (!rssByPid.has(rootPid)) return undefined;

  let total = 0;
  const pending = [rootPid];
  const visited = new Set<number>();
  while (pending.length > 0) {
    const pid = pending.pop()!;
    if (visited.has(pid)) continue;
    visited.add(pid);
    total += (rssByPid.get(pid) ?? 0) * rssUnitBytes;
    const children = childrenByPid.get(pid);
    if (children) pending.push(...children);
  }
  return total;
}

function run(file: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      {
        timeout: SAMPLE_TIMEOUT_MS,
        maxBuffer: SAMPLE_MAX_BUFFER,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}

/**
 * Samples resident memory for the process tree rooted at `rootPid`, in bytes.
 * Returns `undefined` when the tree cannot be sampled (root gone, `ps`
 * unavailable, timeout). Never throws.
 */
export async function sampleProcessTreeRssBytes(
  rootPid: number,
): Promise<number | undefined> {
  if (!Number.isInteger(rootPid) || rootPid <= 0) return undefined;
  try {
    if (process.platform === 'win32') {
      const stdout = await run('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_Process | ForEach-Object { "{0} {1} {2}" -f $_.ProcessId, $_.ParentProcessId, $_.WorkingSetSize }',
      ]);
      return sumProcessTreeRssBytes(
        parseProcessTable(stdout),
        rootPid,
        WINDOWS_RSS_UNIT_BYTES,
      );
    }
    const stdout = await run('ps', ['-axo', 'pid=,ppid=,rss=']);
    return sumProcessTreeRssBytes(
      parseProcessTable(stdout),
      rootPid,
      PS_RSS_UNIT_BYTES,
    );
  } catch {
    return undefined;
  }
}
