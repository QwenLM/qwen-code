/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createRequire } from 'node:module';
import * as path from 'node:path';
import { expect } from 'vitest';

/** The node:fs calls the probe makes. */
export interface ProbeFs {
  mkdtempSync(prefix: string): string;
  chmodSync(path: string, mode: number): void;
  readdirSync(path: string): unknown;
  writeFileSync(path: string, data: string): void;
  rmSync(path: string, options: { recursive: boolean; force: boolean }): void;
}

// The real node:fs and node:os, even when the test file that asks has
// vi.mock()ed them: vitest mocks its own module graph, not a builtin loaded
// through Node's require. A mocked fs would answer for the mock, not the
// kernel. A vi.spyOn on node:fs's default export at collection time would
// still reach the probe, since that export is this same module object.
const nodeRequire = createRequire(import.meta.url);
const realFs = nodeRequire('node:fs') as typeof import('node:fs');
const realOs = nodeRequire('node:os') as typeof import('node:os');

/**
 * Whether file permission bits bind this process, for tests that force a
 * failure with `chmod`. They do not on Windows, which ignores Unix-style
 * bits, nor for root, which bypasses them (on Linux through
 * CAP_DAC_OVERRIDE and CAP_DAC_READ_SEARCH). ci.yml drops both
 * capabilities when it runs unit tests as root (package-scripts.test.js
 * pins that), so asking the kernel, rather than checking for uid 0, keeps
 * those tests running there. A probe that cannot measure also answers
 * false, and says so on stderr.
 * `fs` is for this helper's own tests; every caller probes the real one.
 */
export function arePermissionBitsEnforced(fs: ProbeFs = realFs): boolean {
  if (process.platform === 'win32') return false;
  let dir: string | undefined;
  try {
    dir = fs.mkdtempSync(path.join(realOs.tmpdir(), 'qwen-permission-probe-'));
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
 * Under GitHub Actions the line opens with a workflow command, so the skips
 * show in the check UI and not only deep in the log.
 */
function inconclusive(error: unknown): void {
  try {
    process.stderr.write(
      `${process.env['GITHUB_ACTIONS'] === 'true' ? '::warning::' : ''}` +
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
