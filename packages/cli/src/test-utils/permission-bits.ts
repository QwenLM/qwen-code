/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect } from 'vitest';

/**
 * Whether file permission bits bind this process, for tests that force a
 * failure with `chmod`. They do not on Windows, which ignores Unix-style
 * bits, nor for root, which bypasses them (on Linux through
 * CAP_DAC_OVERRIDE and CAP_DAC_READ_SEARCH). ci.yml drops both
 * capabilities when it runs unit tests as root, so asking the kernel,
 * rather than checking for uid 0, keeps those tests running there. A
 * probe that cannot measure also answers false, and says so on stderr.
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
  } catch (error) {
    // A temp directory that cannot hold the probe, or refuses chmod,
    // cannot hold these tests' fixtures either, though after a transient
    // ENOSPC it may hold them again by the time they run, so say which it
    // was rather than skip silently.
    inconclusive(error);
    return false;
  } finally {
    if (dir !== undefined) {
      try {
        fs.chmodSync(dir, 0o700);
      } catch {
        // Best effort, like the removal below: newer Node versions refuse
        // to remove even an empty mode-000 directory.
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
    if (errnoOf(error) === 'EACCES') return true;
    inconclusive(error);
    return false;
  }
}

function errnoOf(error: unknown): string | undefined {
  const code = attempt(
    () => (error as NodeJS.ErrnoException | null | undefined)?.code,
  );
  return typeof code === 'string' ? code : undefined;
}

/**
 * Names a probe that could not measure, and the test file that asked, so
 * the skips it causes are not mistaken for a Windows or root run. vitest's
 * `silent: true` drops console output, so this writes to stderr directly.
 */
function inconclusive(error: unknown): void {
  try {
    process.stderr.write(
      `[permission-bits] probe inconclusive (${causeOf(error)})${askedBy()}; ` +
        'treating permission bits as unenforced, so chmod-based tests skip\n',
    );
  } catch {
    // A diagnostic must never fail the test file it is meant to explain.
  }
}

function causeOf(error: unknown): string {
  const code = errnoOf(error);
  if (code === undefined) {
    return (
      attempt(() => String(error).split('\n', 1)[0]) ?? 'an unprintable value'
    );
  }
  const syscall = attempt(() => (error as NodeJS.ErrnoException).syscall);
  return typeof syscall === 'string' ? `${code} in ${syscall}` : code;
}

function askedBy(): string {
  const testPath = attempt(() => expect.getState().testPath);
  if (!testPath) return '';
  return ` for ${attempt(() => path.relative(process.cwd(), testPath)) ?? testPath}`;
}

function attempt<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}
