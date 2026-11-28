/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { runLogger } from '../utils/runLogger.js';
import { clearPluginCacheExclusions } from './orphanedPluginFilter.js';
import { clearMarketplacesCache } from './management/marketplaceManager.js';
import type { LoadedPlugin, PluginError } from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RefreshResult {
  /** Plugins that loaded successfully. */
  enabled: LoadedPlugin[];
  /** Plugins that were present but failed to load. */
  disabled: Array<{ pluginId: string; error: PluginError }>;
  /** All errors encountered during loading. */
  errors: PluginError[];
}

export interface RefreshOptions {
  /** Plugin directories to scan. If not provided, uses default locations. */
  pluginDirs?: string[];
  /** Source identifier for loaded plugins. */
  source?: string;
  /** Repository identifier for loaded plugins. */
  repository?: string;
  /** Whether to clear orphaned plugin cache exclusions (default: true).
   *  Set to true for explicit user-initiated reloads (/reload-plugins).
   *  Set to false for automatic background refreshes. */
  clearOrphanExclusions?: boolean;
}

// ---------------------------------------------------------------------------
// Cache clearing
// ---------------------------------------------------------------------------

/**
 * Clear all plugin-related memoization caches.
 *
 * Clears:
 *   - Marketplace cache (in-memory Map of loaded marketplaces)
 *   - Orphaned plugin exclusions (session-frozen glob patterns)
 *
 * Note: installedPluginsManager reads from disk each time (no memoization
 * to clear), and pluginLoader's loadAllPlugins is not memoized in core.
 */
export function clearAllPluginCaches(options?: {
  clearOrphanExclusions?: boolean;
}): void {
  clearMarketplacesCache();
  if (options?.clearOrphanExclusions !== false) {
    clearPluginCacheExclusions();
  }
  runLogger.log('[Refresh] Cleared all plugin caches');
}
