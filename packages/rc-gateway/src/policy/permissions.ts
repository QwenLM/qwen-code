/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { stat } from 'node:fs/promises';

/** A policy file whose mode grants write to group and/or world. */
export interface InsecurePolicyFile {
  path: string;
  /** The low 12 permission bits (e.g. 0o666). */
  mode: number;
}

/**
 * Group-write (0o020) | world-write (0o002). The spec says "world-writable", but
 * a group-writable policy file is the same non-owner-write exposure (another
 * account in the file's group can rewrite the tool-permission policy), so we warn
 * on the strictly safer superset.
 */
export const NON_OWNER_WRITE_MASK = 0o022;

/** Minimal stat surface this check needs — injected in tests. */
type StatLike = (path: string) => Promise<{ mode: number }>;

/**
 * Boot-time hygiene check: which of `paths` are group/world-writable. Purely
 * advisory — it never changes whether a policy loads (fail-closed parsing is
 * unchanged), it only lets the operator notice a tampering-exposed file.
 *
 * Best-effort and total: a missing file (ENOENT — the normal no-policy case) or
 * ANY stat error is skipped, so a permission CHECK can never itself break boot.
 * The returned mode is masked to the permission bits.
 */
export async function checkPolicyFilePermissions(
  paths: readonly string[],
  statFn: StatLike = stat,
): Promise<InsecurePolicyFile[]> {
  const insecure: InsecurePolicyFile[] = [];
  for (const path of paths) {
    try {
      const { mode } = await statFn(path);
      if ((mode & NON_OWNER_WRITE_MASK) !== 0) {
        insecure.push({ path, mode: mode & 0o7777 });
      }
    } catch {
      // ENOENT (no policy file) or any other stat failure -> no warning.
    }
  }
  return insecure;
}

/** The operator-facing warning for one insecure policy file (octal mode + fix). */
export function formatInsecurePolicyWarning(f: InsecurePolicyFile): string {
  const octal = f.mode.toString(8).padStart(3, '0');
  return (
    `policy: ${f.path} is group/world-writable (mode 0${octal}) - ` +
    `anyone with write access can alter your tool-permission policy; ` +
    `run: chmod go-w ${f.path}`
  );
}
