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
import {
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  constants,
} from 'node:fs';

/** Far beyond any honest plan JSON or gate-bounded source file, far below
 *  an OOM. */
export const AUDIT_READ_MAX_BYTES = 10 * 1024 * 1024;

/** sha256 of a regular file, streamed in chunks with NO size cap: memory
 *  stays O(chunk), so a file's size limits nothing but the time spent —
 *  the 10MB read cap bounds memory on capped reads, not baseline
 *  eligibility here. Returns undefined for a path that is missing or not
 *  a regular file (FIFO / device / directory); O_NONBLOCK keeps even an
 *  open() raced onto a FIFO from hanging. */
export function streamSha256(abs: string): string | undefined {
  let fd: number;
  try {
    fd = openSync(abs, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch {
    return undefined;
  }
  try {
    if (!fstatSync(fd).isFile()) return undefined;
    const hash = createHash('sha256');
    const buf = Buffer.allocUnsafe(64 * 1024);
    let read: number;
    while ((read = readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, read));
    }
    return hash.digest('hex');
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
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
    return readFileSync(fd);
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}
