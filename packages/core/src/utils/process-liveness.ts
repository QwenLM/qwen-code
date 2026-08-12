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
 * `EPERM` (and Windows' `EACCES`) means the process exists but is owned
 * by another user — that is still alive, and reporting it as dead would
 * let one user's session sweep another's record out of a shared registry
 * directory. The zombie exclusion still applies on that path: the kernel
 * permission-checks signal 0 regardless of the target's state, so a
 * cross-user zombie reaches the catch too.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    // A zombie answers kill(pid, 0) — the PID still exists — but the
    // process has already exited and only waits for its parent to reap
    // it. It will never act again, so for registry purposes it is dead;
    // without this, a spawn-but-never-wait parent keeps the record
    // listed for its entire lifetime.
    return !isZombie(pid);
  } catch (err) {
    // `/proc/<pid>/stat` is world-readable by default, so the zombie
    // check works here as well; where it is not readable (hidepid),
    // `isZombie` degrades to false and behavior is unchanged.
    return (
      isNodeError(err) &&
      (err.code === 'EPERM' || err.code === 'EACCES') &&
      !isZombie(pid)
    );
  }
}

/**
 * True when `pid` is a zombie: exited but not yet reaped. Field 3
 * (state) of the same `/proc/<pid>/stat` line the token parser reads
 * carries it; `Z` is the one state that means "no longer running".
 * Unreadable `/proc` degrades to "not a zombie" — the conservative
 * direction, since the sweep only ever acts on a positive answer.
 */
function isZombie(pid: number): boolean {
  if (process.platform !== 'linux') return false;
  let raw: string;
  try {
    raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return false;
  }
  // The state is the first token after the parenthesized `comm`, which
  // may itself contain spaces and ')' — anchor on the LAST ')'.
  const commEnd = raw.lastIndexOf(')');
  if (commEnd === -1) return false;
  return raw
    .slice(commEnd + 1)
    .trimStart()
    .startsWith('Z');
}

/**
 * An opaque token that changes when a PID is recycled, or `null` when the
 * platform does not expose one cheaply.
 *
 * Backed by `boot_id` plus the `starttime` field of `/proc/<pid>/stat`
 * on Linux — the process start time in clock ticks since boot. Two processes
 * sharing a PID within one boot will not share `starttime`; across a
 * reboot they can, and a registry record outlives a reboot whenever the
 * machine crashes or loses power, so the boot id is what makes every
 * pre-reboot token provably foreign.
 *
 * `session-writer-lease.ts`'s `readProcessStartIdentity` builds the same
 * Linux identity, and is deliberately left alone: its token is a
 * persisted on-disk format with takeover semantics, so unifying them is a
 * change to that file's contract rather than a refactor. If a third
 * caller ever needs this, it imports from here — two is already the
 * limit.
 *
 * When the boot id is unreadable this returns `null` rather than a bare
 * tick count: emitting two token shapes on one machine would let a reader
 * that has the boot id "mismatch" a live session recorded without it and
 * sweep its record. A `null` degrades to a plain liveness check instead.
 *
 * Returns `null` on every non-Linux platform rather than shelling out to
 * `ps`: callers must already tolerate a missing token (the registry falls
 * back to a plain liveness check), and a subprocess per record would make
 * enumeration far more expensive than the problem it solves.
 */
export function readProcStartToken(pid: number): string | null {
  if (process.platform !== 'linux') return null;
  if (!Number.isInteger(pid) || pid <= 0) return null;

  const bootId = readLocalBootId();
  if (bootId === null) return null;

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
  return startTime !== undefined && /^\d+$/.test(startTime)
    ? `${bootId}:${startTime}`
    : null;
}

/**
 * The kernel's per-boot UUID, or `null` when it cannot be read. Successes
 * are cached — the value cannot change while this process lives, and
 * enumeration reads a token per record — but failures are not: both
 * first-read moments (startup registration, first concurrent sweep) are
 * fd-pressure moments, and pinning the cache to a transient EMFILE would
 * silently disable PID-reuse protection for the whole process lifetime.
 *
 * Exported for the session registry: two machines sharing one home can
 * collide on PID number and even on PID-namespace inode (the initial
 * namespace inode is a kernel constant), so a record's boot-id prefix
 * is the only identity that proves which machine wrote it.
 */
let cachedBootId: string | undefined;

export function readLocalBootId(): string | null {
  if (cachedBootId !== undefined) return cachedBootId;
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
 * The identity of the PID namespace this process lives in (the inode of
 * `/proc/self/ns/pid`), or `null` where the platform does not expose it.
 *
 * PID numbers and start-time tokens are only meaningful within the
 * namespace that assigned them: two sessions in separate namespaces can
 * share one `~/.qwen` (host + devcontainer with a mounted home, sibling
 * CI containers, NFS homes), and each side's sweep would otherwise judge
 * the other's records by PIDs that resolve to nothing — or worse, to a
 * different process — on its own side. Records carry this identity so a
 * reader can tell its own namespace's records from a foreign one's.
 */
export function readPidNamespaceId(): number | null {
  if (process.platform !== 'linux') return null;
  try {
    return fs.statSync('/proc/self/ns/pid').ino;
  } catch {
    return null;
  }
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
