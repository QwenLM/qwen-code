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
import * as os from 'node:os';
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
 * An opaque identifier for the PID namespace this process lives in, or
 * `null` where the platform does not expose one.
 *
 * A PID only means something inside one namespace. Anything that writes a
 * PID into a directory another namespace can also read — a container and
 * its host sharing a mounted home dir, say — has to record *which*
 * namespace the number came from, or a namespace-local "no such process"
 * reads as proof of death for a process that is very much alive.
 *
 * Backed by `/proc/self/ns/pid`, a symlink whose target is
 * `pid:[<inode>]`; the inode is stable for the namespace's lifetime and
 * identical for two processes exactly when a PID means the same thing to
 * both of them. Returns `null` off Linux, where the concept does not
 * exist — callers must treat a `null` on both sides as "no namespace
 * boundary to worry about", and a mismatch of any kind as unprovable.
 */
export function readPidNamespaceId(): string | null {
  if (process.platform !== 'linux') return null;
  try {
    const target = fs.readlinkSync('/proc/self/ns/pid');
    const match = /^pid:\[(\d+)\]$/.exec(target);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Candidate sources for a machine identity, most specific first.
 *
 * Both are the standard 32-hex-character host id; the dbus copy is the
 * fallback for distributions that populate it but not `/etc/machine-id`.
 */
const MACHINE_ID_FILES = ['/etc/machine-id', '/var/lib/dbus/machine-id'];

/**
 * An opaque identifier for the machine this process is running on, or
 * `null` when none could be read.
 *
 * A PID namespace id does not identify a machine: the initial namespace's
 * inode is the same constant on every non-containerized Linux box, so two
 * machines sharing one registry directory — an NFS home, a `QWEN_HOME` on
 * a shared volume — agree on it and each reads the other's PIDs as its
 * own. Pair this with {@link readPidNamespaceId}: together they say
 * whether a recorded PID is a number this process can probe at all.
 *
 * Backed by `/etc/machine-id`, which is *stable across reboots* on
 * purpose. `/proc/sys/kernel/random/boot_id` would additionally invalidate
 * every pre-reboot record, but it would also make a record written before
 * the last reboot permanently unattributable — unsweepable, and (for
 * writers that refuse to overwrite another origin's record) able to block
 * registration at that PID forever. Reboot-recycled PIDs are already the
 * job of {@link readProcStartToken}, whose token is boot-relative.
 *
 * Falls back to the hostname where no machine id file is readable, which
 * covers every non-Linux platform. A hostname is weaker — it can change
 * under a running session, leaving that session's own record
 * unattributable to it — but the alternative, `null`, silently restores
 * the cross-machine hole for exactly the platforms with no other
 * discriminator.
 */
export function readMachineId(): string | null {
  for (const file of MACHINE_ID_FILES) {
    try {
      const id = fs.readFileSync(file, 'utf8').trim();
      if (id !== '') return id;
    } catch {
      // Not this one; try the next source.
    }
  }
  const hostname = os.hostname().trim();
  return hostname === '' ? null : hostname;
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
