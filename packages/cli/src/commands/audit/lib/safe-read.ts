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

import {
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  constants,
} from 'node:fs';

/** Far beyond any honest plan JSON or gate-bounded source file, far below
 *  an OOM. */
export const AUDIT_READ_MAX_BYTES = 10 * 1024 * 1024;

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
