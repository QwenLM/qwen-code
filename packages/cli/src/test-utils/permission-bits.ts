/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Whether file permission bits bind this process, for tests that force a
 * failure with `chmod`. They do not on Windows, which ignores Unix-style
 * bits, nor for root, which bypasses them (on Linux through
 * CAP_DAC_OVERRIDE and CAP_DAC_READ_SEARCH). ci.yml drops both
 * capabilities when it runs unit tests as root, so asking the kernel,
 * rather than checking for uid 0, keeps those tests running there.
 */
export function arePermissionBitsEnforced(): boolean {
  if (process.platform === 'win32') return false;
  let dir: string | undefined;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-permission-probe-'));
    fs.chmodSync(dir, 0o000);
    const probe = dir;
    return (
      refused(() => fs.readdirSync(probe)) &&
      refused(() => fs.writeFileSync(path.join(probe, 'probe'), ''))
    );
  } catch {
    // A temp directory that cannot hold the probe, or refuses chmod,
    // cannot hold these tests' fixtures either.
    return false;
  } finally {
    if (dir !== undefined) {
      try {
        fs.chmodSync(dir, 0o700);
      } catch {
        // Removal below does not need it for an empty directory.
      }
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best effort: a leftover probe must not fail the test file.
      }
    }
  }
}

function refused(attempt: () => unknown): boolean {
  try {
    attempt();
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EACCES';
  }
}
