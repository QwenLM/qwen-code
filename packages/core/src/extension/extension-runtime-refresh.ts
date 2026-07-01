/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { createDebugLogger } from '../utils/debugLogger.js';
import type { Config } from '../config/config.js';

const debugLogger = createDebugLogger('EXTENSION_RUNTIME_REFRESH');

export type ExtensionRuntimeRefreshConfig = Pick<
  Config,
  | 'getToolRegistry'
  | 'getSkillManager'
  | 'getSubagentManager'
  | 'refreshHierarchicalMemory'
>;

export async function refreshExtensionRuntime(
  config: ExtensionRuntimeRefreshConfig | undefined,
): Promise<void> {
  if (!config) return;

  await config.getToolRegistry().restartMcpServers();

  // Use allSettled so a rejection from one refresh leg does not prevent the
  // other leg from applying or stop the memory refresh below.
  const skillManager = config.getSkillManager();
  const settled = await Promise.allSettled([
    skillManager?.refreshCache(),
    config.getSubagentManager().refreshCache(),
  ]);

  for (const result of settled) {
    if (result.status === 'rejected') {
      debugLogger.warn(
        'refreshExtensionRuntime: a refreshCache leg failed:',
        result.reason,
      );
    }
  }

  // Await hierarchical memory refresh so callers only continue after the
  // extension refresh has settled, but do not unwind an already-applied
  // extension mutation if memory refresh fails.
  try {
    await config.refreshHierarchicalMemory();
  } catch (err) {
    debugLogger.error(
      'refreshExtensionRuntime: refreshHierarchicalMemory failed:',
      err,
    );
  }
}
