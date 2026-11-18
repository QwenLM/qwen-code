/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Type-only import: this module is imported from inside `vi.mock('node:fs')`
// factories, and a value import of `node:fs` there would recurse into the
// mock.
import type * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Directories whose files the system settings trust gate should treat as
 * administrator-controlled. See `trustedSystemSettingsLstat` and
 * `trustedSystemSettingsStat`. Test files add their fixture roots in
 * `beforeEach` and remove them in `afterEach`.
 */
export const trustedSystemSettingsDirs: Set<string> = new Set();

/**
 * Report the stats of a location as root-owned while it sits under one of the
 * trusted directories. The gate for the `QWEN_CODE_SYSTEM_SETTINGS_PATH` /
 * `QWEN_CODE_SYSTEM_DEFAULTS_PATH` overrides only honors files owned by root
 * (in a directory owned by root), and a non-root test host cannot make its
 * temp fixtures root-owned; reporting the fixtures as root-owned stands in for
 * an administrator-created system file, so the tests keep exercising
 * everything the gate sits in front of.
 */
function reportTrusted(
  location: fs.PathLike,
  stats: fs.Stats | undefined,
): fs.Stats | undefined {
  if (!stats) return stats;
  const text = String(location);
  for (const dir of trustedSystemSettingsDirs) {
    if (text === dir || text.startsWith(dir + path.sep)) {
      stats.uid = 0;
      stats.gid = 0;
      break;
    }
  }
  return stats;
}

/**
 * The `lstatSync` a test file that mocks `node:fs` should expose in place of
 * the real one: the real `lstatSync`, except that it reports the locations
 * under the trusted directories as root-owned (see `reportTrusted`).
 */
export function trustedSystemSettingsLstat(
  realLstatSync: typeof fs.lstatSync,
): typeof fs.lstatSync {
  const wrapped = (
    location: fs.PathLike,
    options?: fs.StatSyncOptions,
  ): fs.Stats | undefined =>
    reportTrusted(
      location,
      realLstatSync(location, options) as fs.Stats | undefined,
    );
  return wrapped as typeof fs.lstatSync;
}

/**
 * The `statSync` a test file that mocks `node:fs` should expose in place of
 * the real one: the real `statSync` (which follows links), except that it
 * reports the locations under the trusted directories as root-owned, so a
 * fixture reached through a link still reads as an administrator file the way
 * a mounted one does on a managed host.
 */
export function trustedSystemSettingsStat(
  realStatSync: typeof fs.statSync,
): typeof fs.statSync {
  const wrapped = (
    location: fs.PathLike,
    options?: fs.StatSyncOptions,
  ): fs.Stats | undefined =>
    reportTrusted(
      location,
      realStatSync(location, options) as fs.Stats | undefined,
    );
  return wrapped as typeof fs.statSync;
}
