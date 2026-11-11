/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import type { Config } from '@qwen-code/core';
import {
  invalidateInstalledPluginsCache,
  clearAllPluginCaches,
  formatMissingPluginDiagnostic,
  getEffectiveBlockedMarketplaces,
  stopAutoUpdateScheduler,
  runLogger,
} from '@qwen-code/core';
import type { LoadedSettings } from '../../config/settings.js';
import {
  createCorePluginManager,
  migrateLegacyPluginIdentities,
} from '@qwen-code/core/plugin-management';
import { registerCleanup } from '../../utils/cleanup.js';
import {
  appEvents,
  AppEvent,
  LONG_TRANSIENT_MESSAGE_DURATION_MS,
  TransientMessageType,
} from '../../utils/events.js';

export interface PluginStartupChecksResult {
  needsRefresh: boolean;
}

export function usePluginStartupChecks(opts: {
  config: Config;
  settings: LoadedSettings;
  isTrusted: boolean | undefined;
}): PluginStartupChecksResult {
  const { settings, isTrusted } = opts;
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const ranRef = useRef(false);

  const run = useCallback(async () => {
    try {
      const identitiesMigrated = await migrateLegacyPluginIdentities(settings);
      const result = await createCorePluginManager(
        settings,
        { factory: opts.config.getPluginManagerFactory?.(), cwd: opts.config.getTargetDir?.() },
      ).reconcileInstalledState({
        includeProjectMarketplaces: true,
        onProgress: (msg: string) => {
          runLogger.log(`[Plugin StartupCheck] ${msg}`);
        },
      });

      if (result.changed || identitiesMigrated) {
        invalidateInstalledPluginsCache();
        clearAllPluginCaches({ clearOrphanExclusions: false });
        setNeedsRefresh(true);
        appEvents.emit(AppEvent.TransientMessage, {
          id: 'plugins-startup-updated',
          message:
            'Plugin configuration updated. Run /plugins reload to apply.',
          type: TransientMessageType.Success,
          durationMs: LONG_TRANSIENT_MESSAGE_DURATION_MS,
        });
        runLogger.log(
          `[Plugin StartupCheck] Marketplaces: ${result.marketplaces.installed} installed, ${result.marketplaces.updated} updated. Missing external plugins: ${result.plugins.missing.length}.`,
        );
      }
      if (result.plugins.missing.length > 0) {
        const { missing } = result.plugins;
        for (const diagnostic of missing) {
          runLogger.warn(
            `[Plugin StartupCheck] ${formatMissingPluginDiagnostic(diagnostic)}`,
          );
        }

        const message =
          missing.length === 1
            ? formatMissingPluginDiagnostic(missing[0])
            : `${missing.length} enabled plugins are not installed. Run /plugins to install them.`;
        appEvents.emit(AppEvent.TransientMessage, {
          id: 'plugins-not-installed',
          message,
          type: TransientMessageType.Warning,
          durationMs: LONG_TRANSIENT_MESSAGE_DURATION_MS,
        });
      }
    } catch (e) {
      runLogger.warn(
        `[Plugin StartupCheck] Failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      appEvents.emit(AppEvent.TransientMessage, {
        message: `Plugin startup check failed: ${e instanceof Error ? e.message : String(e)}`,
        type: TransientMessageType.Warning,
        persist: false,
      });
    }
  }, [settings, opts.config]);

  const scheduleAutoUpdate = useCallback(() => {
    const merged = settings.merged;
    createCorePluginManager(settings, {
      factory: opts.config.getPluginManagerFactory?.(),
      cwd: opts.config.getTargetDir?.(),
    }).startAutoUpdate({
      enabled: merged.plugins?.autoUpdate !== false,
      blockedMarketplaces: getEffectiveBlockedMarketplaces(
        merged.blockedMarketplaces,
      ),
      strictKnownMarketplaces: merged.strictKnownMarketplaces,
      onUpdateResult: (results) => {
        const updated = results.filter((r) => r.updated);
        if (updated.length === 0) return;
        runLogger.log(
          `[Plugin AutoUpdate] ${updated.length} plugin(s) updated.`,
        );
        appEvents.emit(AppEvent.TransientMessage, {
          id: 'plugins-auto-updated',
          message: `${updated.length} plugin(s) updated. Run /plugins reload to apply.`,
          type: TransientMessageType.Success,
          durationMs: LONG_TRANSIENT_MESSAGE_DURATION_MS,
        });
      },
    });
    registerCleanup(() => {
      stopAutoUpdateScheduler();
    });
  }, [settings, opts.config]);

  useEffect(() => {
    if (isTrusted !== true) return;
    if (ranRef.current) return;
    ranRef.current = true;

    // Reconcile first: the jitter can be as short as 0ms, so scheduling before
    // it settles risks an update check writing the install records while the
    // reconcile is still writing them too.
    void run()
      .then(scheduleAutoUpdate)
      .catch((e: unknown) => {
        runLogger.warn(
          `[Plugin AutoUpdate] Scheduling failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      });
  }, [isTrusted, run, scheduleAutoUpdate]);

  return { needsRefresh };
}
