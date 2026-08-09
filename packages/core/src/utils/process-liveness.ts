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
 * {@link isPidAlive} with {@link readProcStartToken} to close that gap
 * wherever the platform provides a start-time token.
 */

import * as fs from 'node:fs';
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

/**
 * An opaque token that changes when a PID is recycled, or `null` when the
 * platform does not expose one cheaply.
 *
 * Backed by the `starttime` field of `/proc/<pid>/stat` on Linux — the
 * process start time in clock ticks since boot. Two processes sharing a
 * PID across a recycle will not share this value.
 *
 * Returns `null` on every non-Linux platform rather than shelling out to
 * `ps`: callers must already tolerate a missing token (the registry falls
 * back to a plain liveness check), and a subprocess per record would make
 * enumeration far more expensive than the problem it solves.
 */
export function readProcStartToken(pid: number): string | null {
  if (process.platform !== 'linux') return null;
  if (!Number.isInteger(pid) || pid <= 0) return null;

  let raw: string;
  try {
    raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return null;
  }

  // Field 2 (`comm`) is parenthesized and may itself contain spaces and
  // ')' — a process named "my ) proc" is legal. Splitting the whole line
  // on whitespace therefore misaligns every later field, so anchor on the
  // LAST ')' and count from there.
  const commEnd = raw.lastIndexOf(')');
  if (commEnd === -1) return null;

  // After "<pid> (<comm>) " the next token is field 3 (state), so field N
  // lands at index N - 3. `starttime` is field 22.
  const fields = raw
    .slice(commEnd + 1)
    .trim()
    .split(/\s+/);
  const startTime = fields[19];
  return startTime !== undefined && /^\d+$/.test(startTime) ? startTime : null;
}

/**
 * True when `pid` is alive AND is the same process that recorded
 * `procStart`.
 *
 * A `null` recorded token is trusted only where the platform genuinely
 * has none. Reading it as "written somewhere without tokens" everywhere
 * would hand any record that simply omits the field a free pass, which
 * makes the token defence opt-out for exactly the party it defends
 * against; on a platform that does produce tokens, a token-less record
 * is provably not one this code wrote, because the writer reads its own
 * `/proc/<pid>/stat` and that read cannot fail for a live self.
 *
 * A `null` *current* token still degrades to a plain liveness check: the
 * process may have died between the two reads, or `/proc` may have gone
 * unreadable, and deleting a live session's record is the worse failure.
 */
export function isSameProcess(
  pid: number,
  procStart: string | null | undefined,
): boolean {
  if (!isPidAlive(pid)) return false;
  if (procStart == null) return readProcStartToken(pid) === null;
  const current = readProcStartToken(pid);
  if (current === null) return true;
  return current === procStart;
}
