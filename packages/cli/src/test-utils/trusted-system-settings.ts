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
 * administrator-controlled. See `trustedSystemSettingsLstat`. Test files add
 * their fixture roots in `beforeEach` and remove them in `afterEach`.
 */
export const trustedSystemSettingsDirs: Set<string> = new Set();

/**
 * The `lstatSync` a test file that mocks `node:fs` should expose in place of
 * the real one: the real `lstatSync`, except that it reports the files under
 * the trusted directories as root-owned.
 *
 * The trust gate for the `QWEN_CODE_SYSTEM_SETTINGS_PATH` /
 * `QWEN_CODE_SYSTEM_DEFAULTS_PATH` overrides only honors a root-owned regular
 * file, and a non-root test host cannot make its temp fixtures root-owned.
 * Reporting the fixtures as root-owned stands in for an administrator-created
 * system file, so the tests keep exercising everything the gate sits in front
 * of.
 */
export function trustedSystemSettingsLstat(
  realLstatSync: typeof fs.lstatSync,
): typeof fs.lstatSync {
  const wrapped = (
    location: fs.PathLike,
    options?: fs.StatSyncOptions,
  ): fs.Stats | undefined => {
    const stats = realLstatSync(location, options) as fs.Stats | undefined;
    if (stats) {
      const text = String(location);
      for (const dir of trustedSystemSettingsDirs) {
        if (text === dir || text.startsWith(dir + path.sep)) {
          stats.uid = 0;
          stats.gid = 0;
          break;
        }
      }
    }
    return stats;
  };
  return wrapped as typeof fs.lstatSync;
}
