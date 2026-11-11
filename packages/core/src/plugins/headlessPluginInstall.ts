/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdir } from 'node:fs/promises';

import {
  emitSessionPhaseFinished,
  emitSessionPhaseStarted,
} from '../utils/diagnosticInterceptors.js';
import { runLogger } from '../utils/runLogger.js';
import { BRAND_CLI_BIN } from '../config/brand.js';
import { clearMarketplacesCache } from './management/marketplaceManager.js';
import {
  reconcileMarketplaces,
  type DeclaredMarketplace,
  type ReconcileProgressEvent,
} from './reconciler.js';
import {
  checkEnabledPlugins,
  type PluginInstallResult,
} from './pluginStartupCheck.js';
import {
  cleanupSessionPluginCache,
  getZipCacheMarketplacesDir,
  getZipCachePluginsDir,
  isMarketplaceSourceSupportedByZipCache,
  isPluginZipCacheEnabled,
} from './zipCache.js';
import { syncMarketplacesToZipCache } from './zipCacheAdapters.js';
import type { PluginScope } from './schemas.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HeadlessInstallOptions {
  /** Declared marketplaces from settings.extraKnownMarketplaces. */
  declaredMarketplaces: Record<string, DeclaredMarketplace>;
  /** Plugin IDs enabled in settings. */
  enabledPluginIds: string[];
  /** Plugin IDs explicitly disabled. */
  disabledPluginIds?: string[];
  /** Fallback scope used when the settings owner cannot be resolved. */
  scope: Exclude<PluginScope, 'managed'>;
  /** Project path for project-scoped installations. */
  projectPath?: string;
  /** Progress callback. */
  onProgress?: (message: string) => void;
  /** Blocked marketplace names from policy. */
  blockedMarketplaces?: string[];
  /** Strict known-marketplaces enforcement. */
  strictKnownMarketplaces?: boolean;
  /** Callback to register cleanup function at process exit. */
  registerCleanup?: (fn: () => Promise<void>) => void;
  /** Session ID for diagnostic segment correlation. */
  sessionId?: string;
  /** Resolve the settings scope that owns an enabled plugin intent. */
  getPluginScope?: (
    pluginId: string,
  ) => Exclude<PluginScope, 'managed'>;
}

export interface MissingPluginDiagnostic {
  pluginId: string;
  scope: Exclude<PluginScope, 'managed'>;
  reason: 'not-installed';
}

export interface StartupPluginCheckResult extends PluginInstallResult {
  /** Registered external plugins that require explicit installation. */
  missing: MissingPluginDiagnostic[];
}

export interface HeadlessInstallResult {
  /** Whether anything changed (caller should refresh Layer 3). */
  changed: boolean;
  /** Marketplace reconciliation counts. */
  marketplaces: {
    installed: number;
    updated: number;
    failed: number;
    skipped: number;
  };
  /** Plugin startup check result. Startup reconcile never installs plugins. */
  plugins: StartupPluginCheckResult;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Reconcile marketplaces and diagnose registered missing plugins for startup.
 *
 * Marketplace materialization is automatic, but enabled intent is not an
 * authorization to download and install external plugin code.
 *
 * @returns Result including whether any changes were made.
 */
export async function reconcilePluginsForStartup(
  options: HeadlessInstallOptions,
): Promise<HeadlessInstallResult> {
  const { enabledPluginIds, disabledPluginIds } = options;
  const zipCacheMode = isPluginZipCacheEnabled();
  runLogger.log(
    `[HeadlessInstall] Starting${zipCacheMode ? ' (zip cache mode)' : ''}`,
  );
  const startedAt = Date.now();
  const declaredMarketplaceCount = Object.keys(
    options.declaredMarketplaces,
  ).length;
  const shouldEmitDiagnostics =
    zipCacheMode ||
    declaredMarketplaceCount > 0 ||
    enabledPluginIds.length > 0;
  if (shouldEmitDiagnostics) {
    emitSessionPhaseStarted({
      sessionId: options.sessionId,
      phase: 'headless_plugin_install',
      data: {
        zip_cache_mode: zipCacheMode,
        declared_marketplace_count: declaredMarketplaceCount,
        enabled_plugin_count: enabledPluginIds.length,
        disabled_plugin_count: disabledPluginIds?.length ?? 0,
        scope: options.scope,
      },
    });
  }

  const result: HeadlessInstallResult = {
    changed: false,
    marketplaces: { installed: 0, updated: 0, failed: 0, skipped: 0 },
    plugins: { installed: [], failed: [], missing: [] },
  };
  let failedError: unknown;

  // Ensure zip cache directory structure exists
  if (zipCacheMode) {
    await Promise.all([
      mkdir(getZipCacheMarketplacesDir(), { recursive: true }),
      mkdir(getZipCachePluginsDir(), { recursive: true }),
    ]);
  }

  try {
    // 1. Reconcile declared marketplaces with materialized state
    if (Object.keys(options.declaredMarketplaces).length === 0) {
      runLogger.log('[HeadlessInstall] No marketplaces declared');
    } else {
      const reconcileResult = await reconcileMarketplaces(
        options.declaredMarketplaces,
        {
          skip: zipCacheMode
            ? (_name, source) => !isMarketplaceSourceSupportedByZipCache(source)
            : undefined,
          onProgress: (event: ReconcileProgressEvent) => {
            if (event.type === 'installed') {
              const message =
                event.action === 'update'
                  ? `Reconciled marketplace "${event.name}" to its declared source`
                  : `Installed marketplace "${event.name}"`;
              runLogger.log(`[HeadlessInstall] ${message}`);
              options.onProgress?.(message);
            } else if (event.type === 'failed') {
              const action = event.action ?? 'install';
              runLogger.log(
                `[HeadlessInstall] Failed to ${action} marketplace "${event.name}": ${event.error}`,
              );
            }
          },
          projectRoot: options.projectPath,
        },
      );

      result.marketplaces = {
        installed: reconcileResult.installed.length,
        updated: reconcileResult.updated.length,
        failed: reconcileResult.failed.length,
        skipped: reconcileResult.skipped.length,
      };

      if (reconcileResult.skipped.length > 0) {
        runLogger.log(
          `[HeadlessInstall] Skipped ${reconcileResult.skipped.length} marketplace(s) unsupported by zip cache`,
        );
      }

      const marketplacesChanged =
        reconcileResult.installed.length + reconcileResult.updated.length;

      if (marketplacesChanged > 0) {
        clearMarketplacesCache();
        result.changed = true;
      }
    }

    // 2. Sync marketplace data to zip cache for offline access
    if (zipCacheMode) {
      await syncMarketplacesToZipCache();
    }

    // 3. Check enabled plugins. Registered external plugins require explicit
    // install; unattributed shared settings intent is ignored by the checker.
    if (enabledPluginIds.length > 0) {
      const missing = await checkEnabledPlugins(
        enabledPluginIds,
        disabledPluginIds,
        options.projectPath,
      );

      if (missing.length > 0) {
        runLogger.log(
          `[HeadlessInstall] ${missing.length} enabled external plugin(s) require explicit installation`,
        );

        result.plugins.missing = missing.map(({ pluginId, reason }) => ({
          pluginId,
          scope: options.getPluginScope?.(pluginId) ?? options.scope,
          reason,
        }));
        for (const { pluginId, scope, reason } of result.plugins.missing) {
          const message = formatMissingPluginDiagnostic({
            pluginId,
            scope,
            reason,
          });
          runLogger.warn(`[StartupCheck] ${message}`);
          options.onProgress?.(message);
        }
      }
    }

    // 4. Register session cleanup for zip cache
    if (zipCacheMode && options.registerCleanup) {
      options.registerCleanup(cleanupSessionPluginCache);
    }

    return result;
  } catch (error) {
    failedError = error;
    runLogger.warn(
      `[HeadlessInstall] Failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return result;
  } finally {
    if (shouldEmitDiagnostics) {
      emitSessionPhaseFinished({
        sessionId: options.sessionId,
        phase: 'headless_plugin_install',
        durationMs: Date.now() - startedAt,
        success:
          failedError === undefined &&
          result.plugins.failed.length === 0 &&
          result.marketplaces.failed === 0,
        error: failedError,
        data: {
          changed: result.changed,
          marketplace_installed: result.marketplaces.installed,
          marketplace_updated: result.marketplaces.updated,
          marketplace_failed: result.marketplaces.failed,
          marketplace_skipped: result.marketplaces.skipped,
          plugin_missing: result.plugins.missing.length,
        },
      });
    }
  }
}

export function formatMissingPluginDiagnostic(
  diagnostic: MissingPluginDiagnostic,
): string {
  const { pluginId, scope } = diagnostic;
  return (
    `Plugin "${pluginId}" is enabled for scope "${scope}" but is not installed. ` +
    `Run \`${BRAND_CLI_BIN} plugins install ${pluginId} --scope ${scope}\`.`
  );
}

/** @deprecated Use reconcilePluginsForStartup. */
export const installPluginsForHeadless = reconcilePluginsForStartup;
