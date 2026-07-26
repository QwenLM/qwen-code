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
> & {
  reinitializeLsp?: Config['reinitializeLsp'];
};

export async function refreshExtensionRuntime(
  config: ExtensionRuntimeRefreshConfig | undefined,
): Promise<void> {
  if (!config) return;

  // MCP servers must settle first — skills and subagents may depend on the
  // updated MCP tool list for their own refresh (e.g. SkillTool.refreshSkills()
  // rebuilds the model-facing tool description and updates geminiClient's tool
  // list). A failure here is user-visible because extension MCP tools will be
  // unavailable, so let callers surface it.
  await config.reinitializeMcpServers(config.getSettingsMcpServers());
  let lspReloadError: unknown;
  try {
    const lspResult = await config.reinitializeLsp?.();
    const failedLspServers = lspResult?.reconcile.failed ?? [];
    if (failedLspServers.length > 0) {
      lspReloadError = new Error(
        `LSP reload partially failed: ${failedLspServers.join(', ')}`,
      );
    }
  } catch (err) {
    debugLogger.warn('refreshExtensionRuntime: reinitializeLsp failed:', err);
    lspReloadError = err;
  }

  // Skills, subagents, and hooks refresh in parallel. Use allSettled (rather
  // than Promise.all) so a rejection from one leg does not prevent the other
  // legs from applying or skip refreshHierarchicalMemory below. Hook reload
  // failures are surfaced after these best-effort legs settle.
  const skillManager = config.getSkillManager();
  const refreshLegs = [
    { name: 'skills', promise: skillManager?.refreshCache() },
    { name: 'subagents', promise: config.getSubagentManager().refreshCache() },
    { name: 'hooks', promise: config.getHookSystem()?.reload() },
  ] as const;
  const settled = await Promise.allSettled(
    refreshLegs.map((leg) => leg.promise),
  );
  let hookReloadError: unknown;

  settled.forEach((result, index) => {
    if (result.status === 'rejected') {
      debugLogger.warn(
        `refreshExtensionRuntime: ${refreshLegs[index].name} failed:`,
        result.reason,
      );
      if (refreshLegs[index].name === 'hooks') {
        hookReloadError = result.reason;
      }
    }
  });

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

  const surfacedErrors = [hookReloadError, lspReloadError].filter(
    (error): error is unknown => error !== undefined,
  );
  if (surfacedErrors.length === 1) {
    throw surfacedErrors[0];
  }
  if (surfacedErrors.length > 1) {
    throw new AggregateError(
      surfacedErrors,
      'Extension runtime refresh had multiple failures',
    );
  }
}
