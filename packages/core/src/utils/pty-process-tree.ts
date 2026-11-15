/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';

/** The processes a POSIX pty owns, as listed by {@link collectPtyProcessTree}. */
export interface PtyProcessTree {
  /** The root first (unless it was reaped), then in discovery order. */
  pids: number[];
  /** The root's session id (Linux) or controlling tty (macOS), if known. */
  scope: string | undefined;
  /** `ps` start time per listed pid: tells a later scan's same process from a recycled pid. */
  started: Map<number, string>;
}

interface ProcessRow {
  pid: number;
  parentPid: number;
  scope: string | undefined;
  started: string;
}

const SCOPE_COLUMN =
  process.platform === 'linux'
    ? 'sid'
    : process.platform === 'darwin'
      ? 'tdev'
      : undefined;

function listProcesses(): ProcessRow[] {
  const scoped = SCOPE_COLUMN ? [`${SCOPE_COLUMN}=`] : [];
  // A ps without lstart (busybox) still yields the tree, only without the
  // start times a later scan needs to carry members over.
  for (const columns of [
    ['pid=', 'ppid=', ...scoped, 'lstart='],
    ['pid=', 'ppid=', ...scoped],
  ]) {
    const result = spawnSync('ps', ['-A', '-o', columns.join(',')], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
      maxBuffer: 8 * 1024 * 1024,
      timeout: 2_000,
    });
    // A timed-out scan keeps what it printed; a refused column prints nothing.
    if (!result.stdout?.trim()) continue;
    return result.stdout.split('\n').flatMap((line) => {
      const fields = line.trim().split(/\s+/);
      const pid = Number(fields[0]);
      const parentPid = Number(fields[1]);
      if (!Number.isInteger(pid) || !Number.isInteger(parentPid)) return [];
      const scope = SCOPE_COLUMN ? fields[2] : undefined;
      const started = fields.slice(SCOPE_COLUMN ? 3 : 2).join(' ');
      return [{ pid, parentPid, scope, started }];
    });
  }
  return [];
}

/**
 * Lists the processes a POSIX pty owns: the root, its descendants by parent
 * pid, and every other process in the root's session (Linux `sid`) or on its
 * controlling terminal (macOS `tdev`). Signalling the root's process group is
 * not enough: an interactive shell runs each foreground job in its own group,
 * and a job that outlives its shell is reparented away from the root.
 *
 * Pass the result of an earlier scan as `previous` to list the tree again
 * later. Its members are kept while they are still the same process (same
 * start time). Once the root has been reaped (`rootReaped`), it is no longer
 * listed, and its scope is reused only where it still names the same
 * session: a Linux session id outlives its leader unless that pid now leads
 * a new process, while macOS drops the controlling tty with the session
 * leader and may hand the device to another session.
 *
 * Returns only the root when `ps` cannot run.
 */
export function collectPtyProcessTree(
  rootPid: number,
  previous?: PtyProcessTree,
  rootReaped = false,
): PtyProcessTree {
  const rows = listProcesses();
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  let scope = rootReaped
    ? SCOPE_COLUMN === 'sid' && !byPid.has(rootPid)
      ? previous?.scope
      : undefined
    : (byPid.get(rootPid)?.scope ?? previous?.scope);
  if (scope === '0' || scope === '??') scope = undefined;

  const targets = new Set<number>();
  if (!rootReaped) targets.add(rootPid);
  for (const pid of previous?.pids ?? []) {
    const started = previous?.started.get(pid);
    if (pid !== rootPid && started && byPid.get(pid)?.started === started) {
      targets.add(pid);
    }
  }
  let found = true;
  while (found) {
    found = false;
    for (const { pid, parentPid, scope: rowScope } of rows) {
      if (
        pid > 1 &&
        !targets.has(pid) &&
        (targets.has(parentPid) || (scope !== undefined && rowScope === scope))
      ) {
        targets.add(pid);
        found = true;
      }
    }
  }
  const started = new Map<number, string>();
  for (const pid of targets) {
    const row = byPid.get(pid);
    if (row?.started) started.set(pid, row.started);
  }
  return { pids: [...targets], scope, started };
}
