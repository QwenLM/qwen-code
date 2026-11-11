/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';

import { getInstalledPluginsV2Path } from '../pluginDirectories.js';
import {
  InstalledPluginsFileSchemaV2,
  type PluginInstallationEntry,
} from '../schemas.js';
import { runLogger } from '../../utils/runLogger.js';

/**
 * Raw, cache-bypassing read of `installed_plugins_v2.json`.
 *
 * Used by guards that need a fresh view of the on-disk state without
 * polluting `installedPluginsManager`'s module-level `cachedState`. Returns
 * `null` for any unreadable / malformed / missing case so callers default
 * to the "no entry" branch — never throws, never triggers legacy migration.
 */
export function readInstalledPluginsV2Raw(): {
  version: 2;
  plugins: Record<string, PluginInstallationEntry[]>;
} | null {
  try {
    const text = fs.readFileSync(getInstalledPluginsV2Path(), 'utf-8');
    const parsed = InstalledPluginsFileSchemaV2.safeParse(JSON.parse(text));
    if (!parsed.success) {
      runLogger.debug(
        `[installedPluginsRaw] V2 schema parse failed: ${parsed.error.message}`,
      );
      return null;
    }
    return parsed.data;
  } catch (err) {
    const code =
      err instanceof Error && 'code' in err
        ? (err as NodeJS.ErrnoException).code
        : undefined;
    if (code !== 'ENOENT') {
      runLogger.debug(
        `[installedPluginsRaw] raw read failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return null;
  }
}
