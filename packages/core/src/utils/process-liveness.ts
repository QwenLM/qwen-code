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
 * Only `ESRCH` — "no such process" — proves death. Everything else the
 * probe can report is a permission failure against a process that exists:
 * `EPERM` for another user's process on POSIX, and `EACCES` on Windows,
 * where `uv_kill(pid, 0)` fails that way when Mandatory Integrity Control
 * denies `OpenProcess` — an elevated session probed from a non-elevated
 * one of the same user. Reporting either as dead would let one session
 * sweep a live one's record out of a shared registry directory, and
 * registration is startup-only, so the swept session stays invisible to
 * discovery for the rest of its life.
 *
 * Deciding by the one errno that means death rather than by an allowlist
 * of the ones that mean life keeps an unanticipated errno on the safe
 * side of that trade, and matches the three sibling liveness probes in
 * `session-writer-lease.ts`, `serve/live/discovery.ts` and
 * `worktreeSessionService.ts`.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return isNodeError(err) && err.code !== 'ESRCH';
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
 * A `null` recorded token (written on a platform without one) or a `null`
 * current token (the process died between the two reads, or `/proc` is not
 * readable) degrades to a plain liveness check rather than declaring the
 * record stale — deleting a live session's record is the worse failure.
 */
export function isSameProcess(
  pid: number,
  procStart: string | null | undefined,
): boolean {
  if (!isPidAlive(pid)) return false;
  if (procStart == null) return true;
  const current = readProcStartToken(pid);
  if (current === null) return true;
  return current === procStart;
}
