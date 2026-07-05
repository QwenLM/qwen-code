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
  | 'getSettingsMcpServers'
  | 'reinitializeMcpServers'
  | 'getSkillManager'
  | 'getSubagentManager'
  | 'getHookSystem'
  | 'refreshHierarchicalMemory'
>;

export async function refreshExtensionRuntime(
  config: ExtensionRuntimeRefreshConfig | undefined,
): Promise<void> {
  if (!config) return;

  // MCP servers must settle first — skills and subagents may depend on the
  // updated MCP tool list for their own refresh (e.g. SkillTool.refreshSkills()
  // rebuilds the model-facing tool description and updates geminiClient's tool
  // list). Wrap in try/catch so a failure here does not prevent the remaining
  // refresh legs from running.
  try {
    await config.reinitializeMcpServers(config.getSettingsMcpServers());
  } catch (err) {
    debugLogger.warn(
      'refreshExtensionRuntime: reinitializeMcpServers failed:',
      err,
    );
  }

  // Skills, subagents, and hooks refresh in parallel. Use allSettled (rather
  // than Promise.all) so a rejection from one leg does not cascade — the other
  // legs' results are still applied, refreshHierarchicalMemory below still
  // runs, and callers (`enableExtension`, etc.) don't unwind because of an
  // unrelated transient failure.
  const skillManager = config.getSkillManager();
  const settled = await Promise.allSettled([
    skillManager?.refreshCache(),
    config.getSubagentManager().refreshCache(),
    config.getHookSystem()?.reload(),
  ]);

  for (const result of settled) {
    if (result.status === 'rejected') {
      debugLogger.warn(
        'refreshExtensionRuntime: a refresh leg failed:',
        result.reason,
      );
    }
  }

  // Await hierarchical memory refresh so callers only continue after the
  // extension refresh has settled. Wrap in try/catch so a transient failure
  // doesn't propagate up to `enableExtension` / `installExtension` callers,
  // which have already mutated their `isActive`/`installed` flags by the time
  // this function is invoked — a failed memory refresh leaves stale memory
  // but should not back out the surrounding extension transition. At this
  // point enable/disable and install/uninstall callers may already have
  // updated isActive state, extension cache entries, or on-disk enablement
  // metadata.
  try {
    await config.refreshHierarchicalMemory();
  } catch (err) {
    debugLogger.warn(
      'refreshExtensionRuntime: refreshHierarchicalMemory failed:',
      err,
    );
  }
}
