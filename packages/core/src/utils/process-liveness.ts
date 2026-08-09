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
 * Recorded in place of a namespace id when the platform *has* PID
 * namespaces but this process could not read its own — a `hidepid=2`
 * mount, a seccomp filter, a `/proc` that is not mounted at all.
 *
 * It exists because `null` is already spoken for. `null` means "this
 * platform has no namespaces", which is a positive statement two peers can
 * agree on; an unreadable `/proc/self/ns/pid` is the opposite, a total
 * absence of evidence. Collapsing the two would make two containers that
 * share a machine id and a `QWEN_HOME` but can neither read their own
 * namespace agree that they are one origin, and a matching PID number
 * would then be enough to list, patch, overwrite or sweep the other
 * container's record.
 *
 * Never equal to a real id — those are decimal inodes — so
 * `isSameOrigin`-style comparisons reject it on whichever side it appears.
 */
export const PID_NAMESPACE_UNREADABLE = 'unreadable';

/**
 * An opaque identifier for the PID namespace this process lives in,
 * `null` where the platform does not expose one, or
 * {@link PID_NAMESPACE_UNREADABLE} where it does but the id could not be
 * read.
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
 * both of them. Callers must treat a `null` on both sides as "no namespace
 * boundary to worry about", and both a mismatch and an unreadable id as
 * unprovable.
 */
export function readPidNamespaceId(): string | null {
  if (process.platform !== 'linux') return null;
  try {
    const target = fs.readlinkSync('/proc/self/ns/pid');
    const match = /^pid:\[(\d+)\]$/.exec(target);
    // A target that exists but does not parse is the same evidential
    // state as one that could not be read: Linux, namespaces, no id.
    return match?.[1] ?? PID_NAMESPACE_UNREADABLE;
  } catch {
    return PID_NAMESPACE_UNREADABLE;
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
 * The literal systemd writes into `/etc/machine-id` when the file is
 * provisioned but no id has been committed yet — `machine-id(5)` reserves
 * it for exactly that state, and OSTree-style images (Fedora CoreOS,
 * rpm-ostree) plus any host between `systemd-firstboot` and
 * `machine-id-setup --commit` sit in it.
 *
 * It has to be rejected explicitly rather than left to the empty-string
 * check: the file *exists* and is readable, so nothing else would fall
 * through to the next source. Treating it as an identity would hand every
 * such host the same `machineId`, which is precisely the "one machine"
 * verdict {@link readMachineId} exists to withhold.
 */
const UNINITIALIZED_MACHINE_ID = 'uninitialized';

/**
 * The all-zero id, which `machine-id(5)` reserves as invalid ("This ID may
 * not be all zeros"). It is the same "no machine id" state as the empty
 * file and the {@link UNINITIALIZED_MACHINE_ID} sentinel — the legacy,
 * pre-sentinel convention for template and OSTree-style images — and needs
 * rejecting for the same reason: the file exists and reads cleanly, so
 * nothing else falls through to the next source, and every host in this
 * state would otherwise agree on one `machineId`.
 */
const ALL_ZERO_MACHINE_ID = '0'.repeat(32);

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
 * registration at that PID forever. Reboot-recycled PIDs are bounded by
 * {@link isPidAlive} sweeping dead PIDs and by same-origin re-registration
 * overwriting the stale record; {@link readProcStartToken}'s token is
 * boot-relative, which is what leaves a narrow same-tick collision window
 * across a reboot rather than what closes it.
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
      if (
        id !== '' &&
        id !== UNINITIALIZED_MACHINE_ID &&
        id !== ALL_ZERO_MACHINE_ID
      ) {
        return id;
      }
    } catch {
      // Not this one; try the next source.
    }
  }
  const hostname = os.hostname().trim();
  return hostname === '' ? null : hostname;
}

/**
 * True when this platform can produce start tokens at all, probed against
 * the calling process — the one PID guaranteed to exist and to be ours.
 *
 * This is what turns a missing `procStart` from "written by a platform
 * that has no token" into "written by something that is not this build":
 * where a token is available, every record this code writes carries one,
 * so a same-origin record without one is unprovable rather than merely
 * unproven. Callers use it to withhold trust, never to delete — the
 * writer might be a future version, and a wrong unlink hides a live
 * session permanently (registration is startup-only).
 */
export function supportsProcStartToken(): boolean {
  return readProcStartToken(process.pid) !== null;
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
