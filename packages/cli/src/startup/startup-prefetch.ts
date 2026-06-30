/**
 * @license
 * Copyright 2026 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { createDebugLogger, type Config } from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../config/settings.js';
import { preconnectApi } from '../utils/apiPreconnect.js';
import { recordStartupEvent } from '../utils/startupProfiler.js';

const debugLogger = createDebugLogger('STARTUP_PREFETCH');

const earlyStarted = new WeakSet<Config>();
const postRenderStarted = new WeakSet<Config>();

/**
 * Starts a best-effort startup task without adding it to the caller's
 * critical path. Failures are recorded for diagnostics and otherwise
 * swallowed so optional prefetch work cannot break REPL startup.
 */
function runDeferredTask(name: string, task: () => Promise<void> | void): void {
  recordStartupEvent('startup_prefetch_started', { name });
  void Promise.resolve()
    .then(task)
    .then(() => {
      recordStartupEvent('startup_prefetch_completed', { name });
    })
    .catch((err) => {
      recordStartupEvent('startup_prefetch_failed', { name });
      debugLogger.warn(
        `${name} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
}

/**
 * Starts pre-render startup prefetches that benefit from maximum lead time.
 *
 * This runs after `loadCliConfig()` has produced a Config, but before
 * `initializeApp()` and UI rendering. Keep this phase limited to work that is
 * cheap to start, independent of Ink/React, and safe to ignore on failure.
 */
export function startEarlyStartupPrefetches(config: Config): void {
  if (earlyStarted.has(config)) return;
  earlyStarted.add(config);

  try {
    const modelsConfig = config.getModelsConfig();
    const authType = modelsConfig.getCurrentAuthType();
    const resolvedBaseUrl = modelsConfig.getGenerationConfig().baseUrl;
    const proxy = config.getProxy();
    preconnectApi(authType, { resolvedBaseUrl, proxy });
    recordStartupEvent('startup_prefetch_started', { name: 'api_preconnect' });
  } catch (error) {
    debugLogger.debug(
      `Preconnect skipped due to error getting authType: ${error}`,
    );
  }
}

/**
 * Starts post-render startup prefetches for ordinary interactive TUI sessions.
 *
 * This runs immediately after Ink's `render()` returns (`first_paint`). Tasks
 * here may load heavier modules or perform network/IPC work, but they must not
 * affect `startInteractiveUI()` success. `connectIde` is opt-in so headless,
 * stream-json, and ACP/Zed paths can keep their awaited IDE startup semantics.
 */
export function startPostRenderPrefetches(
  config: Config,
  settings: LoadedSettings,
  options: { connectIde?: boolean } = {},
): void {
  if (postRenderStarted.has(config)) return;
  postRenderStarted.add(config);

  if (settings.merged.general?.enableAutoUpdate !== false) {
    runDeferredTask('update_check', async () => {
      const [{ checkForUpdates }, { handleAutoUpdate }] = await Promise.all([
        import('../ui/utils/updateCheck.js'),
        import('../utils/handleAutoUpdate.js'),
      ]);
      const info = await checkForUpdates();
      handleAutoUpdate(info, settings, config.getProjectRoot());
    });
  }

  if (options.connectIde && config.getIdeMode()) {
    runDeferredTask('ide_connect', async () => {
      const { connectIdeForStartup } = await import('../core/initializer.js');
      await connectIdeForStartup(config);
    });
  }

  runDeferredTask('background_housekeeping', async () => {
    const { startBackgroundHousekeeping } = await import(
      '../utils/housekeeping/scheduler.js'
    );
    startBackgroundHousekeeping(config, settings);
  });
}
