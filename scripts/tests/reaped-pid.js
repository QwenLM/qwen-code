/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';

/**
 * Returns the PID of a throwaway child that has already exited and been waited
 * for, so it is neither alive nor an unreaped zombie.
 *
 * Fixtures standing in for a torn-down worker must not hardcode a numeric PID:
 * the Linux runners use the full 4194304-entry PID space and recycle it, so any
 * constant is periodically held by a real process and a live-PID guard then
 * fails the round closed. macOS never reuses these constants because its PID
 * ceiling is lower, which is why the collision only shows up on Linux CI.
 */
export function reapedPid() {
  const child = spawnSync(process.execPath, ['-e', 'process.exit(0)'], {
    stdio: 'ignore',
  });
  if (child.error || child.status !== 0 || !Number.isInteger(child.pid)) {
    throw new Error(
      `reapedPid: throwaway child failed: ${child.error?.message ?? `exit status ${child.status}`}`,
    );
  }
  return child.pid;
}
