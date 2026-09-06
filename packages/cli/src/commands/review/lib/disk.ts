/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { statfsSync } from 'node:fs';

/**
 * Free-disk floors for the toolchain preflights, in bytes.
 *
 * Dogfooded on a live review: with ~2.7G free, `npm ci` on this monorepo ran 33
 * seconds, died on `ENOSPC`, and the now-full disk went on to fail every agent
 * scheduled after this command — a disk a command fills is not a failure that
 * stays contained to that command. The installed `node_modules` here is ~1.4G,
 * and npm stages cache and temp writes on the same filesystem while it
 * materialises the tree, so 3 GiB is the least an install can be trusted with.
 * The build phase writes far less (`dist/` and tsbuildinfo) and gets a lower
 * floor — enough that a compile cannot be the thing that fills the disk.
 * Like the deadline, a floor violation is skip-and-disclose, never a finding:
 * an environment that cannot fit the command is not a defect in the diff.
 */
export const INSTALL_MIN_FREE_BYTES = 3 * 1024 ** 3;
export const BUILD_MIN_FREE_BYTES = 1024 ** 3;

/**
 * Free bytes on the filesystem holding `dir`, or `null` where that cannot be
 * measured (`statfsSync` is not available on every platform). An unmeasurable
 * disk lets the run proceed: the preflight exists to prevent failures, not to
 * invent them.
 */
export function freeDiskBytes(dir: string): number | null {
  try {
    const s = statfsSync(dir);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

export const gib = (bytes: number): string => (bytes / 1024 ** 3).toFixed(1);
