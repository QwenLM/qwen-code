/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The facts a session record uses to prove which process wrote it.
 *
 * A PID alone proves nothing: PIDs are recycled within a boot, repeat
 * across PID namespaces, and repeat across machines that share one home
 * directory. A record therefore carries three things — the PID, a start
 * token that changes when the PID is recycled, and the PID namespace it
 * was written from — and a reader believes a record only when all three
 * still describe a running process as the reader sees it.
 *
 * Linux exposes all three cheaply. Everywhere else the token and the
 * namespace are `null`, and liveness degrades to "is the PID running".
 */

import * as fs from 'node:fs';

/**
 * True when `pid` belongs to a running process.
 *
 * `EPERM` means the process exists but belongs to another user: that is
 * still alive. A zombie answers the signal too, but it has exited and will
 * never act again, so it counts as dead.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return !isZombie(pid);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return (code === 'EPERM' || code === 'EACCES') && !isZombie(pid);
  }
}

/** Fields after the parenthesized command name of `/proc/<pid>/stat`. */
function statFieldsAfterComm(pid: number): string[] | null {
  let raw: string;
  try {
    raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return null;
  }
  // The command name may itself contain spaces and ')', so anchor on the
  // last one: field 3 (state) is the first token after it.
  const commEnd = raw.lastIndexOf(')');
  if (commEnd === -1) return null;
  return raw
    .slice(commEnd + 1)
    .trim()
    .split(/\s+/);
}

function isZombie(pid: number): boolean {
  if (process.platform !== 'linux') return false;
  return statFieldsAfterComm(pid)?.[0] === 'Z';
}

let cachedBootId: string | undefined;

/**
 * The kernel's per-boot id, or null when it cannot be read.
 *
 * A success is cached, since it cannot change while this process lives. A
 * failure is not: the first read tends to land at a moment of descriptor
 * pressure, and caching that would disable reuse protection for good.
 */
export function readLocalBootId(): string | null {
  if (cachedBootId !== undefined) return cachedBootId;
  if (process.platform !== 'linux') return null;
  try {
    const value = fs
      .readFileSync('/proc/sys/kernel/random/boot_id', 'utf8')
      .trim();
    if (/^[0-9a-f-]+$/i.test(value)) {
      cachedBootId = value;
      return value;
    }
  } catch {
    // Retried on the next call.
  }
  return null;
}

/**
 * `<boot id>:<start ticks>` for `pid` on Linux, or null.
 *
 * Start ticks separate two processes that shared a PID within one boot; the
 * boot id separates boots, and with them machines. Without the boot id this
 * returns null rather than bare ticks, so one machine never writes two
 * token shapes that a reader could mistake for a mismatch.
 */
export function readProcStartToken(pid: number): string | null {
  if (process.platform !== 'linux') return null;
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const bootId = readLocalBootId();
  if (bootId === null) return null;
  // Field 22 (starttime) is the 20th token after the command name.
  const startTime = statFieldsAfterComm(pid)?.[19];
  return startTime !== undefined && /^\d+$/.test(startTime)
    ? `${bootId}:${startTime}`
    : null;
}

/** The inode of this process's PID namespace on Linux, or null. */
export function readPidNamespaceId(): number | null {
  if (process.platform !== 'linux') return null;
  try {
    return fs.statSync('/proc/self/ns/pid').ino;
  } catch {
    return null;
  }
}

/** The boot id inside a start token, or null for a token without one. */
export function bootIdOf(procStart: string): string | null {
  const separator = procStart.indexOf(':');
  return separator === -1 ? null : procStart.slice(0, separator);
}

/**
 * True when `pid` is alive and is the process that recorded `procStart`.
 *
 * A missing token on either side degrades to plain liveness: declaring a
 * live session dead is the worse mistake.
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
