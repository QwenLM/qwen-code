/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export function getEffectiveBlockedMarketplaces(
  blockedMarketplaces: readonly string[] | undefined,
): string[] {
  const effective = new Map<string, string>();

  for (const marketplace of blockedMarketplaces ?? []) {
    const normalized = marketplace.toLowerCase();
    effective.set(normalized, normalized);
  }
  return Array.from(effective.values());
}

/**
 * Check if a plugin is force-disabled by policy.
 *
 * @param pluginId - Plugin identifier (e.g., "my-plugin@marketplace")
 * @param settings - Merged settings object (or just the plugins section)
 */
export function isPluginBlockedByPolicy(
  pluginId: string,
  settings: {
    plugins?: {
      disabled?: string[];
      blockedMarketplaces?: string[];
    };
  },
): boolean {
  const pluginsConfig = settings.plugins;
  if (!pluginsConfig) return false;

  // NOTE: plugins.disabled[] is the normal user toggle list managed by
  // setPluginEnabledOp — it is NOT an organization policy.  Treating it
  // as a block here would prevent re-enabling any previously disabled
  // plugin (the policy check fires before the mutation that removes the
  // entry from disabled[]).  Only blockedMarketplaces is a true policy.

  // Check blocked marketplaces
  const atIndex = pluginId.lastIndexOf('@');
  const effectiveBlockedMarketplaces = getEffectiveBlockedMarketplaces(
    pluginsConfig.blockedMarketplaces,
  );
  if (atIndex > 0 && effectiveBlockedMarketplaces.length) {
    const marketplace = pluginId.slice(atIndex + 1);
    if (effectiveBlockedMarketplaces.includes(marketplace.toLowerCase())) {
      return true;
    }
  }

  return false;
}
