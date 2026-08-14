/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Guarded reads for agent-touched file paths: the audit helpers read files
// the agents name (plans, callers, cited sources), and a read-open on a
// writer-less FIFO blocks indefinitely while /dev/zero or a multi-GB file
// exhausts memory. Probe the opened fd and bound the size BEFORE any
// content read — the same discipline walkAuditTree and recordCaller apply.

import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync, constants } from 'node:fs';

/** Far beyond any honest plan JSON or gate-bounded source file, far below
 *  an OOM. */
export const AUDIT_READ_MAX_BYTES = 10 * 1024 * 1024;

/** sha256 of a regular file, streamed in chunks and bounded at the
 *  size-at-open: memory stays O(chunk), and a concurrent appender that
 *  outpaces the hasher can never drag the loop to a live EOF forever
 *  (the audited agent writes the very files being read). The at-open
 *  prefix hash is byte-identical for stable files and still reports
 *  drift when a file grows. Returns undefined for a path that is missing
 *  or not a regular file (FIFO / device / directory); O_NONBLOCK keeps
 *  even an open() raced onto a FIFO from hanging. */
export function streamSha256(abs: string): string | undefined {
  let fd: number;
  try {
    fd = openSync(abs, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch {
    return undefined;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return undefined;
    const hash = createHash('sha256');
    const buf = Buffer.allocUnsafe(64 * 1024);
    let remaining = st.size;
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

/** Read a regular file, capped. Returns null for a path that is missing,
 *  not a regular file (FIFO / device / directory), or over the cap.
 *  O_NONBLOCK keeps even an open() raced onto a FIFO from hanging. */
export function readGuarded(abs: string, maxBytes: number): Buffer | null {
  let fd: number;
  try {
    fd = openSync(abs, constants.O_RDONLY | constants.O_NONBLOCK);
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
