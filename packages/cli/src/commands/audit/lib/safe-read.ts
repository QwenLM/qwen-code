/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Guarded reads and writes for agent-touched file paths: the audit helpers
// read files the agents name (plans, callers, cited sources) and write
// artifacts beside them, and a read-open on a writer-less FIFO blocks
// indefinitely while /dev/zero or a multi-GB file exhausts memory. Probe the
// opened fd and bound the size BEFORE any content read — the same discipline
// walkAuditTree and recordCaller apply.
//
// Every open here is O_NOFOLLOW: the audited tree and its agents are the
// module's stated adversary, so a path checked by lstat and opened by name
// leaves a swap window the fd-based gate cannot see (the fstat then describes
// the symlink's TARGET). O_NOFOLLOW closes that window in the kernel — the
// open itself fails on a symlink — which is why it belongs on the primitive
// rather than at each call site.

import { createHash } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  openSync,
  readSync,
  writeSync,
  constants,
} from 'node:fs';

/** Far beyond any honest plan JSON or gate-bounded source file, far below
 *  an OOM. */
export const AUDIT_READ_MAX_BYTES = 10 * 1024 * 1024;

/** Read-open flags for every content read: never follow a symlink, never
 *  block on a writer-less FIFO. Windows defines neither flag, so both read
 *  as 0 there and the guards degrade to the fstat gate alone — the same
 *  degradation O_NONBLOCK already had. */
const READ_FLAGS =
  constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW;

/** sha256 of a regular file, streamed in chunks and bounded BOTH at the
 *  size-at-open and at `maxBytes`: memory stays O(chunk), a concurrent
 *  appender that outpaces the hasher can never drag the loop to a live EOF
 *  forever (the audited agent writes the very files being read), and a
 *  pathologically large caller cannot cost minutes of synchronous hashing at
 *  every drift checkpoint. The bounded prefix hash is byte-identical for
 *  files at or under the bound and still reports drift when a file grows,
 *  because the size rides in the digest. Returns undefined for a path that is
 *  missing, a symlink, or not a regular file (FIFO / device / directory);
 *  O_NONBLOCK keeps even an open() raced onto a FIFO from hanging. */
export function streamSha256(
  abs: string,
  maxBytes: number = AUDIT_READ_MAX_BYTES,
): string | undefined {
  let fd: number;
  try {
    fd = openSync(abs, READ_FLAGS);
  } catch {
    return undefined;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return undefined;
    const hash = createHash('sha256');
    // Only a TRUNCATED read mixes the size into the digest, and then it must:
    // two files sharing their first maxBytes but differing past the bound
    // would otherwise hash equal, so growth past the bound would read as "no
    // drift". A file at or under the bound is hashed as its plain content, so
    // the digest stays the file's own sha256 — the property every other tool
    // (and every reader of the sidecar) expects.
    if (st.size > maxBytes) hash.update(`truncated:${st.size}\0`);
    const buf = Buffer.allocUnsafe(64 * 1024);
    let remaining = Math.min(st.size, maxBytes);
    while (remaining > 0) {
      const read = readSync(fd, buf, 0, Math.min(buf.length, remaining), null);
      if (read <= 0) break;
      hash.update(buf.subarray(0, read));
      remaining -= read;
    }
    return hash.digest('hex');
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

/** Read an already-open fd into a buffer sized by `cap`, never past it: a
 *  file that grows between the caller's gate and the read stops at the
 *  buffer's bound instead of reading to EOF. */
export function readFdCapped(fd: number, cap: number): Buffer {
  const buf = Buffer.allocUnsafe(cap);
  let off = 0;
  while (off < cap) {
    const read = readSync(fd, buf, off, cap - off, null);
    if (read <= 0) break;
    off += read;
  }
  return buf.subarray(0, off);
}

/** Read a regular file, capped. Returns null for a path that is missing, a
 *  symlink, not a regular file (FIFO / device / directory), or over the cap.
 *  O_NONBLOCK keeps even an open() raced onto a FIFO from hanging. */
export function readGuarded(abs: string, maxBytes: number): Buffer | null {
  let fd: number;
  try {
    fd = openSync(abs, READ_FLAGS);
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > maxBytes) return null;
    // The cap is a point-in-time fstat check; reading to EOF would let
    // growth between the check and the read exceed maxBytes arbitrarily
    // (the audited agent writes the very files being read). The buffer is
    // sized from the gate, so the read can never pass it.
    return readFdCapped(fd, Math.min(st.size, maxBytes));
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** Write an artifact through an fd that can only ever be a regular file.
 *
 *  Every artifact this command group writes lands next to — or inside — the
 *  audited tree, which the module's own threat statement treats as hostile.
 *  An `lstatSync`-then-`writeFileSync` pair is a check-then-use race: the
 *  path can become a symlink (redirecting the write to a host file the
 *  auditor chose nothing about) or a writer-less FIFO (blocking the write
 *  forever, so the prescribed "re-run the command" remedy hangs too) between
 *  the check and the open. O_NOFOLLOW refuses the symlink in the kernel,
 *  O_NONBLOCK refuses the FIFO, and the post-open fstat refuses every other
 *  non-regular shape before a byte is written. Throws on all three, so a
 *  caller reports the planted path instead of silently landing elsewhere. */
export function writeFileGuarded(
  path: string,
  data: string | Buffer,
  what: string,
): void {
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_TRUNC |
        constants.O_NONBLOCK |
        constants.O_NOFOLLOW,
      0o600,
    );
  } catch (err) {
    throw new Error(
      `audit: cannot write ${what} at ${path} — it is a symlink, a FIFO, or ` +
        `otherwise not openable as a regular file (${
          err instanceof Error ? err.message : String(err)
        }). Remove it and re-run.`,
    );
  }
  try {
    if (!fstatSync(fd).isFile()) {
      throw new Error(
        `audit: cannot write ${what} at ${path} — it is not a regular file. ` +
          `Remove it and re-run.`,
      );
    }
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    let off = 0;
    // One writeSync is not guaranteed to consume the whole buffer.
    while (off < buf.length) {
      off += writeSync(fd, buf, off, buf.length - off);
    }
  } finally {
    closeSync(fd);
  }
}
