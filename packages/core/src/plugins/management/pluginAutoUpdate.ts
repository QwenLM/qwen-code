/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Plugin auto-update scheduler.
 *
 * Checks for updates to installed plugins from their marketplaces once per
 * interactive session. The timer is unref'd, so a short-lived session exits
 * before it ever fires.
 *
 * There is deliberately no periodic timer. A repeating check, multiplied by
 * every running process, compounds against marketplaces that expose no version
 * for their plugins: every pass looks like "newer available" and reinstalls.
 *
 * Updates are applied silently in the background. The user is notified
 * of available updates but existing loaded plugins continue until restart.
 */

import { runLogger } from '../../utils/runLogger.js';
import {
  loadInstalledPluginsFresh,
  type PluginInstallationEntry,
} from './installedPluginsManager.js';
import { updatePluginOp } from './pluginOperations.js';
import { parsePluginIdentifier } from '../pluginIdentifier.js';
import {
  getPluginById,
  loadKnownMarketplacesConfig,
  refreshMarketplace,
} from './marketplaceManager.js';
import { loadPluginFromDirectory } from '../pluginLoader.js';
import { getEffectiveBlockedMarketplaces } from '../pluginPolicy.js';
import { getErrorMessage } from '../../utils/errors.js';
import { ENTERPRISE_MARKETPLACE_PREFIXES } from '../schemas.js';
import type { PluginManager } from './pluginManager.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Upper bound for the random delay before the session's single update check.
 * Uniform over [0, this) so concurrent instances don't fetch in lockstep.
 */
const MAX_STARTUP_JITTER_MS = 10 * 60 * 1000; // 10 minutes

/** Maximum concurrent update operations */
const MAX_CONCURRENT_UPDATES = 3;

/** Maximum concurrent marketplace refresh operations */
const MAX_CONCURRENT_MARKETPLACE_REFRESHES = 3;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PluginUpdateInfo {
  pluginId: string;
  scope: PluginInstallationEntry['scope'];
  projectPath?: string;
  currentVersion?: string;
  availableVersion?: string;
  updated: boolean;
  error?: string;
}

export interface AutoUpdateOptions {
  /** Product manager for candidate selection and per-installation updates. */
  manager?: Pick<
    PluginManager,
    'collectAutoUpdateCandidates' | 'checkAndUpdatePlugin'
  >;
  /** Whether auto-update is enabled (from settings) */
  enabled: boolean;
  /** Blocked marketplace names */
  blockedMarketplaces?: string[];
  /** Strict known marketplaces policy */
  strictKnownMarketplaces?: boolean;
  /** Callback when updates are found/applied */
  onUpdateResult?: (results: PluginUpdateInfo[]) => void;
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

let schedulerTimer: ReturnType<typeof setTimeout> | null = null;
let hasScheduled = false;
let isRunning = false;
let stopped = false;

/**
 * Schedule this session's single auto-update check.
 * Safe to call multiple times; subsequent calls are no-ops.
 */
export function startAutoUpdateScheduler(options: AutoUpdateOptions): void {
  if (!options.enabled) {
    runLogger.log('[Plugin AutoUpdate] Disabled by settings.');
    return;
  }

  // One shot per process. `schedulerTimer` is cleared once the timer fires, so
  // it can't stand in for "already ran".
  if (hasScheduled) {
    runLogger.log('[Plugin AutoUpdate] Already scheduled.');
    return;
  }

  hasScheduled = true;
  stopped = false;
  const delayMs = Math.floor(Math.random() * MAX_STARTUP_JITTER_MS);
  runLogger.log(
    `[Plugin AutoUpdate] Scheduling check in ${Math.round(delayMs / 1000)}s`,
  );

  schedulerTimer = setTimeout(async () => {
    schedulerTimer = null;
    // A timer that already fired can't be cleared, so re-check on entry.
    if (stopped) return;
    await runUpdateCheck(options);
  }, delayMs);
  schedulerTimer.unref?.();
}

/**
 * Stop the auto-update scheduler.
 */
export function stopAutoUpdateScheduler(): void {
  stopped = true;
  hasScheduled = false;
  if (schedulerTimer) {
    clearTimeout(schedulerTimer);
    schedulerTimer = null;
  }
  runLogger.log('[Plugin AutoUpdate] Stopped.');
}

// ---------------------------------------------------------------------------
// Core update logic
// ---------------------------------------------------------------------------

export interface PluginUpdateCandidate {
  pluginId: string;
  entry: PluginInstallationEntry;
}

export function collectUpdateCandidates(
  options: AutoUpdateOptions,
  refreshedMarketplaces: ReadonlySet<string>,
): PluginUpdateCandidate[] {
  const state = loadInstalledPluginsFresh();
  if (!state) return [];

  const blockedSet = new Set(
    getEffectiveBlockedMarketplaces(options.blockedMarketplaces),
  );

  const candidates: PluginUpdateCandidate[] = [];
  for (const [pluginId, entries] of Object.entries(state.plugins)) {
    const { marketplace } = parsePluginIdentifier(pluginId);

    if (!marketplace || marketplace === 'local') continue;
    if (blockedSet.has(marketplace.toLowerCase())) continue;
    if (!refreshedMarketplaces.has(marketplace)) continue;

    // Managed installs are never updated from a marketplace: that would
    // overwrite entries the organization controls. `uninstallPluginOp` rejects
    // managed scope for the same reason.
    for (const entry of entries) {
      if (entry.scope !== 'managed') {
        candidates.push({ pluginId, entry });
      }
    }
  }

  return candidates;
}

function isEnterpriseMarketplace(name: string): boolean {
  const normalized = name.toLowerCase();
  return ENTERPRISE_MARKETPLACE_PREFIXES.some((prefix) =>
    normalized.startsWith(prefix),
  );
}

async function refreshAutoUpdateMarketplaces(
  options: AutoUpdateOptions,
): Promise<Set<string>> {
  const config = loadKnownMarketplacesConfig();
  const blockedSet = new Set(
    getEffectiveBlockedMarketplaces(options.blockedMarketplaces),
  );
  const names = Object.entries(config)
    .filter(
      ([name, entry]) =>
        entry.autoUpdate !== false &&
        !blockedSet.has(name.toLowerCase()) &&
        !isEnterpriseMarketplace(name),
    )
    .map(([name]) => name);

  const refreshed = new Set<string>();
  for (
    let i = 0;
    i < names.length;
    i += MAX_CONCURRENT_MARKETPLACE_REFRESHES
  ) {
    const batch = names.slice(i, i + MAX_CONCURRENT_MARKETPLACE_REFRESHES);
    const results = await Promise.allSettled(
      batch.map((name) => refreshMarketplace(name)),
    );
    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      const name = batch[j];
      if (result.status === 'fulfilled') {
        refreshed.add(name);
      } else {
        runLogger.warn(
          `[Plugin AutoUpdate] Failed to refresh marketplace "${name}": ${getErrorMessage(result.reason)}`,
        );
      }
    }
  }

  return refreshed;
}

async function runUpdateCheck(
  options: AutoUpdateOptions,
): Promise<PluginUpdateInfo[]> {
  if (isRunning) {
    runLogger.log('[Plugin AutoUpdate] Check already in progress, skipping.');
    return [];
  }

  isRunning = true;
  const results: PluginUpdateInfo[] = [];

  try {
    runLogger.log('[Plugin AutoUpdate] Checking for updates...');

    const refreshedMarketplaces = await refreshAutoUpdateMarketplaces(options);
    const updateCandidates = options.manager
      ? options.manager.collectAutoUpdateCandidates(
          options,
          refreshedMarketplaces,
        )
      : collectUpdateCandidates(options, refreshedMarketplaces);

    if (updateCandidates.length === 0) {
      runLogger.log('[Plugin AutoUpdate] No updatable plugins found.');
      return results;
    }

    runLogger.log(
      `[Plugin AutoUpdate] Checking ${updateCandidates.length} plugin installation(s)...`,
    );

    for (let i = 0; i < updateCandidates.length; i += MAX_CONCURRENT_UPDATES) {
      // Shutdown mid-run: stop installing rather than racing process exit.
      if (stopped) break;

      const batch = updateCandidates.slice(i, i + MAX_CONCURRENT_UPDATES);
      const batchResults = await Promise.allSettled(
        batch.map((candidate) =>
          options.manager
            ? options.manager.checkAndUpdatePlugin(candidate)
            : checkAndUpdatePlugin(candidate.pluginId, candidate.entry),
        ),
      );

      for (const result of batchResults) {
        if (result.status === 'fulfilled' && result.value) {
          results.push(result.value);
        }
      }
    }

    const updated = results.filter((r) => r.updated);
    if (updated.length > 0) {
      runLogger.log(
        `[Plugin AutoUpdate] Updated ${updated.length} plugin installation(s): ${updated.map((r) => `${r.pluginId} (${r.scope})`).join(', ')}`,
      );
    } else {
      runLogger.log('[Plugin AutoUpdate] All plugins up to date.');
    }

    options.onUpdateResult?.(results);
  } catch (e) {
    runLogger.warn(`[Plugin AutoUpdate] Check failed: ${getErrorMessage(e)}`);
  } finally {
    isRunning = false;
  }

  return results;
}

export async function checkAndUpdatePlugin(
  pluginId: string,
  entry: PluginInstallationEntry,
  update: typeof updatePluginOp = updatePluginOp,
): Promise<PluginUpdateInfo | null> {
  try {
    const lookup = await getPluginById(pluginId);
    if (!lookup) return null;

    let currentVersion = entry.version;
    if (!currentVersion && entry.installPath) {
      try {
        const loadResult = await loadPluginFromDirectory(
          entry.installPath,
          'check',
          'check',
        );
        if (loadResult.ok) {
          currentVersion = loadResult.plugin.manifest.version;
        }
      } catch {
        // Can't read current, try updating anyway
      }
    }

    // Compare versions — if we can't determine, attempt update
    const latestVersion = lookup.entry.version;
    if (currentVersion && latestVersion && currentVersion === latestVersion) {
      return {
        pluginId,
        scope: entry.scope,
        projectPath: entry.projectPath,
        currentVersion,
        availableVersion: latestVersion,
        updated: false,
      };
    }

    // Attempt update
    const updateResult = await update(
      pluginId,
      entry.scope as 'user' | 'project' | 'local',
      {
        projectPath: entry.projectPath,
      },
    );

    if (updateResult.ok) {
      return {
        pluginId,
        scope: entry.scope,
        projectPath: entry.projectPath,
        currentVersion,
        availableVersion: updateResult.version ?? latestVersion,
        updated: true,
      };
    } else {
      return {
        pluginId,
        scope: entry.scope,
        projectPath: entry.projectPath,
        currentVersion,
        updated: false,
        error: `Update failed`,
      };
    }
  } catch (e) {
    return {
      pluginId,
      scope: entry.scope,
      projectPath: entry.projectPath,
      currentVersion: entry.version,
      updated: false,
      error: getErrorMessage(e),
    };
  }
}
