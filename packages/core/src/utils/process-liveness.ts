/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Process liveness helpers shared by anything that records a PID on disk
 * and later has to decide whether that record still describes a running
 * process.
 *
 * A bare PID is not enough on its own: PIDs are recycled, so a record
 * written by a process that has since exited can be "confirmed alive" by
 * an unrelated process that happens to inherit the number. Pair
 * {@link isPidAlive} with {@link readProcStartToken} to close that gap:
 * the token identifies the process behind the PID, not just the number.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { isNodeError } from './errors.js';

/**
 * True when the given PID belongs to a live process.
 *
 * `EPERM` means the process exists but is owned by another user — that is
 * still alive, and reporting it as dead would let one user's session sweep
 * another's record out of a shared registry directory.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return isNodeError(err) && err.code === 'EPERM';
  }
}

async function execFileText(
  file: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        file,
        args,
        {
          encoding: 'utf8',
          timeout: 1_000,
          windowsHide: true,
          ...(env ? { env } : {}),
        },
        (error, stdout) => {
          const value = stdout.trim();
          resolve(error || value.length === 0 ? null : value);
        },
      );
    } catch {
      resolve(null);
    }
  });
}

/**
 * An opaque identity for the process behind `pid`: it changes when the PID
 * is recycled AND when the machine reboots, and is `null` only when the
 * platform cannot produce one.
 *
 * - Linux: boot ID plus the `/proc/<pid>/stat` start ticks. The tick
 *   count alone resets on every boot, so a record that survives a reboot
 *   could otherwise match a later process with the same PID and tick
 *   count.
 * - macOS: the process start time via `ps`.
 * - Windows: the process start time via PowerShell.
 *
 * The formats match the writer lease's `process_start_identity` on
 * purpose — both answer "is this still the same process" and must agree.
 */
export async function readProcessStartIdentity(
  pid: number,
): Promise<string | null> {
  if (process.platform === 'linux') {
    try {
      const [stat, bootId] = await Promise.all([
        fs.readFile(`/proc/${pid}/stat`, 'utf8'),
        fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
      ]);
      // Field 2 (`comm`) is parenthesized and may itself contain spaces
      // and ')' — a process named "my ) proc" is legal. Splitting the
      // whole line on whitespace misaligns every later field, so anchor
      // on the LAST ')' and count from there. After "<pid> (<comm>) " the
      // next token is field 3 (state), so field N lands at index N - 3;
      // `starttime` is field 22.
      const fields = stat
        .slice(stat.lastIndexOf(')') + 1)
        .trim()
        .split(/\s+/);
      const startTicks = fields[19];
      if (
        !startTicks ||
        !/^\d+$/.test(startTicks) ||
        !/^[0-9a-f-]+$/i.test(bootId.trim())
      ) {
        return null;
      }
      return `linux:${bootId.trim()}:${startTicks}`;
    } catch {
      return null;
    }
  }
  if (process.platform === 'darwin') {
    const startedAt = await execFileText(
      '/bin/ps',
      ['-o', 'lstart=', '-p', String(pid)],
      { ...process.env, LC_ALL: 'C', LANG: 'C', TZ: 'UTC' },
    );
    return startedAt ? `darwin:${startedAt}` : null;
  }
  if (process.platform === 'win32') {
    const startedAt = await execFileText('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$targetProcess = Get-Process -Id ${pid} -ErrorAction Stop; $targetProcess.StartTime.ToUniversalTime().Ticks`,
    ]);
    return startedAt && /^\d+$/.test(startedAt) ? `win32:${startedAt}` : null;
  }
  return null;
}

// This process's identity cannot change for the life of the process, and
// the registry asks for it on every enumeration. Caching it keeps a
// machine-wide listing at one platform lookup instead of one per call —
// the difference matters on Windows, where the lookup shells out.
let ownIdentity: { value: string | null } | undefined;

/**
 * The start identity of `pid`, or `null` when it cannot be read.
 *
 * Callers must already tolerate a missing identity: with none, liveness
 * degrades to a plain PID check, which is all the platform can support.
 */
export async function readProcStartToken(pid: number): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (pid === process.pid) {
    if (ownIdentity === undefined) {
      ownIdentity = { value: await readProcessStartIdentity(pid) };
    }
    return ownIdentity.value;
  }
  return readProcessStartIdentity(pid);
}

/**
 * True when `pid` is alive AND is the same process that recorded
 * `procStart`.
 *
 * A `null` recorded token (written where the platform provides none) or a
 * `null` current token (the process died between the two reads, or the
 * platform lookup failed) degrades to a plain liveness check rather than
 * declaring the record stale — deleting a live session's record is the
 * worse failure.
 */
export async function isSameProcess(
  pid: number,
  procStart: string | null | undefined,
): Promise<boolean> {
  if (!isPidAlive(pid)) return false;
  if (procStart == null) return true;
  const current = await readProcStartToken(pid);
  if (current === null) return true;
  return current === procStart;
}
